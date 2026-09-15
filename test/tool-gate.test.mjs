import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CodexSessionBackend } from "../lib/backend.js";
import { SessionStore } from "../lib/store.js";
import { CodexGateBridge, WORKFLOW_PRE_TOOL_USE } from "../lib/tool-gate.js";

/** Minimal transport: enough for `createSession` to bind one thread. */
class FakeServer extends EventEmitter {
  async connect() {}
  async request(method, params) {
    if (method === "thread/start" || method === "thread/resume") {
      return { thread: { id: "thread-1", status: { type: "idle" }, turns: [] }, cwd: params.cwd, model: "test-model" };
    }
    return {};
  }
  respond() {}
  reject() {}
  async close() {}
}

const binding = (overrides = {}) => ({ role: "coding_worker", hook: WORKFLOW_PRE_TOOL_USE,
  args: { cwd: "/work", productWrites: [], auxiliaryWrites: [], sharedWrites: [] }, ...overrides });

function compose(t, { stateDir } = {}) {
  const dir = stateDir ?? mkdtempSync(join(tmpdir(), "dsh-codex-gate-"));
  if (stateDir === undefined) t.after(() => rmSync(dir, { recursive: true, force: true }));
  const backend = new CodexSessionBackend(dir, () => new FakeServer());
  const gate = new CodexGateBridge();
  backend.attachGate(gate);
  t.after(() => backend.close());
  return { stateDir: dir, backend, gate };
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
