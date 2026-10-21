import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { Message } from "@deepseek-ai/dsh-llm";

import { CODEX_APP_PROVIDER } from "./browser-types.js";
import { isBridgeCallId, isExecutionFactId } from "./facts.js";

const INJECTED_FORMS = new Set(["instructions", "catalog", "snapshot"]);
/** Producer-owned kinds carrying DSH context that Codex must not receive. */
const INJECTED_KINDS = new Set(["runtime-context", "agent-instructions", "skill-catalog"]);
/** Producer-owned kinds carrying durable history that replaced the range it shadows. */
const HISTORY_KINDS = new Set(["compact-checkpoint", "compact-basic"]);

interface SourceFace {
  kind: string;
  form?: unknown;
}

/**
 * True for DSH-injected context the Codex provider must not receive: Codex owns
 * its own system prompt, AGENTS.md instructions, skill catalog and runtime
 * context. The DSH compaction checkpoint is real history and stays.
 *
 * The kinds are the producer-owned ones DSH admits since the released
 * `{ kind: 'plugin', plugin }` wrapper was retired: the V3-to-V4 migration maps
 * `@deepseek-ai/dsh-system-prompt` to `system-prompt` on a system message and
 * to `runtime-context` otherwise, and `compact` to `compact-checkpoint`.
 */
export function isInjectedContext(message: Message): boolean {
  if (message.role === "system") return true;
  // DSH tool declarations reach a route as developer messages. Codex owns its
  // own tools, so those changes are context rather than input, and no block in
  // them is conversation content.
  if (message.role === "developer") return true;
  const source = message.source as SourceFace;
  // A user-invoked DSH skill is explicit input, not background context.
  if (source.kind === "skill-invocation") return false;
  if (HISTORY_KINDS.has(source.kind)) return false;
  // Executed Codex facts are already in the native thread; re-sending them would
  // duplicate work the thread performed and re-present it as an instruction.
  // The identity is on the message, not its source, so reading it from the
  // source would silently keep every imported fact in the request.
  if (isExecutionFactId(message.id)) return true;
  // A bridged tool call was executed inside the native thread already; replaying
  // the DSH record would present it to Codex as a fresh user instruction.
  if (isBridgeCallId(message.id)) return true;
  if (INJECTED_KINDS.has(source.kind)) return true;
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
  const projections = ctx.get("sessionProjections") as
    | { stateOf?: (session: unknown, key: string) => unknown }
    | undefined;
  const state = projections?.stateOf?.(agent.session, "modelSelection") as ModelSelectionState | undefined;
  const selection = state?.pending ?? state?.lastUsed;
  if (selection !== null && selection !== undefined && typeof selection.provider === "string") return selection.provider;
  return agent.options.provider;
}

/**
 * Drop DSH-injected context from the messages entering a Codex step. The
 * Request admission can refresh and log dynamic DSH context after this hook.
 * The provider also filters its outgoing history before sending to Codex.
 * Recalls, relays and compaction checkpoints are preserved.
 */
export function installCodexContextFilter(ctx: Context): () => void {
  return ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
    const decision = await next();
    if (decision.kind !== "enter" || signal.aborted) return decision;
    if (selectedProvider(ctx, agent) !== CODEX_APP_PROVIDER) return decision;
    const messages = decision.messages.filter(isCodexVisible);
    return messages.length === decision.messages.length ? decision : { ...decision, messages };
  });
}
