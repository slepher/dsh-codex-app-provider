import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SessionStore } from "../lib/store.js";

test("persists ownership and recovers an uncertain run as unknown", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "dsh-codex-kit-store-"));
  const first = new SessionStore(stateDir);
  first.put({
    ownerId: "owner-1",
    sessionId: "session-1",
    cwd: "/work",
    state: "running",
    approvals: [],
    events: [],
    nextEventSequence: 1,
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
    events: [],
    nextEventSequence: 1,
    reports,
    ...(worker === undefined ? {} : { worker }),
  });
  store.close();
}

test("accepts valid historical report records", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "dsh-codex-kit-valid-reports-"));
  persist(stateDir, [
    report({ turnId: "old-pending", createdAt: 0, acknowledgedAt: 0 }),
    report({ turnId: "old-accepted", acceptance: "accepted", result: "done", acknowledgedAt: 3 }),
    report({ turnId: "old-changes", acceptance: "changes-requested", acknowledgedAt: 4 }),
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
    ["worker identity", [report({ workerId: "other" })]],
    ["empty worker identity", [report({ workerId: "" })]],
    ["empty thread identity", [report({ threadId: "" })]],
    ["empty turn identity", [report({ turnId: "" })]],
    ["duplicate turn", [report({ turnId: "same" }), report({ turnId: "same", status: "failed" })]],
    ["accepted empty result", [report({ acceptance: "accepted", acknowledgedAt: 2 })]],
    ["accepted protocol error", [report({ acceptance: "accepted", result: "done", protocolError: "bad", acknowledgedAt: 2 })]],
    ["accepted without acknowledgement", [report({ acceptance: "accepted", result: "done" })]],
    ["changes without acknowledgement", [report({ acceptance: "changes-requested" })]],
    ["negative creation time", [report({ createdAt: -1 })]],
    ["fractional acknowledgement time", [report({ acknowledgedAt: 1.5 })]],
    ["negative usage count", [report({ usage: { ...usage, total: { ...usage.total, totalTokens: -1 } } })]],
    ["usage ratio above one", [report({ usage: { ...usage, remainingContextRatio: 1.1 } })]],
  ];
  for (const [name, reports] of invalid) {
    const stateDir = mkdtempSync(join(tmpdir(), "dsh-codex-kit-invalid-reports-"));
    persist(stateDir, reports);
    assert.throws(() => new SessionStore(stateDir), /Invalid Session reports/, name);
    rmSync(stateDir, { recursive: true });
  }

  const workerDir = mkdtempSync(join(tmpdir(), "dsh-codex-kit-invalid-reports-"));
  persist(workerDir, [report({ threadId: "other" })], { parentSessionId: "owner", owner: "agent", name: "worker", detached: false });
  assert.throws(() => new SessionStore(workerDir), /Invalid Session reports/, "worker thread identity");
  rmSync(workerDir, { recursive: true });
});

test("keeps legacy records unbound and recovers complete worker records with unified occupancy", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "dsh-codex-kit-worker-store-"));
  const store = new SessionStore(stateDir);
  const put = (sessionId, state, detached, threadId) => store.put({
    ownerId: "parent", sessionId, threadId, cwd: "/work", state,
    approvals: [], events: [], nextEventSequence: 1, reports: [],
    worker: { parentSessionId: "parent", owner: "agent", name: sessionId, detached },
  });
  store.put({ ownerId: "parent", sessionId: "legacy", threadId: "legacy-thread", cwd: "/work", state: "idle", approvals: [], events: [], nextEventSequence: 1, reports: [] });
  put("attached", "idle", false, "attached-thread");
  put("detached-idle", "idle", true, "free-thread");
  put("detached-running", "running", true, "busy-thread");
  store.close();

  const recovered = new SessionStore(stateDir);
  assert.equal(recovered.get("parent", "legacy").worker, undefined);
  assert.deepEqual(recovered.list("parent").map(record => record.sessionId), ["legacy"]);
  assert.throws(() => recovered.get("parent", "attached"), /Contextual caller required/);
  assert.deepEqual(recovered.listWorkers("parent").map(record => record.sessionId), ["attached"]);
  assert.equal(recovered.bound("attached").state, "saved");
  assert.equal(recovered.bound("attached").worker.savedState, "idle");
  assert.equal(recovered.bound("detached-running").worker.savedState, "running");
  assert.deepEqual(new Set(recovered.occupiedThreads()), new Set(["legacy-thread", "attached-thread", "busy-thread"]));
  recovered.close();
  rmSync(stateDir, { recursive: true });
});

test("rejects partial or owner-mismatched worker blocks", () => {
  for (const worker of [
    { parentSessionId: "parent" },
    { parentSessionId: "other", owner: "user", name: "worker", detached: false },
  ]) {
    const stateDir = mkdtempSync(join(tmpdir(), "dsh-codex-kit-invalid-worker-"));
    const store = new SessionStore(stateDir);
    store.put({ ownerId: "parent", sessionId: "worker", cwd: "/work", state: "idle", approvals: [], events: [], nextEventSequence: 1, reports: [], worker });
    store.close();
    assert.throws(() => new SessionStore(stateDir), /Invalid Session worker/);
    rmSync(stateDir, { recursive: true });
  }
});

test("adopts through a disk-first commit while retaining the authoritative object", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "dsh-codex-kit-adopt-commit-"));
  const store = new SessionStore(stateDir);
  store.put({
    ownerId: "old-parent", sessionId: "worker", threadId: "thread", cwd: "/work", state: "idle",
    approvals: [], events: [], nextEventSequence: 1, reports: [],
    worker: { parentSessionId: "old-parent", owner: "agent", name: "Worker", detached: true },
  });
  const record = store.bound("worker");
  const path = join(stateDir, "sessions", "worker.json");
  const before = readFileSync(path, "utf8");
  const blockedTemp = `${path}.${process.pid}.tmp`;
  mkdirSync(blockedTemp);
  assert.throws(() => store.adopt("worker", "new-parent", "thread"));
  assert.equal(record.ownerId, "old-parent");
  assert.equal(record.worker.parentSessionId, "old-parent");
  assert.equal(record.worker.owner, "agent");
  assert.equal(record.worker.detached, true);
  assert.equal(readFileSync(path, "utf8"), before);
  rmSync(blockedTemp, { recursive: true, force: true });

  const adopted = store.adopt("worker", "new-parent", "thread");
  assert.equal(adopted, record);
  assert.equal(record.ownerId, "new-parent");
  assert.equal(record.worker.parentSessionId, "new-parent");
  assert.equal(record.worker.owner, "user");
  assert.equal(record.worker.detached, false);
  store.close();
  rmSync(stateDir, { recursive: true });
});
