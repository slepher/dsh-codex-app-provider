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

import { claimsThread, parseRecord, recover, type StoredSession } from "./records.js";

export type { StoredHandoffIn, StoredHandoffOut, StoredSession } from "./records.js";

/**
 * The provider's own durable record of every native Session it created.
 *
 * Two responsibilities, and only these two: the state directory this process
 * exclusively owns, and the records it keeps there. What a record *is* lives in
 * `records.ts`; how one is read back without trusting a malformed file lives
 * there too.
 */
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
    return [...this.records.values()].filter(record => record.ownerId === ownerId);
  }

  has(sessionId: string): boolean {
    return this.records.has(sessionId);
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
