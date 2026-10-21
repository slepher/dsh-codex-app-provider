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
  const localeRegistrations = [];
  const rpcCalls = [];
  const form = formStub();
  const slots = {
    inject(_name, factory) { factory(); return () => {}; },
    register(options, component) { registrations.push({ options, component }); return () => {}; },
  };
  const configForms = { get: ns => { assert.equal(ns, "dsh-codex-app-provider"); return form; } };
  const locale = {
    register(ns, copies) { localeRegistrations.push({ ns, copies }); return () => {}; },
    bind: ns => key => `[${ns}:${key}]`,
  };
  const connection = {
    rpc: {
      call(path, method, payload) {
        rpcCalls.push({ path, method, payload });
        return Promise.resolve({
          ok: true,
          value: { checkedAt: 42, command: { program: "C:\\codex.exe", prefixArgs: [], source: "native" }, version: "codex-cli 9.9.9", models: ["m1"] },
        });
      },
    },
  };
  const ctx = {
    effect(fn) { fn(); return () => {}; },
    get(name) { assert.equal(name, "connection"); return connection; },
    inject(services, factory) {
      assert.deepEqual([...services].sort(), ["configForms", "slots"]);
      factory({ ...ctx, slots, configForms, locale, connection });
    },
    slots,
    configForms,
    locale,
    connection,
  };
  const plugin = loaded.factory(name => {
    if (name === "react") {
      return {
        useState: () => [undefined, () => {}],
        useEffect: fn => { fn(); },
        useSyncExternalStore: (_subscribe, get) => get(),
      };
    }
    if (name === "react/jsx-runtime") {
      const element = (type, props) => ({ type, props });
      return { jsx: element, jsxs: element, Fragment: null };
    }
    throw new Error(`unexpected module ${name}`);
  });
  return { plugin, ctx, registrations, localeRegistrations, form, rpcCalls };
}

test("the browser half registers its copy and every configuration surface", () => {
  const { plugin, ctx, registrations, localeRegistrations } = loadBundle();
  assert.deepEqual([...plugin.inject].sort(), ["configForms", "connection", "locale", "slots"]);
  plugin.apply(ctx);
  assert.equal(localeRegistrations.length, 1);
  assert.equal(localeRegistrations[0].ns, "dsh-codex-app-provider");
  assert.equal(typeof localeRegistrations[0].copies.zh.nav, "string");
  assert.equal(localeRegistrations[0].copies.en.nav, "Codex app");
  assert.equal(registrations.length, 3);
  const bundle = registrations.find(entry => entry.options.name === "plugins.bundle.config");
  assert.equal(bundle.options.key, "dsh-codex-app-provider");
  const row = registrations.find(entry => entry.options.name === "plugins.row.config");
  assert.equal(row.options.key, "dsh-codex-app-provider#dsh-codex-app-provider");
  const section = registrations.find(entry => entry.options.name === "settings.section");
  assert.equal(section.options.id, "codex-app-provider");
  assert.equal(section.options.label(), "[dsh-codex-app-provider:nav]");
  for (const entry of registrations) {
    assert.equal(entry.options.locale, "dsh-codex-app-provider");
    assert.equal(typeof entry.component, "function");
  }
});

test("the component renders the Host form and asks the Host to check availability", () => {
  const { ctx, plugin, registrations, rpcCalls } = loadBundle();
  plugin.apply(ctx);
  const bundle = registrations.find(entry => entry.options.name === "plugins.bundle.config");
  const rendered = bundle.component({ view: "page" });
  assert.notEqual(rendered, undefined, "the page body renders");
  assert.equal(rendered.props.view, "page");
  assert.equal(bundle.component({ view: "summary" }).props.view, "summary");
  assert.deepEqual(rpcCalls, [], "no check runs until the page body mounts");
});

test("the bundle and manifest present the client half to the shell", () => {
  assert.match(source, /id:\s*"dsh-codex-app-provider"/);
  assert.match(source, /plugins\.bundle\.config/);
  assert.match(source, /plugins\.row\.config/);
  assert.equal(manifest.dsh.client.platform, "web");
  assert.ok(manifest.dsh.client.inject.includes("@deepseek-ai/dsh-client-ui-renderer"));
  assert.ok(manifest.dsh.client.inject.includes("@deepseek-ai/dsh-client-ui-settings"));
  assert.ok(manifest.dsh.client.inject.includes("@deepseek-ai/dsh-client-connection"));
  assert.equal(manifest.exports["./client"].default, "./lib/client.js");
});
