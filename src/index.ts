import type {} from "@deepseek-ai/dsh-settings";
import { SETTINGS_NAMESPACE, SettingsSchema } from "./settings.js";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { resolve } from "node:path";
import { CodexSessionBackend } from "./backend.js";
import { AppServer } from "./rpc.js";
import { installCodexContextFilter } from "./context.js";
import { CODEX_PROVIDER, CodexProviderAdapter, type ProviderApprovalSeam, type ProviderAttachmentSeam, type ProviderQuestionSeam } from "./provider.js";
export type { NativeExecution, NativeExecutionReader, NativeExecutionReport } from "./execution.js";

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
    unfilter = installCodexContextFilter(ctx);
  }, "dsh-codex-app-provider: execution lifecycle");
}
