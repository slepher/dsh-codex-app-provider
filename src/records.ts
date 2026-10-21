/**
 * What one recorded Session is, and how an on-disk one is read back.
 *
 * This module is the record's schema: the stored shape, the one-time projection
 * of the legacy mirrored-notification form, and the hand-written validators that
 * keep a partly malformed record from being trusted. It opens no file and
 * creates no directory — `store.ts` owns the state directory and the
 * single-owner lock — so the schema can be reasoned about (and eventually
 * replaced by a declared schema) without a filesystem.
 * @module dsh-codex-app-provider/records
 */

import { projectExecutionFacts, reduceExecutionEvents } from "./execution-events.js";
import type {
  ApprovalRequest,
  CreateSessionOptions,
  ExecutionFactLine,
  PendingConfig,
  Report,
  RunState,
  SequencedBackendEvent,
  SessionSnapshot,
} from "./browser-types.js";

/**
 * One recorded thread handover. The source record keeps its history, reports
 * and usage but can no longer start, resume, configure or restart the thread.
 */
export interface StoredHandoffOut {
  /** Successor native Session that now owns the thread. */
  toSessionId: string;
  /** Host request that fixed this handover; repeated requests reuse it. */
  requestId: string;
  at: number;
}

/** The source association one successor record carries. */
export interface StoredHandoffIn {
  /** Native Session that handed the thread over. */
  fromSessionId: string;
  requestId: string;
  at: number;
}

export interface StoredSession extends SessionSnapshot {
  ownerId: string;
  updatedAt?: number;
  turnId?: string;
  /** Authorized target configuration awaiting native confirmation. */
  pending?: PendingConfig;
  /** Set once this record handed its thread to a successor. */
  handedOff?: StoredHandoffOut;
  /** Set when this record was created to continue another record's thread. */
  handoffFrom?: StoredHandoffIn;
  lastStartKey?: string;
  lastTurnState?: RunState;
  lastOutput?: string;
  lastUnphasedOutput?: string;
  operation?: "turn" | "compact";
  released?: boolean;
  approvals: ApprovalRequest[];
  options?: CreateSessionOptions;
  /** Projected execution facts, in transcript order; the raw notifications are not kept. */
  facts: ExecutionFactLine[];
  reports: Report[];
}

/**
 * A record as written while the provider still mirrored every notification.
 *
 * The mirror is projected once on load so an existing state directory is
 * rewritten in the current form instead of being unreadable.
 */
interface LegacyMirror {
  events?: SequencedBackendEvent[];
  nextEventSequence?: number;
}

type LoadedRecord = Omit<StoredSession, "facts"> & Partial<Pick<StoredSession, "facts">> & LegacyMirror;

/**
 * Project one loaded record into the current stored form.
 *
 * `events` is dropped: the raw notifications existed only to build `facts`, and
 * a record whose `events` key is present is written back without it. A turn that
 * was in flight when the process stopped is no longer known to be running, so
 * its state becomes `unknown` rather than being trusted.
 * @param record - the record as parsed from disk.
 * @returns the current-form record.
 */
export function recover(record: LoadedRecord): StoredSession {
  const { events, nextEventSequence: _cursor, ...rest } = record;
  const facts = record.facts ?? projectExecutionFacts(reduceExecutionEvents(events ?? []));
  const current: StoredSession = { ...rest, facts: [...facts] };
  const state: RunState = record.state === "running" || record.state === "waiting-approval"
    ? "unknown"
    : record.state;
  return { ...current, state, approvals: [], reports: record.reports ?? [] };
}

/**
 * Read one record's text into its loaded form, refusing a malformed one.
 *
 * The validators below are deliberately strict and hand-written: a record whose
 * gate binding, handoff, pending target, reports or usage cannot be read back is
 * not repaired and not skipped — it fails the whole load, because a silently
 * degraded record is indistinguishable from a valid one to every later reader.
 * The `events` mirror is admitted here only so {@link recover} can project it.
 * @param text - the record file's contents.
 * @returns the loaded record, still carrying `events` when it is a legacy mirror.
 * @throws when the text is not a record this provider wrote.
 */
export function parseRecord(text: string): LoadedRecord {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null) throw new Error("Invalid Session record");
  const record = value as Partial<LoadedRecord>;
  if (
    typeof record.ownerId !== "string"
    || typeof record.sessionId !== "string"
    || typeof record.cwd !== "string"
    || typeof record.state !== "string"
    || !Array.isArray(record.approvals)
    || !Array.isArray(record.facts) && !Array.isArray(record.events)
  ) throw new Error("Invalid Session record");
  if (!validReports(record)) {
    throw new Error("Invalid Session reports");
  }
  if (!validPending(record.pending)) throw new Error("Invalid Session pending configuration");
  if (!validGate(record.options?.gate)) throw new Error("Invalid Session gate binding");
  if (!validHandoff(record.handedOff, ["toSessionId", "requestId"]) || !validHandoff(record.handoffFrom, ["fromSessionId", "requestId"])) {
    throw new Error("Invalid Session handoff record");
  }
  return record as StoredSession;
}

/** A handoff record is optional as a whole, but never partially malformed. */
function validHandoff(value: unknown, ids: readonly string[]): boolean {
  if (value === undefined) return true;
  if (typeof value !== "object" || value === null) return false;
  const handoff = value as Record<string, unknown>;
  return Object.keys(handoff).every(key => [...ids, "at"].includes(key))
    && ids.every(key => typeof handoff[key] === "string" && (handoff[key] as string).length > 0)
    && validTimestamp(handoff.at);
}

/** A pending target is optional as a whole, but never partially malformed. */
function validPending(value: unknown): value is PendingConfig | undefined {
  if (value === undefined) return true;
  if (typeof value !== "object" || value === null) return false;
  const pending = value as Partial<PendingConfig>;
  if (Object.keys(pending).length === 0) return false;
  if (Object.keys(pending).some(key => key !== "model" && key !== "reasoningEffort")) return false;
  return (pending.model === undefined || typeof pending.model === "string" && pending.model.length > 0)
    && (pending.reasoningEffort === undefined || typeof pending.reasoningEffort === "string" && pending.reasoningEffort.length > 0);
}

/**
 * A recorded gate is optional as a whole, but never partially malformed: a
 * Session whose binding cannot be read back must not be started as if it were
 * ungated, so an unreadable one fails the whole record.
 */
function validGate(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const gate = value as Record<string, unknown>;
  if (Object.keys(gate).some(key => key !== "role" && key !== "hook" && key !== "args")) return false;
  return typeof gate.role === "string" && gate.role.length > 0
    && typeof gate.hook === "string" && gate.hook.length > 0
    && typeof gate.args === "object" && gate.args !== null && !Array.isArray(gate.args);
}

function validReports(record: Partial<StoredSession>): boolean {
  if (record.reports === undefined) return true;
  if (!Array.isArray(record.reports)) return false;
  const turnIds = new Set<string>();
  return record.reports.every(report => {
    if (!validReport(report) || turnIds.has(report.turnId)) return false;
    turnIds.add(report.turnId);
    return true;
  });
}

function validReport(value: unknown): value is Report {
  if (typeof value !== "object" || value === null) return false;
  const report = value as Partial<Report>;
  return typeof report.threadId === "string" && report.threadId.length > 0
    && typeof report.turnId === "string" && report.turnId.length > 0
    && ["completed", "failed", "interrupted"].includes(report.status ?? "")
    && typeof report.result === "string"
    && (report.protocolError === undefined || typeof report.protocolError === "string")
    && (report.error === undefined || typeof report.error === "string")
    && (report.usage === null || validUsage(report.usage))
    && (report.turnUsage === undefined || validUsageValues(report.turnUsage))
    && validTimestamp(report.createdAt);
}

function validUsage(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const usage = value as Record<string, unknown>;
  return validUsageValues(usage.total) && validUsageValues(usage.last)
    && nullableCount(usage.modelContextWindow) && nullableCount(usage.currentContextTokens)
    && (usage.remainingContextRatio === null || typeof usage.remainingContextRatio === "number"
      && Number.isFinite(usage.remainingContextRatio) && usage.remainingContextRatio >= 0 && usage.remainingContextRatio <= 1);
}

function validUsageValues(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const usage = value as Record<string, unknown>;
  return ["totalTokens", "inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningOutputTokens"]
    .every(key => nullableCount(usage[key]));
}

function nullableCount(value: unknown): boolean {
  return value === null || typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validTimestamp(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
