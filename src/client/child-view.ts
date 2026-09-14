/**
 * One sidebar tab's independent view of a child Session's journal.
 *
 * The official conversation shell renders the Session the main area currently
 * binds, so a side pane showing a *non-current* child cannot reuse it. This
 * module owns the child-specific half instead: it keeps an independent event
 * stream per tab, folds the raw journal entries into display rows, and exposes
 * only the operations the pane performs. The stream is injected, so the module
 * stays free of the browser bundle's external module request and is testable
 * without a DOM.
 * @module dsh-codex-app-provider/client/child-view
 */

/** A direct child conversation address, as the official client names it. */
export interface ChildAddress {
  readonly parentSessionId: string;
  readonly childSessionId: string;
  readonly mode: "one-shot" | "continuable";
}

/** Delivery semantics of one composed prompt. */
export type ChildDelivery = "queue" | "steer";

/** A journal entry as the client event window reports it. */
export interface ChildJournalEntry {
  readonly type: "event" | "transient";
  readonly event: { readonly type: string; readonly seq?: number; readonly time?: number; readonly data?: unknown };
}

/** One journal change published by an open stream. */
export interface ChildJournalChange {
  readonly type: "replace" | "prepend" | "append" | "assistant-stream";
  readonly page?: { readonly entries?: readonly ChildJournalEntry[]; readonly hasMore?: boolean };
  readonly entries?: readonly ChildJournalEntry[];
  readonly entry?: ChildJournalEntry;
  readonly hasMore?: boolean;
}

/** The subset of one official `SessionEventStream` this pane drives. */
export interface ChildStream {
  open(request: { maxMessages: number }): Promise<void>;
  prepend(request: { beforeSeq?: number; maxMessages: number }): Promise<void>;
  restart(): void;
  dispose(): Promise<void>;
}

/** Everything the pane needs from the host client; injected so it stays testable. */
export interface ChildStreamFactory {
  create(address: ChildAddress, options: {
    publish(change: ChildJournalChange): void;
    failed(error: unknown): void;
    carrierFailed?(error: unknown): void;
  }): ChildStream;
  prompt(address: ChildAddress, text: string, delivery: ChildDelivery): Promise<void>;
  stop(address: ChildAddress): Promise<void>;
}

/** One rendered row of the child transcript. */
export interface ChildJournalRow {
  readonly id: string;
  readonly role: "user" | "assistant" | "tool" | "notice" | "approval";
  readonly text: string;
  readonly streaming?: true;
  readonly approval?: {
    readonly toolName: string;
    readonly reason?: string;
    readonly pending: boolean;
    readonly outcome?: string;
  };
}

/** Everything the pane renders for one tab. */
export interface ChildJournalSnapshot {
  readonly rows: readonly ChildJournalRow[];
  /** A turn opened and has not ended. */
  readonly running: boolean;
  readonly pendingApprovals: number;
  readonly hasMore: boolean;
  readonly loading: boolean;
  readonly error?: string;
}

/** How many entries one page request asks for; matches the official conversation page. */
export const CHILD_PAGE_MESSAGES = 50;

const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** The visible text of a message's content blocks; reasoning text never crosses. */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const raw of content) {
    const block = object(raw);
    if (block.type !== "text" || typeof block.text !== "string") continue;
    parts.push(block.text);
  }
  return parts.join("\n");
}

/** True when a message came from a plugin rather than a human or the model. */
function isPluginSource(data: Record<string, unknown>): boolean {
  return object(data.source).kind === "plugin";
}

/**
 * Fold one tab's window into the rows the pane renders.
 *
 * The fold is a pure function of the window, so a `replace` after a reconnect
 * or a `prepend` after a page load needs no incremental bookkeeping and can
 * never leave a stale row behind. Only public text crosses: assistant
 * reasoning, raw stream deltas that never committed, and client-only framing
 * events produce no row.
 * @param entries - the contiguous window, oldest first.
 * @returns the render snapshot for that window.
 */
export function reduceChildJournal(entries: readonly ChildJournalEntry[]): Omit<ChildJournalSnapshot, "hasMore" | "loading" | "error"> {
  const rows: ChildJournalRow[] = [];
  const byId = new Map<string, number>();
  const approvals = new Map<string, number>();
  let turn: number | undefined;
  // Live chunks belong to the attempt that follows the newest committed message;
  // anything older was already settled into a durable row.
  let settledThrough = -1;
  const push = (row: ChildJournalRow): void => {
    const existing = byId.get(row.id);
    if (existing === undefined) {
      byId.set(row.id, rows.length);
      rows.push(row);
    } else {
      rows[existing] = row;
    }
  };
  for (const [index, entry] of entries.entries()) {
    if (entry.type !== "event") continue;
    const event = entry.event;
    const data = object(event.data);
    const seq = event.seq ?? 0;
    switch (event.type) {
      case "turn/start":
        turn = typeof data.turn === "number" ? data.turn : turn;
        break;
      case "turn/end":
        turn = undefined;
        break;
      case "user/message": {
        const text = contentText(data.content);
        if (text === "") break;
        push({ id: `message:${String(data.id ?? seq)}`, role: isPluginSource(data) ? "notice" : "user", text });
        break;
      }
      case "assistant/message": {
        const text = contentText(object(data.message).content);
        const messageId = object(data.message).id;
        if (text === "") break;
        settledThrough = index;
        push({ id: `assistant:${String(messageId ?? seq)}`, role: "assistant", text });
        break;
      }
      case "tool/result": {
        const text = contentText(object(data.message).content);
        if (text === "") break;
        push({ id: `tool:${String(data.callId ?? seq)}`, role: "tool", text });
        break;
      }
      case "approval/asked": {
        const id = `approval:${String(data.id ?? seq)}`;
        approvals.set(id, rows.length);
        push({ id, role: "approval", text: typeof data.reason === "string" && data.reason !== "" ? data.reason : String(data.toolName ?? ""),
          approval: { toolName: String(data.toolName ?? ""), ...(typeof data.reason === "string" ? { reason: data.reason } : {}), pending: true } });
        break;
      }
      case "approval/decided": {
        const id = `approval:${String(data.id ?? seq)}`;
        const index = approvals.get(id);
        if (index === undefined) break;
        const row = rows[index];
        if (row?.approval === undefined) break;
        rows[index] = { ...row, approval: { ...row.approval, pending: false, ...(typeof data.outcome === "string" ? { outcome: data.outcome } : {}) } };
        break;
      }
      default:
        break;
    }
  }
  const live = new Map<string, string>();
  for (const [index, entry] of entries.entries()) {
    if (entry.type !== "transient" || index <= settledThrough) continue;
    const data = object(entry.event.data);
    const attempt = String(data.attemptId ?? "live");
    const chunk = object(data.chunk);
    if (chunk.type === "text-delta" && typeof chunk.text === "string") live.set(attempt, (live.get(attempt) ?? "") + chunk.text);
    else if (chunk.type === "block-end") {
      const block = object(chunk.block);
      if (block.type === "text" && typeof block.text === "string") live.set(attempt, block.text);
    }
  }
  for (const [attempt, text] of live) {
    if (text === "") continue;
    rows.push({ id: `live:${attempt}`, role: "assistant", text, streaming: true });
  }
  return {
    rows,
    running: turn !== undefined,
    pendingApprovals: rows.filter(row => row.approval?.pending === true).length,
  };
}

/** What one tab's controller exposes to its React host. */
export interface ChildViewHandle {
  getSnapshot(): ChildJournalSnapshot;
  loadMore(): Promise<void>;
  restart(): void;
  send(text: string, delivery: ChildDelivery): Promise<void>;
  stop(): Promise<void>;
  setDraft(text: string): string;
  getDraft(): string;
  release(): void;
}

/**
 * The pane's per-tab session controller.
 *
 * Drafts, the open stream and the unsubscribed state are keyed by the tab's own
 * address, so every tab is independent and closing one releases only its
 * display resources: the child keeps running, and reopening the address reuses
 * the draft the user had typed.
 * @param factory - the injected stream and prompt operations.
 * @returns an object that attaches one listener per open pane.
 */
export function createChildViews(factory: ChildStreamFactory) {
  const drafts = new Map<string, string>();
  const key = (address: ChildAddress): string =>
    `${address.parentSessionId}\u0000${address.childSessionId}\u0000${address.mode}`;

  return {
    /** Attach the pane to one address; the returned handle owns that address's stream only. */
    attach(address: ChildAddress, listener: (snapshot: ChildJournalSnapshot) => void): ChildViewHandle {
      const id = key(address);
      let entries: ChildJournalEntry[] = [];
      let hasMore = false;
      let loading = true;
      let error: string | undefined;
      let released = false;
      let stream: ChildStream | undefined;
      let firstSeq: number | undefined;
      const snapshot = (): ChildJournalSnapshot => ({
        ...reduceChildJournal(entries), hasMore, loading, ...(error === undefined ? {} : { error }),
      });
      const publish = (): void => { if (!released) listener(snapshot()); };
      const accept = (change: ChildJournalChange): void => {
        loading = false;
        error = undefined;
        if (change.hasMore !== undefined) hasMore = change.hasMore;
        if (change.page?.hasMore !== undefined) hasMore = change.page.hasMore;
        if (change.type === "replace") entries = [...(change.page?.entries ?? change.entries ?? [])];
        else if (change.type === "prepend") entries = [...(change.page?.entries ?? change.entries ?? []), ...entries];
        else if (change.type === "append" && change.entry !== undefined) entries = [...entries, change.entry];
        const first = entries.find(entry => typeof entry.event.seq === "number");
        firstSeq = first?.event.seq;
        publish();
      };
      const fail = (cause: unknown): void => {
        loading = false;
        error = cause instanceof Error ? cause.message : String(cause);
        publish();
      };
      stream = factory.create(address, {
        publish: accept,
        failed: fail,
        // A lost carrier is retryable: the stream re-baselines itself instead of
        // presenting a half-read transcript as complete.
        carrierFailed: () => { loading = true; publish(); },
      });
      void stream.open({ maxMessages: CHILD_PAGE_MESSAGES }).catch(fail);
      publish();

      return {
        getSnapshot: snapshot,
        async loadMore(): Promise<void> {
          if (released || stream === undefined || !hasMore || loading) return;
          loading = true;
          publish();
          try {
            await stream.prepend({ ...(firstSeq === undefined ? {} : { beforeSeq: firstSeq }), maxMessages: CHILD_PAGE_MESSAGES });
          } catch (cause) {
            fail(cause);
          }
        },
        restart(): void {
          if (released || stream === undefined) return;
          loading = true;
          error = undefined;
          publish();
          stream.restart();
        },
        async send(text: string, delivery: ChildDelivery): Promise<void> {
          if (released || text.trim() === "") return;
          await factory.prompt(address, text, delivery);
          drafts.set(id, "");
          publish();
        },
        async stop(): Promise<void> {
          if (released) return;
          await factory.stop(address);
        },
        setDraft(text: string): string { drafts.set(id, text); return text; },
        getDraft(): string { return drafts.get(id) ?? ""; },
        release(): void {
          if (released) return;
          released = true;
          // Closing the pane releases display resources only; the child's task
          // keeps running and the draft survives for the next open.
          void stream?.dispose().catch(() => {});
        },
      };
    },
  };
}
