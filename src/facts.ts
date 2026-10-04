/**
 * Executed-fact messages for the DSH session log.
 *
 * Codex executes its own tools, so the DSH log holds no record of what ran. The
 * provider persists that record through the supported plugin seam as ordinary
 * `user/message` events sourced from this plugin: the Session log stays the
 * conversation's source of truth, the facts are readable and replayable by
 * stock core, and nothing is faked as a tool call waiting for the DSH
 * dispatcher.
 *
 * Identity is derived from the native fact (`threadId`/`turnId`/`itemId`), so a
 * reconnect, a replay or a cold recovery re-derives the same message identity
 * instead of importing the same executed command twice.
 * @module dsh-codex-app-provider/facts
 */

import {
  MessageId,
  boundContextSummary,
  freezeMessage,
  type ContextFormed,
  type UserMessage,
} from "@deepseek-ai/dsh-llm";

import type { CodexExecutionFactLine } from "./execution-events.js";

declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    /** Executed-fact records this plugin commits. */
    "dsh-codex-app-provider": {
      kind: "dsh-codex-app-provider";
    } & ContextFormed;
  }
}

/**
 * Plugin identity, recorded as the source kind of every message this plugin
 * commits.
 *
 * The literal is also the declared key of the {@link MessageSourceMap} entry
 * above; both must change together. DSH no longer admits the released
 * `{ kind: 'plugin', plugin }` wrapper, which the V3-to-V4 migration rewrites
 * to `plugin:dsh-codex-app-provider` for rows this plugin already wrote.
 */
export const FACT_PLUGIN = "dsh-codex-app-provider";
/** Prefix that makes an imported fact message recognizable in the session log. */
const FACT_ID_PREFIX = "codex-executed:";

/**
 * True when a message identity is one of this plugin's imported facts.
 *
 * The identity, not the plugin name, is the discriminator: the plugin writes
 * other messages into the same log, and those must not be mistaken for facts
 * that are already in the native thread.
 * @param id - the message identity under test.
 * @returns whether the message is an imported executed fact.
 */
export function isExecutionFactId(id: unknown): boolean {
  return typeof id === "string" && id.startsWith(FACT_ID_PREFIX);
}

/** One native item's rendered facts, ready to persist as one DSH message. */
export interface CodexFactMessage {
  /** Stable DSH message identity derived from the native item. */
  id: string;
  threadId: string;
  turnId: string;
  itemId: string;
  /** Sourced fact text, already marked as executed rather than instructed. */
  text: string;
}

/**
 * Group rendered fact lines into one message per native item.
 *
 * One item can render several lines (a command and its output); they stay one
 * durable row so the transcript shows one entry per executed thing rather than
 * one per line, and so the message identity stays a function of the item.
 * @param lines - projected fact lines in transcript order.
 * @returns one entry per distinct native item, oldest first.
 */
export function factMessages(lines: readonly CodexExecutionFactLine[]): readonly CodexFactMessage[] {
  const grouped = new Map<string, CodexFactMessage>();
  for (const line of lines) {
    const id = `${FACT_ID_PREFIX}${line.threadId}:${line.turnId}:${line.itemId}`;
    const existing = grouped.get(id);
    if (existing === undefined) {
      grouped.set(id, { id, threadId: line.threadId, turnId: line.turnId, itemId: line.itemId, text: line.text });
    } else {
      existing.text = `${existing.text}\n${line.text}`;
    }
  }
  return [...grouped.values()];
}

/**
 * Build the DSH message for one executed native item.
 *
 * The message is a `plugin`-sourced `user/message`: it is visibly an executed
 * fact, it carries no tool-call identity the DSH dispatcher could act on, and
 * its identity is stable so the log deduplicates a repeated import.
 * @param fact - the grouped fact for one native item.
 * @returns the immutable message to append to the DSH session log.
 */
export function factMessage(fact: CodexFactMessage): UserMessage {
  return freezeMessage({
    id: MessageId(fact.id),
    role: "user",
    content: [{ type: "text", text: fact.text }],
    source: {
      kind: FACT_PLUGIN,
      form: "notice",
      summary: boundContextSummary(`Codex executed: ${firstLine(fact.text)}`),
    },
  });
}

/**
 * The message identities already present in a Session's event snapshot.
 *
 * Reading the current log is what makes the import idempotent: a fact whose
 * message is already committed is never appended again, whatever path (a
 * retried turn, a reconnect, a cold recovery) reaches the projection.
 * @param events - the Session's current event snapshot, when readable.
 * @returns the set of imported fact message identities.
 */
export function importedFactIds(events: readonly { type: string; data: unknown }[] | undefined): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const event of events ?? []) {
    if (event.type !== "user/message") continue;
    const id = (event.data as { id?: unknown } | undefined)?.id;
    if (typeof id === "string" && id.startsWith(FACT_ID_PREFIX)) ids.add(id);
  }
  return ids;
}

/** The first non-empty line of a rendered fact, for the collapsed row account. */
function firstLine(text: string): string {
  const line = text.split("\n").find(value => value.trim() !== "");
  return line?.trim() ?? "executed item";
}
