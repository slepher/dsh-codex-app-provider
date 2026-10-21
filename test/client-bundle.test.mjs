import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = readFileSync(new URL("lib/client.js", root), "utf8");
const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));

/** One Host form stand-in: the settings contract the component subscribes to. */
function formStub() {
  const snapshot = {
    status: "ready",
    value: { command: "codex", allowMainSession: false, toolBridge: { enabled: false, allow: [] } },
    base: undefined, user: undefined, revision: 3, writable: true,
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    mutate: async () => true,
    set: async () => true,
    unset: async () => true,
  };
}

/** Load the shipped client bundle the way the shell's module table does. */
function loadBundle() {
  let loaded;
  const window = { __ModuleLoader__: { load: value => { loaded = value; } } };
  runInNewContext(source, { window, require: name => { throw new Error(`unexpected require ${name}`); } });
  const registrations = [];
  const form = formStub();
  const slots = {
    inject(_name, factory) { factory(); return () => {}; },
    register(options, component) { registrations.push({ options, component }); return () => {}; },
  };
  const configForms = { get: ns => { assert.equal(ns, "dsh-codex-app-provider"); return form; } };
  const ctx = {
    inject(services, factory) {
      assert.deepEqual([...services].sort(), ["configForms", "slots"]);
      factory({ ...ctx, slots, configForms });
    },
    slots,
    configForms,
  };
  const plugin = loaded.factory(name => {
    if (name === "react") return { useState: () => [undefined, () => {}], useSyncExternalStore: (_subscribe, get) => get() };
    if (name === "react/jsx-runtime") {
      const element = (type, props) => ({ type, props });
      return { jsx: element, jsxs: element, Fragment: null };
    }
    throw new Error(`unexpected module ${name}`);
  });
  return { plugin, ctx, registrations, form };
}

test("the browser half registers every configuration surface", () => {
  const { plugin, ctx, registrations } = loadBundle();
  assert.deepEqual([...plugin.inject].sort(), ["configForms", "slots"]);
  plugin.apply(ctx);
  assert.equal(registrations.length, 3);
  const bundle = registrations.find(entry => entry.options.name === "plugins.bundle.config");
  assert.equal(bundle.options.key, "dsh-codex-app-provider");
  const row = registrations.find(entry => entry.options.name === "plugins.row.config");
  assert.equal(row.options.key, "dsh-codex-app-provider#dsh-codex-app-provider");
  const section = registrations.find(entry => entry.options.name === "settings.section");
  assert.equal(section.options.id, "codex-app-provider");
  assert.equal(section.options.label(), "Codex app");
  for (const entry of registrations) assert.equal(typeof entry.component, "function");
});

test("the component renders the Host form's accepted value", () => {
  const { ctx, plugin, registrations } = loadBundle();
  plugin.apply(ctx);
  const bundle = registrations.find(entry => entry.options.name === "plugins.bundle.config");
  const rendered = bundle.component({ view: "page" });
  assert.notEqual(rendered, undefined, "the page body renders");
  assert.equal(rendered.props.view, "page");
  assert.equal(bundle.component({ view: "summary" }).props.view, "summary");
});

test("the bundle and manifest present the client half to the shell", () => {
  assert.match(source, /id:\s*"dsh-codex-app-provider"/);
  assert.match(source, /plugins\.bundle\.config/);
  assert.match(source, /plugins\.row\.config/);
  assert.equal(manifest.dsh.client.platform, "web");
  assert.ok(manifest.dsh.client.inject.includes("@deepseek-ai/dsh-client-ui-renderer"));
  assert.ok(manifest.dsh.client.inject.includes("@deepseek-ai/dsh-client-ui-settings"));
  assert.equal(manifest.exports["./client"].default, "./lib/client.js");
});
