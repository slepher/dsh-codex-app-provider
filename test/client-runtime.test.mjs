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
  constructor(remote, address, options) { this.remote = remote; this.address = address; this.options = options; }
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
  const components = new Map(), routes = [], rows = [];
  const runEffect = fn => { const result = fn(); if (typeof result === "function") routes.push(result); else if (result?.next) for (const d of result) routes.push(d); };
  const ctx = {
    inject(_names, fn) { fn(ctx); },
    uiConversation: { events: { register() {} } },
    effect(fn) { runEffect(fn); },
    locale: { register() { return () => {}; } },
    settingsScope: { bind() { return { getSnapshot: () => ({ status: "ready", value: { subagentOpenPosition: "sidebar" } }) }; } },
    sessions: { get: () => undefined, subagentAddress: id => ({ parentSessionId: "parent", childSessionId: id, mode: "continuable" }), openSubagent() {} },
    remote: { $stream() {}, session: {}, subagents: {} },
    connection: { rpc: { call: async () => ({ ok: true, value: { approvals: [] } }) } },
    sidebarRight: { openResource() {} },
    sidebarRightTabs: { register() { return () => {}; } },
    slots: { inject(_name, fn) { runEffect(fn); return () => {}; }, register(row, component) { rows.push(row); components.set(row.key ?? row.id ?? row.name, component); return () => {}; } },
  };
  module.apply(ctx);
  return { components, rows, routes };
}

test("the pane renders its transcript, composer and stop control", async () => {
  const { components } = load();
  const ChildConversation = components.get("codex-child");
  const attach = () => ({ getSnapshot: () => ({ rows: [], running: false, pendingApprovals: 0, hasMore: false, loading: true }),
    getDraft: () => "", setDraft: value => value, loadMore: async () => {}, restart() {}, send: async () => {}, stop: async () => {}, release() {} });
  const approvals = createCodexApprovalRpc({ rpc: { call: async () => ({ ok: true, value: { approvals: [] } }) } });
  const address = { parentSessionId: "parent", childSessionId: "child-1", mode: "continuable" };
  const html = renderToStaticMarkup(React.createElement(ChildConversation, {
    useTabInfo: () => ({ tab: { navigation: { params: address }, signal: new AbortController().signal } }),
    openMain() {}, attach, approvals, t: key => key,
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
    openMain() {}, attach, approvals, t: key => key,
  }));
  assert.match(unavailable, /childUnavailable/);
  assert.doesNotMatch(unavailable, /codex-child-log/);
});

test("the client approval calls use the plugin's own channel", async () => {
  const calls = [];
  const rpc = createCodexApprovalRpc({ rpc: { call: async (channel, method, payload, signal) => {
    calls.push({ channel, method, payload, signal });
    return method === "pending" ? { ok: true, value: { approvals: [{ requestId: "req-1", turnId: "turn-1", method: "m", reason: "run ls" }] } } : { ok: true, value: { decided: true } };
  } } });
  const controller = new AbortController();
  const pending = await rpc.pending("child-1", controller.signal);
  assert.deepEqual(pending.map(entry => entry.requestId), ["req-1"]);
  assert.deepEqual(calls[0], { channel: "/codex-approval", method: "pending", payload: { sessionId: "child-1" }, signal: controller.signal });
  await rpc.decide("child-1", "req-1", "decline", controller.signal);
  assert.deepEqual(calls[1].payload, { sessionId: "child-1", requestId: "req-1", decision: "decline" });

  const failing = createCodexApprovalRpc({ rpc: { call: async () => ({ ok: false, error: { message: "Approval is no longer pending for this Session" } }) } });
  await assert.rejects(failing.decide("child-1", "req-1", "accept"), /no longer pending/,
    "a stale decision surfaces the channel's refusal instead of being swallowed");
});
