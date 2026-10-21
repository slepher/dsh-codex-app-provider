import type { Context, Volatile } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { CodexSessionBackend } from "./backend.js";
import { AppServer } from "./rpc.js";
import type { AppServerSpawner, AppServerTimer } from "./process.js";
import { installCodexContextFilter } from "./context.js";
import { dshSessionId, nativeSessionId } from "./handoff.js";
import { retireMainSessionSelection, type DefaultModelFace, type MainSessionRetirementDeps, type ProjectionsFace } from "./main-session.js";
import { CODEX_OWNER_ID, CODEX_APP_PROVIDER, CodexProviderAdapter, backendSessionId, type ProviderApprovalSeam, type ProviderAttachmentSeam, type ProviderQuestionSeam } from "./provider.js";
import { SessionId } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-working-directory";
import { CodexGateBridge } from "./tool-gate.js";
import { ToolCallId } from "@deepseek-ai/dsh-llm/brand";
import type {} from "@deepseek-ai/dsh-tools";
import { DEFAULT_BRIDGED_TOOLS, ToolBridge } from "./tool-bridge.js";
import { resolveCodexCommand } from "./command.js";
import { fileURLToPath } from "node:url";
// Type-only: the Loader's `loader/volatile-update` instance event.
import type {} from "@deepseek-ai/cordis-plugin-loader";
export type { NativeExecution, NativeExecutionReader, NativeExecutionReport } from "./execution.js";
export type {
  CodexThreadHandoffRequest, CodexThreadHandoffResult, CodexThreadHandoffService, CodexThreadOwnership,
} from "./handoff.js";
export { WORKFLOW_PRE_TOOL_USE, CodexGateBridge } from "./tool-gate.js";
export type { CodexToolGate, GateBinding, GateDecision, GateEvent, GateHandler, HookRunEvidence } from "./tool-gate.js";

export interface Config {
  /**
   * Where the plugin persists its own Session records. Omitted
   * means `defaultStateDir`: the launched profile's state directory, never the
   * directory the process happened to start in.
   */
  stateDir?: string;
  /**
   * Executable run as the App Server (`<command> app-server --stdio`).
   *
   * Blank (the default) means "detect": the plugin searches this system's `PATH`
   * for a spawnable Codex and resolves a Windows npm shim to the JavaScript entry
   * it launches. Configure it only to override the detected program.
   *
   * Live-editable: a new runtime reads the current value.
   */
  command: Volatile<string>;
  requestTimeoutMs?: number;
  /**
   * Model-settings working directory, and the working directory a Codex thread
   * falls back to when its Session records none. Omitted means the project
   * directory the Harness was launched in.
   */
  providerCwd?: string;
  /**
   * Whether top-level main Sessions may select this route. Default `false`:
   * `codex-app` stays available to managed workflow children only, so the
   * composer, `/model`, titles and `/compact` never start an external process
   * unless the deployment opts in. Live-editable through the Plugins row.
   */
  allowMainSession: Volatile<boolean>;
  /**
   * The native DSH tool bridge: when enabled, the Codex route exposes the
   * configured DSH tools as dynamic tools on the native thread and executes
   * their callbacks through DSH's own tool pipeline. Live-editable.
   */
  toolBridge: Volatile<ToolBridgeConfig>;
}

/** The tool bridge's editable fields. */
export interface ToolBridgeConfig {
  /** Whether the bridge is on for this deployment; default `false`. */
  enabled: boolean;
  /** DSH tool names the bridge may expose; the intersection is what ships. */
  allow: string[];
}

export const Config = z.object({
  stateDir: z.string().required(false),
  command: z.string().default("").volatile(),
  requestTimeoutMs: z.number().min(1).max(2_147_483_647).default(30_000),
  providerCwd: z.string().required(false),
  allowMainSession: z.boolean().default(false).volatile(),
  toolBridge: z.object({
    enabled: z.boolean().default(false),
    allow: z.array(z.string()).default([...DEFAULT_BRIDGED_TOOLS]),
  }).default({ enabled: false, allow: [...DEFAULT_BRIDGED_TOOLS] }).volatile(),
});

export const inject = ["agents", "sessions", "llm", "workingDirectory", "tools"];

/**
 * Launcher-provided profile facts, read defensively.
 *
 * `profileContext` is not a typed DSH service face: the live runtime carries
 * the profile's name (state lands under it today) while the declared contract
 * does not name that field, so no value here is trusted unexamined. A field
 * that is absent or unusable is omitted, and the derivations below fall back
 * to the environment.
 * @param ctx - the Host context.
 * @returns the usable profile facts, or `undefined` when the service is absent.
 */
function launchedProfile(ctx: Context): { name?: string; home?: string; cwd?: string } | undefined {
  const value = ctx.get("profileContext") as Record<string, unknown> | undefined;
  if (value === null || typeof value !== "object") return undefined;
  const name = text(value.name), home = text(value.home), cwd = text(value.cwd);
  return {
    ...(name === undefined ? {} : { name }),
    ...(home === undefined || !isAbsolute(home) ? {} : { home }),
    ...(cwd === undefined || !isAbsolute(cwd) ? {} : { cwd }),
  };
}

/** A non-empty string, or `undefined` for every other value. */
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * Persistence root used when the entry config omits `stateDir`.
 *
 * The launcher-provided profile owns the Harness home and its own name, so the
 * fallback lands inside that profile's state tree. Resolving against the
 * current working directory instead would scatter state into whichever
 * directory `dsh` was started from, and two profiles started from one directory
 * would share it. A boot without a profile falls back to `$DSH_HOME`, then
 * `~/.dsh`, under the `default` profile name.
 * @param ctx - the Host context carrying the launcher-provided profile context.
 * @returns the absolute state directory for this deployment.
 */
function defaultStateDir(ctx: Context): string {
  const profile = launchedProfile(ctx);
  const configuredHome = process.env.DSH_HOME?.trim();
  const home = profile?.home ?? (configuredHome === undefined || configuredHome === "" ? join(homedir(), ".dsh") : configuredHome);
  // The profile name is what keeps two profiles on one home apart.
  // `profileContext.name` is the launcher's own answer; `DSH_PROFILE` is the
  // same fact from the environment, used when a host does not expose the former.
  const name = profile?.name ?? text(process.env.DSH_PROFILE) ?? "default";
  return join(home, "state", name, "codex");
}

/**
 * Project directory a Codex thread falls back to when its Session records none.
 *
 * The launcher captures the directory it was started in, so a later
 * `process.chdir` in this process cannot move a thread's default workspace.
 * @param ctx - the Host context carrying the launcher-provided profile context.
 * @returns the absolute fallback working directory.
 */
function defaultProviderCwd(ctx: Context): string {
  return launchedProfile(ctx)?.cwd ?? process.cwd();
}

/**
 * The deployment's managed-process capability, when it has one.
 *
 * Read structurally rather than trusted by name: the service is optional and
 * untyped here, so a value that does not actually offer `spawn` is treated as
 * absent instead of failing later inside the transport.
 * @param ctx - the Host context.
 * @returns the spawner, or `undefined` when this composition has none.
 */
function subprocessSeam(ctx: Context): AppServerSpawner | undefined {
  const value = ctx.get("subprocess") as Partial<AppServerSpawner> | undefined;
  return value !== null && typeof value === "object" && typeof value.spawn === "function"
    ? value as AppServerSpawner
    : undefined;
}

/**
 * The deployment's disposable-timer capability, when it has one.
 * @param ctx - the Host context.
 * @returns the timer seam, or `undefined` when this composition has none.
 */
function timerSeam(ctx: Context): AppServerTimer | undefined {
  const value = ctx.get("timer") as Partial<AppServerTimer> | undefined;
  return value !== null && typeof value === "object" && typeof value.timeout === "function"
    ? value as AppServerTimer
    : undefined;
}

/** Install one Codex execution owner and its native DSH route. */
export function apply(ctx: Context, config?: Config): void {
  // The Loader parses every entry through `Config`, which fills the volatile
  // fields from their defaults; a direct mount with no config is normalized the
  // same way instead of dereferencing an absent Volatile reference.
  const entry: Config = config ?? new Config({});
  // Report a system with no usable Codex once at startup; a configured command is
  // never second-guessed, and resolution runs again for every new runtime.
  if (resolveCodexCommand({ configured: entry.command.get() }).source === "fallback") {
    ctx.logger.warn("dsh-codex-app-provider: no spawnable Codex CLI was found on PATH; set the provider's `command` to override detection");
  }
  ctx.effect(function* () {
    // Process ownership and timers are deployment capabilities, not plugin
    // policy: `ctx.subprocess` terminates a whole managed range and joins it on
    // release, which an unmanaged child of this process cannot promise. Both
    // are optional capabilities, so a composition that provides neither still
    // runs the App Server, as a child this process owns directly — and says so.
    const spawner = subprocessSeam(ctx);
    const timer = timerSeam(ctx);
    const unmanaged = [spawner === undefined && "subprocess", timer === undefined && "timer"]
      .filter((name): name is string => typeof name === "string");
    if (unmanaged.length > 0) {
      ctx.logger.warn("dsh-codex-app-provider: ctx.%s unavailable; the Codex App Server runs as an unmanaged child of this process", unmanaged.join(", ctx."));
    }
    const backend = new CodexSessionBackend(
      resolve(entry.stateDir ?? defaultStateDir(ctx)),
      // The transport factory carries a gated runtime's gate environment and
      // leaves an ungated one with exactly the environment it had before. The
      // executable is read at spawn time, so a live configuration edit applies
      // to the next runtime rather than requiring a plugin remount.
      options => new AppServer({ command: entry.command.get(), timeoutMs: entry.requestTimeoutMs,
        ...(spawner === undefined ? {} : { spawner }),
        ...(timer === undefined ? {} : { timer }),
        ...(options?.env === undefined ? {} : { env: options.env }) }),
    );
    let provider: CodexProviderAdapter | undefined;
    let unregister: (() => void) | undefined;
    let unfilter: (() => void) | undefined;
    // The workflow gate is a Host capability, not a model-facing tool: the
    // workflow plugin registers the one business handler and binds each child it
    // starts, and the provider only carries the binding to its execution points.
    const toolGate = new CodexGateBridge();
    // The startup preflight matches the installed hook command, so this is the
    // one entry the provider will accept as its own PreToolUse hook.
    toolGate.useClient(fileURLToPath(new URL("./pretool-client.js", import.meta.url)));
    backend.attachGate(toolGate);
    // The native tool bridge executes through DSH's own tool pipeline, so the
    // deployment's scoped policy, guards, approvals and cancellation apply
    // unchanged; the provider only carries the binding.
    const toolBridge = new ToolBridge({
      seam: {
        schemas: agent => ctx.tools.schemas(agent),
        execute: call => ctx.tools.execute({
          callId: ToolCallId(call.callId),
          name: call.name,
          arguments: call.arguments,
          agent: call.agent,
          signal: call.signal,
        }),
      },
      options: {
        // Getters: the bridge reads the live entry config on every decision, so
        // a form edit takes effect without remounting this plugin.
        get enabled(): boolean { return entry.toolBridge.get().enabled === true; },
        get allow(): readonly string[] { return entry.toolBridge.get().allow; },
        log: message => ctx.logger.warn("dsh-codex-app-provider: %s", message),
      },
    });
    // The Host owns a Session's lifecycle and reports disposal as a fact. The
    // Codex record that backed the Session is this plugin's to release, so the
    // two are joined here rather than by asking the core for a teardown
    // primitive it has no authority to execute.
    // Returning the close lets a host that awaits this seam wait for the process
    // to exit; the backend also awaits it during teardown.
    const onDisposed = ctx.on("session/disposed", session => backend.releaseDisposed(backendSessionId(String(session.id))));
    // A live form edit can withdraw the route from main Sessions; the saved
    // selection has to move off it then, exactly as at startup.
    const retireIfWithdrawn = (): void => {
      if (entry.allowMainSession.get() === true) return;
      void retireMainSessionSelection(retirementDeps(ctx)).then(
        changed => { if (changed) ctx.logger.warn("dsh-codex-app-provider: main-Session model selections were moved off the codex-app route"); },
        error => { ctx.logger.warn("dsh-codex-app-provider: the saved main-Session selection was not retired: %s", messageOf(error)); },
      );
    };
    const offVolatile = ctx.on("loader/volatile-update", retireIfWithdrawn);
    yield async () => {
      offVolatile();
      onDisposed();
      provider?.close();
      unregister?.();
      unfilter?.();
      await backend.close();
      await toolGate.close();
    };
    provider = new CodexProviderAdapter({
      backend,
      sessions: ctx.sessions,
      agents: ctx.agents,
      currentCwd: id => {
        const session = ctx.sessions.get(SessionId(id));
        return session === undefined ? undefined : ctx.workingDirectory.get(session);
      },
      // The user-facing halves of a native request are DSH's to ask. Codex keeps
      // its own permission judgment; the plugin only carries the question.
      approval: ctx.get("approval") as ProviderApprovalSeam | undefined,
      questions: ctx.get("userQuestions") as ProviderQuestionSeam | undefined,
      attachments: ctx.get("attachments") as ProviderAttachmentSeam | undefined,
      logger: ctx.logger,
      providerCwd: resolve(entry.providerCwd ?? defaultProviderCwd(ctx)),
      allowMainSession: () => entry.allowMainSession.get() === true,
      toolBridge,
    });
    backend.attachToolBridge({ call: request => provider!.handleToolCall(request) });
    unregister = ctx.llm.registerAdapter([CODEX_APP_PROVIDER], provider);
    ctx.provide("codexToolGate", toolGate);
    ctx.provide("codexExecution", {
      read: nativeSessionId => provider!.readExecution(nativeSessionId),
      facts: nativeSessionId => provider!.facts(nativeSessionId),
      // The workflow settings page keeps offering this route for child roles,
      // so a Host consumer reads the catalog here even while the composer menu
      // hides it behind `allowMainSession: false`.
      catalog: () => provider!.catalogGroup(),
    });
    // The controlled thread handover stays a trusted-Host capability: ordinary
    // children receive neither this service nor arbitrary thread authority.
    ctx.provide("codexHandoff", {
      handoff: async request => {
        const fromSessionId = nativeSessionId(request.fromSessionId);
        const source = await backend.readSession(CODEX_OWNER_ID, fromSessionId);
        if (source === undefined) throw new Error("Thread handoff source Session is unknown to the Codex provider");
        const liveCwd = liveSessionCwd(ctx, request.fromSessionId);
        if (liveCwd !== undefined && liveCwd !== source.cwd) {
          throw new Error("The source Session workspace changed; the Codex thread handoff was refused");
        }
        const liveSession = ctx.sessions.get(SessionId(request.fromSessionId));
        if (liveSession !== undefined && ctx.workingDirectory.get(liveSession) !== (source.executionCwd ?? source.cwd)) {
          throw new Error("The source Session execution directory changed; the Codex thread handoff was refused");
        }
        // The successor continues the same native thread, so its execution cwd
        // is the source's; the boundary the caller declared travels verbatim and
        // the backend refuses one that would move the thread or widen a
        // declared task constraint into an unscoped execution.
        const result = await backend.handoffThread(CODEX_OWNER_ID, {
          ...request,
          fromSessionId,
          toSessionId: nativeSessionId(request.toSessionId),
        });
        return { ...result, toSessionId: dshSessionId(result.toSessionId) };
      },
      read: async session => {
        const ownership = await backend.threadOwnership(CODEX_OWNER_ID, nativeSessionId(session));
        if (ownership === undefined) return undefined;
        const { sessionId, threadId, handedOffTo, handoffFrom } = ownership;
        return { sessionId: dshSessionId(sessionId), ...(threadId === undefined ? {} : { threadId }),
          ...(handedOffTo === undefined ? {} : { handedOffTo: dshSessionId(handedOffTo) }),
          ...(handoffFrom === undefined ? {} : { handoffFrom: dshSessionId(handoffFrom) }) };
      },
    });
    unfilter = installCodexContextFilter(ctx);
    // Withdrawing the route from main Sessions must release the selections that
    // still point at it, or the Host blocks input with "Select model".
    retireIfWithdrawn();
  }, "dsh-codex-app-provider: execution lifecycle");
}

/**
 * The optional Host capabilities one retirement pass reads.
 *
 * `agentDefaultModel` and `sessionProjections` are separate plugins in some
 * compositions, so both are read structurally through `ctx.get` and skipped
 * when absent instead of blocking this plugin's startup.
 * @param ctx - the Host context carrying the optional services.
 * @returns the retirement inputs, with every absent seam left undefined.
 */
function retirementDeps(ctx: Context): MainSessionRetirementDeps {
  const defaultModel = ctx.get("agentDefaultModel") as Partial<DefaultModelFace> | undefined;
  const projections = ctx.get("sessionProjections") as Partial<ProjectionsFace> | undefined;
  return {
    llm: ctx.llm,
    sessions: ctx.sessions,
    agents: ctx.agents,
    defaultModel: typeof defaultModel?.currentSelection === "function" && typeof defaultModel.saveSelection === "function"
      ? defaultModel as DefaultModelFace
      : undefined,
    projections: typeof projections?.stateOf === "function" ? projections as ProjectionsFace : undefined,
    log: message => ctx.logger.warn("dsh-codex-app-provider: %s", message),
  };
}

/** A message from any thrown value. */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

/**
 * The registered DSH Session's workspace, when it is still readable.
 *
 * A handover must refuse a source workspace that moved after the provider
 * recorded it; an unregistered Session has nothing to compare and the backend
 * still verifies the native thread cwd.
 * @param ctx - the plugin context carrying the Session registry.
 * @param sessionId - the DSH Session identity to read.
 * @returns the Session workspace, or undefined when it is not registered.
 */
function liveSessionCwd(ctx: Context, sessionId: string): string | undefined {
  try {
    const cwd = ctx.sessions.get(SessionId(sessionId))?.header?.cwd;
    return typeof cwd === "string" ? cwd : undefined;
  } catch {
    return undefined;
  }
}
