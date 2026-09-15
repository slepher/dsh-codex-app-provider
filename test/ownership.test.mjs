import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
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

const privateCaller = nativeSessionId => ({ nativeSessionId, source: "ui" });
const agentCaller = nativeSessionId => ({ nativeSessionId, source: "agent", parentAgent: { id: "agent", nativeSessionId } });
const agentUiCaller = nativeSessionId => ({ nativeSessionId, source: "ui", parentAgent: { id: "agent", nativeSessionId } });

test("isolates private and agent-owned workers and decides an agent worker's approval", async t => {
  const stateDir = mkdtempSync(join(tmpdir(), "dsh-worker-ownership-"));
  const cwd = mkdtempSync(join(tmpdir(), "dsh-worker-cwd-"));
  t.after(() => { rmSync(stateDir, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true }); });
  const hub = { cwd, thread: 0, servers: [] };
  const backend = new CodexSessionBackend(stateDir, () => new FakeServer(hub));
  t.after(() => backend.close());
  const uiA = privateCaller("parent-a"), agentA = agentCaller("parent-a"), agentUiA = agentUiCaller("parent-a");
  const management = [];
  backend.subscribeWorkers(agentUiA, event => management.push(event));

  const privateWorker = await backend.createWorker(uiA, { id: "private", name: "Private", cwd });
  const agentWorker = await backend.createWorker(agentA, { id: "agent-worker", name: "Agent", cwd });
  assert.deepEqual((await backend.listWorkers(uiA)).map(worker => worker.id), ["private"]);
  assert.deepEqual((await backend.listWorkers(agentA)).map(worker => worker.id), ["agent-worker"]);
  assert.deepEqual((await backend.listWorkers(agentUiA)).map(worker => worker.id), ["private", "agent-worker"]);
  await assert.rejects(backend.listWorkers({ nativeSessionId: "parent-a", source: "agent" }), /Invalid contextual caller/);
  await assert.rejects(backend.listWorkers({ nativeSessionId: "parent-a", source: "ui", parentAgent: null }), /Invalid contextual caller/);
  await assert.rejects(backend.listWorkers({ nativeSessionId: "parent-a", source: "ui", parentAgent: { id: 1, nativeSessionId: "parent-a" } }), /Invalid contextual caller/);
  await assert.rejects(backend.listWorkers({ nativeSessionId: "parent-a", source: "ui", parentAgent: { id: "", nativeSessionId: "parent-a" } }), /Invalid contextual caller/);
  await assert.rejects(backend.getWorker({ nativeSessionId: "parent-a", source: "ui", parentAgent: { id: "agent", nativeSessionId: "parent-b" } }, privateWorker.id), /Invalid contextual caller/);
  assert.equal((await backend.getWorker(agentUiA, privateWorker.id)).owner, "user");
  await assert.rejects(backend.getWorker(agentA, privateWorker.id), /Worker not found/);
  await assert.rejects(backend.readReports(uiA, agentWorker.id), /Worker not found/);
  await assert.rejects(backend.startTurn(privateCaller("parent-b"), privateWorker.id, "no"), /Worker not found/);
  await assert.rejects(backend.history(agentA, privateWorker.id), /Worker not found/);
  assert.throws(() => backend.subscribe(agentA, privateWorker.id, () => {}), /Worker not found/);
  await assert.rejects(backend.readSession("parent-a", privateWorker.id), /Contextual caller required/);

  const agentTurn = await backend.startTurn(agentA, agentWorker.id, "approval");
  const agentServer = hub.servers.find(server => server.threadId === agentWorker.threadId);
  agentServer.emit("request", {
    id: "agent-approval",
    method: "item/fileChange/requestApproval",
    params: { threadId: agentWorker.threadId, turnId: agentTurn.turnId },
  });
  const [agentApproval] = await backend.pendingApprovals(agentA, agentWorker.id);
  // A worker approval is decided by the caller that owns the worker: the parent
  // Agent the plugin's bridge answers for, or the UI conversation it came from.
  // Ownership is the check, so a different parent and an invalid verdict are
  // both refused without touching the native request.
  await assert.rejects(backend.decideApproval(agentCaller("parent-b"), agentWorker.id, agentApproval.requestId, "decline"), /Worker not found/);
  await assert.rejects(backend.decideApproval(agentA, agentWorker.id, agentApproval.requestId, "cancel"), /Invalid approval decision/);
  assert.deepEqual(agentServer.responses, []);
  await backend.decideApproval(agentA, agentWorker.id, agentApproval.requestId, "decline");
  assert.deepEqual(agentServer.responses, [{ id: "agent-approval", result: { decision: "decline" } }]);

  // A completed agent-owned turn announces its report to the parent it belongs to.
  const ready = [];
  backend.subscribe(agentA, agentWorker.id, event => { if (event.type === "report.ready") ready.push(event); });
  agentServer.emit("notification", {
    method: "item/completed",
    params: { threadId: agentWorker.threadId, turnId: agentTurn.turnId, item: { type: "agentMessage", phase: "final_answer", text: "agent result" } },
  });
  agentServer.emit("notification", {
    method: "turn/completed",
    params: { threadId: agentWorker.threadId, turn: { id: agentTurn.turnId, status: "completed" } },
  });
  assert.deepEqual(ready, [{ type: "report.ready", workerId: "agent-worker", turnId: agentTurn.turnId, parentSessionId: "parent-a" }]);

  const first = await backend.startTurn(uiA, privateWorker.id, "first");
  const privateServer = hub.servers.find(server => server.threadId === privateWorker.threadId);
  privateServer.emit("notification", {
    method: "item/completed",
    params: { threadId: privateWorker.threadId, turnId: first.turnId, item: { type: "agentMessage", phase: "final_answer", text: "first result" } },
  });
  privateServer.emit("notification", {
    method: "turn/completed",
    params: { threadId: privateWorker.threadId, turn: { id: first.turnId, status: "completed" } },
  });
  const projection = await backend.getWorker(uiA, privateWorker.id);
  assert.equal(projection.group, "user");
  projection.reports[0].result = "mutated";
  assert.equal((await backend.getWorker(uiA, privateWorker.id)).reports[0].result, "first result");

  // A user-owned worker reports to nobody: its completion is not a parent notice.
  assert.deepEqual(management.map(({ workerId, change, invalidated }) => [workerId, change, invalidated]), [
    ["private", "created", undefined],
    ["agent-worker", "created", undefined],
    ["agent-worker", "report", undefined],
  ]);
});
