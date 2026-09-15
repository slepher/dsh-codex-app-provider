import type {} from "@deepseek-ai/dsh-settings";
import { SETTINGS_NAMESPACE, SettingsSchema } from "./settings.js";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { resolve } from "node:path";
import { CodexSessionBackend } from "./backend.js";
import { AppServer } from "./rpc.js";
import { installCodexContextFilter } from "./context.js";
import { dshSessionId, nativeSessionId } from "./handoff.js";
import { CODEX_OWNER_ID, CODEX_PROVIDER, CodexProviderAdapter, type ProviderAttachmentSeam, type ProviderQuestionSeam } from "./provider.js";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { agentCaller, assertAgentIdentity, captureAgentIdentity } from "./identity.js";
import { executeWorkerAction, type WorkerAction } from "./worker-actions.js";
import { installWorkerDelivery, type WorkerDelivery } from "./worker-delivery.js";
import { installApprovalRpc, type ApprovalChannelState } from "./approval-rpc.js";
export type { NativeExecution, NativeExecutionReader, NativeExecutionReport } from "./execution.js";
export type {
  CodexThreadHandoffRequest, CodexThreadHandoffResult, CodexThreadHandoffService, CodexThreadOwnership,
} from "./handoff.js";

export interface Config {
  stateDir?: string;
  command?: string;
  requestTimeoutMs?: number;
  providerCwd?: string;
}

export const Config: z<Config> = z.object({
  stateDir: z.string().default(resolve(".dsh-state")),
  command: z.string().default("codex"),
  requestTimeoutMs: z.number().min(1).max(2_147_483_647).default(30_000),
  providerCwd: z.string().default(process.cwd()),
});

export const inject = ["agents", "sessions", "llm"];

/** Install one Codex execution owner and its native DSH route. */
export function apply(ctx: Context, config: Config = {}): void {
  ctx.inject(["settings"], settingsCtx => {
    settingsCtx.settings.register(SETTINGS_NAMESPACE, SettingsSchema, { applies: "live" });
  });
  ctx.effect(function* () {
    const backend = new CodexSessionBackend(
      resolve(config.stateDir ?? ".dsh-state"),
      () => new AppServer({ command: config.command, timeoutMs: config.requestTimeoutMs }),
    );
    let provider: CodexProviderAdapter | undefined;
    let unregister: (() => void) | undefined;
    let unfilter: (() => void) | undefined;
    let untool: (() => void) | undefined;
    let delivery: WorkerDelivery | undefined;
    yield async () => {
      provider?.close();
      unregister?.();
      unfilter?.();
      untool?.();
      delivery?.close();
      await backend.close();
    };
    const approvals: ApprovalChannelState = { interactive: false };
    provider = new CodexProviderAdapter({
      backend,
      sessions: ctx.sessions,
      agents: ctx.agents,
      approvals,
      questions: ctx.get("userQuestions") as ProviderQuestionSeam | undefined,
      attachments: ctx.get("attachments") as ProviderAttachmentSeam | undefined,
      logger: ctx.logger,
      providerCwd: resolve(config.providerCwd ?? process.cwd()),
    });
    unregister = ctx.llm.registerAdapter([CODEX_PROVIDER], provider);
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
    // Codex approvals are answered on the plugin's own authenticated channel,
    // never by DSH's approval policy.
    ctx.inject(["connection", "webServer"], scope => installApprovalRpc(scope, backend, approvals));
    // Ordinary delegation is a tool surface, so it is registered only where a
    // tool registry exists; the provider itself stays usable without one.
    ctx.inject(["tools", "systemPrompt"], tools => {
      const callerIdentity = (agent: Agent | undefined) => captureAgentIdentity(ctx, agent);
      untool = tools.tools.register(defineTool({
        name: "codex_workers",
        description: "Create, query, and control persistent Codex workers owned by this parent Session. Give a worker its instructions as the prompt. This tool has no role concept: a role-bound child (a reviewer, an evidence runner, a tester) is dispatched by the workflow tool, which owns the role catalogue. Reports are durable; acknowledgement and acceptance are separate.",
        parameters: {
          action: { type: "string", required: true, enum: [...WORKER_ACTIONS] },
          workerId: { type: "string" },
          name: { type: "string" },
          cwd: { type: "string" },
          model: { type: "string" },
          effort: { type: "string" },
          text: { type: "string" },
          turnId: { type: "string" },
          acceptance: { type: "string", enum: ["pending", "accepted", "changes-requested"] },
        },
        output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
        async execute(args, execution) {
          const identity = callerIdentity(execution.agent);
          const value = await executeWorkerAction(backend, agentCaller(identity), String(identity.session.header.cwd),
            args as WorkerAction, () => assertAgentIdentity(ctx, identity));
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
    const face = (ctx.sessions as unknown as {
      get(id: string): { header?: { cwd?: string } } | undefined;
    }).get(sessionId);
    const cwd = face?.header?.cwd;
    return typeof cwd === "string" ? cwd : undefined;
  } catch {
    return undefined;
  }
}
