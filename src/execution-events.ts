import type { BackendEvent } from "./browser-types.js";
import type { ProviderSessionFace } from "./provider.js";

/** Informational Codex item facts; omission never changes DSH execution or model history. */
export interface CodexExecutionEvent {
  threadId: string;
  turnId: string;
  itemId: string;
  backendSequence: number;
  method: string;
  params: Record<string, unknown>;
}

declare module "@deepseek-ai/dsh-session/types" {
  interface SessionEventMap {
    /** Codex-owned execution facts, never an instruction for the DSH tool dispatcher. */
    "codex/execution": CodexExecutionEvent;
  }
}

const itemKinds = new Set(["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "functionCallOutput", "webSearch", "contextCompaction", "plan"]);
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Bind exactly one native Session and Codex turn; durable sequence prevents replay duplication. */
export function createExecutionEventWriter(session: ProviderSessionFace | undefined, threadId: string, turnId: string) {
  const seen = new Set<string>();
  const pending = new Set<string>();
  const track = (data: CodexExecutionEvent) => {
    seen.add(`${data.backendSequence}:${data.itemId}`);
    const status = data.method === "item/status" ? data.params.status : object(data.params.item).status;
    if (data.method === "item/completed" || status === "completed" || status === "failed" || status === "interrupted" || status === "declined") pending.delete(data.itemId);
    else pending.add(data.itemId);
  };
  for (const event of session?.snapshotEvents?.() ?? []) {
    if (event.type === "codex/execution" && event.data.threadId === threadId && event.data.turnId === turnId) track(event.data);
  }
  const append = (data: CodexExecutionEvent) => {
    if (seen.has(`${data.backendSequence}:${data.itemId}`)) return;
    session!.append!("codex/execution", data, { ignorable: true });
    track(data);
  };
  return (event: BackendEvent, sequence?: number): void => {
    if (session?.append === undefined || sequence === undefined) return;
    if (event.type === "session.uncertain" || event.type === "turn.state" && event.turn.threadId === threadId && event.turn.turnId === turnId
      && ["completed", "failed", "interrupted"].includes(event.turn.state)) {
      const status = event.type === "session.uncertain" || event.turn.state === "completed" ? "unknown" : event.turn.state;
      for (const itemId of [...pending]) append({ threadId, turnId, itemId, backendSequence: sequence,
        method: "item/status", params: { threadId, turnId, itemId, status } });
      return;
    }
    if (event.type !== "thread.notification") return;
    let params = object(event.params);
    if (params.threadId !== threadId || params.turnId !== turnId) return;
    const item = object(params.item);
    if (event.method === "item/started" || event.method === "item/completed") {
      if (item.type === "reasoning") {
        // Only the protocol's public summary crosses into the native transcript.
        if (!Array.isArray(item.summary)) return;
        params = { threadId, turnId, item: { id: item.id, type: "reasoning", summary: item.summary.filter(value => typeof value === "string") } };
      } else if (!itemKinds.has(String(item.type))) return;
    } else if (event.method === "item/reasoning/summaryTextDelta") {
      if (typeof params.delta !== "string" || !Number.isSafeInteger(params.summaryIndex) || Number(params.summaryIndex) < 0) return;
      params = { threadId, turnId, itemId: params.itemId, delta: params.delta, summaryIndex: params.summaryIndex };
    } else if (event.method !== "item/commandExecution/outputDelta") return;
    const itemId = item.id ?? params.itemId;
    if (typeof itemId !== "string" || !itemId) return;
    append({ threadId, turnId, itemId, backendSequence: sequence, method: event.method, params });
  };
}
