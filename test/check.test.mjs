import assert from "node:assert/strict";
import test from "node:test";

import { createAvailabilityProbe } from "../lib/check.js";

/** One probe whose side effects are recorded instead of spawned. */
function probe({ configured = () => "", version = async () => "codex-cli 9.9.9", models = async () => ["m1", "m2"], now = () => 1000 } = {}) {
  const calls = { version: 0, models: 0 };
  const check = createAvailabilityProbe({
    configured,
    runVersion: async command => { calls.version += 1; return version(command); },
    listModels: async () => { calls.models += 1; return models(); },
    now,
  });
  return { check, calls };
}

test("the first check resolves, runs version and reads models", async () => {
  const { check, calls } = probe({ configured: () => "C:\\tools\\codex.exe" });
  const result = await check(false);
  assert.deepEqual(result.command, { program: "C:\\tools\\codex.exe", prefixArgs: [], source: "configured" });
  assert.equal(result.version, "codex-cli 9.9.9");
  assert.deepEqual(result.models, ["m1", "m2"]);
  assert.equal(result.checkedAt, 1000);
  assert.equal(calls.version, 1);
  assert.equal(calls.models, 1);
});

test("later reads reuse the cached answer and the button forces a refresh", async () => {
  const { check, calls } = probe();
  const first = await check(false);
  const second = await check(false);
  assert.equal(second, first, "the cached object is returned unchanged");
  assert.equal(calls.version, 1);
  await check(true);
  assert.equal(calls.version, 2);
  assert.equal(calls.models, 2);
});

test("a CLI that cannot run reports the failure instead of a version", async () => {
  const { check, calls } = probe({ version: async () => { throw new Error("spawn ENOENT"); } });
  const result = await check(true);
  assert.match(result.error, /could not run: spawn ENOENT/);
  assert.equal(result.version, undefined);
  assert.equal(calls.models, 0);
});

test("a failing model catalog keeps the working version result", async () => {
  const { check } = probe({ models: async () => { throw new Error("model/list failed"); } });
  const result = await check(true);
  assert.equal(result.version, "codex-cli 9.9.9");
  assert.match(result.error, /model catalog could not be read: model\/list failed/);
});
