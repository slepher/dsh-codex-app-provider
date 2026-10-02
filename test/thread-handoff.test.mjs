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
const OPENING = "codex:opening";
const SUCCESSOR = "codex:continue";

const EXECUTION = { developerInstructions: "Execute coding_worker [coding-bootstrap-continuation,coding-adaptive]" };
const BOUNDARY = { cwd: "", writableRoots: [""], network: "disabled" };

/**
 * One App Server transport that answers thread lifecycle with a shared hub, so
 * a temporary reader, a resumed successor and a fresh process all agree on the
 * same native thread identity.
 */
class HandoffServer extends EventEmitter {
  constructor(hub) { super(); this.hub = hub; this.calls = []; this.resumeResult = {}; }
  async connect() {}
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === "thread/read") {
      return { thread: { id: this.hub.resumeThreadId ?? params.threadId, status: { type: "idle" }, turns: [], cwd: this.hub.cwd }, model: "luna", reasoningEffort: "high" };
    }
    if (method === "thread/start") {
      this.thread = `thread-${++this.hub.thread}`;
      return { thread: { id: this.thread, status: { type: "idle" }, turns: [], cwd: params.cwd }, model: params.model, reasoningEffort: params.config?.model_reasoning_effort };
    }
    if (method === "thread/resume") {
      if (this.hub.rejectResume) throw new RpcError("thread/resume refused", -32000);
      this.thread = this.hub.resumeThreadId ?? params.threadId;
      const permissions = params.config?.permissions?.["dsh-task"];
      const writableRoots = permissions === undefined
        ? []
        : Object.entries(permissions.filesystem).filter(([, mode]) => mode === "write").map(([path]) => path);
      return { thread: { id: this.thread, status: { type: "idle" }, turns: [], cwd: params.cwd }, model: params.model,
        reasoningEffort: params.config?.model_reasoning_effort, approvalPolicy: "never",
        sandbox: { type: "workspaceWrite", writableRoots, excludeSlashTmp: true, excludeTmpdirEnvVar: true,
          networkAccess: permissions?.network?.enabled === true }, ...this.resumeResult };
    }
    if (method === "turn/start") {
      const id = `turn-${++this.hub.turn}`;
      this.turnId = id;
      this.emit("notification", { method: "turn/started", params: { threadId: this.thread, turn: { id } } });
      return { turn: { id, status: "inProgress" } };
    }
    if (method === "model/list") return { data: [], nextCursor: null };
    if (method === "config/read") return { config: { model: "luna", model_reasoning_effort: "high" } };
    return {};
  }
  notify(method, params) { this.emit("notification", { method, params }); }
  async close() { this.closed = (this.closed ?? 0) + 1; }
}

function setup(prefix) {
  const stateDir = mkdtempSync(join(tmpdir(), prefix));
  const cwd = mkdtempSync(join(tmpdir(), `${prefix}cwd-`));
  const hub = { cwd, thread: 0, turn: 0, servers: [], rejectResume: false, resumeThreadId: undefined };
  const backend = new CodexSessionBackend(stateDir, () => { const server = new HandoffServer(hub); hub.servers.push(server); return server; });
  return { stateDir, cwd, hub, backend };
}

function cleanup(fixture) {
  rmSync(fixture.stateDir, { recursive: true, force: true });
  rmSync(fixture.cwd, { recursive: true, force: true });
}

const methods = (fixture, method) => fixture.hub.servers.flatMap(server => server.calls.filter(call => call.method === method));

const user = (id, text) => ({ id, role: "user", content: [{ type: "text", text }], source: { kind: "user" } });
const codexAssistant = (id, text, threadId) => ({ id, role: "assistant", content: [{ type: "text", text }],
  source: { kind: "model", provider: "codex", model: "sup-model", replayState: { response: { threadId, turnId: "turn-old", input: "u0" } } } });

/** Create the opening record and hand its thread to the reserved successor. */
async function handedOver(fixture, request = {}) {
  await fixture.backend.createSession(OWNER, OPENING, fixture.cwd, { model: "sup-model", reasoningEffort: "high", developerInstructions: "Opening instructions" });
  const source = await fixture.backend.readSession(OWNER, OPENING);
  const result = await fixture.backend.handoffThread(OWNER, {
    requestId: "req-1", fromSessionId: OPENING, toSessionId: SUCCESSOR, model: "def-model", reasoningEffort: "medium",
    developerInstructions: EXECUTION.developerInstructions,
    boundary: { cwd: fixture.cwd, writableRoots: [fixture.cwd], network: "disabled" }, ...request,
  });
  return { source, result };
}

function adapterFor(fixture, { execution, model = "def-model", reasoningEffort = "medium" } = {}) {
  const session = { id: "continue", header: { cwd: fixture.cwd } };
  const agent = { session, options: { model, reasoningEffort, ...(execution === undefined ? {} : { execution }) } };
  const adapter = new CodexProviderAdapter({
    backend: fixture.backend, sessions: { get: id => (id === "continue" ? session : undefined) },
    agents: { get: id => (id === "continue" ? agent : undefined) }, logger: { warn() {} }, providerCwd: fixture.cwd,
  });
  return { adapter, agent };
}

const options = (messages, extra = {}) => ({ provider: "codex", model: "def-model", reasoningEffort: "medium", sessionId: "continue", messages, ...extra });

async function waitFor(condition, label) {
  for (let attempt = 0; attempt < 5_000; attempt++) {
    if (await condition()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function collect(iterable) {
  const chunks = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

test("a handoff binds the successor to the original thread and de-authorizes the source", async t => {
  const fixture = setup("dsh-provider-handoff-");
  t.after(async () => { await fixture.backend.close(); cleanup(fixture); });
  const { source, result } = await handedOver(fixture);

  assert.equal(result.toSessionId, SUCCESSOR);
  assert.equal(result.threadId, source.threadId, "the successor keeps the original thread");
  assert.equal(result.state, "idle");
  const target = await fixture.backend.readSession(OWNER, SUCCESSOR);
  assert.equal(target.threadId, source.threadId);
  assert.deepEqual([target.model, target.reasoningEffort], ["def-model", "medium"], "the target model and effort are recorded");
  assert.equal(target.options.developerInstructions, EXECUTION.developerInstructions, "the successor's first request carries the phase instructions");
  assert.deepEqual(target.options.boundary, { cwd: fixture.cwd, writableRoots: [fixture.cwd], network: "disabled" });
  assert.equal(target.turnId, undefined);

  const released = await fixture.backend.threadOwnership(OWNER, OPENING);
  assert.equal(released.handedOffTo, SUCCESSOR);
  const continued = await fixture.backend.threadOwnership(OWNER, SUCCESSOR);
  assert.equal(continued.handoffFrom, OPENING);
  assert.equal(continued.threadId, source.threadId);
  assert.deepEqual(await fixture.backend.occupiedThreads(), [source.threadId], "only the successor occupies the thread");
  assert.equal(fixture.hub.servers[0].closed, 1, "the handover closes the source's live runtime");

  // A repeated request reuses the recorded handover instead of re-deciding it.
  const replay = await fixture.backend.handoffThread(OWNER, {
    requestId: "req-1", fromSessionId: OPENING, toSessionId: SUCCESSOR, model: "def-model", reasoningEffort: "medium",
    developerInstructions: EXECUTION.developerInstructions, boundary: { cwd: fixture.cwd, writableRoots: [fixture.cwd], network: "disabled" },
  });
  assert.equal(replay.threadId, source.threadId);
  assert.equal(methods(fixture, "thread/start").length, 1, "a replay never starts another thread");
  await assert.rejects(fixture.backend.handoffThread(OWNER, {
    requestId: "req-2", fromSessionId: OPENING, toSessionId: SUCCESSOR, model: "other-model",
  }), /already recorded with different inputs/);
});

test("every thread path on the source is refused after the handover, including cold recovery", async t => {
  const fixture = setup("dsh-provider-revoke-");
  t.after(async () => { await fixture.backend.close(); cleanup(fixture); });
  const { source } = await handedOver(fixture);
  const refusals = [
    ["start a turn", () => fixture.backend.startTurn(OWNER, OPENING, "more work")],
    ["resume its thread", () => fixture.backend.resumeSession(OWNER, OPENING)],
    ["configure its thread", () => fixture.backend.configureSession(OWNER, OPENING, { model: "third-model" })],
    ["compact its thread", () => fixture.backend.compactSession(OWNER, OPENING)],
  ];
  for (const [action, run] of refusals) {
    await assert.rejects(run(), new RegExp(`handed its Codex thread to ${SUCCESSOR}; it can no longer ${action}`));
  }
  // Closing the source stays possible and never touches the successor's thread.
  await fixture.backend.closeSession(OWNER, OPENING);
  assert.equal((await fixture.backend.readSession(OWNER, OPENING)).threadId, source.threadId);

  await fixture.backend.close();
  const restartedHub = { ...fixture.hub, servers: [] };
  const cold = new CodexSessionBackend(fixture.stateDir, () => { const server = new HandoffServer(restartedHub); restartedHub.servers.push(server); return server; });
  t.after(() => cold.close());
  await assert.rejects(cold.startTurn(OWNER, OPENING, "after restart"), /can no longer start a turn on its thread/);
  await assert.rejects(cold.resumeSession(OWNER, OPENING), /can no longer resume its thread/);
  const recovered = await cold.resumeSession(OWNER, SUCCESSOR);
  assert.equal(recovered.threadId, source.threadId, "the successor cold-recovers on the original thread");
  assert.deepEqual([recovered.model, recovered.reasoningEffort], ["def-model", "medium"]);
  assert.equal(restartedHub.servers.flatMap(server => server.calls.filter(call => call.method === "thread/start")).length, 0,
    "cold recovery resumes instead of starting a thread");
});

test("the successor's first request resumes the original thread on the target configuration", async t => {
  const fixture = setup("dsh-provider-first-request-");
  t.after(async () => { await fixture.backend.close(); cleanup(fixture); });
  const { source } = await handedOver(fixture);
  const execution = { ...EXECUTION, boundary: { cwd: fixture.cwd, writableRoots: [fixture.cwd], network: "disabled" } };
  const { adapter } = adapterFor(fixture, { execution });

  const starts = methods(fixture, "thread/start").length;
  const done = collect(adapter.stream(options([user("u1", "continue the remaining work")], { execution })));
  await waitFor(async () => (await fixture.backend.readSession(OWNER, SUCCESSOR))?.state === "running", "the successor turn");
  const server = fixture.hub.servers.find(candidate => candidate.calls.some(call => call.method === "turn/start"));
  const resume = server.calls.filter(call => call.method === "thread/resume");
  assert.equal(resume.length, 1, "the first request resumes the prepared thread");
  assert.equal(resume[0].params.threadId, source.threadId);
  assert.equal(resume[0].params.model, "def-model");
  assert.equal(resume[0].params.config.model_reasoning_effort, "medium");
  const start = server.calls.find(call => call.method === "turn/start");
  assert.deepEqual([start.params.threadId, start.params.model, start.params.effort], [source.threadId, "def-model", "medium"]);
  assert.equal(methods(fixture, "thread/start").length, starts, "no thread was started for the successor");

  server.notify("item/completed", { threadId: source.threadId, turnId: server.turnId, item: { type: "agentMessage", phase: "final_answer", text: "continued" } });
  server.notify("turn/completed", { threadId: source.threadId, turn: { id: server.turnId, status: "completed" } });
  assert.equal((await done).at(-1).type, "finish");
  const after = await fixture.backend.readSession(OWNER, SUCCESSOR);
  assert.equal(after.threadId, source.threadId);
  assert.equal(after.options.developerInstructions, EXECUTION.developerInstructions, "the creation snapshot is kept for audit");
});

test("a failed or mismatched continuation binding errors instead of starting a thread", async t => {
  const fixture = setup("dsh-provider-binding-fail-");
  t.after(async () => { await fixture.backend.close(); cleanup(fixture); });
  const { source } = await handedOver(fixture);
  const execution = { ...EXECUTION, boundary: { cwd: fixture.cwd, writableRoots: [fixture.cwd], network: "disabled" } };
  const { adapter } = adapterFor(fixture, { execution });
  const starts = methods(fixture, "thread/start").length;

  fixture.hub.rejectResume = true;
  await assert.rejects(collect(adapter.stream(options([user("u1", "continue")], { execution }))), /thread\/resume refused/);
  assert.equal(methods(fixture, "thread/start").length, starts, "a refused resume never falls back to thread/start");
  assert.equal((await fixture.backend.readSession(OWNER, SUCCESSOR)).state, "unknown", "the failed binding keeps the successor unclaimed");

  // A resume that reports another thread is refused just as firmly. The unknown
  // ownership left by the first failure is confirmed stopped before the retry,
  // which is the same native resume path.
  fixture.hub.rejectResume = false;
  fixture.hub.resumeThreadId = "thread-impostor";
  await assert.rejects(fixture.backend.resumeSession(OWNER, SUCCESSOR), /Recovered thread identity mismatch/);
  assert.equal(methods(fixture, "thread/start").length, starts, "a mismatched thread identity never starts a replacement");
});

test("a successor's first input never replays the source thread history", async t => {
  const fixture = setup("dsh-provider-no-replay-");
  t.after(async () => { await fixture.backend.close(); cleanup(fixture); });
  const { source } = await handedOver(fixture);
  const execution = { ...EXECUTION, boundary: { cwd: fixture.cwd, writableRoots: [fixture.cwd], network: "disabled" } };
  const { adapter } = adapterFor(fixture, { execution });

  // The successor's session carries a Codex reply from another thread, so the
  // planner would otherwise re-import it as user input.
  await assert.rejects(collect(adapter.stream(options([
    codexAssistant("a1", "opening phase work", "thread-elsewhere"),
    user("u1", "continue the remaining work"),
  ], { execution }))), /must continue the handed-over Codex thread instead of replaying its history/);
  assert.equal(methods(fixture, "turn/start").length, 0, "no turn was started with replayed history");
  assert.equal((await fixture.backend.readSession(OWNER, SUCCESSOR)).state, "idle");
  assert.equal(source.threadId !== undefined, true);
});
