import assert from "node:assert/strict";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import SettingsProvider from "@deepseek-ai/dsh-settings";
import { SettingsSchema, SETTINGS_NAMESPACE } from "../lib/settings.js";
import { canSave, openPosition, savePosition } from "../lib/client/settings.js";

class MemorySettings extends SettingsProvider {
  writable = true;
  failure;
  async load() { return {}; }
  async persist() { if (this.failure) throw this.failure; }
}

test("native settings schema defaults, validates, and preserves committed value on conflict or failed save", async t => {
  const ctx = new Context();
  const settings = new MemorySettings(ctx);
  t.after(() => ctx.fiber.dispose());
  const scope = settings.register(SETTINGS_NAMESPACE, SettingsSchema, { applies: "live" });
  assert.deepEqual(scope.get(), { subagentOpenPosition: "sidebar" });
  await scope.update({ subagentOpenPosition: "main" });
  assert.equal(scope.get().subagentOpenPosition, "main");
  await assert.rejects(scope.update({ subagentOpenPosition: "invalid" }));
  await assert.rejects(settings.update(SETTINGS_NAMESPACE, { subagentOpenPosition: "sidebar" }, -1));
  settings.failure = new Error("disk full");
  await assert.rejects(scope.update({ subagentOpenPosition: "sidebar" }), /disk full/);
  assert.equal(scope.get().subagentOpenPosition, "main");
});

test("client saves only ready writable Host settings, and keeps its own pane before readiness", async () => {
  const ready = { status: "ready", mode: "host", writable: true, value: { subagentOpenPosition: "sidebar" } };
  let snapshot = ready;
  const calls = [];
  const scope = { getSnapshot: () => snapshot, set: async (...args) => { calls.push(args); } };
  assert.equal(openPosition(ready), "sidebar");
  await savePosition(scope, "main");
  assert.deepEqual(calls, [["subagentOpenPosition", "main"]]);
  for (const patch of [{ status: "loading" }, { status: "unavailable" }, { mode: "memory" }, { writable: false }]) {
    snapshot = { ...ready, ...patch };
    assert.equal(canSave(snapshot), false);
    await assert.rejects(savePosition(scope, "main"));
    // An unreadable preference must not send the plugin's entry into the main
    // area: the official catalog already owns that navigation.
    assert.equal(openPosition({ ...snapshot, value: {} }), "sidebar");
  }
  // A preference the client can read still wins, including one stored in a
  // process-local document.
  assert.equal(openPosition({ status: "ready", mode: "memory", value: { subagentOpenPosition: "main" } }), "main");
  snapshot = ready;
  scope.set = async () => { throw new Error("revision conflict"); };
  await assert.rejects(savePosition(scope, "main"), /revision conflict/);
  assert.equal(openPosition(snapshot), "sidebar");
});
