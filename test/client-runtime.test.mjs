import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { join } from "node:path";
import test from "node:test";

import { createCodexApprovalRpc } from "../lib/client/approval-rpc.js";

// One React instance for the bundle and the renderer: resolution can pick either
// tree's copy, so both are loaded through the tree that answers `react-dom/server`.
const probe = createRequire(import.meta.url);
const reactDomPath = probe.resolve("react-dom/server");
const platformRequire = createRequire(join(reactDomPath.slice(0, reactDomPath.indexOf("react-dom")), "index.js"));
const React = platformRequire("react");
const { renderToStaticMarkup } = platformRequire("react-dom/server");

const PLATFORM = ["react", "react/jsx-runtime", "react-dom"];
const EXTERNAL = "@deepseek-ai/dsh-api-session-controller/client";

class FakeSessionEventStream {
  constructor(remote, address, options) {
    // The real stream reads `remote.session`; a scope that does not declare it
    // must fail here instead of only in a live shell.
    assert.notEqual(remote.session, undefined, "the child stream needs the injected remote.session service");
    this.remote = remote; this.address = address; this.options = options;
  }
  async open() {}
  async prepend() {}
  restart() {}
  async dispose() {}
}

/** Load the shipped client bundle and capture the components it registers. */
function load() {
  const require = platformRequire;
  let module;
  runInNewContext(readFileSync(new URL("../lib/client.js", import.meta.url), "utf8"), {
    window: { __ModuleLoader__: { load(value) {
      module = value.factory(name => {
        if (name === EXTERNAL) return { SessionEventStream: FakeSessionEventStream };
        assert.ok(PLATFORM.includes(name), `unexpected module request ${name}`);
        return require(name);
      });
    } } },
  });
  const components = new Map(), routes = [], rows = [], calls = [];
  const runEffect = fn => { const result = fn(); if (typeof result === "function") routes.push(result); else if (result?.next) for (const d of result) routes.push(d); };
  const subsystems = {
    uiConversation: { events: { register() {} } },
    sessions: {
      get: () => undefined,
      subagentAddress: id => (id === "child-1" ? { parentSessionId: "parent", childSessionId: id, mode: "continuable" } : undefined),
      openSubagent: address => calls.push({ kind: "openSubagent", address }),
    },
    remote: { own: { $stream() {} }, subs: { session: {}, subagents: {} } },
    connection: { rpc: { call: async () => ({ ok: true, value: { approvals: [] } }) } },
    sidebarRight: { openResource: resource => calls.push({ kind: "openResource", resource }) },
    sidebarRightTabs: { register() { return () => {}; } },
  };
  // The plugin's own `inject` list is what every scope inherits; a scope only
  // also sees the services it asks for. Passing the whole context to every
  // scope would hide exactly the mistake this models: reading a Session service
  // from a conversation-scoped inject face.
  const own = {
    slots: { inject(_name, fn) { runEffect(fn); return () => {}; }, register(row, component) { rows.push(row); components.set(row.key ?? row.id ?? row.name, component); return () => {}; } },
    locale: { register() { return () => {}; } },
    settingsScope: { bind() { return { getSnapshot: () => ({ status: "ready", value: { subagentOpenPosition: "sidebar" } }) }; } },
  };
  const ctx = {
    ...own,
    effect(fn) { runEffect(fn); },
    inject(names, fn) {
      const scope = { ...own };
      for (const name of names) {
        const [head, sub] = name.split(".");
        if (sub === undefined) scope[head] = { ...(subsystems[head].own ?? subsystems[head]) };
        // A nested service must be asked for by its own name: the shell refuses
        // `remote.session` to a scope that only declared `remote`.
        else scope[head] = { ...(scope[head] ?? {}), [sub]: subsystems[head].subs[sub] };
      }
      fn(scope);
    },
  };
  module.apply(ctx);
  return { components, rows, routes, calls };
}

test("the pane renders its transcript, composer and stop control", async () => {
  const { components } = load();
  const ChildConversation = components.get("codex-child");
  const nativeState = () => () => {};
  const attach = () => ({ getSnapshot: () => ({ rows: [], running: false, pendingApprovals: 0, hasMore: false, loading: true }),
    getDraft: () => "", setDraft: value => value, loadMore: async () => {}, restart() {}, send: async () => {}, stop: async () => {}, release() {} });
  const approvals = createCodexApprovalRpc({ rpc: { call: async (_channel, method) => ({ ok: true, value: method === "questions" ? { questions: [] } : { approvals: [] } }) } });
  const address = { parentSessionId: "parent", childSessionId: "child-1", mode: "continuable" };
  const html = renderToStaticMarkup(React.createElement(ChildConversation, {
    useTabInfo: () => ({ tab: { navigation: { params: address }, signal: new AbortController().signal } }),
    openMain() {}, attach, approvals, nativeState, t: key => key,
  }));
  assert.match(html, /codex-child-log/, "the transcript is a log region");
  assert.match(html, /role="log"/);
  assert.match(html, /codex-child-input/, "the composer input renders");
  assert.match(html, /aria-label="childPrompt"/);
  assert.match(html, /childStop/, "the stop control renders");
  assert.match(html, /childSend/, "an idle child is sent to, not steered");
  assert.match(html, /childLoading/, "an empty unopened pane shows its loading state");

  // A tab without a child address renders the unavailable state instead of the pane.
  const unavailable = renderToStaticMarkup(React.createElement(ChildConversation, {
    useTabInfo: () => ({ tab: { navigation: { params: undefined }, signal: new AbortController().signal } }),
    openMain() {}, attach, approvals, nativeState, t: key => key,
  }));
  assert.match(unavailable, /childUnavailable/);
  assert.doesNotMatch(unavailable, /codex-child-log/);
});

test("the header child entry resolves a child through the shell's Session services", () => {
  const { components, rows } = load();
  const row = rows.find(candidate => candidate.name === "conversation.session.header.actions");
  assert.ok(row !== undefined, "the plugin registers an additive header action");
  const ChildAction = components.get("codex-child-open");
  assert.ok(ChildAction !== undefined, "the header action component is registered under its id");
  const face = row.inject();
  const action = renderToStaticMarkup(React.createElement(ChildAction, { sessionId: "child-1", t: key => key, ...face }));
  assert.match(action, /codex-child-open/, "a direct child gets the plugin's entry");
  assert.match(action, /childOpen/, "the entry states what it opens");
  // A Session that is not a direct child contributes nothing instead of throwing.
  assert.equal(renderToStaticMarkup(React.createElement(ChildAction, { sessionId: "parent", t: key => key, ...face })), "");
});

test("the pane's own stream gets the services it needs from the shell", () => {
  const { rows } = load();
  const row = rows.find(candidate => candidate.name === "sidebar.right.pane.tab");
  assert.ok(row !== undefined, "the plugin registers a child pane tab");
  const face = row.inject();
  const handle = face.attach({ parentSessionId: "parent", childSessionId: "child-1", mode: "continuable" }, () => {});
  assert.equal(typeof handle.getSnapshot, "function", "attaching one pane yields a readable view");
  handle.release();
});

test("the client approval calls use the plugin's own channel", async () => {
  const calls = [];
  const rpc = createCodexApprovalRpc({ rpc: { call: async (channel, method, payload, signal) => {
    calls.push({ channel, method, payload, signal });
    if (method === "pending") return { ok: true, value: { approvals: [{ requestId: "req-1", turnId: "turn-1", method: "m", reason: "run ls" }] } };
    if (method === "questions") return { ok: true, value: { questions: [] } };
    return { ok: true, value: { decided: true } };
  } } });
  const controller = new AbortController();
  const pending = await rpc.pending("child-1", controller.signal);
  await rpc.questions("child-1", controller.signal);
  await rpc.answer("child-1", "req-2", { q1: ["Yes"] }, controller.signal);
  assert.deepEqual(calls[1], { channel: "/codex-approval", method: "questions", payload: { sessionId: "child-1" }, signal: controller.signal });
  assert.deepEqual(calls[2], { channel: "/codex-approval", method: "answer", payload: { sessionId: "child-1", requestId: "req-2", answers: { q1: ["Yes"] } }, signal: controller.signal });
  assert.deepEqual(pending.map(entry => entry.requestId), ["req-1"]);
  assert.deepEqual(calls[0], { channel: "/codex-approval", method: "pending", payload: { sessionId: "child-1" }, signal: controller.signal });
  await rpc.decide("child-1", "req-1", "decline", controller.signal);
  assert.deepEqual(calls[3].payload, { sessionId: "child-1", requestId: "req-1", decision: "decline" });

  const failing = createCodexApprovalRpc({ rpc: { call: async () => ({ ok: false, error: { message: "Approval is no longer pending for this Session" } }) } });
  await assert.rejects(failing.decide("child-1", "req-1", "accept"), /no longer pending/,
    "a stale decision surfaces the channel's refusal instead of being swallowed");
});
