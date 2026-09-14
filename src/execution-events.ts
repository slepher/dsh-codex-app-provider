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

/** Long native output is shortened in the fact block; the durable item stays addressable. */
const FACT_OUTPUT_LIMIT = 600;

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

/** One rendered fact line plus the durable identity a reader can resolve it by. */
export interface CodexExecutionFactLine {
  /** Sourced line, already marked as an executed fact rather than an instruction. */
  text: string;
  threadId: string;
  turnId: string;
  itemId: string;
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
