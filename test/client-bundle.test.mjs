import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";

const PLATFORM = ["react", "react/jsx-runtime", "react-dom"];
/** The one declared non-baseline request; the shell answers it from its module table. */
const EXTERNAL = "@deepseek-ai/dsh-api-session-controller/client";
/** Stand-in for the externally supplied stream class. */
class FakeSessionEventStream {
  constructor(remote, address, options) { this.remote = remote; this.address = address; this.options = options; }
  async open() {}
  async prepend() {}
  restart() {}
  async dispose() {}
}

/** Load the shipped bundle with a recording module table. */
function loadBundle() {
  const require = createRequire(import.meta.url);
  let module;
  runInNewContext(readFileSync(new URL("../lib/client.js", import.meta.url), "utf8"), {
    window: { __ModuleLoader__: { load(value) {
      assert.equal(value.id, "dsh-codex-app-provider");
      module = value.factory(name => {
        if (name === EXTERNAL) return { SessionEventStream: FakeSessionEventStream };
        assert.ok(PLATFORM.includes(name), `unexpected module request ${name}`);
        return require(name);
      });
    } } },
  });
  return module;
}

/** A minimal client context that records registrations. */
function harness() {
  const effects = [], rows = [], definitions = [], opened = [], navigated = [], handlers = new Map();
  const components = new Map();
  const runEffect = fn => {
    const result = fn();
    if (typeof result === "function") effects.push(result);
    else if (result?.next) for (const dispose of result) effects.push(dispose);
  };
  const subsystems = {
    uiConversation: { events: { register(value) { definitions.push(value); } } },
    sessions: {
      list: { getSnapshot: () => ({ current: "parent" }) },
      // The client service exposes exactly this accessor to feature plugins; the
      // controller's catalog-navigation helper is not part of that surface.
      subagentAddress(id) { return id === "child-1" ? { parentSessionId: "parent", childSessionId: id, mode: "continuable" } : undefined; },
      openSubagent(address) { navigated.push(address); },
    },
    remote: { $stream() {}, session: {}, subagents: { prompt: async () => ({ ok: true, value: {} }), interruptByParent: async () => ({ ok: true, value: {} }) } },
    connection: { rpc: { call: async () => ({ ok: true, value: { approvals: [] } }) } },
    sidebarRight: { openResource(address, options) { opened.push({ address, options }); } },
    sidebarRightTabs: { register(definition) { assert.equal(definition.kind, "codex-child"); return () => {}; } },
  };
  // A scope sees the plugin's own injected services plus the ones it asks for;
  // reading a Session service from a conversation-scoped face must not work.
  const own = {
    effect(fn) { runEffect(fn); },
    on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name); },
    locale: { register(ns) { assert.equal(ns, "dsh-codex-app-provider"); return () => {}; } },
    slots: { inject(_name, fn) { runEffect(fn); return () => {}; }, register(row, component) { rows.push(row); components.set(row.key ?? row.id ?? row.name, component); return () => {}; } },
  };
  const ctx = {
    ...own,
    inject(names, fn) {
      const view = { ...own };
      for (const name of names) view[name.split(".")[0]] = subsystems[name.split(".")[0]];
      fn(view);
    },
  };
  return { ctx, state: { effects, rows, definitions, opened, navigated, handlers, components } };
}

test("shipped client registers the child pane, the additive child entry and the execution node", async () => {
  const module = loadBundle();
  const { ctx, state } = harness();
  module.apply(ctx);
  assert.equal(state.rows.some(row => row.name === "settings.general.item"), false, "no opening-position setting is registered");
  assert.equal(module.inject.includes("settingsScope"), false);
  assert.equal(state.definitions.length, 2, "both Codex conversation node definitions are registered");

  // The execution node still renders through the shared JSX runtime.
  const rendered = state.components.get("codex-execution")({ node: { data: { kind: "commandExecution", status: "completed", text: "ok" } }, useTurnData: () => undefined, t: key => key });
  assert.equal(rendered.type, "details");

  // The entry is additive: the single lineage seat keeps its official catalog
  // occupant, and this plugin contributes a header action instead.
  assert.equal(state.rows.some(row => row.name === "conversation.session.header.lineage"), false,
    "the official subagent catalog keeps its seat");
  const open = state.rows.find(row => row.id === "codex-child-open");
  assert.equal(open.name, "conversation.session.header.actions");
  const openFace = open.inject();
  const address = openFace.addressOf("child-1");
  assert.deepEqual(address, { parentSessionId: "parent", childSessionId: "child-1", mode: "continuable" });
  assert.equal(openFace.addressOf("unrelated"), undefined, "an ordinary Session gets no child entry");
  assert.equal(openFace.addressOf("child-2"), undefined,
    "a child the shell did not retain is left to the official catalog rather than guessed at");

  const action = state.components.get("codex-child-open");
  assert.equal(action({ sessionId: "unrelated", addressOf: openFace.addressOf,
    openSidebar: openFace.openSidebar, t: key => key }), null,
    "an ordinary Session renders nothing");
  const button = action({ sessionId: "child-1", addressOf: openFace.addressOf,
    openSidebar: openFace.openSidebar, t: key => key });
  assert.equal(button.type, "button");
  assert.match(button.props.title, /childOpen → childPositionSidebar/,
    "the entry states where it will open, which the official catalog beside it does not");
  button.props.onClick();
  assert.equal(state.opened.length, 1);
  assert.equal(state.opened[0].address, "dsh-resource://codex-child/parent/child-1/continuable");
  assert.deepEqual(state.opened[0].options.params, address);
  assert.deepEqual(state.navigated, [], "the sidebar route does not touch the main area");

  // The pane registers a tab type and a body; no mount field is invented.
  const panel = state.rows.find(row => row.key === "codex-child");
  assert.equal(panel.children, undefined, "the pane owns its own view instead of declaring a mount");
  const face = panel.inject();
  let published;
  assert.equal(typeof face.approvals.pending, "function", "the pane answers native approvals on the plugin's own channel");
  assert.equal(typeof face.approvals.decide, "function");
  await face.approvals.pending("child-1");
  const handle = face.attach(address, snapshot => { published = snapshot; });
  assert.equal(typeof handle.getSnapshot, "function");
  assert.equal(handle.getDraft(), "", "a fresh tab starts with an empty draft");
  handle.setDraft("half typed");
  handle.release();
  assert.equal(published.rows.length, 0);
  face.openMain(address);
  assert.deepEqual(state.navigated.at(-1), address);

  state.effects.reverse().forEach(dispose => dispose());
});

test("shipped client styles the child pane from the shared tokens", () => {
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  for (const frame of [/\.codex-child\s*\{/, /\.codex-child-log/, /\.codex-child-row/, /\.codex-child-composer/, /\.codex-child-open/]) {
    assert.match(source, frame, `child pane style ${String(frame)} is missing`);
  }
  for (const token of [/var\(--dsw-alias-bg-module-platform\)/, /var\(--dsw-alias-label-primary\)/, /var\(--dsw-alias-border-l2\)/]) {
    assert.match(source, token, `shared token ${String(token)} is missing`);
  }
  assert.match(source, /data-plugin-css/);
  assert.ok(source.includes('className: "codex-child"'));
  assert.ok(source.includes('className: "codex-child-log"'));
  assert.ok(source.includes('"aria-label"') || source.includes("aria-label"), "the composer keeps an accessible name");
  assert.ok(source.includes('role: "log"'), "the transcript is a live log region");
});
