import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CodexSessionBackend } from "../lib/backend.js";

class FakeServer extends EventEmitter {
  calls = [];
  responses = [];
  turn = 0;
  constructor(hub) { super(); this.hub = hub; hub.servers.push(this); }
  async connect() {}
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === "thread/start") {
      this.threadId = `thread-${++this.hub.thread}`;
      return { thread: { id: this.threadId }, model: "model" };
    }
    if (method === "thread/resume") {
      this.threadId = params.threadId;
      return { thread: { id: this.threadId, status: { type: "idle" }, turns: [] } };
    }
    if (method === "thread/read") return {
      thread: { id: params.threadId, cwd: this.hub.cwd, status: { type: "idle" }, turns: [] },
    };
    if (method === "turn/start") {
      const id = `${this.threadId}-turn-${++this.turn}`;
      this.emit("notification", { method: "turn/started", params: { threadId: this.threadId, turn: { id } } });
      return { turn: { id, status: "inProgress" } };
    }
    return {};
  }
  respond(id, result) { this.responses.push({ id, result }); }
  reject(id, message) { this.responses.push({ id, message }); }
  async close() {}
}

const agentCaller = nativeSessionId => ({ nativeSessionId, source: "agent", parentAgent: { id: "agent", nativeSessionId } });

test("isolates parent workers, rejects UI callers and retains legacy user ownership", async t => {
  const stateDir = mkdtempSync(join(tmpdir(), "dsh-worker-ownership-"));
  const cwd = mkdtempSync(join(tmpdir(), "dsh-worker-cwd-"));
  t.after(() => { rmSync(stateDir, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true }); });
  mkdirSync(join(stateDir, "sessions"));
  const legacy = { ownerId: "parent-a", sessionId: "private", threadId: "private-thread", cwd,
    state: "idle", approvals: [], facts: [], reports: [],
    worker: { parentSessionId: "parent-a", owner: "user", name: "Private", detached: false } };
  writeFileSync(join(stateDir, "sessions/private.json"), JSON.stringify(legacy));
  const hub = { cwd, thread: 0, servers: [] };
  const backend = new CodexSessionBackend(stateDir, () => new FakeServer(hub));
  t.after(() => backend.close());
  const caller = agentCaller("parent-a"), management = [];
  backend.subscribeWorkers(caller, event => management.push(event));
  const worker = await backend.createWorker(caller, { id: "agent-worker", name: "Agent", cwd });
  assert.deepEqual((await backend.listWorkers(caller)).map(worker => worker.id), ["agent-worker"]);
  assert.deepEqual(await backend.listWorkers(agentCaller("parent-b")), []);
  for (const invalid of [
    { nativeSessionId: "parent-a", source: "ui" },
    { nativeSessionId: "parent-a", source: "agent" },
    { ...caller, parentAgent: null },
    { ...caller, parentAgent: { id: 1, nativeSessionId: "parent-a" } },
    { ...caller, parentAgent: { id: "", nativeSessionId: "parent-a" } },
    { ...caller, parentAgent: { id: "agent", nativeSessionId: "parent-b" } },
  ]) await assert.rejects(backend.listWorkers(invalid), /Invalid contextual caller/);
  await assert.rejects(backend.getWorker(caller, "private"), /Worker not found/);
  await assert.rejects(backend.startTurn(caller, "private", "no"), /Worker not found/);
  await assert.rejects(backend.getWorker(agentCaller("parent-b"), worker.id), /Worker not found/);
  await assert.rejects(backend.readSession("parent-a", worker.id), /Contextual caller required/);
  const turn = await backend.startTurn(caller, worker.id, "approval");
  const server = hub.servers.at(-1);
  server.emit("request", { id: "approval", method: "item/fileChange/requestApproval",
    params: { threadId: worker.threadId, turnId: turn.turnId } });
  const [approval] = await backend.pendingApprovals(caller, worker.id);
  await assert.rejects(backend.decideApproval(agentCaller("parent-b"), worker.id, approval.requestId, "decline"), /Worker not found/);
  await assert.rejects(backend.decideApproval(caller, worker.id, approval.requestId, "cancel"), /Invalid approval decision/);
  assert.deepEqual(server.responses, []);
  await backend.decideApproval(caller, worker.id, approval.requestId, "decline");
  assert.deepEqual(server.responses, [{ id: "approval", result: { decision: "decline" } }]);
  const ready = [];
  backend.subscribe(caller, worker.id, event => { if (event.type === "report.ready") ready.push(event); });
  server.emit("notification", { method: "item/completed", params: { threadId: worker.threadId,
    turnId: turn.turnId, item: { type: "agentMessage", phase: "final_answer", text: "agent result" } } });
  server.emit("notification", { method: "turn/completed", params: { threadId: worker.threadId,
    turn: { id: turn.turnId, status: "completed" } } });
  assert.deepEqual(ready, [{ type: "report.ready", workerId: worker.id, turnId: turn.turnId, parentSessionId: "parent-a" }]);
  const projection = await backend.getWorker(caller, worker.id);
  projection.reports[0].result = "mutated";
  assert.equal((await backend.getWorker(caller, worker.id)).reports[0].result, "agent result");
  assert.equal("group" in projection, false);
  assert.deepEqual(management.map(({ change }) => change), ["created", "report"]);
});
