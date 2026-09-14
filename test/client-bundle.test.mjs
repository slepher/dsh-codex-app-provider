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
  let position = "sidebar";
  const scope = { getSnapshot: () => ({ status: "ready", mode: "host", value: { subagentOpenPosition: position } }) };
  const runEffect = fn => {
    const result = fn();
    if (typeof result === "function") effects.push(result);
    else if (result?.next) for (const dispose of result) effects.push(dispose);
  };
  const ctx = {
    inject(names, fn) { fn(ctx); },
    uiConversation: { events: { register(value) { definitions.push(value); } } },
    effect(fn) { runEffect(fn); },
    on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name); },
    locale: { register(ns) { assert.equal(ns, "dsh-codex-app-provider"); return () => {}; } },
    settingsScope: { bind(spec) { assert.equal(spec.namespace, "dsh-codex-app-provider"); return scope; } },
    sessions: {
      list: { getSnapshot: () => ({ current: "parent" }) },
      subagentAddress(id) { return id.startsWith("child") ? { parentSessionId: "parent", childSessionId: id, mode: "continuable" } : undefined; },
      openSubagent(address) { navigated.push(address); },
    },
    remote: { $stream() {}, session: {}, subagents: { prompt: async () => ({ ok: true, value: {} }), interruptByParent: async () => ({ ok: true, value: {} }) } },
    sidebarRight: { openResource(address, options) { opened.push({ address, options }); } },
    sidebarRightTabs: { register(definition) { assert.equal(definition.kind, "codex-child"); return () => {}; } },
    slots: { inject(_name, fn) { runEffect(fn); return () => {}; }, register(row, component) { rows.push(row); components.set(row.key ?? row.id ?? row.name, component); return () => {}; } },
  };
  return { ctx, state: { effects, rows, definitions, opened, navigated, handlers, components, setPosition: value => { position = value; } } };
}

test("shipped client registers the child pane, the lineage entry and the execution node", () => {
  const module = loadBundle();
  const { ctx, state } = harness();
  module.apply(ctx);
  assert.equal(state.definitions.length, 2, "both Codex conversation node definitions are registered");

  // The execution node still renders through the shared JSX runtime.
  const rendered = state.components.get("codex-execution")({ node: { data: { kind: "commandExecution", status: "completed", text: "ok" } }, useTurnData: () => undefined, t: key => key });
  assert.equal(rendered.type, "details");

  // The lineage seat is taken at a lower priority than the official occupant, so
  // the plugin owns the child entry without adding a second additive seat.
  const lineage = state.rows.find(row => row.name === "conversation.session.header.lineage");
  assert.equal(lineage.priority, -1);
  const lineageFace = lineage.inject();
  const address = lineageFace.addressOf("child-1");
  assert.deepEqual(address, { parentSessionId: "parent", childSessionId: "child-1", mode: "continuable" });
  assert.equal(lineageFace.addressOf("unrelated"), undefined, "a non-child crumb keeps the core rendering");

  const lineageNode = state.components.get("conversation.session.header.lineage");
  // A non-child crumb renders the plain title and never navigates.
  const plain = lineageNode({ lineageSessionId: "unrelated", displayTitle: "Parent", openTitle: () => state.navigated.push("openTitle"), addressOf: lineageFace.addressOf, position: lineageFace.position, openSidebar: lineageFace.openSidebar, t: key => key });
  assert.equal(plain.type, Symbol.for("react.fragment"), "a non-child crumb is a plain fragment with no navigation of its own");
  // A child crumb opens the plugin pane while the sidebar position is configured.
  const crumb = lineageNode({ lineageSessionId: "child-1", displayTitle: "Child", openTitle: () => state.navigated.push("openTitle"), addressOf: lineageFace.addressOf, position: lineageFace.position, openSidebar: lineageFace.openSidebar, t: key => key });
  assert.equal(crumb.type, "button");
  crumb.props.onClick();
  assert.equal(state.opened.length, 1);
  assert.equal(state.opened[0].address, "dsh-resource://codex-child/parent/child-1/continuable");
  assert.deepEqual(state.opened[0].options.params, address);
  assert.deepEqual(state.navigated, [], "the sidebar route does not touch the main area");

  // With the main-area position configured the same click uses the core entry.
  state.setPosition("main");
  crumb.props.onClick();
  assert.deepEqual(state.navigated, ["openTitle"]);
  assert.equal(state.opened.length, 1, "no sidebar resource is opened for the main-area position");
  state.setPosition("sidebar");

  // The pane registers a tab type and a body; no mount field is invented.
  const panel = state.rows.find(row => row.key === "codex-child");
  assert.equal(panel.children, undefined, "the pane owns its own view instead of declaring a mount");
  const face = panel.inject();
  let published;
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
  for (const frame of [/\.codex-child\s*\{/, /\.codex-child-log/, /\.codex-child-row/, /\.codex-child-composer/, /\.codex-child-lineage/]) {
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
