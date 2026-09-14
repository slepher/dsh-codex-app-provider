import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { Message } from "@deepseek-ai/dsh-llm";

import { isExecutionFactId } from "./facts.js";

const INJECTED_FORMS = new Set(["instructions", "catalog", "snapshot"]);
const DSH_SYSTEM_PROMPT = "@deepseek-ai/dsh-system-prompt";
const COMPACT_CHECKPOINT = "compact";

interface SourceFace {
  id?: unknown;
  kind?: unknown;
  plugin?: unknown;
  form?: unknown;
}

/**
 * True for DSH-injected context the Codex provider must not receive: Codex owns
 * its own system prompt, AGENTS.md instructions, skill catalog and runtime
 * context. The DSH compaction checkpoint is real history and stays.
 */
export function isInjectedContext(message: Message): boolean {
  if (message.role === "system") return true;
  const source = message.source as SourceFace;
  // A user-invoked DSH skill is explicit input, not background context.
  if (source.kind === "skill-invocation") return false;
  if (source.kind === "plugin" && source.plugin === COMPACT_CHECKPOINT) return false;
  // Executed Codex facts are already in the native thread; re-sending them would
  // duplicate work the thread performed and re-present it as an instruction.
  // Worker-report notices from the same plugin are real model input and stay.
  if (isExecutionFactId(source.id)) return true;
  if (source.kind === "plugin" && source.plugin === DSH_SYSTEM_PROMPT) return true;
  if (source.kind === "plugin" && source.plugin === "agent-instructions") return true;
  if (source.kind === "agent-instructions" || source.kind === "skill-catalog") return true;
  return typeof source.form === "string" && INJECTED_FORMS.has(source.form);
}

export function isCodexVisible(message: Message): boolean {
  return !isInjectedContext(message);
}

interface ModelSelectionState {
  lastUsed?: { provider?: unknown } | null;
  pending?: { provider?: unknown } | null;
}

/**
 * The provider selected for the upcoming request: the durable model-selection
 * projection wins, then the agent's configured route. Unknown means "not
 * Codex" so a missing projection never hides another provider's context.
 */
export function selectedProvider(ctx: Context, agent: Agent): string | undefined {
  const projections = (ctx as unknown as { get?: (name: string) => unknown }).get?.("sessionProjections") as
    | { stateOf?: (session: unknown, key: string) => unknown }
    | undefined;
  const state = projections?.stateOf?.(agent.session, "modelSelection") as ModelSelectionState | undefined;
  const selection = state?.pending ?? state?.lastUsed;
  if (selection !== null && selection !== undefined && typeof selection.provider === "string") return selection.provider;
  return agent.options.provider;
}

/**
 * Drop DSH-injected context from the messages entering a Codex step. The
 * `agent/pre-step` waterfall is the supported logical-upstream seam: messages
 * removed here are neither committed to the Session surface (so the transcript
 * shows no misleading context-injection rows) nor sent to Codex. Worker report
 * notices, recalls, relays and compaction checkpoints are preserved.
 */
export function installCodexContextFilter(ctx: Context): () => void {
  return ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
    const decision = await next();
    if (decision.kind !== "enter" || signal.aborted) return decision;
    if (selectedProvider(ctx, agent) !== "codex") return decision;
    const messages = decision.messages.filter(isCodexVisible);
    return messages.length === decision.messages.length ? decision : { ...decision, messages };
  });
}
