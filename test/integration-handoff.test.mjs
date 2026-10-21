import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";
import LlmRuntime from "@deepseek-ai/dsh-llm";
import * as plugin from "../lib/index.js";

/**
 * Deterministic L1 integration: the real plugin context, the real hand-off
 * service, and a scripted App Server instead of a model. It asserts the
 * slice's contract without network, model or approval — specifically that the
 * hand-off entry forwards the declared lane boundary verbatim, that the
 * successor's first native call is `thread/resume` and never `thread/start`,
 * and that execution facts are projected from the provider store.
 */
const FAKE = fileURLToPath(new URL("./fake-codex-app-server.mjs", import.meta.url));
const vehicle = (id, text) => ({ id, role: "user", content: [{ type: "text", text }], source: { kind: "user" } });
const options = (sessionId, messages, extra = {}) => ({ provider: "codex", model: "luna", reasoningEffort: "medium", sessionId, messages, ...extra });

async function collect(iterable) {
  const chunks = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

function setup() {
  const stateDir = mkdtempSync(join(tmpdir(), "dsh-handoff-integration-"));
  const cwd = mkdtempSync(join(tmpdir(), "dsh-handoff-cwd-"));
  const lane = mkdtempSync(join(tmpdir(), "dsh-handoff-lane-"));
  const log = join(stateDir, "requests.jsonl");
  const previous = { log: process.env.DSH_FAKE_CODEX_LOG, state: process.env.DSH_FAKE_CODEX_STATE };
  process.env.DSH_FAKE_CODEX_LOG = log;
  process.env.DSH_FAKE_CODEX_STATE = join(stateDir, "fake-threads");
  return { stateDir, cwd, lane, log, restore: () => {
    if (previous.log === undefined) delete process.env.DSH_FAKE_CODEX_LOG; else process.env.DSH_FAKE_CODEX_LOG = previous.log;
    if (previous.state === undefined) delete process.env.DSH_FAKE_CODEX_STATE; else process.env.DSH_FAKE_CODEX_STATE = previous.state;
  } };
}

const requests = file => readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));

test("the handoff entry forwards the declared lane boundary and the successor resumes the handed thread", async t => {
  const fixture = setup();
  const opening = { id: "opening", header: { cwd: fixture.cwd }, currentCwd: fixture.lane };
  const successor = { id: "continue", header: { cwd: fixture.cwd }, currentCwd: fixture.lane };
  const sessions = new Map([[opening.id, opening], [successor.id, successor]]);
  const agents = new Map([
    [opening.id, { session: opening, options: { model: "luna", reasoningEffort: "medium",
      execution: { developerInstructions: "opening role", boundary: { cwd: fixture.lane, writableRoots: [fixture.lane], network: "disabled" } } } }],
    [successor.id, { session: successor, options: { model: "sol", reasoningEffort: "high",
      execution: { developerInstructions: "successor role", boundary: { cwd: fixture.lane, writableRoots: [fixture.lane], network: "disabled" } } } }],
  ]);
  const ctx = new Context();
  ctx.provide("workingDirectory", { get: session => session.currentCwd ?? session.header.cwd });
  new LlmRuntime(ctx);
  ctx.provide("agents", { get: id => agents.get(id) });
  ctx.provide("sessions", { get: id => sessions.get(id) });
  t.after(async () => {
    await ctx.fiber.dispose();
    fixture.restore();
    for (const path of [fixture.stateDir, fixture.cwd, fixture.lane]) rmSync(path, { recursive: true, force: true });
  });
  await ctx.plugin(plugin, { stateDir: fixture.stateDir, command: FAKE, providerCwd: fixture.cwd });

  const opened = await collect(ctx.llm.stream(options(opening.id, [vehicle("u1", "open the thread")])));
  assert.equal(opened.at(-1).reason.kind, "stop", "the opening child completed one turn");
  const source = await ctx.codexExecution.read(opening.id);
  assert.equal(typeof source.threadId, "string");

  // The lane is the task's real working location: the hand-off entry forwards
  // the declared boundary verbatim, so both the source and the successor thread
  // run in the lane and the host workspace never enters the sandbox scope.
  const bound = await ctx.codexHandoff.handoff({
    requestId: "handoff-integration-1", fromSessionId: opening.id, toSessionId: successor.id,
    model: "sol", reasoningEffort: "high", developerInstructions: "successor role",
    boundary: { cwd: fixture.lane, writableRoots: [fixture.lane], network: "disabled" },
  });
  assert.equal(bound.threadId, source.threadId, "the successor binds the handed-over thread");
  assert.equal((await ctx.codexHandoff.read(opening.id)).handedOffTo, successor.id, "the source is de-authorized");
  assert.equal((await ctx.codexHandoff.read(successor.id)).handoffFrom, opening.id);

  const continued = await collect(ctx.llm.stream(options(successor.id, [vehicle("u2", "continue")], { model: "sol", reasoningEffort: "high" })));
  assert.equal(continued.at(-1).reason.kind, "stop", "the successor completed its first turn");

  const log = requests(fixture.log);
  assert.equal(log.filter(entry => entry.method === "thread/start").length, 1, "only the opening child created a thread");
  const resumed = log.filter(entry => entry.method === "thread/resume");
  assert.equal(resumed.length, 1, "the successor's first request resumes the handed thread");
  const [resume] = resumed;
  assert.equal(resume.params.threadId, source.threadId, "the resumed thread identity never changes");
  assert.equal(resume.params.model, "sol", "the target model reaches the native thread");
  assert.equal(resume.params.config.model_reasoning_effort, "high", "the target effort reaches the native thread");
  assert.equal(resume.params.developerInstructions, "successor role", "the target instructions reach the native thread");
  assert.equal("approvalPolicy" in resume.params, false, "Codex owns its approval policy, not the plugin");
  assert.equal(resume.params.cwd, fixture.lane, "the resumed thread stays in the task's declared lane");
  // Permissions stay Codex's own subject: the plugin authors no permission
  // profile, so a declared task boundary reaches the thread only as the
  // directory it runs in.
  assert.equal("permissions" in resume.params.config, false, "no plugin-authored permission profile is sent");
  assert.equal("default_permissions" in resume.params.config, false);

  // Execution facts live in the provider store, not the DSH session log.
  const facts = (await ctx.codexExecution.facts(opening.id)).join("\n");
  assert.match(facts, /\[source: codex thread=\S+ turn=\S+ item=\S+\] command: run-fake-command \(exit 0/);
  assert.match(facts, /fake-command-output/);
});
