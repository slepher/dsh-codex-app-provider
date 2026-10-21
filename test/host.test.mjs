import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import LlmRuntime from "@deepseek-ai/dsh-llm";
import * as plugin from "../lib/index.js";
import { CODEX_OWNER_ID } from "../lib/provider.js";

test("headless Host registers one route, releases ownership on unload, and reloads", async t => {
  const stateDir = mkdtempSync(join(tmpdir(), "dsh-app-host-"));
  const ctx = new Context();
  ctx.provide("workingDirectory", { get: session => session.currentCwd ?? session.header.cwd });
  new LlmRuntime(ctx);
  ctx.provide("agents", { get() {} });
  ctx.provide("sessions", { get() {} });
  t.after(async () => { await ctx.fiber.dispose(); rmSync(stateDir, { recursive: true, force: true }); });
  const first = await ctx.plugin(plugin, { stateDir });
  assert.equal(ctx.llm.listProviders().some(p => p.id === "codex-app"), true);
  assert.equal(await ctx.codexExecution.read("nonexistent-native-session"), undefined);
  assert.equal(await ctx.codexHandoff.read("nonexistent-native-session"), undefined, "thread ownership reads are published for the trusted Host");
  assert.equal(existsSync(join(stateDir, "owner.lock")), true);
  await first.dispose();
  assert.equal(ctx.llm.listProviders().some(p => p.id === "codex-app"), false);
  assert.equal(ctx.get("codexExecution"), undefined);
  assert.equal(ctx.get("codexHandoff"), undefined);
  assert.equal(existsSync(join(stateDir, "owner.lock")), false);
  const second = await ctx.plugin(plugin, { stateDir });
  assert.equal(ctx.llm.listProviders().filter(p => p.id === "codex-app").length, 1);
  await second.dispose();
  assert.equal(existsSync(join(stateDir, "owner.lock")), false);
});

test("a disposed Session releases the Codex record that backed it", async t => {
  const stateDir = mkdtempSync(join(tmpdir(), "dsh-app-disposed-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  // The record a previous process left behind for a Session the Host disposes.
  const records = join(stateDir, "sessions");
  mkdirSync(records, { recursive: true });
  const path = join(records, `${encodeURIComponent("codex:child")}.json`);
  writeFileSync(path, JSON.stringify({ ownerId: CODEX_OWNER_ID, sessionId: "codex:child", cwd: "/work",
    executionCwd: "/work", state: "unknown", approvals: [], options: {}, facts: [], reports: [] }));

  const ctx = new Context();
  ctx.provide("workingDirectory", { get: session => session.currentCwd ?? session.header.cwd });
  new LlmRuntime(ctx);
  ctx.provide("agents", { get() {} });
  ctx.provide("sessions", { get() {} });
  t.after(async () => { await ctx.fiber.dispose(); });
  const instance = await ctx.plugin(plugin, { stateDir });
  assert.equal(JSON.parse(readFileSync(path, "utf8")).released, undefined, "the record starts owned");

  // The Host owns the Session lifecycle and reports disposal as a fact; the
  // record that backed the Session is this plugin's to release. Without this
  // join an `unknown` record is stranded with nothing able to reach it.
  ctx.emit("session/disposed", { id: "child" });
  assert.equal(JSON.parse(readFileSync(path, "utf8")).released, true);

  // A disposed Session that this plugin never recorded is not an error.
  ctx.emit("session/disposed", { id: "never-seen" });
  await instance.dispose();
  assert.equal(existsSync(join(stateDir, "owner.lock")), false);
});

test("an omitted stateDir lands in the launched profile's state tree", async t => {
  const home = mkdtempSync(join(tmpdir(), "dsh-app-profile-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const ctx = new Context();
  ctx.provide("workingDirectory", { get: session => session.currentCwd ?? session.header.cwd });
  new LlmRuntime(ctx);
  ctx.provide("agents", { get() {} });
  ctx.provide("sessions", { get() {} });
  // The launcher provides this in a profile-launched process; the plugin reads
  // it instead of resolving a path against the directory `dsh` started in.
  ctx.provide("profileContext", { name: "probe-profile", home });
  t.after(async () => { await ctx.fiber.dispose(); });
  const instance = await ctx.plugin(plugin, {});
  assert.equal(existsSync(join(home, "state", "probe-profile", "codex", "owner.lock")), true,
    "the default state directory is the profile's own");
  await instance.dispose();
  assert.equal(existsSync(join(home, "state", "probe-profile", "codex", "owner.lock")), false);
});
