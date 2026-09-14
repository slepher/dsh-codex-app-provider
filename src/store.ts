import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, resolve } from "node:path";

import type {
  ApprovalRequest,
  CreateSessionOptions,
  PendingConfig,
  Report,
  RunState,
  SequencedBackendEvent,
  SessionSnapshot,
  WorkerOwner,
  WorkerState,
} from "./browser-types.js";

export interface StoredWorker {
  parentSessionId: string;
  main?: true;
  owner: WorkerOwner;
  managedBy?: "workflow";
  role?: string;
  name: string;
  detached: boolean;
  savedState?: WorkerState;
}

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
  operation?: "turn" | "review" | "compact";
  released?: boolean;
  approvals: ApprovalRequest[];
  options?: CreateSessionOptions;
  events: SequencedBackendEvent[];
  nextEventSequence: number;
  reports: Report[];
  worker?: StoredWorker;
}

export class SessionStore {
  private readonly directory: string;
  private readonly lock: string;
  private readonly records = new Map<string, StoredSession>();

  constructor(readonly stateDir: string) {
    if (!isAbsolute(stateDir)) throw new Error("stateDir must be absolute");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    this.directory = resolve(stateDir, "sessions");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.lock = resolve(stateDir, "owner.lock");
    this.acquireLock();
    try {
      for (const name of readdirSync(this.directory)) {
        if (!name.endsWith(".json")) continue;
        const record = parseRecord(readFileSync(resolve(this.directory, name), "utf8"));
        if (this.records.has(record.sessionId)) throw new Error(`Duplicate Session ${record.sessionId}`);
        this.records.set(record.sessionId, recover(record));
      }
    } catch (error) {
      this.close();
      throw error;
    }
  }

  mainConversations(cwd: string): StoredSession[] {
    return [...this.records.values()].filter(record => record.worker?.main && record.cwd === cwd);
  }

  list(ownerId: string): StoredSession[] {
    return [...this.records.values()].filter(record => record.worker === undefined && record.ownerId === ownerId);
  }

  listWorkers(parentSessionId: string): StoredSession[] {
    return [...this.records.values()].filter(record => record.worker?.parentSessionId === parentSessionId && !record.worker.detached);
  }

  bound(sessionId: string): StoredSession | undefined {
    const record = this.records.get(sessionId);
    return record?.worker === undefined ? undefined : record;
  }

  has(sessionId: string): boolean {
    return this.records.has(sessionId);
  }

  findBoundByThread(threadId: string): StoredSession | undefined {
    return [...this.records.values()].find(record => record.worker !== undefined && record.threadId === threadId);
  }

  findByThread(threadId: string): StoredSession[] {
    return [...this.records.values()].filter(record => record.threadId === threadId);
  }

  occupiedThreads(): string[] {
    return [...new Set([...this.records.values()].flatMap(record => claimsThread(record) && record.threadId !== undefined ? [record.threadId] : []))];
  }

  get(ownerId: string, sessionId: string): StoredSession | undefined {
    const record = this.records.get(sessionId);
    if (record?.worker !== undefined) throw new Error("Contextual caller required for bound worker");
    if (record !== undefined && record.ownerId !== ownerId) throw new Error("Session owner mismatch");
    return record;
  }

  adopt(sessionId: string, parentSessionId: string, expectedThreadId: string): StoredSession {
    const record = this.records.get(sessionId);
    if (record?.handedOff !== undefined) throw new Error("This Codex Session handed its thread to a successor");
    const matches = [...this.records.values()].filter(item => item.threadId === expectedThreadId);
    if (record?.worker === undefined || record.threadId !== expectedThreadId
      || matches.length !== 1 || matches[0] !== record || occupied(record)) {
      throw new Error("Worker adoption target changed");
    }
    this.assertWritable(record);
    const adopted: StoredSession = {
      ...record,
      ownerId: parentSessionId,
      worker: { ...record.worker, parentSessionId, owner: "user", detached: false },
    };
    this.persist(adopted);
    Object.assign(record, adopted);
    this.records.set(sessionId, record);
    return record;
  }

  put(record: StoredSession): void {
    record.updatedAt = Date.now();
    const existing = this.records.get(record.sessionId);
    if (existing !== undefined && existing.ownerId !== record.ownerId) throw new Error("Session owner mismatch");
    this.assertWritable(record);
    this.write(record);
  }

  assertWritable(record: StoredSession): void {
    if (!validRoleSnapshot(record)) throw new Error("Invalid Session role execution snapshot");
  }

  private write(record: StoredSession): void {
    this.persist(record);
    this.records.set(record.sessionId, record);
  }

  private persist(record: StoredSession): void {
    const path = resolve(this.directory, `${encodeURIComponent(record.sessionId)}.json`);
    const temp = `${path}.${process.pid}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
      renameSync(temp, path);
    } catch (error) {
      try { rmSync(temp, { force: true }); } catch {}
      throw error;
    }
  }

  close(): void {
    try {
      if (readFileSync(resolve(this.lock, "pid"), "utf8") === String(process.pid)) rmSync(this.lock, { recursive: true });
    } catch {}
  }

  private acquireLock(): void {
    try {
      mkdirSync(this.lock);
    } catch {
      const pid = Number(readFileSync(resolve(this.lock, "pid"), "utf8"));
      if (!Number.isSafeInteger(pid) || pid <= 0 || processIsAlive(pid)) {
        throw new Error(`stateDir is already owned by pid ${pid || "unknown"}`);
      }
      const reclaim = `${this.lock}.reclaim`;
      mkdirSync(reclaim);
      try {
        rmSync(this.lock, { recursive: true });
        mkdirSync(this.lock);
      } finally {
        rmSync(reclaim, { recursive: true });
      }
    }
    writeFileSync(resolve(this.lock, "pid"), String(process.pid), { mode: 0o600 });
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function recover(record: StoredSession): StoredSession {
  if (record.worker !== undefined) {
    const savedState = record.state === "saved" ? record.worker.savedState : record.state;
    return { ...record, state: "saved", worker: { ...record.worker, savedState }, approvals: [], events: record.events ?? [], nextEventSequence: record.nextEventSequence ?? 1, reports: record.reports ?? [] };
  }
  const state: RunState = record.state === "running" || record.state === "waiting-approval"
    ? "unknown"
    : record.state;
  return { ...record, state, approvals: [], events: record.events ?? [], nextEventSequence: record.nextEventSequence ?? 1, reports: record.reports ?? [] };
}

function parseRecord(text: string): StoredSession {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null) throw new Error("Invalid Session record");
  const record = value as Partial<StoredSession>;
  if (
    typeof record.ownerId !== "string"
    || typeof record.sessionId !== "string"
    || typeof record.cwd !== "string"
    || typeof record.state !== "string"
    || !Array.isArray(record.approvals)
    || !Array.isArray(record.events)
    || typeof record.nextEventSequence !== "number"
  ) throw new Error("Invalid Session record");
  if (record.worker !== undefined && (!validWorker(record.worker, record.state) || record.worker.parentSessionId !== record.ownerId)) {
    throw new Error("Invalid Session worker");
  }
  if (!validReports(record)) {
    throw new Error("Invalid Session reports");
  }
  if (!validPending(record.pending)) throw new Error("Invalid Session pending configuration");
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

/** Whether one record still owns and may operate its native thread. */
function claimsThread(record: StoredSession): boolean {
  return record.handedOff === undefined && occupied(record);
}

function occupied(record: StoredSession): boolean {
  if (record.worker === undefined) return !record.released;
  return !record.worker.detached
    || !["idle", "saved"].includes(record.state)
    || record.state === "saved" && record.worker.savedState !== "idle";
}

function validWorker(value: unknown, state: unknown): value is StoredWorker {
  if (typeof value !== "object" || value === null) return false;
  const worker = value as Partial<StoredWorker>;
  return typeof worker.parentSessionId === "string" && worker.parentSessionId.length > 0
    && (worker.main === undefined || worker.main === true && worker.owner === "user" && !worker.detached && worker.managedBy === undefined)
    && (worker.owner === "user" || worker.owner === "agent")
    && (worker.managedBy === undefined || worker.managedBy === "workflow")
    && (worker.role === undefined || typeof worker.role === "string" && worker.role.length > 0)
    && typeof worker.name === "string"
    && typeof worker.detached === "boolean"
    && validWorkerState(state)
    && (worker.savedState === undefined || validWorkerState(worker.savedState));
}

function validWorkerState(value: unknown): value is WorkerState {
  return typeof value === "string" && [
    "starting", "idle", "running", "interrupt-requested", "waiting-approval",
    "completed", "failed", "interrupted", "unknown", "saved",
  ].includes(value);
}

function validRoleSnapshot(record: Partial<StoredSession>): boolean {
  if (record.worker?.role === undefined) return true;
  const options = record.options;
  return typeof options?.model === "string" && options.model.length > 0
    && typeof options.reasoningEffort === "string" && options.reasoningEffort.length > 0
    && typeof options.developerInstructions === "string" && options.developerInstructions.length > 0
    && record.model === options.model
    && record.reasoningEffort === options.reasoningEffort;
}

function validReports(record: Partial<StoredSession>): boolean {
  if (record.reports === undefined) return true;
  if (!Array.isArray(record.reports)) return false;
  const turnIds = new Set<string>();
  return record.reports.every(report => {
    if (!validReport(report, record) || turnIds.has(report.turnId)) return false;
    turnIds.add(report.turnId);
    return true;
  });
}

function validReport(value: unknown, record: Partial<StoredSession>): value is Report {
  if (typeof value !== "object" || value === null) return false;
  const report = value as Partial<Report>;
  const acknowledged = report.acknowledgedAt === undefined || validTimestamp(report.acknowledgedAt);
  return typeof report.workerId === "string" && report.workerId.length > 0 && report.workerId === record.sessionId
    && typeof report.threadId === "string" && report.threadId.length > 0
    && (record.worker === undefined || report.threadId === record.threadId)
    && typeof report.turnId === "string" && report.turnId.length > 0
    && ["completed", "failed", "interrupted"].includes(report.status ?? "")
    && typeof report.result === "string"
    && (report.protocolError === undefined || typeof report.protocolError === "string")
    && (report.error === undefined || typeof report.error === "string")
    && (report.usage === null || validUsage(report.usage))
    && (report.turnUsage === undefined || validUsageValues(report.turnUsage))
    && validTimestamp(report.createdAt)
    && ["pending", "accepted", "changes-requested"].includes(report.acceptance ?? "")
    && acknowledged
    && (report.acceptance === "pending" || report.acknowledgedAt !== undefined)
    && (report.acceptance !== "accepted" || report.result.trim().length > 0 && report.protocolError === undefined);
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
