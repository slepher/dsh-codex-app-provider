import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";

test("shipped client loads through DSH module loader and registers native settings and external execution node", () => {
  const require = createRequire(import.meta.url);
  let module;
  runInNewContext(readFileSync(new URL("../lib/client.js", import.meta.url), "utf8"), {
    window: { __ModuleLoader__: { load(value) { assert.equal(value.id, "dsh-codex-app-provider"); module = value.factory(name => { assert.ok(["react", "react/jsx-runtime"].includes(name)); return require(name); }); } } },
  });
  const effects = [], rows = [], definitions = [], opened = [], navigated = [];
  const components = new Map();
  const handlers = new Map();
  let position = "sidebar", retained = 0, released = 0;
  const scope = { getSnapshot: () => ({ status: "ready", mode: "host", value: { subagentOpenPosition: position } }) };
  const runEffect = fn => {
    const result = fn();
    if (typeof result === "function") effects.push(result);
    else if (result?.next) for (const dispose of result) effects.push(dispose);
  };
  const ctx = {
    inject(names, fn) { assert.ok(["uiConversation", "sessions"].includes(names[0])); fn(ctx); },
    uiConversation: { events: { register(value) { definitions.push(value); } } },
    effect(fn) { runEffect(fn); },
    on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name); },
    locale: { register(ns) { assert.equal(ns, "dsh-codex-app-provider"); return () => {}; } },
    settingsScope: { bind(spec) { assert.equal(spec.namespace, "dsh-codex-app-provider"); return scope; } },
    sessions: {
      list: { getSnapshot: () => ({ current: "parent" }) },
      retainSubagent() { retained++; return () => { released++; }; },
      openSubagent(address) { navigated.push(address); },
    },
    sidebarRight: { openResource(address, options) { opened.push({ address, options }); } },
    sidebarRightTabs: { register(definition) { assert.equal(definition.kind, "codex-child"); return () => {}; } },
    slots: { inject(_name, fn) { runEffect(fn); return () => {}; }, register(row, component) { rows.push(row); components.set(row.key ?? row.id, component); return () => {}; } },
  };
  module.apply(ctx);
  assert.equal(definitions.length, 2);
  const rendered = components.get("codex-execution")({ node: { data: { kind: "commandExecution", status: "completed", text: "ok" } }, useTurnData: () => undefined, t: key => key });
  assert.equal(rendered.type, "details", "shipped JSX uses the shared runtime without a global React");
  assert.equal(rows.length, 3);
  assert.equal(rows.find(row => row.name === "settings.general.item").inject().hooks.settings, scope);
  const address = { parentSessionId: "parent", childSessionId: "child", mode: "continuable" };
  const open = handlers.get("subagent/open");
  assert.equal(open({ address, originSessionId: "parent" }), true);
  assert.equal(opened.length, 1);
  assert.equal(opened[0].options.params, address);
  position = "main";
  assert.equal(open({ address, originSessionId: "parent" }), undefined);
  position = "sidebar";
  assert.equal(open({ address, originSessionId: "old-parent" }), undefined);
  assert.equal(opened.length, 1);
  const panel = rows.find(row => row.key === "codex-child");
  assert.equal(panel.children["codex.child.conversation"].mount, "main.conversation");
  const face = panel.inject();
  const lifetime = new AbortController();
  face.retainView(address, lifetime.signal); face.retainView(address, lifetime.signal);
  assert.equal(retained, 1); assert.equal(released, 0);
  face.openMain(address); assert.equal(navigated[0], address);
  lifetime.abort(); assert.equal(released, 1);
  const other = new AbortController(); face.retainView(address, other.signal);
  effects.reverse().forEach(dispose => dispose());
  assert.equal(released, 2); assert.equal(handlers.size, 0);
});
