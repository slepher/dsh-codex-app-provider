/**
 * The DSH conversation ↔ native Codex thread boundary.
 *
 * Everything here reads the DSH Session log and the request's durable messages
 * and turns them into the input one Codex turn receives: which messages are new,
 * how a history segment is rendered, and which native thread identity the log
 * itself still proves. It owns no process, no backend handle and no Host
 * capability — the imports below are types, one pure predicate module, and the
 * LLM vocabulary — so it can be exercised without a running App Server.
 * @module dsh-codex-app-provider/history
 */

import { LlmError, type ContentBlock, type Message, type RequestMessage } from "@deepseek-ai/dsh-llm";

import type { ProviderImageRef } from "./provider.js";
import { CODEX_APP_PROVIDER, type TurnInput } from "./browser-types.js";
import { isCodexVisible, isInjectedContext } from "./context.js";

/** Opening text of one projected DSH history segment (`importedInput`). */
export const HISTORY_IMPORT_MARKER = "[DSH history import";

/**
 * The native thread identity this Session's own log still carries.
 *
 * Read from the newest `finish.replayState` the adapter committed, so a record
 * whose cached identity was lost can resume the thread those turns actually ran
 * on. The newest marker wins: a rebuilt or handed-over thread is written to the
 * log as soon as it runs, so an older marker never overrides a newer one.
 * @param events - the Session log's events, when the Host exposes them.
 * @returns the thread identity, or `undefined` when the log carries none.
 */
export function recoveredThreadId(events: readonly { type: string; data: unknown }[] | undefined): string | undefined {
  if (events === undefined) return undefined;
  for (let index = events.length - 1; index >= 0; index--) {
    const message = eventMessage(events[index]!);
    if (message?.source.kind !== "model" || message.source.provider !== CODEX_APP_PROVIDER) continue;
    const threadId = replayThread(message.source.replayState);
    if (threadId !== undefined) return threadId;
  }
  return undefined;
}

export async function planInput(
  messages: readonly Message[],
  threadId: string | undefined,
  cursor: string | undefined,
  image: ImageResolver,
  events?: readonly { type: string; seq?: number; data: unknown }[],
): Promise<{ input: string | TurnInput[]; key: string }> {
  const lastUser = [...messages].reverse().find(message => message.role === "user" && message.source.kind !== "tool");
  if (lastUser === undefined) throw new LlmError("Codex provider received no user input", "INVALID_REQUEST");
  const key = String(lastUser.id);
  let start = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== "assistant" || message.source.kind !== "model" || message.source.provider !== CODEX_APP_PROVIDER) continue;
    if (threadId !== undefined && replayThread(message.source.replayState) === threadId) { start = index; break; }
  }
  if (start === -1 && cursor !== undefined) {
    const index = messages.findIndex(message => String(message.id) === cursor);
    if (index !== -1) start = index === messages.length - 1 ? index - 1 : index;
  }
  if (start === -1 && threadId !== undefined && events !== undefined) {
    start = nativeHistoryCursor(messages, threadId, events);
  }
  const segment = messages.slice(start + 1).filter(isCodexVisible);
  const current = segment[segment.length - 1];
  if (current === undefined) throw new LlmError("Codex provider found no new input for this turn", "INVALID_REQUEST");
  const names = toolCallNames(messages);
  const isUserInput = current.role === "user" && current.source.kind !== "tool";
  if (!isUserInput) return { input: await importedInput(segment, names, ref => image(ref, "history")), key };
  const history = segment.slice(0, -1);
  const currentParts = await renderBlocks(current.content, ref => image(ref, "content"));
  if (history.length === 0) return { input: represent(currentParts), key };
  const imported = await importedInput(history, names, ref => image(ref, "history"));
  if (imported === "") return { input: represent(currentParts), key };
  const parts: TurnInput[] = typeof imported === "string" ? [{ type: "text", text: imported }] : [...imported];
  const currentText = textOf(currentParts);
  if (currentText !== "" || currentParts.length === 0) parts.push({ type: "text", text: currentText });
  for (const part of currentParts) if (part.type !== "text") parts.push(part);
  return { input: parts, key };
}

/** Recover the input boundary when DSH checkpoints hide the native replay marker. */
function nativeHistoryCursor(
  messages: readonly Message[],
  threadId: string,
  events: readonly { type: string; seq?: number; data: unknown }[],
): number {
  let last = -1;
  for (const [index, event] of events.entries()) {
    if (event.type !== "assistant/message") continue;
    const message = (event.data as { message?: Message }).message;
    if (message?.source.kind === "model" && message.source.provider === CODEX_APP_PROVIDER
      && replayThread(message.source.replayState) === threadId) last = index;
  }
  if (last === -1) return -1;
  // Everything up to the last native marker is already in the thread, and DSH
  // context the provider never sends cannot be missing from it either. A real
  // checkpoint also replaces the executed-fact notices an earlier turn imported,
  // so those must not make an otherwise covered range look unknown.
  const covered = new Set<number>();
  for (const [index, event] of events.entries()) {
    if (event.seq === undefined) continue;
    const message = eventMessage(event);
    if (index <= last || message !== undefined && isInjectedContext(message)) covered.add(event.seq);
  }
  const summaries = new Map<string, readonly number[]>();
  const known = new Set<string>();
  for (const [index, event] of events.entries()) {
    if (event.type === "compaction/summary") {
      const data = event.data as { compactionId: string; shadowedSeqs: readonly number[] };
      summaries.set(data.compactionId, data.shadowedSeqs);
    }
    const message = eventMessage(event);
    if (message === undefined) continue;
    const source = message.source as { compactionId?: unknown };
    // A checkpoint source carries the compaction it belongs to; the kind that
    // used to spell this as `plugin: 'compact'` is now `compact-checkpoint`.
    const shadowed = typeof source.compactionId === "string" ? summaries.get(source.compactionId) : undefined;
    if (index <= last || shadowed !== undefined && shadowed.length > 0 && shadowed.every(seq => covered.has(seq))) {
      known.add(String(message.id));
      if (event.seq !== undefined) covered.add(event.seq);
    }
  }
  let cursor = -1;
  for (const [index, message] of messages.entries()) if (known.has(String(message.id))) cursor = index;
  // Keep the final input available for the existing idempotent retry path.
  return Math.min(cursor, messages.length - 2);
}

/** The message one surface event carries, when it produces one. */
function eventMessage(event: { type: string; data: unknown }): Message | undefined {
  if (event.type === "user/message") return event.data as Message;
  if (event.type === "assistant/message") return (event.data as { message?: Message }).message;
  return undefined;
}

/**
 * One durable Session message.
 *
 * A request either carries persisted messages — every one of which has an
 * identity and a producer source — or identity-free one-shot user inputs, which
 * Session never writes and this provider serves only through the auxiliary path.
 */
export function isDurableMessage(message: RequestMessage): message is Message {
  return (message as { id?: unknown }).id !== undefined;
}

/**
 * The durable Session messages of one ordinary request.
 *
 * Boundary detection, the retry cursor and the Codex idempotency key are all
 * message identities, so an ordinary request cannot be served from identity-free
 * one-shot inputs; DSH sends those only for the auxiliary purposes this provider
 * routes through `streamAuxiliary`.
 */
export function durableMessages(messages: readonly RequestMessage[]): readonly Message[] {
  if (messages.some(message => !isDurableMessage(message))) {
    throw new LlmError("Codex provider requires durable Session messages for an ordinary request", "INVALID_REQUEST");
  }
  return messages.filter(isDurableMessage);
}

/**
 * Render one DSH history segment as a single deterministic text import, or as
 * interleaved text/image inputs when the segment carries durable images.
 */
export async function importedInput(
  messages: readonly RequestMessage[],
  names: Map<string, string>,
  image: (ref: ProviderImageRef) => Promise<TurnInput>,
): Promise<string | TurnInput[]> {
  const entries: { label: string; parts: TurnInput[] }[] = [];
  for (const message of messages) {
    if (isDurableMessage(message) && isInjectedContext(message)) continue;
    const parts = toolResultAccount(message, await renderBlocks(message.content, image));
    const hasImage = parts.some(part => part.type !== "text");
    if (parts.length === 0 || (!hasImage && textOf(parts).trim() === "")) continue;
    entries.push({ label: messageLabel(message, names), parts });
  }
  if (entries.length === 0) return "";
  const header = "[DSH history import — reconstructed from the DSH Session log for continuity]";
  if (!entries.some(entry => entry.parts.some(part => part.type !== "text"))) {
    const lines = [header];
    for (const entry of entries) lines.push(`${entry.label}: ${textOf(entry.parts)}`);
    return lines.join("\n");
  }
  const parts: TurnInput[] = [];
  let buffer = [header];
  for (const entry of entries) {
    const body = textOf(entry.parts);
    if (body.trim() !== "") buffer.push(`${entry.label}: ${body}`);
    const images = entry.parts.filter(part => part.type !== "text");
    if (images.length > 0) {
      parts.push({ type: "text", text: buffer.join("\n") });
      parts.push(...images);
      buffer = [];
    }
  }
  if (buffer.length > 0) parts.push({ type: "text", text: buffer.join("\n") });
  return parts;
}

/** Collapse rendered parts into the legacy string form unless the turn carries images. */
function represent(parts: readonly TurnInput[]): string | TurnInput[] {  if (!parts.some(part => part.type !== "text")) return textOf(parts);
  const values: TurnInput[] = [];
  for (const part of parts) if (part.type !== "text" || part.text !== "") values.push(part);
  return values;
}

function textOf(parts: readonly TurnInput[]): string {
  const values: string[] = [];
  for (const part of parts) if (part.type === "text") values.push(part.text);
  return values.join("\n");
}

function messageLabel(message: RequestMessage, names: Map<string, string>): string {
  if (!isDurableMessage(message)) return message.role;
  if (message.source.kind === "tool") {
    const name = names.get(String(message.source.callId));
    return `tool${name === undefined ? "" : `(${name})`}`;
  }
  // A user-role message from any producer other than the human is context DSH
  // injected; the human's own input is the only `user`-sourced user message.
  return message.role === "user" && message.source.kind !== "user" ? "context" : message.role;
}

/**
 * Prefix a tool-role message with the account its result block used to render.
 *
 * DSH moved tool results out of content into first-class tool-role messages, so
 * the account that used to come from the block now comes from the message.
 * @param message - the message whose content was just rendered.
 * @param parts - the rendered content parts, text and images in order.
 * @returns the parts with the result account ahead of its images.
 */
function toolResultAccount(message: RequestMessage, parts: readonly TurnInput[]): TurnInput[] {
  if (!isDurableMessage(message) || message.role !== "tool") return [...parts];
  const account = `[tool result${message.isError === true ? " error" : ""}]`;
  return [{ type: "text", text: `${account} ${textOf(parts)}` }, ...parts.filter(part => part.type !== "text")];
}

async function renderBlocks(
  blocks: readonly ContentBlock[],
  image: (ref: ProviderImageRef) => Promise<TurnInput>,
): Promise<TurnInput[]> {
  const parts: TurnInput[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "text": if (block.text !== "") parts.push({ type: "text", text: block.text }); break;
      case "reasoning": break;
      case "image": parts.push(await image(block.attachment)); break;
      case "file": parts.push({ type: "text", text: `[file: ${block.attachment.name} (${block.attachment.bytes} bytes)]` }); break;
      case "tool-call": parts.push({ type: "text", text: `[tool call ${block.name} ${block.arguments}]` }); break;
      default: parts.push({ type: "text", text: `[unsupported block: ${(block as { type: string }).type}]` });
    }
  }
  return parts;
}

export function toolCallNames(messages: readonly Message[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    for (const block of message.content) if (block.type === "tool-call") names.set(String(block.id), block.name);
  }
  return names;
}

/** The native thread identity one `finish.replayState` envelope carries, when it carries one. */
function replayThread(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const response = (value as { response?: unknown }).response;
  if (typeof response !== "object" || response === null) return undefined;
  const threadId = (response as { threadId?: unknown }).threadId;
  return typeof threadId === "string" ? threadId : undefined;
}

/** How one rendered image reference becomes Codex input, per message role. */
type ImageResolver = (ref: ProviderImageRef, kind: "content" | "history") => Promise<TurnInput>;
