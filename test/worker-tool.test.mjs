import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";
import LlmRuntime from "@deepseek-ai/dsh-llm";
import * as plugin from "../lib/index.js";
import { SessionStore } from "../lib/store.js";
import { executeWorkerAction } from "../lib/worker-actions.js";
import { installWorkerDelivery } from "../lib/worker-delivery.js";

const FAKE = fileURLToPath(new URL("./fake-codex-app-server.mjs", import.meta.url));

function setup() {
  const stateDir = mkdtempSync(join(tmpdir(), "dsh-worker-tool-"));
  const cwd = mkdtempSync(join(tmpdir(), "dsh-worker-tool-cwd-"));
  const previous = { log: process.env.DSH_FAKE_CODEX_LOG, state: process.env.DSH_FAKE_CODEX_STATE };
  process.env.DSH_FAKE_CODEX_STATE = join(stateDir, "fake-threads");
  delete process.env.DSH_FAKE_CODEX_LOG;
  return { stateDir, cwd, restore: () => {
    if (previous.log === undefined) delete process.env.DSH_FAKE_CODEX_LOG; else process.env.DSH_FAKE_CODEX_LOG = previous.log;
    if (previous.state === undefined) delete process.env.DSH_FAKE_CODEX_STATE; else process.env.DSH_FAKE_CODEX_STATE = previous.state;
  } };
}

/** One parent Agent plus a second, unregistered Agent used for the fencing test. */
function host(ctx, cwd) {
  const parentSession = { id: "parent", header: { cwd } };
  const followed = [];
  const parent = { id: "parent-agent", session: parentSession, status: "idle", followup(message) { followed.push(message); } };
  const strangers = { id: "stranger-agent", session: { id: "stranger", header: { cwd } }, status: "idle", followup() {} };
  const agents = new Map([[parent.id, parent]]);
  const sessions = new Map([[parentSession.id, parentSession]]);
  ctx.provide("agents", { get: id => agents.get(id), list: () => [...agents.values()] });
  ctx.provide("sessions", { get: id => sessions.get(id) });
  return { parent, strangers, agents, followed };
}

const exec = agent => ({ agent, callId: "call-1", name: "codex_workers", arguments: {}, signal: new AbortController().signal });

async function waitFor(condition, label) {
  for (let attempt = 0; attempt < 5_000; attempt++) {
    const value = await condition();
    if (value !== undefined && value !== false) return value;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

test("the provider registers codex_workers and its prompt section", async t => {
  const fixture = setup();
  const ctx = new Context();
  new LlmRuntime(ctx);
  const { parent } = host(ctx, fixture.cwd);
  const registered = [], sections = [];
  ctx.provide("tools", { register(definition) { registered.push(definition); return () => {}; } });
  ctx.provide("systemPrompt", { section(section) { sections.push(section); return () => {}; }, getSectionOrder: () => 10 });
  t.after(async () => { await ctx.fiber.dispose(); fixture.restore(); rmSync(fixture.stateDir, { recursive: true, force: true }); rmSync(fixture.cwd, { recursive: true, force: true }); });
  await ctx.plugin(plugin, { stateDir: fixture.stateDir, command: FAKE, providerCwd: fixture.cwd });

  const tool = registered.find(definition => definition.name === "codex_workers");
  assert.ok(tool, "the ordinary delegation tool is registered");
  assert.deepEqual(tool.parameters.required, ["action"]);
  assert.deepEqual(tool.parameters.properties.action.enum,
    ["create", "roles", "list", "get", "reports", "append", "steer", "interrupt", "resume", "accept", "ack", "close"]);
  assert.equal(tool.presentCall({ action: "list" }).kind, "read", "a query is presented as a read");
  assert.equal(tool.presentCall({ action: "append" }).kind, "execute");
  assert.equal(sections.filter(section => section.name === "tool:codex-workers").length, 1, "the prompt section is contributed once");

  // Create through the registered definition, so argument validation runs too.
  const created = JSON.parse(await tool.execute({ action: "create", name: "ordinary worker", cwd: fixture.cwd }, exec(parent)));
  assert.equal(created.name, "ordinary worker");
  assert.equal(created.parentSessionId, "parent", "the worker is owned by the calling parent Session");
  assert.equal(created.owner, "agent");
  assert.equal(created.cwd, fixture.cwd);

  const listed = JSON.parse(await tool.execute({ action: "list" }, exec(parent)));
  assert.deepEqual(listed.map(worker => worker.id), [created.id]);
  const read = JSON.parse(await tool.execute({ action: "get", workerId: created.id }, exec(parent)));
  assert.equal(read.id, created.id);
  assert.equal(read.state, "idle");

  await assert.rejects(tool.execute({ action: "create" }, exec(parent)), /name/, "a create without a name is refused before any side effect");
  await assert.rejects(tool.execute({ action: "get" }, exec(parent)), /workerId/);
  await assert.rejects(tool.execute({ action: "append", workerId: created.id }, exec(parent)), /text/);
});

test("a caller that is not the live parent Agent cannot touch its workers", async t => {
  const fixture = setup();
  const ctx = new Context();
  new LlmRuntime(ctx);
  const { parent, strangers, agents } = host(ctx, fixture.cwd);
  const registered = [];
  ctx.provide("tools", { register(definition) { registered.push(definition); return () => {}; } });
  ctx.provide("systemPrompt", { section() { return () => {}; }, getSectionOrder: () => 10 });
  t.after(async () => { await ctx.fiber.dispose(); fixture.restore(); rmSync(fixture.stateDir, { recursive: true, force: true }); rmSync(fixture.cwd, { recursive: true, force: true }); });
  await ctx.plugin(plugin, { stateDir: fixture.stateDir, command: FAKE, providerCwd: fixture.cwd });
  const tool = registered.find(definition => definition.name === "codex_workers");

  const created = JSON.parse(await tool.execute({ action: "create", name: "owned", cwd: fixture.cwd }, exec(parent)));
  await assert.rejects(tool.execute({ action: "get", workerId: created.id }, exec(undefined)), /live parent agent/,
    "a call without an Agent cannot act at all");
  await assert.rejects(tool.execute({ action: "get", workerId: created.id }, exec(strangers)), /identity changed/,
    "an Agent the registry does not know cannot act");
  // A forged Agent becomes "registered" but points at a Session it does not own.
  const forged = { ...strangers, session: { id: "parent", header: { cwd: fixture.cwd } } };
  agents.set(forged.id, forged);
  await assert.rejects(tool.execute({ action: "get", workerId: created.id }, exec(forged)), /identity changed/,
    "a forged Agent whose Session belongs to someone else is refused");
});

test("append runs a worker turn and its report arrives as pending, then accept and close", async t => {
  const fixture = setup();
  const ctx = new Context();
  new LlmRuntime(ctx);
  const { parent, followed } = host(ctx, fixture.cwd);
  const registered = [];
  ctx.provide("tools", { register(definition) { registered.push(definition); return () => {}; } });
  ctx.provide("systemPrompt", { section() { return () => {}; }, getSectionOrder: () => 10 });
  t.after(async () => { await ctx.fiber.dispose(); fixture.restore(); rmSync(fixture.stateDir, { recursive: true, force: true }); rmSync(fixture.cwd, { recursive: true, force: true }); });
  await ctx.plugin(plugin, { stateDir: fixture.stateDir, command: FAKE, providerCwd: fixture.cwd });
  const tool = registered.find(definition => definition.name === "codex_workers");

  const created = JSON.parse(await tool.execute({ action: "create", name: "runner", cwd: fixture.cwd }, exec(parent)));
  await tool.execute({ action: "append", workerId: created.id, text: "do the task" }, exec(parent));
  const report = await waitFor(async () => {
    const reports = JSON.parse(await tool.execute({ action: "reports" }, exec(parent)));
    return reports[0];
  }, "the worker report");
  assert.equal(report.workerId, created.id);
  assert.equal(report.status, "completed");
  assert.equal(report.result, "fake-final-answer");
  assert.equal(report.acceptance, "pending");

  // The idle parent is woken with the same notice the step path would deliver.
  const notice = await waitFor(() => followed.find(message => JSON.stringify(message).includes(created.id)), "the parent notice");
  assert.equal(notice.source.plugin, "dsh-codex-app-provider", "the notice is plugin-sourced, never a human prompt");
  assert.equal(notice.source.form, "notice");
  assert.match(notice.content[0].text, /accept, request changes, or acknowledge/);

  const accepted = JSON.parse(await tool.execute({ action: "accept", workerId: created.id, turnId: report.turnId, acceptance: "accepted" }, exec(parent)));
  assert.equal(accepted.acceptance, "accepted");
  assert.ok(accepted.acknowledgedAt > 0);
  const closed = JSON.parse(await tool.execute({ action: "close", workerId: created.id }, exec(parent)));
  assert.deepEqual(closed, { id: created.id, closed: true });
  const listed = JSON.parse(await tool.execute({ action: "list" }, exec(parent)));
  assert.deepEqual(listed, [], "a closed worker leaves the parent's group");
});

test("worker actions enforce the backend's state preconditions", async () => {
  const calls = [];
  const backend = {
    workflowRoles: () => [{ name: "reviewer" }],
    listWorkers: () => [{ id: "w1", state: "running" }],
    pendingReports: () => [],
    getWorker: async (_caller, id) => ({ id, state: "running", turnId: "turn-1" }),
    append: async () => {},
    startTurn: async () => { throw new Error("must not start"); },
    steerTurn: async (_caller, id, turnId) => { calls.push({ id, turnId }); },
    interruptTurn: async () => {},
    resumeSession: async () => {},
    acknowledgeReport: async (_caller, id, turnId) => ({ workerId: id, turnId }),
    acceptReport: async (_caller, id, turnId, acceptance) => ({ workerId: id, turnId, acceptance }),
    closeSession: async () => {},
  };
  const caller = { nativeSessionId: "parent", source: "agent", parentAgent: { id: "parent-agent", nativeSessionId: "parent" } };
  assert.deepEqual(await executeWorkerAction(backend, caller, "/parent", { action: "roles" }), [{ name: "reviewer" }]);
  // `append` requires confirmed idleness; a running worker is refused before any dispatch.
  await assert.rejects(executeWorkerAction(backend, caller, "/parent", { action: "append", workerId: "w1", text: "more" }), /Worker is running/);
  // `steer` is the action for an active turn and needs that turn's identity.
  await executeWorkerAction(backend, caller, "/parent", { action: "steer", workerId: "w1", turnId: "turn-1", text: "hurry" });
  assert.deepEqual(calls, [{ id: "w1", turnId: "turn-1" }]);
  await assert.rejects(executeWorkerAction(backend, caller, "/parent", { action: "steer", workerId: "w1", text: "hurry" }), /turnId/);
  await assert.rejects(executeWorkerAction(backend, caller, "/parent", { action: "accept", workerId: "w1", turnId: "turn-1", acceptance: "maybe" }), /Invalid report acceptance/);
  // A create without an explicit cwd uses the parent Session workspace.
  let requested;
  await executeWorkerAction({ ...backend, createWorker: async (_caller, input) => { requested = input; return input; } }, caller, "/parent", { action: "create", name: "w2" });
  assert.equal(requested.cwd, "/parent");
});

test("report notices are claimed once per parent and never fabricated as a decision", async () => {
  const listeners = new Map();
  const emitted = [];
  const ctx = {
    agents: { list: () => [] },
    logger: { warn() {} },
    on(name, handler) { listeners.set(name, handler); return () => listeners.delete(name); },
    effect() { return () => {}; },
  };
  const reports = [{ workerId: "w1", threadId: "t1", turnId: "turn1", status: "completed", result: "done", acceptance: "pending" }];
  const backend = {
    pendingReports: async () => reports,
    listWorkers: async () => [],
    subscribeWorkers: () => () => {},
  };
  const delivery = installWorkerDelivery(ctx, backend);
  const agent = { id: "parent-agent", session: { id: "parent" }, status: "busy", followup(message) { emitted.push(message); } };
  const identity = { agent, session: agent.session };
  ctx.agents.get = id => (id === agent.id ? agent : undefined);
  ctx.sessions = { get: id => (id === agent.session.id ? agent.session : undefined) };

  await delivery.refresh(identity);
  // A busy parent is not woken; the notice waits for its next step.
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(emitted, []);

  const handler = listeners.get("agent/pre-step");
  const decision = await handler({ agent, signal: new AbortController().signal }, async () => ({ kind: "enter", messages: [] }));
  assert.equal(decision.messages.length, 1, "the pending report is offered at the step boundary");
  const notice = decision.messages[0];
  assert.equal(notice.source.kind, "plugin");
  assert.equal(notice.source.form, "notice");
  assert.match(notice.content[0].text, /accept, request changes, or acknowledge/);
  assert.match(notice.content[0].text, /Do not repeat work/);
  assert.match(notice.content[0].text, /w1/);
  // A second step in the same process must not re-offer the same report.
  const again = await handler({ agent, signal: new AbortController().signal }, async () => ({ kind: "enter", messages: [] }));
  assert.deepEqual(again.messages, []);
  delivery.close();
});

test("the restored entry serves legacy worker data without migrating or re-identifying it", async t => {
  const fixture = setup();
  // Data written by the previous entry: one Session with no worker block at all,
  // and one bound worker with a durable report. repair.md §4.5: legacy data is
  // neither migrated nor re-identified, and the old entry may only be retired
  // once real consumers can still reach that history.
  const store = new SessionStore(fixture.stateDir);
  store.put({ ownerId: "parent", sessionId: "legacy-session", threadId: "legacy-thread", cwd: fixture.cwd,
    state: "idle", approvals: [], events: [], nextEventSequence: 1, reports: [] });
  store.put({ ownerId: "parent", sessionId: "legacy-worker", threadId: "worker-thread", cwd: fixture.cwd,
    state: "idle", approvals: [], events: [], nextEventSequence: 1,
    reports: [{ workerId: "legacy-worker", threadId: "worker-thread", turnId: "turn-legacy", status: "completed",
      result: "legacy deliverable", usage: null, createdAt: Date.now(), acceptance: "pending" }],
    worker: { parentSessionId: "parent", owner: "agent", name: "legacy worker", detached: false } });
  store.close();

  const ctx = new Context();
  new LlmRuntime(ctx);
  const { parent } = host(ctx, fixture.cwd);
  const registered = [];
  ctx.provide("tools", { register(definition) { registered.push(definition); return () => {}; } });
  ctx.provide("systemPrompt", { section() { return () => {}; }, getSectionOrder: () => 10 });
  t.after(async () => { await ctx.fiber.dispose(); fixture.restore(); rmSync(fixture.stateDir, { recursive: true, force: true }); rmSync(fixture.cwd, { recursive: true, force: true }); });
  await ctx.plugin(plugin, { stateDir: fixture.stateDir, command: FAKE, providerCwd: fixture.cwd });
  const tool = registered.find(definition => definition.name === "codex_workers");

  const listed = JSON.parse(await tool.execute({ action: "list" }, exec(parent)));
  assert.deepEqual(listed.map(worker => worker.id), ["legacy-worker"],
    "a Session with no worker block stays unbound: it is not adopted into the group by being read");
  const worker = JSON.parse(await tool.execute({ action: "get", workerId: "legacy-worker" }, exec(parent)));
  assert.equal(worker.name, "legacy worker");
  assert.equal(worker.threadId, "worker-thread", "the historical thread identity is preserved, not rewritten");

  const reports = JSON.parse(await tool.execute({ action: "reports" }, exec(parent)));
  assert.deepEqual(reports.map(report => report.turnId), ["turn-legacy"], "the old entry's durable report is still reachable");
  const accepted = JSON.parse(await tool.execute({ action: "accept", workerId: "legacy-worker", turnId: "turn-legacy", acceptance: "accepted" }, exec(parent)));
  assert.equal(accepted.acceptance, "accepted");
  await tool.execute({ action: "close", workerId: "legacy-worker" }, exec(parent));
  assert.deepEqual(JSON.parse(await tool.execute({ action: "list" }, exec(parent))), []);

  // The unbound Session is still readable history, and adoption is the explicit,
  // reviewed path that gives it an identity — never an implicit migration.
  const execution = await ctx.codexExecution.read("legacy-session");
  assert.equal(execution, undefined, "an unbound legacy Session outside the provider owner is not claimed");
});
