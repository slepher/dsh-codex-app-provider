import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = readFileSync(new URL("lib/client.js", root), "utf8");
const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));

/** Load the shipped client bundle the way the shell's module table does. */
function loadBundle() {
  let loaded;
  const window = { __ModuleLoader__: { load: value => { loaded = value; } } };
  runInNewContext(source, { window, require: name => { throw new Error(`unexpected require ${name}`); } });
  const registrations = [];
  const ctx = {
    inject: ["slots"],
    slots: {
      inject(name, factory) { assert.equal(name, "plugins.row.config"); return factory(); },
      register(options, component) { registrations.push({ options, component }); return () => {}; },
    },
  };
  const plugin = loaded.factory(name => {
    if (name === "react") return { useState: () => [] };
    if (name === "react/jsx-runtime") return { jsx: () => null, jsxs: () => null, Fragment: null };
    throw new Error(`unexpected module ${name}`);
  });
  return { plugin, ctx, registrations };
}

test("the browser half registers the provider row configuration", () => {
  const { plugin, ctx, registrations } = loadBundle();
  assert.equal(plugin.inject.includes("slots"), true);
  plugin.apply(ctx);
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].options.name, "plugins.row.config");
  assert.equal(registrations[0].options.key, "dsh-codex-app-provider#dsh-codex-app-provider");
  assert.equal(typeof registrations[0].component, "function");
});

test("the bundle and manifest present the client half to the shell", () => {
  assert.match(source, /id:\s*"dsh-codex-app-provider"/);
  assert.match(source, /plugins\.row\.config/);
  assert.equal(manifest.dsh.client.platform, "web");
  assert.ok(manifest.dsh.client.inject.includes("@deepseek-ai/dsh-client-ui-renderer"));
  assert.equal(manifest.exports["./client"].default, "./lib/client.js");
});
