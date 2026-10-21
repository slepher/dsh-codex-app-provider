import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CodexSessionBackend } from "../lib/backend.js";
import { CodexProviderAdapter } from "../lib/provider.js";
import { RpcError } from "../lib/rpc.js";

const OWNER = "dsh-codex-provider";

/**
 * One App Server transport that records every request and can confirm an
 * applied thread configuration through `thread/settings/updated`.
 */
class SwitchServer extends EventEmitter {
  calls = [];
  thread = "thread-1";
  turn = 0;
  resumeResult = {};
  rejectTurn = false;
  async connect() {}
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === "thread/start" || method === "thread/resume") {
      return {
        thread: { id: params.threadId ?? this.thread, status: { type: "idle" }, turns: [] },
        model: params.model ?? "luna",
        reasoningEffort: params.config?.model_reasoning_effort,
        // A managed execution now always carries an effective boundary, so the
        // App Server must confirm it before the turn is admitted.
        cwd: params.cwd,
        approvalPolicy: "never",
        sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true },
        ...this.resumeResult,
      };
    }
    if (method === "turn/start") {
      if (this.rejectTurn) throw new RpcError("turn rejected", -32000);
      const id = `turn-${++this.turn}`;
      this.turnId = id;
      this.emit("notification", { method: "turn/started", params: { threadId: this.thread, turn: { id } } });
      return { turn: { id, status: "inProgress" } };
    }
    if (method === "model/list") return { data: [], nextCursor: null };
    if (method === "config/read") return { config: { model: "luna", model_reasoning_effort: "high" } };
    return {};
  }
  notify(method, params) { this.emit("notification", { method, params }); }
  async close() {}
}

function setup(prefix) {
  const stateDir = mkdtempSync(join(tmpdir(), prefix));
  const cwd = mkdtempSync(join(tmpdir(), `${prefix}cwd-`));
  const servers = [];
  const backend = new CodexSessionBackend(stateDir, () => { const server = new SwitchServer(); servers.push(server); return server; });
  return { stateDir, cwd, servers, backend };
}

function cleanup(fixture) {
  rmSync(fixture.stateDir, { recursive: true, force: true });
  rmSync(fixture.cwd, { recursive: true, force: true });
}

async function waitFor(condition, label) {
  for (let attempt = 0; attempt < 5_000; attempt++) {
    if (await condition()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const user = (id, text) => ({ id, role: "user", content: [{ type: "text", text }], source: { kind: "user" } });
const options = (sessionId, messages, extra = {}) => ({ provider: "codex", model: "luna", reasoningEffort: "high", sessionId, messages, ...extra });

/** Start one turn and hand the live server back once its native turn exists. */
async function liveTurn(adapter, fixture, sessionId, opts, emit) {
  const starts = () => fixture.servers.flatMap(server => server.calls.filter(call => call.method === "turn/start")).length;
  const before = starts();
  const collected = (async () => { for await (const chunk of adapter.stream(opts)) void chunk; })();
  await waitFor(() => starts() > before, "turn/start");
  const server = fixture.servers[0];
  await emit(server, adapter);
  return collected;
}

const completed = server => {
  server.notify("item/completed", { threadId: server.thread, turnId: server.turnId, item: { type: "agentMessage", phase: "final_answer", text: "done" } });
  server.notify("turn/completed", { threadId: server.thread, turn: { id: server.turnId, status: "completed" } });
};

test("a managed child switches model and effort in the same thread, pending until natively confirmed", async t => {
  const fixture = setup("dsh-provider-switch-");
  t.after(async () => { await fixture.backend.close(); cleanup(fixture); });
  const execution = { developerInstructions: "Role A instructions" };
  const session = { id: "child", header: { cwd: fixture.cwd } };
  const agent = { session, options: { model: "luna", reasoningEffort: "high", execution } };
  const adapter = new CodexProviderAdapter({ currentCwd: () => fixture.cwd,
    backend: fixture.backend, sessions: { get: id => (id === "child" ? session : undefined) },
    agents: { get: id => (id === "child" ? agent : undefined) }, logger: { warn() {} }, providerCwd: fixture.cwd,
  });

  await liveTurn(adapter, fixture, "child", options("child", [user("u1", "task")], { execution }), async server => { completed(server); });
  const server = fixture.servers[0];
  assert.equal(server.calls.filter(call => call.method === "turn/start").length, 1);
  assert.equal(fixture.servers.length, 1, "the switch reuses the existing native thread");

  // The core's guarded configuration update is what makes the new route
  // legitimate; an unguarded request never reaches the provider.
  agent.options.model = "sol";
  agent.options.reasoningEffort = "medium";
  await liveTurn(adapter, fixture, "child", options("child", [user("u2", "continue")], { execution, model: "sol", reasoningEffort: "medium" }), async (live, liveAdapter) => {
    const starts = server.calls.filter(call => call.method === "turn/start");
    assert.deepEqual([starts.at(-1).params.model, starts.at(-1).params.effort], ["sol", "medium"], "the same thread starts on the requested configuration");
    const before = await liveAdapter.readExecution("child");
    assert.equal(before.model, "luna", "the confirmed model is unchanged while the switch is unconfirmed");
    assert.deepEqual(before.pending, { model: "sol", reasoningEffort: "medium" });
    live.notify("thread/settings/updated", { threadId: server.thread, threadSettings: { model: "sol", effort: "medium" } });
    const after = await liveAdapter.readExecution("child");
    assert.equal(after.model, "sol");
    assert.equal(after.reasoningEffort, "medium");
    assert.equal("pending" in after, false, "native confirmation clears the pending target");
    completed(live);
  });
  const final = await adapter.readExecution("child");
  assert.equal(final.model, "sol");
  assert.equal(final.state, "idle");
  assert.equal(server.calls.filter(call => call.method === "thread/start").length, 1, "no forked or rebuilt thread");
});

test("an ordinary main Session switches model and effort on a later turn without a new thread", async t => {
  const fixture = setup("dsh-provider-main-switch-");
  t.after(async () => { await fixture.backend.close(); cleanup(fixture); });
  const session = { id: "main", header: { cwd: fixture.cwd } };
  const adapter = new CodexProviderAdapter({ currentCwd: () => fixture.cwd,
    backend: fixture.backend, sessions: { get: id => (id === "main" ? session : undefined) },
    agents: { get: () => undefined }, logger: { warn() {} }, providerCwd: fixture.cwd,
  });

  await liveTurn(adapter, fixture, "main", options("main", [user("u1", "first")]), async server => { completed(server); });
  const server = fixture.servers[0];
  // The user picks another model in the native picker; the next request carries
  // it and the App Server confirms what the same thread now runs.
  await liveTurn(adapter, fixture, "main", options("main", [user("u2", "second")], { model: "sol", reasoningEffort: "low" }), async live => {
    const starts = server.calls.filter(call => call.method === "turn/start");
    assert.deepEqual([starts.at(-1).params.model, starts.at(-1).params.effort], ["sol", "low"],
      "the user's new selection reaches the App Server");
    live.notify("thread/settings/updated", { threadId: server.thread, threadSettings: { model: "sol", effort: "low" } });
    completed(live);
  });
  assert.equal(server.calls.filter(call => call.method === "thread/start").length, 1, "no replacement Session is built");
  assert.equal(fixture.servers.length, 1, "the switch reuses the one App Server runtime");
  const record = await fixture.backend.readSession(OWNER, "codex:main");
  assert.deepEqual([record.model, record.reasoningEffort], ["sol", "low"], "the native confirmation is recorded");
  assert.equal(record.executionCwd, fixture.cwd, "an unscoped Session runs in its host workspace");
});

test("an explicitly rejected switch keeps the last confirmed configuration", async t => {
  const fixture = setup("dsh-provider-switch-reject-");
  t.after(async () => { await fixture.backend.close(); cleanup(fixture); });
  const id = "codex:child";
  await fixture.backend.createSession(OWNER, id, fixture.cwd, { model: "luna", reasoningEffort: "high", developerInstructions: "Role A" });
  const server = fixture.servers[0];
  server.rejectTurn = true;
  await assert.rejects(fixture.backend.startTurn(OWNER, id, "next", { model: "sol", reasoningEffort: "medium" }), /turn rejected/);
  const after = await fixture.backend.readSession(OWNER, id);
  assert.equal(after.model, "luna");
  assert.equal(after.reasoningEffort, "high");
  assert.equal("pending" in after, false, "a rejected target is never left pending");
});

test("a confirmed switch survives a cold resume and never reverts to the creation snapshot", async t => {
  const fixture = setup("dsh-provider-switch-resume-");
  t.after(() => cleanup(fixture));
  const id = "codex:child";
  await fixture.backend.createSession(OWNER, id, fixture.cwd, { model: "luna", reasoningEffort: "high", developerInstructions: "Role A" });
  const server = fixture.servers[0];
  await fixture.backend.startTurn(OWNER, id, "first", { model: "sol", reasoningEffort: "medium" });
  server.notify("thread/settings/updated", { threadId: server.thread, threadSettings: { model: "sol", effort: "medium" } });
  server.notify("turn/completed", { threadId: server.thread, turn: { id: server.turnId, status: "completed" } });
  const switched = await fixture.backend.readSession(OWNER, id);
  assert.deepEqual([switched.model, switched.reasoningEffort], ["sol", "medium"]);
  assert.equal(switched.options.model, "luna", "the creation snapshot stays for audit");
  await fixture.backend.close();

  // The restarted Host owns a fresh transport; its resume reports the
  // configuration the surviving thread actually runs.
  const runtime = new SwitchServer();
  runtime.resumeResult = { model: "sol", reasoningEffort: "medium" };
  const resumed = new CodexSessionBackend(fixture.stateDir, () => runtime);
  t.after(() => resumed.close());
  const record = await resumed.resumeSession(OWNER, id);
  assert.deepEqual([record.model, record.reasoningEffort], ["sol", "medium"], "cold restore keeps the switched configuration");
  assert.equal(record.options.model, "luna", "the initial snapshot is not rewritten");
});

test("a pending switch is reconciled from native facts on resume instead of reverting", async t => {
  const fixture = setup("dsh-provider-switch-pending-");
  t.after(() => cleanup(fixture));
  const id = "codex:child";
  await fixture.backend.createSession(OWNER, id, fixture.cwd, { model: "luna", reasoningEffort: "high", developerInstructions: "Role A" });
  const server = fixture.servers[0];
  await fixture.backend.startTurn(OWNER, id, "first", { model: "sol", reasoningEffort: "medium" });
  const started = await fixture.backend.readSession(OWNER, id);
  assert.deepEqual(started.pending, { model: "sol", reasoningEffort: "medium" }, "the target is pending before native confirmation");
  assert.equal(started.model, "luna");
  await fixture.backend.close();

  // The killed process never confirmed; the resumed thread reports what it runs.
  const runtime = new SwitchServer();
  runtime.resumeResult = { model: "sol", reasoningEffort: "medium" };
  const resumed = new CodexSessionBackend(fixture.stateDir, () => runtime);
  t.after(() => resumed.close());
  const record = await resumed.resumeSession(OWNER, id);
  assert.deepEqual([record.model, record.reasoningEffort], ["sol", "medium"], "the resumed thread's configuration wins");
  assert.equal("pending" in record, false);
});
