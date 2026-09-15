import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CodexSessionBackend } from "../lib/backend.js";
import { SessionStore } from "../lib/store.js";
import { assertPreToolUseHook, CodexGateBridge, WORKFLOW_PRE_TOOL_USE } from "../lib/tool-gate.js";

/** The hook command path the stand-in deployment installs. */
const CLIENT = "/opt/dsh-codex-app-provider/lib/pretool-client.js";

/** One listed hook entry, as `hooks/list` reports it. */
const hookEntry = overrides => ({ key: `/etc/codex/requirements.toml:pre_tool_use:0:0`, eventName: "preToolUse",
  command: `node ${CLIENT}`, matcher: "*", timeoutSec: 10, enabled: true, isManaged: true,
  source: "managed", sourcePath: "/etc/codex/requirements.toml", currentHash: "hash", trustStatus: "managed",
  errors: undefined, warnings: undefined, ...overrides });

/** Minimal transport: enough for `createSession` to bind one thread. */
class FakeServer extends EventEmitter {
  hooks = [hookEntry({})];
  hookError;
  calls = [];
  async connect() {}
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === "hooks/list") {
      if (this.hookError !== undefined) throw new Error(this.hookError);
      return { data: this.hooks };
    }
    if (method === "thread/read") {
      return { thread: { id: params.threadId, cwd: "/work", status: { type: "idle" }, turns: [] } };
    }
    if (method === "thread/start" || method === "thread/resume") {
      this.threadId = method === "thread/resume" ? params.threadId : "thread-1";
      return { thread: { id: this.threadId, status: { type: "idle" }, turns: [] }, cwd: params.cwd, model: "test-model" };
    }
    return {};
  }
  respond() {}
  reject() {}
  async close() {}
}

const binding = (overrides = {}) => ({ role: "coding_worker", hook: WORKFLOW_PRE_TOOL_USE,
  args: { cwd: "/work", productWrites: [], auxiliaryWrites: [], sharedWrites: [] }, ...overrides });

function compose(t, { stateDir, hooks } = {}) {
  const dir = stateDir ?? mkdtempSync(join(tmpdir(), "dsh-codex-gate-"));
  if (stateDir === undefined) t.after(() => rmSync(dir, { recursive: true, force: true }));
  const servers = [];
  const backend = new CodexSessionBackend(dir, options => {
    const server = new FakeServer();
    if (hooks !== undefined) server.hooks = hooks;
    server.env = options?.env;
    servers.push(server);
    return server;
  });
  const gate = new CodexGateBridge();
  gate.useClient(CLIENT);
  backend.attachGate(gate);
  t.after(() => gate.close());
  t.after(() => backend.close());
  return { stateDir: dir, backend, gate, servers };
}

test("one handler per hook: duplicate registration fails and the disposer releases it", () => {
  const gate = new CodexGateBridge();
  const handler = () => ({ kind: "allow" });
  const dispose = gate.register(WORKFLOW_PRE_TOOL_USE, handler);
  assert.throws(() => gate.register(WORKFLOW_PRE_TOOL_USE, () => ({ kind: "allow" })), /already registered/);
  assert.throws(() => gate.register("", handler), /hook name is required/);
  assert.throws(() => gate.register("other", undefined), /handler function is required/);
  dispose();
  assert.equal(gate.hasHandler(WORKFLOW_PRE_TOOL_USE), false);
  assert.doesNotThrow(() => gate.register(WORKFLOW_PRE_TOOL_USE, handler));
});

test("a binding is staged before the record exists and is idempotent for the same value", () => {
  const gate = new CodexGateBridge();
  gate.register(WORKFLOW_PRE_TOOL_USE, () => ({ kind: "allow" }));
  gate.bind("child-1", binding());
  // Property order is not a difference; a re-registration of the same binding succeeds.
  gate.bind("child-1", { args: { sharedWrites: [], auxiliaryWrites: [], productWrites: [], cwd: "/work" },
    hook: WORKFLOW_PRE_TOOL_USE, role: "coding_worker" });
  assert.notEqual(gate.bindingFor("child-1"), undefined);
  assert.throws(() => gate.bind("child-1", binding({ role: "manager" })), /different gate/);
});

test("a binding refuses an unregistered hook, a missing role and non-JSON arguments", () => {
  const gate = new CodexGateBridge();
  assert.throws(() => gate.bind("child-1", binding()), /hook is not registered/);
  gate.register(WORKFLOW_PRE_TOOL_USE, () => ({ kind: "allow" }));
  assert.throws(() => gate.bind("child-1", binding({ role: "" })), /non-empty role/);
  assert.throws(() => gate.bind("child-1", binding({ hook: "" })), /non-empty hook/);
  assert.throws(() => gate.bind("", binding()), /Session identity is required/);
  assert.throws(() => gate.bind("child-1", binding({ args: { when: new Date() } })), /plain objects/);
  assert.throws(() => gate.bind("child-1", binding({ args: { value: Number.NaN } })), /finite numbers/);
  assert.throws(() => gate.bind("child-1", binding({ args: { value: undefined } })), /not undefined/);
  assert.throws(() => gate.bind("child-1", binding({ args: { value: () => 1 } })), /JSON data/);
  assert.throws(() => gate.bind("child-1", binding({ args: [] })), /JSON object/);
});

test("the provider accepts any role label; it never enumerates workflow roles", () => {
  const gate = new CodexGateBridge();
  gate.register(WORKFLOW_PRE_TOOL_USE, () => ({ kind: "allow" }));
  for (const role of ["manager", "planner", "a-role-this-package-never-heard-of", "coding_worker"]) {
    gate.bind(`child-${role}`, binding({ role }));
    assert.equal(gate.bindingFor(`child-${role}`).role, role);
  }
});

test("the decision is deny whenever the binding or the handler is unavailable", () => {
  const gate = new CodexGateBridge();
  const event = { source: "codex", sessionId: "child-1", callId: "call", cwd: "/work", toolName: "Bash", toolArgs: {} };
  assert.match(gate.decide("child-1", event).reason, /no workflow binding/);
  let dispose = gate.register(WORKFLOW_PRE_TOOL_USE, () => ({ kind: "allow" }));
  gate.bind("child-1", binding());
  assert.deepEqual(gate.decide("child-1", event), { kind: "allow" });
  // A handler that was unregistered after binding denies instead of falling back
  // to ordinary execution.
  dispose();
  assert.match(gate.decide("child-1", event).reason, /no handler is registered/);
  dispose = gate.register(WORKFLOW_PRE_TOOL_USE, () => { throw new Error("boom"); });
  assert.match(gate.decide("child-1", event).reason, /handler failed: Error: boom/);
  dispose();
  dispose = gate.register(WORKFLOW_PRE_TOOL_USE, () => undefined);
  assert.match(gate.decide("child-1", event).reason, /no decision/);
  dispose();
  gate.register(WORKFLOW_PRE_TOOL_USE, () => ({ kind: "deny", reason: "" }));
  assert.match(gate.decide("child-1", event).reason, /denied without a reason/);
});

test("two Sessions keep their own handler arguments", () => {
  const gate = new CodexGateBridge();
  const seen = [];
  gate.register(WORKFLOW_PRE_TOOL_USE, (bound, event) => {
    seen.push([event.sessionId, bound.role, bound.args.lane]);
    return { kind: "allow" };
  });
  gate.bind("left", binding({ role: "coding_worker", args: { lane: "lane-01" } }));
  gate.bind("right", binding({ role: "reviewer", args: { lane: "lane-02" } }));
  const event = sessionId => ({ source: "dsh", sessionId, callId: "call", cwd: "/work", toolName: "write", toolArgs: {} });
  gate.decide("left", event("left"));
  gate.decide("right", event("right"));
  assert.deepEqual(seen, [["left", "coding_worker", "lane-01"], ["right", "reviewer", "lane-02"]]);
});

test("the handler receives a detached binding it cannot use to rewrite the table", () => {
  const gate = new CodexGateBridge();
  gate.register(WORKFLOW_PRE_TOOL_USE, bound => {
    bound.role = "manager";
    bound.args.cwd = "/elsewhere";
    return { kind: "allow" };
  });
  gate.bind("child-1", binding());
  const event = { source: "dsh", sessionId: "child-1", callId: "call", cwd: "/work", toolName: "write", toolArgs: {} };
  gate.decide("child-1", event);
  assert.equal(gate.bindingFor("child-1").role, "coding_worker");
  assert.equal(gate.bindingFor("child-1").args.cwd, "/work");
});

test("a bound Session's first record persists the gate and a later bind can only restate it", async t => {
  const { backend, gate } = compose(t);
  gate.register(WORKFLOW_PRE_TOOL_USE, () => ({ kind: "allow" }));
  gate.bind("session", binding());
  const snapshot = await backend.createSession("owner", "codex:session", "/work");
  assert.deepEqual(snapshot.options.gate, binding());
  assert.throws(() => gate.bind("session", binding({ role: "manager" })), /different gate/);
  gate.bind("session", binding());
  assert.equal(backend.gateFacts("session").closed, false);
  assert.equal(backend.gateFacts("session").cwd, "/work");
  assert.equal(backend.gateFacts("unknown"), undefined);
});

test("an ordinary Session records no gate and its created options are unchanged", async t => {
  const { backend, gate, stateDir } = compose(t);
  gate.register(WORKFLOW_PRE_TOOL_USE, () => ({ kind: "allow" }));
  const snapshot = await backend.createSession("owner", "codex:plain", "/work", { model: "test-model" });
  assert.equal(snapshot.options.gate, undefined);
  assert.equal(gate.isBound("plain"), false);
  assert.equal(Object.hasOwn(snapshot.options, "gate"), false);
  await backend.close();
  // The store round-trips a gated record and drops an ungated one without inventing a gate.
  const store = new SessionStore(stateDir);
  assert.equal(store.get("owner", "codex:plain").options.gate, undefined);
  store.close();
});

test("the gate survives a Session store reload", async t => {
  const { backend, gate, stateDir } = compose(t);
  gate.register(WORKFLOW_PRE_TOOL_USE, () => ({ kind: "allow" }));
  gate.bind("session", binding({ args: { lane: "lane-01" } }));
  await backend.createSession("owner", "codex:session", "/work");
  await backend.close();
  const store = new SessionStore(stateDir);
  assert.deepEqual(store.get("owner", "codex:session").options.gate, binding({ args: { lane: "lane-01" } }));
  store.close();
});

test("a malformed recorded gate fails the record instead of loading it ungated", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "dsh-codex-gate-bad-"));
  const write = gate => {
    const store = new SessionStore(stateDir);
    store.put({ ownerId: "owner", sessionId: "codex:session", cwd: "/work", state: "idle", approvals: [], facts: [],
      options: gate === undefined ? {} : { gate } });
    store.close();
  };
  const cases = [{}, { role: "", hook: "h", args: {} }, { role: "r", hook: "", args: {} },
    { role: "r", hook: "h", args: [] }, { role: "r", hook: "h", args: {}, extra: 1 }];
  for (const value of cases) {
    rmSync(join(stateDir, "sessions"), { recursive: true, force: true });
    write(value);
    assert.throws(() => new SessionStore(stateDir), /Invalid Session gate binding/, JSON.stringify(value));
  }
  rmSync(stateDir, { recursive: true, force: true });
});

/**
 * Run the built hook command exactly as Codex would: one process, stdin JSON.
 *
 * The receiver lives in this process, so the client must run asynchronously —
 * a synchronous spawn would block the event loop that has to answer it.
 */
function runClient(env, input) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("../lib/pretool-client.js", import.meta.url))],
      { env: { ...process.env, ...env } });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("close", status => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}

/** The single JSON line the hook command printed, or undefined when it printed none. */
function clientDecision(result) {
  const line = result.stdout.trim();
  return line === "" ? undefined : JSON.parse(line).hookSpecificOutput;
}

/** One gated Session ready to receive hook calls, plus the environment Codex would inherit. */
async function gated(t, handler) {
  const composed = compose(t);
  let dispose = composed.gate.register(WORKFLOW_PRE_TOOL_USE, handler);
  composed.gate.bind("session", binding());
  await composed.backend.createSession("owner", "codex:session", "/work");
  const env = composed.servers[0].env;
  assert.equal(env.DSH_PRETOOL_ENABLED, "1");
  assert.equal(typeof env.DSH_PRETOOL_RUNTIME, "string");
  return { ...composed, env, rehandler: next => { dispose(); dispose = composed.gate.register(WORKFLOW_PRE_TOOL_USE, next); } };
}

const hookInput = overrides => JSON.stringify({ session_id: "codex:session", turn_id: "turn-1",
  cwd: "/work", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "touch marker.txt" },
  tool_use_id: "call-1", ...overrides });

test("the built hook command carries a real operation to the Host and back", async t => {
  const seen = [];
  const h = await gated(t, (bound, event) => { seen.push({ role: bound.role, event }); return { kind: "allow" }; });
  const allowed = await runClient(h.env, hookInput());
  assert.equal(allowed.status, 0);
  assert.deepEqual(clientDecision(allowed), { hookEventName: "PreToolUse", permissionDecision: "allow" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].event.source, "codex");
  assert.equal(seen[0].event.sessionId, "session");
  assert.equal(seen[0].event.callId, "call-1");
  assert.equal(seen[0].event.cwd, "/work");
  assert.equal(seen[0].event.toolName, "Bash");
  assert.deepEqual(seen[0].event.toolArgs, { command: "touch marker.txt" });

  h.rehandler(() => ({ kind: "deny", reason: "workflow gate: write outside assigned paths" }));
  const denied = await runClient(h.env, hookInput());
  assert.equal(denied.status, 0);
  assert.deepEqual(clientDecision(denied), { hookEventName: "PreToolUse", permissionDecision: "deny",
    permissionDecisionReason: "workflow gate: write outside assigned paths" });
  assert.equal(denied.stderr.includes(JSON.stringify(h.env.DSH_PRETOOL_RUNTIME)), false, "the client never prints the runtime key");
  assert.equal(denied.stdout.includes(h.env.DSH_PRETOOL_RUNTIME), false);
});

test("an unarmed hook exits silently and an armed one without a transport denies", async () => {
  assert.equal((await runClient({ DSH_PRETOOL_ENABLED: "0", DSH_PRETOOL_SOCKET: "/nonexistent", DSH_PRETOOL_RUNTIME: "k" }, hookInput())).stdout, "");
  const unarmed = await runClient({}, hookInput());
  assert.equal(unarmed.status, 0);
  assert.equal(unarmed.stdout, "", "an ordinary Codex Session is untouched");
  for (const env of [
    { DSH_PRETOOL_ENABLED: "1", DSH_PRETOOL_RUNTIME: "k" },
    { DSH_PRETOOL_ENABLED: "1", DSH_PRETOOL_SOCKET: "/nonexistent/gate.sock" },
  ]) {
    const result = await runClient(env, hookInput());
    assert.equal(result.status, 0);
    assert.equal(clientDecision(result).permissionDecision, "deny", JSON.stringify(env));
  }
  const invalid = await runClient({ DSH_PRETOOL_ENABLED: "1", DSH_PRETOOL_SOCKET: "/nonexistent/gate.sock", DSH_PRETOOL_RUNTIME: "k" }, "not json");
  assert.equal(clientDecision(invalid).permissionDecision, "deny");
});

test("a handler that throws, an unregistered hook and a stale runtime key all deny", async t => {
  const h = await gated(t, () => ({ kind: "allow" }));
  h.rehandler(() => { throw new Error("boom"); });
  assert.match(clientDecision(await runClient(h.env, hookInput())).permissionDecisionReason, /handler failed: Error: boom/);

  const stale = await runClient({ ...h.env, DSH_PRETOOL_RUNTIME: "forged-key" }, hookInput());
  assert.match(clientDecision(stale).permissionDecisionReason, /unknown runtime/);

  // A handed-over Session's old key is retired with its runtime.
  h.gate.releaseRuntime("session");
  assert.match(clientDecision(await runClient(h.env, hookInput())).permissionDecisionReason, /unknown runtime/);
});

test("a payload cannot choose its own Session, role or arguments", async t => {
  const seen = [];
  const h = await gated(t, (bound, event) => { seen.push({ bound, event }); return { kind: "allow" }; });
  // The payload claims another Session and another cwd: the record still decides.
  const forged = await runClient(h.env, hookInput({ session_id: "codex:someone-else", cwd: "/elsewhere" }));
  assert.match(clientDecision(forged).permissionDecisionReason, /not the Session's/);
  const mismatchedTurn = await runClient(h.env, hookInput({ turn_id: "turn-9" }));
  assert.equal(clientDecision(mismatchedTurn).permissionDecision, "allow", "no turn is recorded, so no turn check applies");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].event.sessionId, "session");
  assert.equal(seen[0].event.cwd, "/work");
  assert.deepEqual(seen[0].bound.args, binding().args);
});

test("concurrent Sessions keep their own bindings", async t => {
  const composed = compose(t);
  const seen = [];
  composed.gate.register(WORKFLOW_PRE_TOOL_USE, (bound, event) => { seen.push([event.sessionId, bound.args.lane]); return { kind: "allow" }; });
  composed.gate.bind("left", binding({ args: { ...binding().args, lane: "lane-01" } }));
  composed.gate.bind("right", binding({ args: { ...binding().args, lane: "lane-02" } }));
  await composed.backend.createSession("owner", "codex:left", "/work");
  await composed.backend.createSession("owner", "codex:right", "/work");
  const [left, right] = composed.servers.map(server => server.env);
  const results = await Promise.all([runClient(left, hookInput()), runClient(right, hookInput())]);
  for (const result of results) assert.equal(clientDecision(result).permissionDecision, "allow");
  assert.deepEqual(seen.sort(), [["left", "lane-01"], ["right", "lane-02"]]);
});

test("a receiver that never answers denies instead of hanging the hook", async t => {
  // A receiver that accepts and never answers: the client must deny on its own
  // bound instead of waiting for the hook timeout to expire.
  const accepted = [];
  const silent = createServer(socket => { accepted.push(socket); });
  const dir = mkdtempSync(join(tmpdir(), "dsh-pretool-silent-"));
  const path = join(dir, "gate.sock");
  await new Promise(resolve => silent.listen(path, resolve));
  t.after(() => { for (const socket of accepted) socket.destroy(); return new Promise(resolve => silent.close(() => resolve())); });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const started = Date.now();
  const result = await runClient({ DSH_PRETOOL_ENABLED: "1", DSH_PRETOOL_SOCKET: path, DSH_PRETOOL_RUNTIME: "k" }, hookInput());
  assert.match(clientDecision(result).permissionDecisionReason, /did not answer in time/);
  assert.ok(Date.now() - started >= 2_500, "the client waits for its own 3s bound, shorter than the 10s hook timeout");
});

test("the startup preflight accepts only a managed or trusted PreToolUse entry for this client", () => {
  assert.doesNotThrow(() => assertPreToolUseHook({ data: [hookEntry({})] }, { client: CLIENT }));
  assert.doesNotThrow(() => assertPreToolUseHook({ data: [hookEntry({ isManaged: false, source: "user", trustStatus: "trusted" })] }, { client: CLIENT }));
  const refused = [
    [{ data: [] }, /named no hooks/],
    [{ data: [hookEntry({ command: "node /other/hook.js" })] }, /no installed Codex hook runs/],
    [{ data: [hookEntry({ trustStatus: "untrusted", isManaged: false })] }, /not trusted/],
    [{ data: [hookEntry({ enabled: false })] }, /disabled or reports errors/],
    [{ data: [hookEntry({ errors: ["bad command"] })] }, /disabled or reports errors/],
    [{ data: [hookEntry({ eventName: "PostToolUse" })] }, /not a PreToolUse hook/],
  ];
  for (const [response, pattern] of refused) assert.throws(() => assertPreToolUseHook(response, { client: CLIENT }), pattern);
});

test("a gated Session refuses to start when Codex would silently skip the hook", async t => {
  const composed = compose(t);
  composed.gate.register(WORKFLOW_PRE_TOOL_USE, () => ({ kind: "allow" }));
  composed.gate.bind("session", binding());
  const created = await composed.backend.createSession("owner", "codex:session", "/work");
  assert.equal(created.state, "idle");
  assert.equal(composed.servers.length, 1);
  assert.equal(composed.servers[0].calls.some(call => call.method === "thread/start"), true);

  // A second, freshly gated Session whose listed hook is untrusted never reaches
  // `thread/start`: the entry is present and enabled, and Codex would skip it.
  const other = compose(t, { hooks: [hookEntry({ trustStatus: "untrusted", isManaged: false })] });
  other.gate.register(WORKFLOW_PRE_TOOL_USE, () => ({ kind: "allow" }));
  other.gate.bind("second", binding());
  await assert.rejects(other.backend.createSession("owner", "codex:second", "/work"), /not trusted/);
  assert.deepEqual(other.servers[0].calls.map(call => call.method), ["hooks/list"], "the refusal happens before any thread is started");
});

test("a handed-over thread keeps its binding on the successor", async t => {
  const composed = compose(t);
  composed.gate.register(WORKFLOW_PRE_TOOL_USE, () => ({ kind: "allow" }));
  composed.gate.bind("source", binding());
  await composed.backend.createSession("owner", "codex:source", "/work");
  const port = composed.servers[0].env.DSH_PRETOOL_RUNTIME;
  assert.equal(typeof port, "string");
  await composed.backend.close();
  const backend = new CodexSessionBackend(composed.stateDir, options => {
    const server = new FakeServer();
    server.env = options?.env;
    composed.servers.push(server);
    return server;
  });
  backend.attachGate(composed.gate);
  t.after(() => backend.close());
  const result = await backend.handoffThread("owner", { requestId: "req-1", fromSessionId: "codex:source",
    toSessionId: "codex:successor", model: "test-model" });
  assert.equal(result.toSessionId, "codex:successor");
  const successor = await backend.readSession("owner", "codex:successor");
  assert.deepEqual(successor.options.gate, binding(), "the successor continues the source's scope");
  assert.equal(composed.gate.isBound("successor"), true, "the successor is gated through its own record");
  await backend.resumeSession("owner", "codex:successor");
  assert.equal(composed.servers.at(-1).env.DSH_PRETOOL_ENABLED, "1");
  assert.notEqual(composed.servers.at(-1).env.DSH_PRETOOL_RUNTIME, port, "a handed-over thread gets a fresh runtime key");
});

test("hook run notifications are the evidence that distinguishes a refusal from an untried tool", async t => {
  const h = await gated(t, () => ({ kind: "allow" }));
  assert.deepEqual(h.backend.readHookRuns("session"), []);
  h.servers[0].emit("notification", { method: "hook/started", params: { threadId: "thread-1", turnId: "turn-1",
    hook: { eventName: "preToolUse", command: `node ${CLIENT}` } } });
  h.servers[0].emit("notification", { method: "hook/completed", params: { threadId: "thread-1", turnId: "turn-1",
    result: { permissionDecision: "deny" } } });
  assert.deepEqual(h.backend.readHookRuns("session").map(run => run.method), ["hook/started", "hook/completed"]);
  // A run the Session never reported stays empty: the two states are different.
  assert.deepEqual(h.backend.readHookRuns("other"), []);
});

test("an ungated Session gets no gate environment and no hook preflight", async t => {
  const composed = compose(t);
  await composed.backend.createSession("owner", "codex:plain", "/work");
  assert.equal(composed.servers[0].env, undefined, "no runtime key is injected");
  assert.deepEqual(composed.servers[0].calls.map(call => call.method), ["thread/start"], "no hooks/list is issued");
});
