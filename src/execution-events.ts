import type { BackendEvent, ExecutionFactLine, SequencedBackendEvent } from "./browser-types.js";

/** Informational Codex item facts; omission never changes DSH execution or model history. */
export interface CodexExecutionEvent {
  threadId: string;
  turnId: string;
  itemId: string;
  backendSequence: number;
  method: string;
  params: Record<string, unknown>;
}

/** Long native output is shortened in the fact block; the durable item stays addressable. */
const FACT_OUTPUT_LIMIT = 600;

const itemKinds = new Set(["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "functionCallOutput", "webSearch", "contextCompaction", "plan"]);
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Terminal turn states whose pending items did not report a final item status. */
const TERMINAL_TURN_STATES = new Set(["completed", "failed", "interrupted"]);

/**
 * Reduce one Session's recorded backend events into Codex item facts.
 *
 * Execution facts live only in the provider's own store: stock DSH core neither
 * persists nor reads an unknown `codex/execution` session event, so nothing is
 * appended to the session log. Replaying the recorded backend events with the
 * same item filtering keeps the transcript projection durable without touching
 * that log, and a terminal turn or an uncertain session still reports each
 * unfinished item exactly once.
 * @param events - recorded backend events with their durable sequence, oldest first.
 * @returns the reduced item facts, oldest first.
 */
export function reduceExecutionEvents(events: readonly SequencedBackendEvent[]): readonly CodexExecutionEvent[] {
  const accepted: CodexExecutionEvent[] = [];
  const seen = new Set<string>();
  const pending = new Map<string, CodexExecutionEvent>();
  const pendingKey = (data: { threadId: string; turnId: string; itemId: string }): string =>
    `${data.threadId}:${data.turnId}:${data.itemId}`;
  const emit = (data: CodexExecutionEvent): void => {
    const identity = `${data.backendSequence}:${data.itemId}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    const status = data.method === "item/status" ? data.params.status : object(data.params.item).status;
    if (data.method === "item/completed" || status === "completed" || status === "failed" || status === "interrupted" || status === "declined") {
      pending.delete(pendingKey(data));
    } else {
      pending.set(pendingKey(data), data);
    }
    accepted.push(data);
  };
  // A terminal turn certifies only its own items; a lost session cannot tell which
  // turn an item belonged to, so every unfinished item ends as unknown. `emit`
  // owns the pending bookkeeping, so an already-recorded sequence leaves the item
  // pending and a later terminal turn can still resolve it.
  const flush = (status: string, sequence: number, turn?: { threadId: string; turnId: string }): void => {
    for (const item of [...pending.values()]) {
      if (turn !== undefined && (item.threadId !== turn.threadId || item.turnId !== turn.turnId)) continue;
      emit({ threadId: item.threadId, turnId: item.turnId, itemId: item.itemId, backendSequence: sequence,
        method: "item/status", params: { threadId: item.threadId, turnId: item.turnId, itemId: item.itemId, status } });
    }
  };
  for (const { event, sequence } of events) {
    if (event.type === "session.uncertain") {
      flush("unknown", sequence);
      continue;
    }
    if (event.type === "turn.state" && TERMINAL_TURN_STATES.has(event.turn.state)) {
      const threadId = String(event.turn.threadId), turnId = String(event.turn.turnId);
      flush(event.turn.state === "completed" ? "unknown" : event.turn.state, sequence, { threadId, turnId });
      continue;
    }
    if (event.type !== "thread.notification") continue;
    let params = object(event.params);
    if (typeof params.threadId !== "string" || typeof params.turnId !== "string") continue;
    const { threadId, turnId } = params as { threadId: string; turnId: string };
    const item = object(params.item);
    if (event.method === "item/started" || event.method === "item/completed") {
      if (item.type === "reasoning") {
        // Only the protocol's public summary crosses into the native transcript.
        if (!Array.isArray(item.summary)) continue;
        params = { threadId, turnId, item: { id: item.id, type: "reasoning", summary: item.summary.filter(value => typeof value === "string") } };
      } else if (!itemKinds.has(String(item.type))) continue;
    } else if (event.method === "item/reasoning/summaryTextDelta") {
      if (typeof params.delta !== "string" || !Number.isSafeInteger(params.summaryIndex) || Number(params.summaryIndex) < 0) continue;
      params = { threadId, turnId, itemId: params.itemId, delta: params.delta, summaryIndex: params.summaryIndex };
    } else if (event.method !== "item/commandExecution/outputDelta") continue;
    const itemId = item.id ?? params.itemId;
    if (typeof itemId !== "string" || !itemId) continue;
    emit({ threadId, turnId, itemId, backendSequence: sequence, method: event.method, params });
  }
  return accepted;
}

/** One rendered fact line plus the durable identity a reader can resolve it by. */
export type CodexExecutionFactLine = ExecutionFactLine;

/**
 * Whether one recorded backend event can contribute to an execution fact.
 *
 * The projection reads item lifecycle, the public reasoning summary, command
 * output, and the two events that resolve items a turn left unfinished. Model
 * text and status notices are not part of it, which is why they are published
 * but never retained.
 * @param event - one recorded backend event.
 * @returns whether the projection reads it.
 */
export function feedsExecutionFacts(event: BackendEvent): boolean {
  if (event.type === "session.uncertain" || event.type === "turn.state") return true;
  if (event.type !== "thread.notification") return false;
  return event.method === "item/started"
    || event.method === "item/completed"
    || event.method === "item/reasoning/summaryTextDelta"
    || event.method === "item/commandExecution/outputDelta";
}

/** Render one string value, shortening long output and naming where the rest lives. */
function bounded(value: unknown, reference: string): string {
  const text = typeof value === "string" ? value : value === undefined || value === null ? "" : JSON.stringify(value);
  const collapsed = text.split("\n").map(line => line.trimEnd()).filter(line => line !== "").join("\n");
  if (collapsed.length <= FACT_OUTPUT_LIMIT) return collapsed;
  return `${collapsed.slice(0, FACT_OUTPUT_LIMIT)}\n… [truncated; full output at ${reference}]`;
}

/** One `fileChange` item's changed paths. */
function changedPaths(item: Record<string, unknown>): string[] {
  if (!Array.isArray(item.changes)) return [];
  return item.changes.flatMap(change => {
    const entry = object(change);
    if (typeof entry.path !== "string" || !entry.path) return [];
    const kind = typeof entry.kind === "string" ? entry.kind : object(entry.kind).type;
    return [`${entry.path}${typeof kind === "string" && kind ? ` (${kind})` : ""}`];
  });
}

/**
 * Render one item's completed state as sourced fact lines.
 *
 * Only executed facts cross: commands with their exit status, changed paths,
 * tool calls and their results, searches, and native compaction markers.
 * Model-authored reasoning and plan text stay out, and nothing here is an
 * instruction the worker may re-execute.
 */
function factLines(item: Record<string, unknown>, reference: string): string[] {
  const type = String(item.type);
  if (type === "commandExecution") {
    const command = typeof item.command === "string" ? item.command : "";
    const status = [`exit ${String(item.exitCode ?? "?")}`, ...(item.cwd === undefined ? [] : [`cwd ${String(item.cwd)}`])].join(", ");
    const output = bounded(item.aggregatedOutput, reference);
    return [`command: ${command} (${status})`, ...(output === "" ? [] : [output])];
  }
  if (type === "fileChange") {
    const paths = changedPaths(item);
    return paths.length === 0 ? [] : [`file change: ${paths.join(", ")}`];
  }
  if (type === "mcpToolCall" || type === "dynamicToolCall") {
    const name = [item.server ?? item.namespace, item.tool].filter(value => typeof value === "string" && value).join("/");
    const outcome = item.error !== undefined && item.error !== null
      ? `error: ${bounded(item.error, reference)}`
      : bounded(item.result ?? item.contentItems, reference);
    return [`tool ${name === "" ? "call" : name}: ${outcome}`];
  }
  if (type === "functionCallOutput") {
    return [`tool output ${typeof item.name === "string" ? item.name : ""}: ${bounded(item.output, reference)}`.trimEnd()];
  }
  if (type === "webSearch") return [`web search: ${bounded(item.query, reference)}`];
  if (type === "contextCompaction") return ["context compacted by the native adapter"];
  return [];
}

/**
 * Project the recorded native transcript into sourced history lines for a
 * continuation under another adapter.
 *
 * The projection keeps each item's last completed state, in transcript order,
 * and skips items that never completed rather than presenting partial output
 * as a fact.
 * @param events - recorded `codex/execution` payloads, oldest first.
 * @returns one entry per fact line, each carrying its durable item identity.
 */
export function projectExecutionFacts(events: readonly CodexExecutionEvent[]): readonly CodexExecutionFactLine[] {
  const completed = new Map<string, CodexExecutionEvent>();
  let current: CodexExecutionEvent | undefined;
  for (const data of events) {
    const key = `${data.threadId}:${data.turnId}:${data.itemId}`;
    if (data.method === "item/completed") {
      current = data;
      completed.set(key, data);
      continue;
    }
    if (data.method === "item/status") {
      // A terminal status without a completed item still describes what ran.
      const status = String(data.params.status ?? "");
      if (status === "interrupted" || status === "failed" || status === "declined") completed.set(key, data);
    }
  }
  if (current === undefined && completed.size === 0) return [];
  const lines: CodexExecutionFactLine[] = [];
  for (const data of completed.values()) {
    const reference = `codex thread=${data.threadId} turn=${data.turnId} item=${data.itemId} (nativeSessionId, threadId, turnId, itemId)`;
    const item = data.method === "item/completed" ? object(data.params.item) : { type: "unknown" };
    // A synthetic terminal status records only the item identity and outcome;
    // the native item's type is not part of the pending-item bookkeeping.
    const rendered = data.method === "item/status"
      ? [`item ${data.itemId} ended as ${String(data.params.status)}`]
      : factLines(item, reference);
    for (const text of rendered) {
      lines.push({ text: `[source: codex thread=${data.threadId} turn=${data.turnId} item=${data.itemId}] ${text}`, threadId: data.threadId, turnId: data.turnId, itemId: data.itemId });
    }
  }
  return lines;
}
