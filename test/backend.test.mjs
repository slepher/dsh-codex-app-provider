import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CodexSessionBackend } from "../lib/backend.js";

class FakeServer extends EventEmitter {
  calls = [];
  responses = [];
  threadId = "thread-1";
  turn = 0;
  async connect() {}
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === "thread/start" || method === "thread/resume") {
      if (method === "thread/resume") this.threadId = params.threadId;
      return {
        thread: { id: this.threadId, path: this.threadPath, status: { type: "idle" }, turns: [] },
        cwd: params.cwd,
        model: "test-model",
        ...(params.approvalPolicy === undefined ? {} : { approvalPolicy: params.approvalPolicy }),
        // The sandbox is Codex's own configuration, so the scripted server
        // reports one without being asked; the plugin authors no permissions.
        sandbox: { type: "workspaceWrite", writableRoots: [params.cwd], excludeSlashTmp: true,
          excludeTmpdirEnvVar: true, networkAccess: false },
      };
    }
    if (method === "turn/start") {
      const id = `turn-${++this.turn}`;
      this.emit("notification", { method: "turn/started", params: { threadId: this.threadId, turn: { id } } });
      return { turn: { id, status: "inProgress" } };
    }
    if (method === "review/start") {
      const id = `review-${++this.turn}`;
      this.emit("notification", { method: "turn/started", params: { threadId: this.threadId, turn: { id } } });
      return { turn: { id, status: "inProgress" } };
    }
    if (method === "thread/compact/start") return {};
    if (method === "thread/list") return { data: [{ id: "history-thread", cwd: "/history", status: { type: "idle" } }], nextCursor: null };
    if (method === "thread/read") return params.includeTurns
      ? { thread: { turns: [{ id: "turn-1" }] } }
      : { thread: { id: params.threadId, cwd: "/history", status: { type: "idle" } }, model: "stored-model", reasoningEffort: "high" };
    return {};
  }
  respond(id, result) { this.responses.push({ id, result }); }
  reject(id, message) { this.responses.push({ id, message }); }
  async close() {}
}

test("binds one thread and deduplicates native retries with approval identity", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "dsh-codex-backend-"));
  const servers = [];
  const backend = new CodexSessionBackend(stateDir, () => {
    const server = new FakeServer();
    servers.push(server);
    return server;
  });
  try {
    let guarded;
    const removeGuard = backend.installGuard(mutation => {
      guarded = mutation;
      throw new Error("guarded");
    });
    await assert.rejects(backend.createSession("other", "reserved", "/work", {
      boundary: { cwd: "/work", writableRoots: ["/work/../lane", "/lane"], network: "disabled" },
    }), /guarded/);
    assert.deepEqual(guarded.boundary.writableRoots, ["/lane"]);
    removeGuard();

    const session = await backend.createSession("owner", "session", "/work");
    assert.equal(session.threadId, "thread-1");
    const events = [];
    backend.subscribe("owner", "session", event => { events.push(event); });
    const turn = await backend.startTurn("owner", "session", "hello", { idempotencyKey: "session:1:1" });
    const retry = await backend.startTurn("owner", "session", "hello", { idempotencyKey: "session:1:1" });
    assert.equal(retry.turnId, turn.turnId);
    assert.equal(servers[0].calls.filter(call => call.method === "turn/start").length, 1);

    servers[0].emit("request", {
      id: "wrong-turn",
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", turnId: "old-turn" },
    });
    assert.equal((await backend.readSession("owner", "session")).state, "running");
    assert.equal((await backend.pendingApprovals("owner", "session")).length, 0);
    servers[0].emit("request", {
      id: "rpc-approval",
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", turnId: turn.turnId },
    });
    const [approval] = await backend.pendingApprovals("owner", "session");
    assert.equal(approval.turnId, turn.turnId);
    await assert.rejects(backend.decideApproval("owner", approval.requestId, "bogus"), /Invalid approval decision/);
    assert.equal((await backend.pendingApprovals("owner", "session")).length, 1);
    await backend.decideApproval("owner", approval.requestId, "accept");
    assert.deepEqual(servers[0].responses, [
      { id: "wrong-turn", message: "No active turn" },
      { id: "rpc-approval", result: { decision: "accept" } },
    ]);

    await backend.interruptTurn("owner", turn.turnId);
    assert.equal((await backend.readSession("owner", "session")).state, "interrupt-requested");
    servers[0].emit("request", {
      id: "while-interrupting",
      method: "item/fileChange/requestApproval",
      params: { threadId: "thread-1" },
    });
    assert.equal((await backend.readSession("owner", "session")).state, "interrupt-requested");
    const [interruptApproval] = await backend.pendingApprovals("owner", "session");
    await backend.decideApproval("owner", interruptApproval.requestId, "cancel");
    servers[0].emit("notification", {
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: turn.turnId, status: "interrupted" } },
    });
    assert.equal((await backend.readSession("owner", "session")).state, "idle");
    assert.equal(events.at(-1).turn.state, "interrupted");
    const facts = await backend.readFacts("owner", "session");
    servers[0].emit("request", {
      id: "late",
      method: "item/fileChange/requestApproval",
      params: { threadId: "thread-1", turnId: turn.turnId },
    });
    assert.equal((await backend.readSession("owner", "session")).state, "idle");
    assert.equal((await backend.pendingApprovals("owner", "session")).length, 0);
    assert.deepEqual(await backend.readFacts("owner", "session"), facts, "a rejected late request records no execution fact");
    assert.deepEqual(servers[0].responses.slice(-2), [
      { id: "while-interrupting", result: { decision: "cancel" } },
      { id: "late", message: "No active turn" },
    ]);
    assert.deepEqual(await backend.history("owner", "session"), { source: "thread", turns: [{ id: "turn-1", status: undefined, startedAt: undefined, completedAt: undefined, durationMs: undefined, error: undefined }], items: [] });
  } finally {
    await backend.close();
  }

  const resumedServers = [];
  const resumed = new CodexSessionBackend(stateDir, () => {
    const server = new FakeServer();
    resumedServers.push(server);
    return server;
  });
  try {
    const turn = await resumed.startTurn("owner", "session", "again", { idempotencyKey: "session:2:1" });
    assert.equal(turn.threadId, "thread-1");
    assert.deepEqual(resumedServers[0].calls.slice(0, 2).map(call => call.method), ["thread/resume", "turn/start"]);
  } finally {
    await resumed.close();
    rmSync(stateDir, { recursive: true });
  }
});

test("surfaces an approval request from a bounded execution instead of declining for Codex", async t => {
  const stateDir = mkdtempSync(join(tmpdir(), "dsh-codex-boundary-approval-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const servers = [];
  const backend = new CodexSessionBackend(stateDir, () => { const server = new FakeServer(); servers.push(server); return server; });
  t.after(() => backend.close());
  await backend.createSession("owner", "boundary", "/work", {
    boundary: { cwd: "/work", writableRoots: ["/lane"], network: "disabled" },
  });
  const turn = await backend.startTurn("owner", "boundary", "work");
  const published = [];
  backend.subscribe("owner", "boundary", event => published.push(event.type));
  // A declared task boundary constrains where the thread may write; it is not an
  // approval policy. A request Codex sends to this client is surfaced and
  // decided on its real identity, never declined on Codex's behalf.
  servers[0].emit("request", {
    id: "unexpected",
    method: "item/commandExecution/requestApproval",
    params: { threadId: turn.threadId, turnId: turn.turnId },
  });
  assert.deepEqual(servers[0].responses, []);
  const pending = await backend.pendingApprovals("owner", "boundary");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].method, "item/commandExecution/requestApproval");
  assert.equal((await backend.readSession("owner", "boundary")).state, "waiting-approval");
  assert.ok(published.includes("approval.requested"), "the native approval reaches a subscriber");
  await backend.decideApproval("owner", pending[0].requestId, "accept");
  assert.deepEqual(servers[0].responses, [{ id: "unexpected", result: { decision: "accept" } }]);
  assert.equal((await backend.pendingApprovals("owner", "boundary")).length, 0);
});

test("grants permissions turns, answers non-interactive user input empty, and declines elicitation", async t => {
  const stateDir = mkdtempSync(join(tmpdir(), "dsh-codex-interactive-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const servers = [];
  const backend = new CodexSessionBackend(stateDir, () => { const server = new FakeServer(); servers.push(server); return server; });
  t.after(() => backend.close());

  const session = await backend.createSession("owner", "session", "/work");
  const turn = await backend.startTurn("owner", "session", "hello");
  const server = servers[0];

  server.emit("request", {
    id: "permissions",
    method: "item/permissions/requestApproval",
    params: { threadId: session.threadId, turnId: turn.turnId, permissions: { network: { enabled: true }, fileSystem: null } },
  });
  const [granted] = await backend.pendingApprovals("owner", "session");
  assert.equal(granted.method, "item/permissions/requestApproval");
  await backend.decideApproval("owner", granted.requestId, "accept");
  assert.deepEqual(server.responses.at(-1), {
    id: "permissions",
    result: { permissions: { network: { enabled: true }, fileSystem: null }, scope: "turn" },
  });

  server.emit("request", {
    id: "permissions-denied",
    method: "item/permissions/requestApproval",
    params: { threadId: session.threadId, turnId: turn.turnId, permissions: { fileSystem: { read: ["/x"], write: null } } },
  });
  const [denied] = await backend.pendingApprovals("owner", "session");
  await backend.decideApproval("owner", denied.requestId, "decline");
  assert.deepEqual(server.responses.at(-1), { id: "permissions-denied", result: { permissions: {}, scope: "turn" } });

  server.emit("request", {
    id: "input-empty",
    method: "item/tool/requestUserInput",
    params: { threadId: session.threadId, turnId: turn.turnId, questions: [{ id: "q", header: "H", question: "Q?", isOther: false, isSecret: false, options: null }] },
  });
  assert.deepEqual(server.responses.at(-1), { id: "input-empty", result: { answers: {} } });

  server.emit("request", {
    id: "elicitation",
    method: "mcpServer/elicitation/request",
    params: { threadId: session.threadId, turnId: turn.turnId, serverName: "mcp", mode: "form", _meta: null, message: "need", requestedSchema: { type: "object" } },
  });
  assert.deepEqual(server.responses.at(-1), { id: "elicitation", result: { action: "decline", content: null, _meta: null } });
});

test("routes blocking user input to an interactive subscriber and answers exactly once", async t => {
  const stateDir = mkdtempSync(join(tmpdir(), "dsh-codex-userinput-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const servers = [];
  const backend = new CodexSessionBackend(stateDir, () => { const server = new FakeServer(); servers.push(server); return server; });
  t.after(() => backend.close());

  const session = await backend.createSession("owner", "session", "/work");
  const events = [];
  backend.subscribe("owner", "session", event => events.push(event), { interactive: true });
  const turn = await backend.startTurn("owner", "session", "hello");
  const server = servers[0];

  server.emit("request", {
    id: 77,
    method: "item/tool/requestUserInput",
    params: {
      threadId: session.threadId, turnId: turn.turnId, itemId: "i1", isBlocking: true, autoResolutionMs: null,
      questions: [{ id: "q1", header: "Pick", question: "Proceed?", isOther: true, isSecret: false, options: [{ label: "Yes", description: "go" }] }],
    },
  });
  const [pending] = await backend.pendingUserInputs("owner", "session");
  assert.equal(pending.turnId, turn.turnId);
  assert.deepEqual(pending.questions, [{ id: "q1", header: "Pick", question: "Proceed?", isOther: true, isSecret: false, options: [{ label: "Yes", description: "go" }] }]);
  assert.equal(events.at(-1).type, "userInput.requested");
  await backend.answerUserInput("owner", pending.requestId, { q1: { answers: ["Yes"] } });
  assert.deepEqual(server.responses.at(-1), { id: 77, result: { answers: { q1: { answers: ["Yes"] } } } });
  assert.equal((await backend.pendingUserInputs("owner", "session")).length, 0);
  await assert.rejects(backend.answerUserInput("owner", pending.requestId, null), /no longer pending/);

  server.emit("request", {
    id: 78,
    method: "item/tool/requestUserInput",
    params: { threadId: session.threadId, turnId: turn.turnId, questions: [{ id: "q2", question: "Sure?", isOther: false, isSecret: false }] },
  });
  const [second] = await backend.pendingUserInputs("owner", "session");
  await backend.answerUserInput("owner", second.requestId, null);
  assert.deepEqual(server.responses.at(-1), { id: 78, result: { answers: {} } });
});

test("reloads a rebuilt provider Session whose reports came from an earlier thread", async t => {
  const stateDir = mkdtempSync(join(tmpdir(), "dsh-codex-rebuild-reports-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const servers = [];
  const threadIds = ["thread-1", "thread-2"];
  let backend = new CodexSessionBackend(stateDir, () => {
    const server = new FakeServer();
    server.threadId = threadIds[servers.length] ?? `thread-${servers.length + 1}`;
    servers.push(server);
    return server;
  });
  await backend.createSession("owner", "session", "/work");
  const firstThread = (await backend.readSession("owner", "session")).threadId;
  const turn = await backend.startTurn("owner", "session", "work");
  servers[0].emit("notification", { method: "item/completed", params: { threadId: firstThread, turnId: turn.turnId, item: { type: "agentMessage", phase: "final_answer", text: "done" } } });
  servers[0].emit("notification", { method: "turn/completed", params: { threadId: firstThread, turn: { id: turn.turnId, status: "completed" } } });
  await backend.restartSession("owner", "session");
  const rebuiltThread = (await backend.readSession("owner", "session")).threadId;
  assert.notEqual(rebuiltThread, firstThread);
  await backend.close();

  backend = new CodexSessionBackend(stateDir, () => new FakeServer());
  t.after(() => backend.close());
  const snapshot = await backend.readSession("owner", "session");
  assert.equal(snapshot.threadId, rebuiltThread, "the rebuilt thread survives a reload");
  const reports = await backend.readReports("owner", "session");
  assert.equal(reports.length, 1);
  assert.equal(reports[0].threadId, firstThread, "the earlier thread's report is retained, not rewritten");
});

test("imports an original thread once, preserves typed skills, and marks compact as maintenance", async t => {
  const stateDir = mkdtempSync(join(tmpdir(), "dsh-codex-import-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const servers = [], rollout = join(stateDir, "rollout.jsonl");
  writeFileSync(rollout, `${JSON.stringify({ type: "session_meta", payload: { id: "history-thread" } })}\n${JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: 12, input_tokens: 8, output_tokens: 4 }, last_token_usage: { total_tokens: 5 }, model_context_window: 100 } } })}\n`);
  const backend = new CodexSessionBackend(stateDir, () => { const server = new FakeServer(); server.threadPath = rollout; servers.push(server); return server; });
  t.after(() => backend.close());

  const page = await backend.searchThreads("owner", "history");
  assert.equal(page.data[0].id, "history-thread");
  const imported = await backend.importSession("owner", "imported", "history-thread");
  assert.equal(imported.threadId, "history-thread");
  assert.equal(imported.model, "stored-model");
  assert.equal(servers.flatMap(server => server.calls).some(call => call.method === "thread/start"), false, "import performs no model/thread creation request");
  await assert.rejects(backend.importSession("other", "duplicate", "history-thread"), /occupied/);

  const turn = await backend.startTurn("owner", "imported", [
    { type: "text", text: "use it" },
    { type: "localImage", path: "/attachments/a1.png" },
    { type: "skill", name: "demo", path: "/skills/demo/SKILL.md" },
  ]);
  assert.equal((await backend.readSession("owner", "imported")).usage.total.totalTokens, 12);
  const runtime = servers.at(-1);
  assert.deepEqual(runtime.calls.find(call => call.method === "turn/start").params.input, [
    { type: "text", text: "use it", text_elements: [] },
    { type: "localImage", path: "/attachments/a1.png" },
    { type: "skill", name: "demo", path: "/skills/demo/SKILL.md" },
  ]);
  runtime.emit("notification", { method: "turn/completed", params: { threadId: "history-thread", turn: { id: turn.turnId, status: "completed" } } });
  await backend.compactSession("owner", "imported");
  runtime.emit("notification", { method: "turn/started", params: { threadId: "history-thread", turn: { id: "compact-1" } } });
  runtime.emit("notification", { method: "turn/completed", params: { threadId: "history-thread", turn: { id: "compact-1", status: "completed" } } });
  assert.equal((await backend.readReports("owner", "imported")).length, 1, "a compact turn is maintenance: it records no report");
  await backend.closeSession("owner", "imported");
  assert.equal((await backend.readSession("owner", "imported")).threadId, "history-thread", "close preserves durable history identity");
  assert.equal((await backend.occupiedThreads()).includes("history-thread"), false, "idle close releases occupancy");
});

test("maps base64 and host-path images and rejects invalid image payloads before any turn", async t => {
  const stateDir = mkdtempSync(join(tmpdir(), "dsh-codex-image-input-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const servers = [], rollout = join(stateDir, "rollout.jsonl");
  writeFileSync(rollout, `${JSON.stringify({ type: "session_meta", payload: { id: "history-thread" } })}\n`);
  const backend = new CodexSessionBackend(stateDir, () => { const server = new FakeServer(); server.threadPath = rollout; servers.push(server); return server; });
  t.after(() => backend.close());
  await backend.importSession("owner", "imported", "history-thread");

  await assert.rejects(backend.startTurn("owner", "imported", [{ type: "image", url: " " }]), /Image URL must not be empty/);
  await assert.rejects(backend.startTurn("owner", "imported", [{ type: "localImage", path: "relative.png" }]), /absolute/);
  assert.equal(servers.flatMap(server => server.calls).some(call => call.method === "turn/start"), false, "invalid input never reaches the app server");

  await backend.startTurn("owner", "imported", [
    { type: "image", url: "data:image/png;base64,AA" },
    { type: "localImage", path: "/attachments/b.png" },
  ]);
  assert.deepEqual(servers.flatMap(server => server.calls).find(call => call.method === "turn/start").params.input, [
    { type: "image", url: "data:image/png;base64,AA" },
    { type: "localImage", path: "/attachments/b.png" },
  ]);
});

test("a stopped worker-less Session needs explicit confirmation to close, a live one does not", async t => {
  const stateDir = mkdtempSync(join(tmpdir(), "dsh-codex-close-session-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const first = new CodexSessionBackend(stateDir, () => new FakeServer());
  await first.createSession("owner", "codex:child", "/work");
  await first.startTurn("owner", "codex:child", "in flight");
  // A process that ends with a turn in flight leaves the record uncertain.
  await first.close();

  const second = new CodexSessionBackend(stateDir, () => new FakeServer());
  t.after(() => second.close());
  assert.equal((await second.readSession("owner", "codex:child")).state, "unknown");
  assert.equal((await second.listSessions("owner")).some(session => session.sessionId === "codex:child"), true);
  // The worker branch has always accepted a confirmed stop; the worker-less
  // branch must not be the one record nobody can release.
  await assert.rejects(second.closeSession("owner", "codex:child"), /idle Session/);
  await second.closeSession("owner", "codex:child", true);
  assert.equal((await second.listSessions("owner")).some(session => session.sessionId === "codex:child"), false,
    "a released Session is no longer owned");
});

test("a live runtime is not uncertain, so confirmation cannot bypass it", async t => {
  const stateDir = mkdtempSync(join(tmpdir(), "dsh-codex-close-live-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const backend = new CodexSessionBackend(stateDir, () => new FakeServer());
  t.after(() => backend.close());
  await backend.createSession("owner", "codex:child", "/work");
  await backend.startTurn("owner", "codex:child", "running here");
  await assert.rejects(backend.closeSession("owner", "codex:child", true), /idle Session/,
    "this process holds the runtime, so there is nothing to confirm away");
});

test("a disposed DSH Session releases the record that backed it", async t => {
  const stateDir = mkdtempSync(join(tmpdir(), "dsh-codex-disposed-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const servers = [];
  const backend = new CodexSessionBackend(stateDir, () => { const server = new FakeServer(); servers.push(server); return server; });
  t.after(() => backend.close());
  const caller = { nativeSessionId: "parent", source: "agent", parentAgent: { id: "parent-agent", nativeSessionId: "parent" } };
  const work = mkdtempSync(join(tmpdir(), "dsh-codex-disposed-cwd-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const worker = await backend.createWorker(caller, { name: "worker", cwd: work });
  await backend.createSession("owner", "codex:conversation", work);
  assert.equal((await backend.listWorkers(caller)).length, 1);
  assert.equal((await backend.listSessions("owner")).some(session => session.sessionId === "codex:conversation"), true);

  // The Host owns the Session lifecycle and reports the disposal as a fact.
  backend.releaseDisposed("codex:conversation");
  backend.releaseDisposed(worker.id);
  assert.equal((await backend.listSessions("owner")).some(session => session.sessionId === "codex:conversation"), false,
    "the released conversation is no longer owned");
  assert.equal((await backend.listWorkers(caller)).length, 0, "a released worker is detached from its parent");
  // A second disposal is a no-op rather than an error.
  backend.releaseDisposed("codex:conversation");
  backend.releaseDisposed("codex:never-existed");
});

const tick = () => new Promise(resolve => setImmediate(resolve));

test("a record a dead process left mid-turn resumes without confirmation and is not redispatched", async t => {
  const stateDir = mkdtempSync(join(tmpdir(), "dsh-codex-resume-dead-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const first = new CodexSessionBackend(stateDir, () => new FakeServer());
  await first.createSession("owner", "codex:child", "/work");
  await first.startTurn("owner", "codex:child", "in flight");
  // The process ends with a turn in flight, so its record cannot say what ran.
  await first.close();

  const servers = [];
  const second = new CodexSessionBackend(stateDir, () => { const server = new FakeServer(); servers.push(server); return server; });
  t.after(() => second.close());
  const stale = await second.readSession("owner", "codex:child");
  assert.equal(stale.state, "unknown", "the dead process's record is still uncertain");

  const resumed = await second.resumeSession("owner", "codex:child");
  assert.equal(resumed.threadId, stale.threadId, "the recorded thread is resumed, not replaced");
  assert.deepEqual(servers.flatMap(server => server.calls).map(call => call.method), ["thread/resume"]);
  assert.equal(servers.flatMap(server => server.calls).some(call => call.method === "turn/start"), false,
    "resuming is not a redispatch of the task the previous process recorded");
});

test("an uncertain runtime in this process refuses to resume instead of being replaced", async t => {
  const stateDir = mkdtempSync(join(tmpdir(), "dsh-codex-resume-uncertain-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const servers = [];
  const backend = new CodexSessionBackend(stateDir, () => { const server = new FakeServer(); servers.push(server); return server; });
  t.after(() => backend.close());
  await backend.createSession("owner", "codex:child", "/work");
  await backend.startTurn("owner", "codex:child", "running here");
  // A loss while this process still holds the runtime is the one case that stays
  // unresolved: only its own owner can say whether the execution continues.
  servers[0].emit("uncertain", new Error("lost connection"));

  await assert.rejects(backend.resumeSession("owner", "codex:child"), /resolve it before resuming/);
  assert.equal(servers.length, 1, "the uncertain runtime was not replaced by a second one");
});

test("releasing a disposed Session is awaitable and teardown waits for that process", async t => {
  const stateDir = mkdtempSync(join(tmpdir(), "dsh-codex-release-await-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let closed = 0;
  class SlowCloseServer extends FakeServer {
    async close() { closed++; await gate; }
  }
  const backend = new CodexSessionBackend(stateDir, () => new SlowCloseServer());
  await backend.createSession("owner", "codex:child", "/work");

  const released = backend.releaseDisposed("codex:child");
  const teardown = backend.close();
  let releasedSettled = false, teardownSettled = false;
  void released.then(() => { releasedSettled = true; });
  void teardown.then(() => { teardownSettled = true; });
  await tick();
  assert.equal(releasedSettled, false, "release reports the process as still exiting");
  assert.equal(teardownSettled, false, "teardown waits for the released process instead of assuming it stopped");
  release();
  await Promise.all([released, teardown]);
  assert.equal(closed, 1, "the process was closed exactly once");
});

test("resume refuses a thread that reports active work instead of claiming it", async t => {
  const stateDir = mkdtempSync(join(tmpdir(), "dsh-codex-resume-active-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const first = new CodexSessionBackend(stateDir, () => new FakeServer());
  await first.createSession("owner", "codex:child", "/work");
  await first.startTurn("owner", "codex:child", "in flight");
  await first.close();

  // A process that outlived its parent still holds the thread, so the native
  // status is the only direct evidence that the recorded execution continues.
  class ActiveThreadServer extends FakeServer {
    async request(method, params) {
      const result = await super.request(method, params);
      if (method === "thread/resume") result.thread.status = { type: "active" };
      return result;
    }
  }
  const second = new CodexSessionBackend(stateDir, () => new ActiveThreadServer());
  t.after(() => second.close());
  await assert.rejects(second.resumeSession("owner", "codex:child"), /appears active/);
});

test("an agent-owned worker is not closed while its thread has a command open", async t => {
  const stateDir = mkdtempSync(join(tmpdir(), "dsh-codex-command-open-"));
  const work = mkdtempSync(join(tmpdir(), "dsh-codex-command-open-cwd-"));
  t.after(() => { rmSync(stateDir, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); });
  const servers = [];
  const backend = new CodexSessionBackend(stateDir, () => { const server = new FakeServer(); servers.push(server); return server; });
  t.after(() => backend.close());
  const caller = { nativeSessionId: "parent", source: "agent", parentAgent: { id: "parent-agent", nativeSessionId: "parent" } };
  const ui = { nativeSessionId: "parent", source: "ui", parentAgent: { id: "parent-agent", nativeSessionId: "parent" } };
  const worker = await backend.createWorker(caller, { name: "worker", cwd: work });
  assert.equal(worker.owner, "agent", "the command guard applies to agent-owned workers");
  const turn = await backend.startTurn(caller, worker.id, "run it");
  const server = servers.at(-1);
  server.emit("notification", { method: "item/started", params: { threadId: server.threadId, turnId: turn.turnId,
    item: { id: "cmd-1", type: "commandExecution", command: "sleep 20", status: "inProgress" } } });
  server.emit("notification", { method: "item/completed", params: { threadId: server.threadId, turnId: turn.turnId,
    item: { type: "agentMessage", phase: "final_answer", text: "done" } } });
  server.emit("notification", { method: "turn/completed", params: { threadId: server.threadId, turn: { id: turn.turnId, status: "completed" } } });
  // The turn ended, so the record is idle and its report is decided first.
  await backend.acknowledgeReport(caller, worker.id, turn.turnId);

  await assert.rejects(backend.closeSession(ui, worker.id), /command still running/,
    "a command the thread reported as running is not abandoned by closing the Session");
  server.emit("notification", { method: "item/completed", params: { threadId: server.threadId, turnId: turn.turnId,
    item: { id: "cmd-1", type: "commandExecution", command: "sleep 20", status: "completed", exitCode: 0 } } });
  await backend.closeSession(ui, worker.id);
  assert.equal((await backend.listWorkers(caller)).length, 0, "the closed worker is released from its parent");
});

test("a terminal turn the thread reports twice is applied once", async t => {
  const stateDir = mkdtempSync(join(tmpdir(), "dsh-codex-terminal-once-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const servers = [];
  const backend = new CodexSessionBackend(stateDir, () => { const server = new FakeServer(); servers.push(server); return server; });
  t.after(() => backend.close());
  await backend.createSession("owner", "session", "/work");
  const turn = await backend.startTurn("owner", "session", "hello");
  const server = servers[0];
  server.emit("notification", { method: "item/completed", params: { threadId: "thread-1", turnId: turn.turnId,
    item: { type: "agentMessage", phase: "final_answer", text: "done" } } });
  const completed = { method: "turn/completed", params: { threadId: "thread-1", turn: { id: turn.turnId, status: "completed" } } };
  server.emit("notification", completed);
  server.emit("notification", completed);

  const record = await backend.readSession("owner", "session");
  assert.equal(record.reports.length, 1, "the same terminal turn is never recorded twice");
  assert.equal(record.state, "idle");

  // The conclusion has to survive the process that reached it: a restarted
  // backend reads the terminal turn from the record, not from memory.
  await backend.close();
  const restartedServers = [];
  const restarted = new CodexSessionBackend(stateDir, () => { const server = new FakeServer(); restartedServers.push(server); return server; });
  t.after(() => restarted.close());
  await restarted.resumeSession("owner", "session");
  restartedServers[0].emit("notification", completed);
  assert.equal((await restarted.readSession("owner", "session")).reports.length, 1,
    "a restarted process reaches the same conclusion from the record alone");
});

test("a record keeps the executed facts and not the notifications that carried them", async t => {
  const stateDir = mkdtempSync(join(tmpdir(), "dsh-codex-facts-only-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const servers = [];
  const backend = new CodexSessionBackend(stateDir, () => { const server = new FakeServer(); servers.push(server); return server; });
  t.after(() => backend.close());
  await backend.createSession("owner", "session", "/work");
  const turn = await backend.startTurn("owner", "session", "work");
  const server = servers[0];
  // One stream the projection does not read, and one item it does.
  server.emit("notification", { method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: turn.turnId, itemId: "msg", delta: "STREAMED_PROSE" } });
  server.emit("notification", { method: "item/started", params: { threadId: "thread-1", turnId: turn.turnId,
    item: { id: "cmd-1", type: "commandExecution", command: "printf OK", status: "inProgress" } } });
  server.emit("notification", { method: "item/completed", params: { threadId: "thread-1", turnId: turn.turnId,
    item: { id: "cmd-1", type: "commandExecution", command: "printf OK", status: "completed", exitCode: 0, aggregatedOutput: "OK" } } });
  server.emit("notification", { method: "turn/completed", params: { threadId: "thread-1", turn: { id: turn.turnId, status: "completed" } } });

  const facts = await backend.readFacts("owner", "session");
  assert.equal(facts.length, 2, "the executed command projects to its fact lines");
  assert.match(facts[0].text, /command: printf OK/);
  const onDisk = JSON.parse(readFileSync(join(stateDir, "sessions", `${encodeURIComponent("session")}.json`), "utf8"));
  assert.equal("events" in onDisk, false, "the notification mirror is not stored");
  assert.equal("nextEventSequence" in onDisk, false, "the live subscriber cursor is not durable state");
  assert.equal(JSON.stringify(onDisk).includes("STREAMED_PROSE"), false, "model text never enters the record");
});
