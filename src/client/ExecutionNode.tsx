import type { PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type { TurnEndReason } from "@deepseek-ai/dsh-session/types";
import type { ConversationNodeDefinition } from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-ui-chat/client";
import type {} from "../execution-events.js";
import type { ConversationItem } from "../browser-types.js";
import { createConversationProjector } from "../conversation.js";

declare module "@deepseek-ai/dsh-client-ui-chat/client" {
  interface ChatNodeDataMap { "codex-execution": ConversationItem }
}

interface ExecutionTurnEnd { turn: number; reason?: TurnEndReason }
declare module "@deepseek-ai/dsh-client-ui-conversation/client" {
  interface ConversationTurnDataMap { "codex-turn-end": ExecutionTurnEnd }
}

/** Native Stop closes the DSH turn; it does not certify that a Codex item stopped. */
export const executionEndDefinition: ConversationNodeDefinition<ExecutionTurnEnd> = {
  kind: "codex-turn-end",
  match: event => event.type === "turn/start" || event.type === "turn/end"
    ? { id: String(event.data.turn), role: event.type === "turn/start" ? "start" : "update" } : null,
  start: (_context, match) => {
    if (match.event.type !== "turn/start") throw new Error("Execution turn state requires turn/start");
    return { turn: match.event.data.turn };
  },
  update: (context, match) => match.event.type === "turn/end" ? { turn: match.event.data.turn, reason: match.event.data.reason } : context.state,
  buildLocationData: (context, scope) => scope !== "turn" || context.state?.reason === undefined ? null
    : { kind: "turn", turn: context.state.turn, key: "codex-turn-end", value: context.state },
};

/** Fold one external execution item with the migrated Codex projector. */
export const executionDefinition: ConversationNodeDefinition<{ item?: ConversationItem }> = {
  kind: "codex-execution", target: "chat",
  match: event => event.type === "codex/execution" ? {
    id: JSON.stringify([event.data.threadId, event.data.turnId, event.data.itemId]),
    role: event.data.method === "item/started" ? "start" : "update",
  } : null,
  start: (_context, match) => {
    if (match.event.type !== "codex/execution") return {};
    const result = createConversationProjector()({ type: "thread.notification", method: match.event.data.method, params: match.event.data.params });
    return result?.type === "item" ? { item: result.item } : {};
  },
  update: (context, match) => {
    if (match.event.type !== "codex/execution") return context.state;
    const result = createConversationProjector(context.state?.item === undefined ? [] : [context.state.item])({ type: "thread.notification", method: match.event.data.method, params: match.event.data.params });
    return result?.type === "item" ? { item: result.item } : context.state;
  },
  publication: match => match.event.type === "codex/execution" && match.event.data.method.endsWith("Delta") ? "animation-frame" : "immediate",
  buildViewNode: context => context.state?.item === undefined || context.state.item.kind === "reasoning" && !context.state.item.text ? null : ({
    key: context.key, kind: "codex-execution", id: context.id, target: "chat", anchorSeq: context.start?.event.seq ?? 0,
    location: context.start?.location ?? { kind: "unresolved" }, visibility: "visible", data: context.state.item,
  }),
};

type Props = PropsRuntime<"conversation.chat.node", "codex-execution"> & PropsLocale<"dsh-codex-app-provider">;
export function ExecutionNode({ node, useTurnData, t }: Props) {
  const item = node.data;
  const end = useTurnData("codex-turn-end");
  const title = item.kind === "reasoning" ? t("reasoningSummary") : item.kind === "fileChange" ? t("files") : item.kind === "webSearch" ? t("search") : item.kind === "contextCompaction" ? t("compaction") : item.title ?? t("execution");
  const status = item.status === "inProgress" ? end?.reason === undefined ? "executing" : end.reason.kind === "aborted" ? "executionStopRequested" : "executionUnknown" : item.status === "unknown" ? "executionUnknown" : item.status === "interrupted" ? "executionInterrupted" : item.status === "failed" || item.status === "declined" ? "executionFailed" : "executed";
  const output = item.changes?.map(change => `${change.path}\n${change.diff}`).join("\n") ?? item.output ?? item.text;
  return <details open={status === "executing"}><summary>{title} · {t(status)}</summary>
    {item.cwd && <div>{item.cwd}</div>}
    {output && <pre>{output}</pre>}
    {item.exitCode !== undefined && <div>{t("exitCode")}: {item.exitCode}</div>}
  </details>;
}
