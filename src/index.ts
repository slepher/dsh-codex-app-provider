import type {} from "@deepseek-ai/dsh-settings";
import { SETTINGS_NAMESPACE, SettingsSchema } from "./settings.js";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { resolve } from "node:path";
import { CodexSessionBackend } from "./backend.js";
import { AppServer } from "./rpc.js";
import { installCodexContextFilter } from "./context.js";
import { dshSessionId, nativeSessionId } from "./handoff.js";
import { CODEX_OWNER_ID, CODEX_PROVIDER, CodexProviderAdapter, type ProviderApprovalSeam, type ProviderAttachmentSeam, type ProviderQuestionSeam } from "./provider.js";
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
    yield async () => {
      provider?.close();
      unregister?.();
      unfilter?.();
      await backend.close();
    };
    provider = new CodexProviderAdapter({
      backend,
      sessions: ctx.sessions,
      agents: ctx.agents,
      approval: ctx.get("approval") as ProviderApprovalSeam | undefined,
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
  }, "dsh-codex-app-provider: execution lifecycle");
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
    const face = (ctx.sessions as unknown as {
      get(id: string): { header?: { cwd?: string } } | undefined;
    }).get(sessionId);
    const cwd = face?.header?.cwd;
    return typeof cwd === "string" ? cwd : undefined;
  } catch {
    return undefined;
  }
}
