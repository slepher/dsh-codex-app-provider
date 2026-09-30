import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { CodexSessionBackend } from "./backend.js";
import { AppServer } from "./rpc.js";
import { installCodexContextFilter } from "./context.js";
import { dshSessionId, nativeSessionId } from "./handoff.js";
import { CODEX_OWNER_ID, CODEX_PROVIDER, CodexProviderAdapter, backendSessionId, type ProviderApprovalSeam, type ProviderAttachmentSeam, type ProviderQuestionSeam } from "./provider.js";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { SessionId } from "@deepseek-ai/dsh-session";
import { agentCaller, assertAgentIdentity, captureAgentIdentity } from "./identity.js";
import { executeWorkerAction, type WorkerAction } from "./worker-actions.js";
import { installWorkerControl, type WorkerControl } from "./worker-control.js";
import { installWorkerDelivery, type WorkerDelivery } from "./worker-delivery.js";
import { CodexGateBridge } from "./tool-gate.js";
import { fileURLToPath } from "node:url";
export type { NativeExecution, NativeExecutionReader, NativeExecutionReport } from "./execution.js";
export type {
  CodexThreadHandoffRequest, CodexThreadHandoffResult, CodexThreadHandoffService, CodexThreadOwnership,
} from "./handoff.js";
export { WORKFLOW_PRE_TOOL_USE, CodexGateBridge } from "./tool-gate.js";
export type { CodexToolGate, GateBinding, GateDecision, GateEvent, GateHandler, HookRunEvidence } from "./tool-gate.js";

export interface Config {
  /**
   * Where the plugin persists its own records and worker bindings. Omitted
   * means `defaultStateDir`: the launched profile's state directory, never the
   * directory the process happened to start in.
   */
  stateDir?: string;
  command?: string;
  requestTimeoutMs?: number;
  /**
   * Model-settings working directory, and the working directory a Codex thread
   * falls back to when its Session records none. Omitted means the project
   * directory the Harness was launched in.
   */
  providerCwd?: string;
}

export const Config: z<Config> = z.object({
  stateDir: z.string().required(false),
  command: z.string().default("codex"),
  requestTimeoutMs: z.number().min(1).max(2_147_483_647).default(30_000),
  providerCwd: z.string().required(false),
});

export const inject = ["agents", "sessions", "llm"];

/**
 * Launcher-provided profile facts.
 * @param ctx - the Host context.
 * @returns the launched profile's name, home, and launch directory, or
 * `undefined` when the process was booted without a profile.
 */
function launchedProfile(ctx: Context): { name?: string; home?: string; cwd?: string } | undefined {
  return ctx.get("profileContext") as { name?: string; home?: string; cwd?: string } | undefined;
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
  return join(home, "state", profile?.name ?? "default", "codex");
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

/** Install one Codex execution owner and its native DSH route. */
export function apply(ctx: Context, config: Config = {}): void {
  ctx.effect(function* () {
    const backend = new CodexSessionBackend(
      resolve(config.stateDir ?? defaultStateDir(ctx)),
      // The transport factory carries a gated runtime's gate environment and
      // leaves an ungated one with exactly the environment it had before.
      options => new AppServer({ command: config.command, timeoutMs: config.requestTimeoutMs,
        ...(options?.env === undefined ? {} : { env: options.env }) }),
    );
    let provider: CodexProviderAdapter | undefined;
    let unregister: (() => void) | undefined;
    let unfilter: (() => void) | undefined;
    let untool: (() => void) | undefined;
    let delivery: WorkerDelivery | undefined;
    let control: WorkerControl | undefined;
    // The workflow gate is a Host capability, not a model-facing tool: the
    // workflow plugin registers the one business handler and binds each child it
    // starts, and the provider only carries the binding to its execution points.
    const toolGate = new CodexGateBridge();
    // The startup preflight matches the installed hook command, so this is the
    // one entry the provider will accept as its own PreToolUse hook.
    toolGate.useClient(fileURLToPath(new URL("./pretool-client.js", import.meta.url)));
    backend.attachGate(toolGate);
    // The Host owns a Session's lifecycle and reports disposal as a fact. The
    // Codex record that backed the Session is this plugin's to release, so the
    // two are joined here rather than by asking the core for a teardown
    // primitive it has no authority to execute.
    // Returning the close lets a host that awaits this seam wait for the process
    // to exit; the backend also awaits it during teardown.
    const onDisposed = ctx.on("session/disposed", session => backend.releaseDisposed(backendSessionId(String(session.id))));
    yield async () => {
      onDisposed();
      provider?.close();
      unregister?.();
      unfilter?.();
      untool?.();
      delivery?.close();
      control?.close();
      await backend.close();
      await toolGate.close();
    };
    provider = new CodexProviderAdapter({
      backend,
      sessions: ctx.sessions,
      agents: ctx.agents,
      // The user-facing halves of a native request are DSH's to ask. Codex keeps
      // its own permission judgment; the plugin only carries the question.
      approval: ctx.get("approval") as ProviderApprovalSeam | undefined,
      questions: ctx.get("userQuestions") as ProviderQuestionSeam | undefined,
      attachments: ctx.get("attachments") as ProviderAttachmentSeam | undefined,
      logger: ctx.logger,
      providerCwd: resolve(config.providerCwd ?? defaultProviderCwd(ctx)),
    });
    unregister = ctx.llm.registerAdapter([CODEX_PROVIDER], provider);
    ctx.provide("codexToolGate", toolGate);
    ctx.provide("codexExecution", {
      read: nativeSessionId => provider!.readExecution(nativeSessionId),
      facts: nativeSessionId => provider!.facts(nativeSessionId),
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
    // Ordinary delegation is a tool surface, so it is registered only where a
    // tool registry exists; the provider itself stays usable without one.
    ctx.inject(["tools", "systemPrompt"], tools => {
      const callerIdentity = (agent: Agent | undefined) => captureAgentIdentity(ctx, agent);
      // An ordinary worker's turn is started here, not by an adapter stream, so
      // the bridge that carries its native approvals and questions to the user
      // is installed around every action.
      control = installWorkerControl(ctx, {
        listWorkers: caller => backend.listWorkers(caller),
        watchWorkerRequests: (caller, workerId, agent) => provider!.watchWorkerRequests(caller, workerId, agent),
      });
      untool = tools.tools.register(defineTool({
        name: "codex_workers",
        description: "Create, query, and control persistent Codex workers owned by this parent Session. Give a worker its instructions as the prompt. This tool has no role concept: a role-bound child (a reviewer, an evidence runner, a tester) is dispatched by the workflow tool, which owns the role catalogue. Reports are durable; acknowledgement and acceptance are separate. The workers here are the ones this tool created: a child started by the workflow tool is a separate DSH subagent and cannot be reached through these actions.",
        parameters: {
          action: { type: "string", required: true, enum: [...WORKER_ACTIONS], description: "The operation to perform. `list` and `reports` read this Session's own workers and take no other field." },
          workerId: { type: "string", description: "The worker this action targets. Required by every action except `create` (which may name the id to create), `list` and `reports`. The provider tracks only the workers this tool created: a child started by the workflow tool is not one of them and cannot be read here." },
          name: { type: "string", description: "`create` only: display name for the new worker." },
          cwd: { type: "string", description: "`create` only: absolute working directory. Defaults to the parent Session's workspace." },
          model: { type: "string", description: "`create` only: model id for the new worker." },
          effort: { type: "string", description: "`create` only: reasoning effort for the new worker." },
          text: { type: "string", description: "`append` and `steer`: the turn's prompt or the guidance to inject into the running turn." },
          turnId: { type: "string", description: "`steer`, `interrupt`, `ack` and `accept`: the exact turn to act on." },
          acceptance: { type: "string", enum: ["pending", "accepted", "changes-requested"], description: "`accept` only: the verdict recorded for the report." },
        },
        output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
        async execute(args, execution) {
          const identity = callerIdentity(execution.agent);
          // Before the action, so an existing worker's new turn is watched from
          // its first event; after it, so a worker the action just created is
          // covered before any later turn starts.
          await control!.ensure(identity);
          const value = await executeWorkerAction(backend, agentCaller(identity), String(identity.session.header.cwd),
            args as WorkerAction, () => assertAgentIdentity(ctx, identity));
          await control!.ensure(identity);
          return JSON.stringify(value);
        },
        presentCall: args => ({
          card: "generic",
          title: `Codex workers: ${String((args as { action?: unknown }).action ?? "")}`,
          kind: WORKER_READ_ACTIONS.has(String((args as { action?: unknown }).action)) ? "read" : "execute",
        }),
      }));
      delivery = installWorkerDelivery(ctx, backend);
      tools.systemPrompt.section({
        name: "tool:codex-workers",
        order: tools.systemPrompt.getSectionOrder("TOOL_JOBS"),
        text: "codex_workers manages persistent Codex workers and starts them as plain workers: state the job in the prompt you send. Role names are not this tool's vocabulary; the workflow tool owns them. Process reports independently; acknowledge or accept after handling. Do not poll, repeat unknown work, or treat interrupt acceptance as completion.",
      });
    });
  }, "dsh-codex-app-provider: execution lifecycle");
}

/** Actions that only read worker state; everything else mutates it. */
const WORKER_READ_ACTIONS = new Set(["list", "get", "reports"]);

/** Every `codex_workers` action, in the order the tool documents them. */
const WORKER_ACTIONS = ["create", "list", "get", "reports", "append", "steer", "interrupt", "resume", "accept", "ack", "close"] as const;

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
