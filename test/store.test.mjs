import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SessionStore, processStartTime } from "../lib/store.js";

test("persists ownership and recovers an uncertain run as unknown", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "dsh-codex-kit-store-"));
  const first = new SessionStore(stateDir);
  first.put({
    ownerId: "owner-1",
    sessionId: "session-1",
    cwd: "/work",
    state: "running",
    approvals: [],
    facts: [],
  });
  assert.throws(() => first.get("owner-2", "session-1"), /owner mismatch/);
  first.close();

  const second = new SessionStore(stateDir);
  assert.equal(second.get("owner-1", "session-1")?.state, "unknown");
  assert.deepEqual(second.get("owner-1", "session-1")?.reports, []);
  second.close();
  assert.match(readFileSync(join(stateDir, "sessions", "session-1.json"), "utf8"), /"ownerId": "owner-1"/);
  rmSync(stateDir, { recursive: true });
});

const report = overrides => ({
  workerId: "session",
  threadId: "thread",
  turnId: "turn",
  status: "completed",
  result: "",
  usage: null,
  createdAt: 1,
  acceptance: "pending",
  ...overrides,
});

const usage = {
  total: { totalTokens: 10, inputTokens: 6, cachedInputTokens: 2, cacheWriteInputTokens: 1, outputTokens: 4, reasoningOutputTokens: 3 },
  last: { totalTokens: 5, inputTokens: 3, cachedInputTokens: 1, cacheWriteInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 1 },
  modelContextWindow: 100,
  currentContextTokens: 5,
  remainingContextRatio: 0.95,
};

function persist(stateDir, reports, worker) {
  const store = new SessionStore(stateDir);
  store.put({
    ownerId: "owner",
    sessionId: "session",
    threadId: "thread",
    turnId: "current-turn",
    cwd: "/work",
    state: "idle",
    approvals: [],
    facts: [],
    reports,
  });
  store.close();
}

test("accepts valid historical report records", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "dsh-codex-kit-valid-reports-"));
  persist(stateDir, [
    report({ turnId: "old-completed", createdAt: 0 }),
    report({ turnId: "old-failed", status: "failed", result: "", createdAt: 3 }),
    report({ turnId: "old-interrupted", status: "interrupted", result: "", createdAt: 4 }),
    report({ turnId: "rebuilt-thread", threadId: "previous-thread" }),
    report({ turnId: "current-turn", usage }),
  ]);
  const reopened = new SessionStore(stateDir);
  assert.equal(reopened.get("owner", "session").reports.length, 5, "provider reports may come from threads replaced by a rebuild");
  reopened.close();
  rmSync(stateDir, { recursive: true });
});

test("rejects invalid persisted report records", () => {
  const invalid = [
    ["reports shape", {}],
    ["empty thread identity", [report({ threadId: "" })]],
    ["empty turn identity", [report({ turnId: "" })]],
    ["duplicate turn", [report({ turnId: "same" }), report({ turnId: "same", status: "failed" })]],
    ["unknown status", [report({ status: "saved" })]],
    ["negative creation time", [report({ createdAt: -1 })]],
    ["negative usage count", [report({ usage: { ...usage, total: { ...usage.total, totalTokens: -1 } } })]],
    ["usage ratio above one", [report({ usage: { ...usage, remainingContextRatio: 1.1 } })]],
  ];
  for (const [name, reports] of invalid) {
    const stateDir = mkdtempSync(join(tmpdir(), "dsh-codex-kit-invalid-reports-"));
    persist(stateDir, reports);
    assert.throws(() => new SessionStore(stateDir), /Invalid Session reports/, name);
    rmSync(stateDir, { recursive: true });
  }

});

test("occupancy follows release and handover rather than the record's momentary state", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "dsh-codex-kit-occupancy-"));
  const store = new SessionStore(stateDir);
  const put = (sessionId, extra) => store.put({ ownerId: "parent", sessionId, cwd: "/work", state: "idle", approvals: [], facts: [], reports: [], ...extra });
  put("live", { threadId: "live-thread" });
  put("released", { threadId: "released-thread", released: true });
  put("handed", { threadId: "handed-thread", handedOff: { toSessionId: "successor", requestId: "r1", at: 1 } });
  store.close();

  const recovered = new SessionStore(stateDir);
  assert.deepEqual(recovered.occupiedThreads(), ["live-thread"]);
  assert.equal(recovered.get("parent", "released").released, true, "the release survives the reload");
  assert.equal(recovered.get("parent", "handed").handedOff.toSessionId, "successor");
  assert.deepEqual(recovered.list("parent").map(record => record.sessionId).sort(), ["handed", "live", "released"]);
  recovered.close();
  rmSync(stateDir, { recursive: true });
});

// The lock's process identity is `/proc`-based, so this case can only assert
// what the platform can express.
const BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";

test("a lock is read by process identity, not by a recycled pid number",
  { skip: existsSync(BOOT_ID_PATH) ? false : "requires /proc boot identity (Linux)" }, async t => {
  const stateDir = mkdtempSync(join(tmpdir(), "dsh-codex-lock-identity-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const lock = join(stateDir, "owner.lock");
  const claim = owner => {
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "owner.json"), JSON.stringify(owner));
  };
  const start = processStartTime(process.pid);
  const boot = readFileSync(BOOT_ID_PATH, "utf8").trim();
  assert.notEqual(start, undefined, "this process has a start time to identify it by");

  // The process named by the lock is running and is still the process that wrote it.
  claim({ pid: process.pid, start, boot });
  assert.throws(() => new SessionStore(stateDir), /already owned by pid/);
  rmSync(lock, { recursive: true, force: true });

  // A later process under the same pid number is not the owner, so the lock is reclaimed.
  claim({ pid: process.pid, start: start - 1, boot });
  const reclaimed = new SessionStore(stateDir);
  reclaimed.close();
  assert.equal(existsSync(lock), false, "the recycled-pid lock is reclaimed and released on close");
});

test("a lock left by a process that died is reclaimed, a live owner's is not", async t => {
  const stateDir = mkdtempSync(join(tmpdir(), "dsh-codex-lock-stale-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  // A process that has already exited cannot own the directory any more.
  const dead = spawnSync(process.execPath, ["-e", ""]).pid;
  mkdirSync(join(stateDir, "owner.lock"), { recursive: true });
  writeFileSync(join(stateDir, "owner.lock", "pid"), String(dead));
  const reclaimed = new SessionStore(stateDir);
  reclaimed.close();
  assert.equal(existsSync(join(stateDir, "owner.lock")), false, "the reclaimed lock is released on close");

  // A running owner is authoritative: two backends must never share a store.
  mkdirSync(join(stateDir, "owner.lock"), { recursive: true });
  writeFileSync(join(stateDir, "owner.lock", "pid"), String(process.pid));
  assert.throws(() => new SessionStore(stateDir), /already owned by pid/);
  rmSync(join(stateDir, "owner.lock"), { recursive: true, force: true });
});

test("a record written with the notification mirror is projected once on load", async t => {
  const stateDir = mkdtempSync(join(tmpdir(), "dsh-codex-legacy-mirror-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  mkdirSync(join(stateDir, "sessions"), { recursive: true });
  const legacy = {
    ownerId: "owner", sessionId: "session", cwd: "/work", state: "idle", approvals: [], reports: [],
    nextEventSequence: 3,
    events: [{ sequence: 1, event: { type: "thread.notification", method: "item/completed", params: {
      threadId: "thread-1", turnId: "turn-1",
      item: { id: "cmd-1", type: "commandExecution", command: "printf MIGRATED", status: "completed", exitCode: 0, aggregatedOutput: "MIGRATED" } } } }],
  };
  writeFileSync(join(stateDir, "sessions", "session.json"), `${JSON.stringify(legacy, null, 2)}\n`);

  const store = new SessionStore(stateDir);
  const record = store.get("owner", "session");
  assert.deepEqual(record.facts.map(line => line.text), [
    "[source: codex thread=thread-1 turn=turn-1 item=cmd-1] command: printf MIGRATED (exit 0)",
    "[source: codex thread=thread-1 turn=turn-1 item=cmd-1] MIGRATED",
  ], "the mirrored notifications project into the facts they described");
  store.close();

  const rewritten = JSON.parse(readFileSync(join(stateDir, "sessions", "session.json"), "utf8"));
  assert.equal("events" in rewritten, false, "the migration is durable, not only in memory");
  assert.equal("nextEventSequence" in rewritten, false);
  assert.equal(rewritten.facts.length, 2);
});
