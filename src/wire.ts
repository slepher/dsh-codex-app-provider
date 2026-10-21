/**
 * The App Server wire ↔ this plugin's vocabulary.
 *
 * Every function here is pure: it reads one request, record or native result and
 * returns the record, snapshot or native parameter object the other side expects.
 * Nothing opens a connection, reads a file or holds a runtime handle — the
 * `CodexSessionBackend` does that and calls in — so the protocol translation can
 * be read and changed without following the process lifecycle.
 * @module dsh-codex-app-provider/wire
 */

import { isAbsolute, resolve } from "node:path";

import type {
  ApprovalDecision,
  ApprovalRequest,
  CreateSessionOptions,
  Report,
  SessionSnapshot,
  TurnInput,
  TurnSnapshot,
  UserInputQuestion,
} from "./browser-types.js";
import type { StoredSession } from "./records.js";
import { UncertainError } from "./rpc.js";

/** The subset of a `thread/start` / `thread/resume` result this plugin reads. */
export interface ThreadResult {
  cwd?: string;
  thread?: { id?: string; cwd?: string; name?: string | null; preview?: string; updatedAt?: number; status?: { type?: string }; turns?: { id?: string; status?: string }[] };
  model?: string;
  reasoningEffort?: string;
  approvalPolicy?: string;
  sandbox?: {
    type?: string;
    writableRoots?: string[];
    excludeSlashTmp?: boolean;
    excludeTmpdirEnvVar?: boolean;
    networkAccess?: boolean;
  };
}

/** The subset of a `turn/start` result this plugin reads. */
export interface TurnResult {
  turn?: { id?: string; status?: string; error?: unknown };
}

/**
 * One turn's input in the App Server's own shape.
 *
 * A turn with no input is refused rather than sent empty, and a `localImage`
 * path must be absolute: Codex resolves it against its own cwd, so a relative
 * one would silently read the wrong file.
 * @param input - the turn's input, text or parts.
 * @returns the native input array.
 * @throws when the input, a text part, an image URL or a path is empty/invalid.
 */
export function turnInput(input: string | readonly TurnInput[]): Record<string, unknown>[] {
  const values = typeof input === "string" ? [{ type: "text" as const, text: input }] : [...input];
  if (!values.length) throw new Error("Input must not be empty");
  return values.map(value => {
    if (value.type === "text") {
      if (!value.text.trim()) throw new Error("Input must not be empty");
      return { type: "text", text: value.text, text_elements: [] };
    }
    if (value.type === "image") {
      if (!value.url.trim()) throw new Error("Image URL must not be empty");
      return { type: "image", url: value.url };
    }
    if (value.type === "localImage") {
      if (!isAbsolute(value.path)) throw new Error("Local image path must be absolute");
      return { type: "localImage", path: value.path };
    }
    if (!value.name || !isAbsolute(value.path)) throw new Error("Skill name and absolute path are required");
    return { type: "skill", name: value.name, path: value.path };
  });
}

/**
 * Project one record onto the snapshot a caller reads.
 *
 * The projection is deep-copied: callers hold a snapshot while the backend keeps
 * mutating the live record, and a shared sub-object would let a reader observe a
 * half-applied turn.
 * @param record - the record to project.
 * @returns the read-only snapshot.
 */
export function snapshot(record: StoredSession): SessionSnapshot {
  const { sessionId, threadId, turnId, cwd, model, reasoningEffort, pending, usage, state, options, reports } = record;
  return { sessionId, threadId, turnId, cwd, executionCwd: record.executionCwd ?? options?.boundary?.cwd ?? cwd,
    model, reasoningEffort, ...(pending === undefined ? {} : { pending: structuredClone(pending) }),
    ...(record.applied === undefined ? {} : { applied: structuredClone(record.applied) }),
    usage, state, options: structuredClone(options), reports: structuredClone(reports) };
}

/**
 * One turn snapshot, refused when the record has no turn identity to name.
 * @throws `UncertainError` when the record cannot name the thread and turn.
 */
export function turnSnapshot(record: StoredSession, state: TurnSnapshot["state"]): TurnSnapshot {
  if (record.threadId === undefined || record.turnId === undefined) throw new UncertainError("Turn identity unavailable");
  return { sessionId: record.sessionId, threadId: record.threadId, turnId: record.turnId, state };
}

/** One native turn status as a run state; `undefined` for a status DSH does not model. */
export function statusState(status: unknown): TurnSnapshot["state"] | undefined {
  if (status === "inProgress") return "running";
  return terminalState(status);
}

/** A native status that ends a turn, or `undefined` while it has not ended. */
export function terminalState(status: unknown): Report["status"] | undefined {
  return status === "completed" || status === "failed" || status === "interrupted" ? status : undefined;
}

/** Read one wire value as a plain record; anything else reads as no fields. */
export function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

/**
 * The response to one approval request, in the method's own shape.
 *
 * `item/permissions/requestApproval` answers with a permission grant rather than
 * a bare decision, and a refusal grants an empty permission set for this turn
 * only — never a broader scope than the request that was declined.
 * @param request - the native request being answered.
 * @param decision - the outcome resolved through DSH.
 * @returns the response parameters.
 */
export function approvalResponse(request: ApprovalRequest, decision: ApprovalDecision): Record<string, unknown> {
  if (request.method !== "item/permissions/requestApproval") return { decision };
  if (decision !== "accept") return { permissions: {}, scope: "turn" };
  const permissions = objectValue(objectValue(request.params).permissions);
  return { permissions, scope: "turn" };
}

/** Read one native question set, dropping entries whose identity or text is not a string. */
export function userInputQuestions(value: unknown): UserInputQuestion[] {
  if (!Array.isArray(value)) return [];
  const questions: UserInputQuestion[] = [];
  for (const raw of value) {
    const question = objectValue(raw);
    if (typeof question.id !== "string" || typeof question.question !== "string") continue;
    const options = Array.isArray(question.options) ? question.options.flatMap(item => {
      const option = objectValue(item);
      return typeof option.label === "string"
        ? [{ label: option.label, description: typeof option.description === "string" ? option.description : "" }]
        : [];
    }) : [];
    questions.push({
      id: question.id,
      header: typeof question.header === "string" ? question.header : "",
      question: question.question,
      isOther: question.isOther === true,
      isSecret: question.isSecret === true,
      ...(options.length === 0 ? {} : { options }),
    });
  }
  return questions;
}

/**
 * Validate one explicitly declared task boundary.
 *
 * The boundary names the Codex execution location and the exact writable roots
 * the task declares. It is forwarded verbatim: the plugin neither rewrites its
 * cwd to the Session workspace nor widens its writable roots. A boundary that
 * does not name absolute directories fails closed.
 * @param boundary - the declared boundary, when the caller declared one.
 * @returns the normalized declared boundary, or undefined for an unscoped Session.
 */
export function normalizedBoundary(boundary: CreateSessionOptions["boundary"]) {
  if (boundary === undefined) return undefined;
  if (!isAbsolute(boundary.cwd) || !boundary.writableRoots.every(isAbsolute)) {
    throw new Error("Boundary cwd and writable roots must be absolute");
  }
  return {
    cwd: resolve(boundary.cwd),
    writableRoots: [...new Set(boundary.writableRoots.map(path => resolve(path)))],
    network: boundary.network,
  } as const;
}

/**
 * Build the native thread request for one record.
 *
 * Only what the record actually declares is sent. `approvalPolicy`,
 * `approvalsReviewer` and `sandbox` travel when the caller declared them, and
 * Codex resolves everything else from its own configuration layers and cwd:
 * permissions are Codex's own subject, so the plugin injects no permission
 * profile and couples no feature flag to a task boundary. A declared boundary
 * contributes only the directory the task runs in.
 * @param record - the record whose thread is being started or resumed.
 * @returns the `thread/start` / `thread/resume` parameters.
 */
export function threadParams(record: StoredSession): Record<string, unknown> {
  const options = record.options ?? {};
  const boundary = options.boundary;
  return {
    // The native thread runs where the task runs, which is the Session workspace
    // only when the Session declares no task boundary.
    cwd: boundary?.cwd ?? record.executionCwd ?? record.cwd,
    model: record.model,
    ...(options.developerInstructions === undefined ? {} : { developerInstructions: options.developerInstructions }),
    ...(options.approvalPolicy === undefined ? {} : { approvalPolicy: options.approvalPolicy }),
    ...(options.approvalsReviewer === undefined ? {} : { approvalsReviewer: options.approvalsReviewer }),
    ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
    config: {
      ...(record.reasoningEffort === undefined ? {} : { model_reasoning_effort: record.reasoningEffort }),
    },
    ephemeral: false,
  };
}
