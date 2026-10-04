import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, resolve } from "node:path";

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
  WorkerState,
} from "./browser-types.js";

export interface StoredWorker {
  parentSessionId: string;
  /** `user` is accepted only when loading a legacy UI worker. */
  owner: "agent" | "user";
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
  operation?: "turn" | "compact";
  released?: boolean;
  approvals: ApprovalRequest[];
  options?: CreateSessionOptions;
  /** Projected execution facts, in transcript order; the raw notifications are not kept. */
  facts: ExecutionFactLine[];
  reports: Report[];
  worker?: StoredWorker;
}

export class SessionStore {
  private readonly directory: string;
  private readonly lock: string;
  private readonly records = new Map<string, StoredSession>();

  /**
   * Own one state directory.
   *
   * This store writes through `node:fs` on purpose. The platform filesystem
   * seam (`ctx.fs`) is sandbox-fenced: under `workspace-write` it refuses every
   * target outside the policy's writable roots, and this plugin's state
   * directory lives under `$DSH_HOME/state/<profile>/codex`, which is outside
   * the workspace — verified live on 0.2.0-rc.2, where a write here fails with
   * `FS_SANDBOX_DENIED`. The seam also models text reads and version-guarded
   * writes only; it has no exclusive directory creation, rename or directory
   * listing, which is exactly what the single-owner lock and the record
   * directory need. The record layer's convergence target is therefore
   * `ctx.storageDomain` (a storage backend owns layout and atomicity), not
   * `ctx.fs`.
   * @param stateDir - absolute directory this store exclusively owns.
   */
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
        const recovered = recover(record);
        this.records.set(recovered.sessionId, recovered);
        // A projected record is written back, so the mirror is gone from disk too.
        if (record.events !== undefined) this.write(recovered);
      }
    } catch (error) {
      this.close();
      throw error;
    }
  }

  list(ownerId: string): StoredSession[] {
    return [...this.records.values()].filter(record => record.worker === undefined && record.ownerId === ownerId);
  }

  listWorkers(parentSessionId: string): StoredSession[] {
    return [...this.records.values()].filter(record => record.worker?.owner === "agent" && record.worker.parentSessionId === parentSessionId && !record.worker.detached);
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

  /**
   * One record by Session identity, whatever backs it.
   *
   * The Host's own Session lifecycle reports disposal as a fact, not as a
   * caller, so the release path cannot go through an ownership-checked getter.
   * @param sessionId - provider-side Session identity.
   * @returns the record, when this store has one.
   */
  lookup(sessionId: string): StoredSession | undefined {
    return this.records.get(sessionId);
  }

  get(ownerId: string, sessionId: string): StoredSession | undefined {
    const record = this.records.get(sessionId);
    if (record?.worker !== undefined) throw new Error("Contextual caller required for bound worker");
    if (record !== undefined && record.ownerId !== ownerId) throw new Error("Session owner mismatch");
    return record;
  }

  put(record: StoredSession): void {
    record.updatedAt = Date.now();
    const existing = this.records.get(record.sessionId);
    if (existing !== undefined && existing.ownerId !== record.ownerId) throw new Error("Session owner mismatch");
    this.write(record);
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
      const read = readLockOwner(this.lock);
      if (read.state === "live" && read.owner.pid === process.pid) rmSync(this.lock, { recursive: true });
    } catch {}
  }

  private acquireLock(): void {
    try {
      mkdirSync(this.lock);
    } catch {
      const read = readLockOwner(this.lock);
      // A live owner is authoritative: two backends must never share a store.
      if (read.state === "live") {
        throw new Error(`stateDir is already owned by pid ${read.owner.pid} (${this.lock})`);
      }
      // A lock that cannot be read back is left for a human: the provider never
      // guesses its way past an owner it cannot identify.
      if (read.state === "unknown") {
        throw new Error(`stateDir is already owned by an unreadable lock (${this.lock})`);
      }
      // The claim directory keeps two reclaimers from tearing down the same lock.
      const reclaim = `${this.lock}.reclaim`;
      mkdirSync(reclaim);
      try {
        rmSync(this.lock, { recursive: true });
        mkdirSync(this.lock);
      } finally {
        rmSync(reclaim, { recursive: true });
      }
    }
    writeOwner(this.lock);
  }
}

/**
 * The process a lock directory names, as far as it can be read back.
 *
 * `pid` alone is what an owner wrote before locks carried an identity. `start` is
 * the process start time in clock ticks since boot and `boot` is the boot's own
 * identity: no later process can reuse that pair, so the two tell a live owner
 * apart from a stale lock whose pid number the OS has since recycled.
 */
interface LockOwner {
  pid: number;
  start?: number;
  boot?: string;
}

type LockRead =
  | { state: "live"; owner: LockOwner }
  | { state: "stale"; owner: LockOwner }
  | { state: "unknown" };

function readLockOwner(lock: string): LockRead {
  let text: string;
  try {
    text = readFileSync(resolve(lock, "owner.json"), "utf8");
  } catch {
    try {
      text = readFileSync(resolve(lock, "pid"), "utf8");
    } catch {
      return { state: "unknown" };
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return classifyPid(text);
  }
  // A bare number is a legacy pid-only lock file, not an owner document.
  if (typeof parsed === "number") return classifyPid(parsed);
  if (typeof parsed !== "object" || parsed === null) return { state: "unknown" };
  const { pid, start, boot } = parsed as Record<string, unknown>;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return { state: "unknown" };
  return classifyOwner({
    pid,
    start: typeof start === "number" && Number.isSafeInteger(start) && start >= 0 ? start : undefined,
    boot: typeof boot === "string" && boot.length > 0 ? boot : undefined,
  });
}

/** A lock file that names its owner by pid alone, as older versions wrote it. */
function classifyPid(text: string | number): LockRead {
  const pid = typeof text === "number" ? text : Number(text);
  return Number.isSafeInteger(pid) && pid > 0 ? classifyOwner({ pid }) : { state: "unknown" };
}

/**
 * Whether the process named by a readable lock is still the one that claimed it.
 *
 * An owner that left no identity can never be told apart from a recycled pid, so
 * it keeps the directory for as long as some process holds its pid number.
 */
function classifyOwner(owner: LockOwner): LockRead {
  if (!processIsAlive(owner.pid)) return { state: "stale", owner: { pid: owner.pid } };
  if (owner.start === undefined || owner.boot === undefined) return { state: "live", owner };
  const current = processIdentity(owner.pid);
  return current !== undefined && owner.start === current.start && owner.boot === current.boot
    ? { state: "live", owner }
    : { state: "stale", owner: { pid: owner.pid } };
}

function processIdentity(pid: number): { start: number; boot: string } | undefined {
  const start = processStartTime(pid);
  const boot = bootIdentity();
  return start === undefined || boot === undefined ? undefined : { start, boot };
}

function writeOwner(lock: string): void {
  const owner: LockOwner = { pid: process.pid, ...processIdentity(process.pid) };
  writeFileSync(resolve(lock, "owner.json"), JSON.stringify(owner), { mode: 0o600 });
  try {
    unlinkSync(resolve(lock, "pid"));
  } catch {}
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** One boot's identity, so a pid from an earlier boot is never mistaken for its successor. */
function bootIdentity(): string | undefined {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * A process's start time in clock ticks since boot.
 *
 * Field 3 of `/proc/<pid>/stat` is the command, and it may itself contain spaces
 * or parentheses, so the fields after it are read from behind the last `)`.
 */
export function processStartTime(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const start = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[19];
    const ticks = Number(start);
    return Number.isSafeInteger(ticks) && ticks >= 0 ? ticks : undefined;
  } catch {
    return undefined;
  }
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

function recover(record: LoadedRecord): StoredSession {
  const { events, nextEventSequence: _cursor, ...rest } = record;
  const facts = record.facts ?? projectExecutionFacts(reduceExecutionEvents(events ?? []));
  const current: StoredSession = { ...rest, facts: [...facts] };
  if (record.worker !== undefined) {
    const savedState = record.state === "saved" ? record.worker.savedState : record.state;
    return { ...current, state: "saved", worker: { ...record.worker, savedState }, approvals: [], reports: record.reports ?? [] };
  }
  const state: RunState = record.state === "running" || record.state === "waiting-approval"
    ? "unknown"
    : record.state;
  return { ...current, state, approvals: [], reports: record.reports ?? [] };
}

function parseRecord(text: string): LoadedRecord {
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
  if (record.worker !== undefined && (!validWorker(record.worker, record.state) || record.worker.parentSessionId !== record.ownerId)) {
    throw new Error("Invalid Session worker");
  }
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
    && (worker.owner === "user" || worker.owner === "agent")
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
