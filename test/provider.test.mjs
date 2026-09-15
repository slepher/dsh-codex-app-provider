import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";
import LlmRuntime from "@deepseek-ai/dsh-llm";

import { CodexSessionBackend } from "../lib/backend.js";
import { CodexProviderAdapter } from "../lib/provider.js";

const OWNER = "dsh-codex-provider";

class FakeServer extends EventEmitter {
  constructor(hub) { super(); this.hub = hub; hub.servers.push(this); }
  async connect() {}
  async request(method, params) {
    this.calls ??= [];
    this.calls.push({ method, params });
    if (method === "thread/start") {
      await new Promise(resolve => setImmediate(resolve));
      this.threadId = `thread-${++this.hub.thread}`;
      return { thread: { id: this.threadId, status: { type: "idle" }, turns: [] }, model: params.model, reasoningEffort: params.config?.model_reasoning_effort, ...this.hub.threadResult };
    }
    if (method === "thread/resume") {
      await new Promise(resolve => setImmediate(resolve));
      this.threadId = params.threadId;
      // A managed record resumes with the same applied configuration contract as
      // thread/start, so a cold recovery is verified rather than assumed.
      return { thread: { id: params.threadId, status: { type: "idle" }, turns: [], cwd: params.cwd }, model: params.model,
        reasoningEffort: params.config?.model_reasoning_effort, approvalPolicy: "never",
        sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true },
        ...this.hub.threadResult };
    }
    if (method === "turn/start") {
      const id = `turn-${++this.hub.turn}`;
      this.turnId = id;
      this.emit("notification", { method: "turn/started", params: { threadId: this.threadId, turn: { id } } });
      return { turn: { id, status: "inProgress" } };
    }
    if (method === "turn/interrupt") { this.interrupted = params; return {}; }
    if (method === "model/list") return { data: this.hub.models, nextCursor: null };
    if (method === "config/read") return { config: this.hub.config ?? { model: "luna", model_reasoning_effort: "high" } };
    return {};
  }
  respond(id, result) { (this.responded ??= []).push({ id, result }); }
  reject(id, message) { (this.rejected ??= []).push({ id, message }); }
  async close() { this.closed = (this.closed ?? 0) + 1; }
  notify(method, params) { this.emit("notification", { method, params }); }
  ask(id, method, params) { this.emit("request", { id, method, params }); }
}

const user = (id, text) => ({ id, role: "user", content: [{ type: "text", text }], source: { kind: "user" } });
const image = (id, text) => ({ id, role: "user", content: [{ type: "text", text }, { type: "image", attachment: { attachmentId: "a1", mediaType: "image/png", name: "x.png", bytes: 3, width: 1, height: 1 } }], source: { kind: "user" } });
const system = text => ({ id: "sys", role: "system", content: [{ type: "text", text }], source: { kind: "plugin", plugin: "test" } });
const assistant = (id, text, provider = "other", replayState) => ({ id, role: "assistant", content: [{ type: "text", text }], source: { kind: "model", provider, model: "x", ...(replayState === undefined ? {} : { replayState }) } });
const toolCall = (id, callId, name, args) => ({ id, role: "assistant", content: [{ type: "tool-call", id: callId, name, arguments: args }], source: { kind: "model", provider: "other", model: "x" } });
const toolResult = (id, callId, text) => ({ id, role: "user", content: [{ type: "tool-result", toolCallId: callId, content: [{ type: "text", text }] }], source: { kind: "tool", callId } });
/** A DSH compaction checkpoint: real history that replaced the range it shadows. */
const checkpoint = (id, text, compactionId) => ({ id, role: "user", content: [{ type: "text", text }], source: { kind: "plugin", plugin: "compact", compactionId } });
/** A plugin notice DSH appended after the last native turn: never sent to Codex yet. */
const notice = (id, text) => ({ id, role: "user", content: [{ type: "text", text }], source: { kind: "plugin", plugin: "dsh-codex-app-provider", form: "notice", summary: text } });

/**
 * A DSH Session stand-in whose `append` is a real instance method.
 *
 * The private field makes a detached `append` throw exactly as the core's
 * Session does, so the fact import cannot regress to calling an unbound method.
 * `snapshotEvents()` carries the sequence numbers the real log assigns, because
 * the input boundary reads them to decide what the native thread already saw.
 */
class FakeAppendSession {
  #log = [];
  #seq = 0;
  constructor(id, cwd) { this.id = id; this.header = { cwd }; }
  append(type, data, intent) {
    const event = { type, seq: ++this.#seq, time: Date.now(), data, ...(intent ?? {}) };
    this.#log.push(Object.assign(event, { intent }));
    return event;
  }
  snapshotEvents() { return this.#log.map(({ intent, ...event }) => event); }
  get appended() { return this.#log; }
}

function setup(prefix) {
  const stateDir = mkdtempSync(join(tmpdir(), prefix));
  const cwd = mkdtempSync(join(tmpdir(), `${prefix}cwd-`));
  const hub = {
    cwd, thread: 0, turn: 0, servers: [],
    models: [{ model: "luna", displayName: "Luna", defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Fast" }, { reasoningEffort: "high", description: "Deep" }] }],
  };
  const backend = new CodexSessionBackend(stateDir, () => new FakeServer(hub));
  return { stateDir, cwd, hub, backend };
}

function cleanup(fixture) {
  rmSync(fixture.stateDir, { recursive: true, force: true });
  rmSync(fixture.cwd, { recursive: true, force: true });
}

function adapterFor(fixture, { approval, questions, attachments, agents = new Map(), sessions = new Map() } = {}) {
  return new CodexProviderAdapter({
    backend: fixture.backend,
    sessions: { get: id => sessions.get(id) },
    agents: { get: id => agents.get(id) },
    approval,
    questions,
    attachments,
    logger: { warn() {} },
    providerCwd: fixture.cwd,
  });
}

const options = (sessionId, messages, extra = {}) => ({ provider: "codex", model: "luna", reasoningEffort: "high", sessionId, messages, ...extra });

async function waitFor(condition, label = "condition") {
  for (let attempt = 0; attempt < 5_000; attempt++) {
    if (await condition()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function collect(iterable) {
  const chunks = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

function sessionServer(hub) { return hub.servers.find(server => server.calls?.some(call => call.method === "thread/start")); }

async function liveTurn(adapter, fixture, sessionId, opts, emit) {
  const done = collect(adapter.stream(opts));
  const backendId = `codex:${sessionId}`;
  await waitFor(async () => (await fixture.backend.readSession(OWNER, backendId))?.threadId !== undefined, "thread identity");
  const record = await fixture.backend.readSession(OWNER, backendId);
  // A cold recovery already knows the thread identity, so the transport that
  // resumes it may not exist yet when this helper looks for it.
  let server;
  await waitFor(() => {
    server = fixture.hub.servers.find(item => item.threadId === record.threadId);
    return server !== undefined;
  }, "session transport");
  await waitFor(async () => {
    const current = await fixture.backend.readSession(OWNER, backendId);
    return server.turnId !== undefined && current?.turnId === server.turnId;
  }, "turn identity");
  await emit(server);
  return done;
}

test("advertises the Codex catalogue and exact model metadata without starting a thread", async t => {
  const fixture = setup("dsh-provider-catalog-");
  t.after(() => { cleanup(fixture); return fixture.backend.close(); });
  const adapter = adapterFor(fixture);
  fixture.hub.config = { model: "luna", model_reasoning_effort: "high", model_context_window: 256000 };
  assert.deepEqual(adapter.providerInfo("codex"), { id: "codex", name: "Codex" });

  const models = await adapter.listModels("codex");
  assert.deepEqual(models, [{ provider: "codex", id: "luna", name: "Luna", inputModalities: ["text"] }]);
  const info = await adapter.resolveModel("codex", "luna");
  assert.equal(info.id, "luna");
  assert.equal(info.context.contextWindow, 256000, "configured context window reaches model resolution");
  assert.equal(info.reasoning.defaultEffort, "high", "configured effort wins for the configured model");
  assert.deepEqual(info.reasoning.efforts.map(effort => effort.id), ["low", "high"]);
  const fallback = await adapter.resolveModel("codex", "unlisted");
  assert.equal(fallback.name, "unlisted");
  assert.equal("reasoning" in fallback, false);
  assert.equal("context" in fallback, false, "the configured window only applies to the configured model");

  await adapter.listModels("codex");
  assert.equal(fixture.hub.servers.length, 1, "the catalogue is cached across calls");
  assert.equal(fixture.hub.servers.flatMap(server => server.calls ?? []).some(call => call.method === "thread/start" || call.method === "turn/start"), false);
  await assert.rejects(collect(adapter.stream(options("missing", [user("u1", "hi")]))), /workspace/);
  await assert.rejects(collect(adapter.stream({ ...options("s1", [user("u1", "hi")]), provider: "other" })), /Unsupported provider route/);
});

test("streams one native turn into text, usage, and replay state, then resumes the same thread", async t => {
  const fixture = setup("dsh-provider-stream-");
  t.after(() => { cleanup(fixture); return fixture.backend.close(); });
  const sessions = new Map([["s1", { header: { cwd: fixture.cwd } }]]);
  const adapter = adapterFor(fixture, { sessions });

  const chunks = await liveTurn(adapter, fixture, "s1", options("s1", [system("prompt"), user("u1", "first")]), async server => {
    server.notify("item/agentMessage/delta", { threadId: server.threadId, turnId: server.turnId, delta: "Hel" });
    server.notify("item/agentMessage/delta", { threadId: server.threadId, turnId: server.turnId, delta: "lo" });
    server.notify("thread/tokenUsage/updated", { threadId: server.threadId, tokenUsage: { total: {}, last: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 5, reasoning_output_tokens: 2 }, modelContextWindow: 1000 } });
    server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: { type: "agentMessage", phase: "final_answer", text: "Hello" } });
    server.notify("turn/completed", { threadId: server.threadId, turn: { id: server.turnId, status: "completed" } });
  });
  const server = sessionServer(fixture.hub);
  assert.equal(sessionServer(fixture.hub).threadId, "thread-1");
  assert.deepEqual(chunks.filter(chunk => chunk.type === "text-delta").map(chunk => chunk.text), ["Hel", "lo"]);
  assert.deepEqual(chunks.find(chunk => chunk.type === "block-end").block, { type: "text", text: "Hello" });
  const usage = chunks.find(chunk => chunk.type === "usage");
  assert.deepEqual(usage.usage, { inputTokens: 80, outputTokens: 5, cacheReadTokens: 20, reasoningTokens: 2 });
  const finish = chunks.at(-1);
  assert.equal(finish.type, "finish"); assert.equal(finish.reason.kind, "stop");
  assert.equal(finish.replayState.response.threadId, server.threadId);

  const threadStart = server.calls.find(call => call.method === "thread/start");
  assert.equal(threadStart.params.cwd, fixture.cwd);
  assert.equal(threadStart.params.model, "luna");
  assert.equal(threadStart.params.config.model_reasoning_effort, "high");
  const firstTurn = server.calls.find(call => call.method === "turn/start");
  assert.deepEqual(firstTurn.params.input, [{ type: "text", text: "first", text_elements: [] }]);
  assert.equal(firstTurn.params.model, "luna"); assert.equal(firstTurn.params.effort, "high");

  // The read-only projection carries the turn's own token accounting, so a
  // Host can attribute cost without resuming or reading the native log.
  const execution = await adapter.readExecution("s1");
  assert.deepEqual(execution.reports[0].usage,
    { totalTokens: null, inputTokens: 100, cachedInputTokens: 20, cacheWriteInputTokens: null, outputTokens: 5, reasoningOutputTokens: 2 });
  assert.equal("total" in execution.reports[0].usage, false, "the cumulative snapshot is not projected as a turn's usage");

  const learned = await adapter.resolveModel("codex", "luna");
  assert.equal(learned.context.contextWindow, 1000, "runtime usage teaches the context window when config does not set one");

  const marker = { response: { threadId: server.threadId, turnId: server.turnId, input: "u1" } };
  const again = await liveTurn(adapter, fixture, "s1", options("s1", [system("prompt"), user("u1", "first"), assistant("a1", "Hello", "codex", marker), user("u2", "second")]), async server => {
    server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: { type: "agentMessage", phase: "final_answer", text: "Again" } });
    server.notify("turn/completed", { threadId: server.threadId, turn: { id: server.turnId, status: "completed" } });
  });
  assert.equal(again.at(-1).reason.kind, "stop");
  assert.equal(server.calls.filter(call => call.method === "thread/start").length, 1, "the second turn reuses the thread");
  const turns = server.calls.filter(call => call.method === "turn/start");
  assert.equal(turns.length, 2);
  assert.deepEqual(turns[1].params.input, [{ type: "text", text: "second", text_elements: [] }]);
});

test("relearns the context window from persisted provider records after a restart", async t => {
  const fixture = setup("dsh-provider-context-");
  const sessions = new Map([["s1", { header: { cwd: fixture.cwd } }]]);
  const first = adapterFor(fixture, { sessions });
  await liveTurn(first, fixture, "s1", options("s1", [user("u1", "hi")]), async server => {
    server.notify("thread/tokenUsage/updated", { threadId: server.threadId, tokenUsage: { total: {}, last: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1 }, modelContextWindow: 123456 } });
    server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: { type: "agentMessage", phase: "final_answer", text: "ok" } });
    server.notify("turn/completed", { threadId: server.threadId, turn: { id: server.turnId, status: "completed" } });
  });
  first.close();
  await fixture.backend.close();
  const restarted = new CodexSessionBackend(fixture.stateDir, () => new FakeServer(fixture.hub));
  t.after(async () => { await restarted.close(); cleanup(fixture); });
  const second = new CodexProviderAdapter({
    backend: restarted,
    sessions: { get: id => sessions.get(id) },
    agents: { get: () => undefined },
    approval: undefined,
    logger: { warn() {} },
    providerCwd: fixture.cwd,
  });
  const info = await second.resolveModel("codex", "luna");
  assert.equal(info.context.contextWindow, 123456, "persisted usage survives provider restarts");
});

test("imports cross-provider and tool history once and fails closed on images without the attachment seam", async t => {
  const fixture = setup("dsh-provider-import-");
  t.after(() => { cleanup(fixture); return fixture.backend.close(); });
  const sessions = new Map([["s1", { header: { cwd: fixture.cwd } }]]);
  const adapter = adapterFor(fixture, { sessions });
  const history = [
    system("prompt"), user("u0", "old question"), assistant("a0", "old answer"),
    toolCall("a1", "call_1", "codex_workers", "{}"), toolResult("t1", "call_1", "worker done"), user("u1", "continue"),
  ];
  const chunks = await liveTurn(adapter, fixture, "s1", options("s1", history), async server => {
    server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: { type: "agentMessage", phase: "final_answer", text: "imported" } });
    server.notify("turn/completed", { threadId: server.threadId, turn: { id: server.turnId, status: "completed" } });
  });
  assert.equal(chunks.find(chunk => chunk.type === "block-end").block.text, "imported");
  const input = sessionServer(fixture.hub).calls.find(call => call.method === "turn/start").params.input;
  assert.equal(input.length, 2);
  assert.match(input[0].text, /^\[DSH history import/);
  assert.match(input[0].text, /user: old question/);
  assert.match(input[0].text, /assistant: old answer/);
  assert.match(input[0].text, /tool\(codex_workers\): \[tool result\] worker done/);
  assert.equal(input[1].text, "continue");

  const images = setup("dsh-provider-image-");
  t.after(() => { cleanup(images); return images.backend.close(); });
  const imageAdapter = adapterFor(images, { sessions: new Map([["s2", { header: { cwd: images.cwd } }]]) });
  assert.deepEqual((await imageAdapter.listModels("codex"))[0].inputModalities, ["text"], "no seam means no image advertisement");
  await assert.rejects(collect(imageAdapter.stream(options("s2", [image("u1", "look at this")]))), /cannot represent this image/);
  const toolImage = {
    id: "u2", role: "user",
    content: [{ type: "tool-result", toolCallId: "call_2", content: [{ type: "image", attachment: { attachmentId: "a2", mediaType: "image/png", name: "y.png", bytes: 3, width: 1, height: 1 } }] }],
    source: { kind: "tool", callId: "call_2" },
  };
  await assert.rejects(collect(imageAdapter.stream(options("s2", [user("u1", "look"), toolImage]))), /cannot represent this image/);
  assert.equal(images.hub.servers.flatMap(server => server.calls ?? []).some(call => call.method === "thread/start"), false);
});

test("advertises image modality and sends user images as localImage inputs", async t => {
  const fixture = setup("dsh-provider-image-native-");
  t.after(() => { cleanup(fixture); return fixture.backend.close(); });
  fixture.hub.models = [{ model: "luna", displayName: "Luna", defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "high", description: "Deep" }], inputModalities: ["text", "image"] }];
  const sessions = new Map([["s1", { header: { cwd: fixture.cwd } }]]);
  const attachments = { imageHostPath: ref => `/attachments/${ref.attachmentId}.png` };
  const adapter = adapterFor(fixture, { sessions, attachments });

  assert.deepEqual((await adapter.listModels("codex"))[0].inputModalities, ["text", "image"]);
  assert.deepEqual((await adapter.resolveModel("codex", "luna")).inputModalities, ["text", "image"]);
  assert.deepEqual((await adapter.resolveModel("codex", "unlisted")).inputModalities, ["text"], "unknown models stay conservative");

  const chunks = await liveTurn(adapter, fixture, "s1", options("s1", [image("u1", "look at this")]), async server => {
    server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: { type: "agentMessage", phase: "final_answer", text: "seen" } });
    server.notify("turn/completed", { threadId: server.threadId, turn: { id: server.turnId, status: "completed" } });
  });
  assert.equal(chunks.at(-1).reason.kind, "stop");
  const input = sessionServer(fixture.hub).calls.find(call => call.method === "turn/start").params.input;
  assert.deepEqual(input, [
    { type: "text", text: "look at this", text_elements: [] },
    { type: "localImage", path: "/attachments/a1.png" },
  ]);
});

test("imports durable history and tool-result images next to their text", async t => {
  const fixture = setup("dsh-provider-image-history-");
  t.after(() => { cleanup(fixture); return fixture.backend.close(); });
  fixture.hub.models = [{ model: "luna", displayName: "Luna", defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "high", description: "Deep" }], inputModalities: ["text", "image"] }];
  const sessions = new Map([["s1", { header: { cwd: fixture.cwd } }]]);
  const attachments = { imageHostPath: ref => `/attachments/${ref.attachmentId}.png` };
  const adapter = adapterFor(fixture, { sessions, attachments });
  const toolImage = {
    id: "t1", role: "user",
    content: [{ type: "tool-result", toolCallId: "call_1", content: [{ type: "text", text: "screenshot" }, { type: "image", attachment: { attachmentId: "a2", mediaType: "image/png", name: "y.png", bytes: 3, width: 1, height: 1 } }] }],
    source: { kind: "tool", callId: "call_1" },
  };
  const history = [
    system("prompt"), user("u0", "old question"),
    toolCall("a1", "call_1", "view", "{}"), toolImage,
    user("u1", "continue"),
  ];
  const chunks = await liveTurn(adapter, fixture, "s1", options("s1", history), async server => {
    server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: { type: "agentMessage", phase: "final_answer", text: "imported" } });
    server.notify("turn/completed", { threadId: server.threadId, turn: { id: server.turnId, status: "completed" } });
  });
  assert.equal(chunks.at(-1).reason.kind, "stop");
  const input = sessionServer(fixture.hub).calls.find(call => call.method === "turn/start").params.input;
  assert.equal(input[0].type, "text");
  assert.match(input[0].text, /^\[DSH history import/);
  assert.match(input[0].text, /user: old question/);
  assert.match(input[0].text, /tool\(view\): \[tool result\] screenshot/);
  assert.deepEqual(input[1], { type: "localImage", path: "/attachments/a2.png" }, "the tool-result image follows its text");
  assert.equal(input[2].text, "continue");
});

test("falls back to a base64 image input when the store has no host path", async t => {
  const fixture = setup("dsh-provider-image-data-");
  t.after(() => { cleanup(fixture); return fixture.backend.close(); });
  fixture.hub.models = [{ model: "luna", displayName: "Luna", defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "high", description: "Deep" }], inputModalities: ["text", "image"] }];
  const sessions = new Map([["s1", { header: { cwd: fixture.cwd } }]]);
  const attachments = { imageHostPath: () => undefined, readImage: async () => ({ data: new Uint8Array([1, 2, 3]) }) };
  const adapter = adapterFor(fixture, { sessions, attachments });
  await liveTurn(adapter, fixture, "s1", options("s1", [image("u1", "look")]), async server => {
    server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: { type: "agentMessage", phase: "final_answer", text: "seen" } });
    server.notify("turn/completed", { threadId: server.threadId, turn: { id: server.turnId, status: "completed" } });
  });
  const input = sessionServer(fixture.hub).calls.find(call => call.method === "turn/start").params.input;
  assert.deepEqual(input[1], { type: "image", url: "data:image/png;base64,AQID" });
});

test("imports tool history for a forked DSH Session without a native checkpoint", async t => {
  const fixture = setup("dsh-provider-fork-");
  t.after(() => { cleanup(fixture); return fixture.backend.close(); });
  const sessions = new Map([
    ["origin", { header: { cwd: fixture.cwd } }],
    ["fork", { header: { cwd: fixture.cwd } }],
  ]);
  const adapter = adapterFor(fixture, { sessions });
  await liveTurn(adapter, fixture, "origin", options("origin", [user("u1", "first")]), async server => {
    server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: { type: "agentMessage", phase: "final_answer", text: "Hello" } });
    server.notify("turn/completed", { threadId: server.threadId, turn: { id: server.turnId, status: "completed" } });
  });
  const origin = sessionServer(fixture.hub);

  const forked = await liveTurn(adapter, fixture, "fork", options("fork", [
    system("prompt"),
    user("u0", "old question"),
    assistant("a0", "old answer", "deepseek"),
    toolCall("a1", "call_1", "codex_workers", "{}"),
    toolResult("t1", "call_1", "worker done"),
    assistant("a2", "native answer", "codex", { response: { threadId: origin.threadId, turnId: origin.turnId, input: "u1" } }),
    user("u1", "continue"),
  ]), async server => {
    server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: { type: "agentMessage", phase: "final_answer", text: "forked" } });
    server.notify("turn/completed", { threadId: server.threadId, turn: { id: server.turnId, status: "completed" } });
  });
  assert.equal(forked.find(chunk => chunk.type === "block-end").block.text, "forked");
  const forkServer = fixture.hub.servers.find(server => server !== origin && server.calls?.some(call => call.method === "thread/start"));
  assert.notEqual(forkServer.threadId, origin.threadId, "the forked DSH Session never reuses the origin native thread");
  const input = forkServer.calls.find(call => call.method === "turn/start").params.input;
  assert.equal(input.length, 2);
  assert.match(input[0].text, /^\[DSH history import/);
  assert.match(input[0].text, /assistant: old answer/);
  assert.match(input[0].text, /tool\(codex_workers\): \[tool result\] worker done/);
  assert.match(input[0].text, /assistant: native answer/);
  assert.equal(input[1].text, "continue");
});

test("drops DSH-injected context from imports while keeping checkpoints and recalls", async t => {
  const fixture = setup("dsh-provider-injected-");
  t.after(() => { cleanup(fixture); return fixture.backend.close(); });
  const sessions = new Map([["s1", { header: { cwd: fixture.cwd } }]]);
  const adapter = adapterFor(fixture, { sessions });
  const injected = [
    { id: "sys", role: "system", content: [{ type: "text", text: "DSH_SYSTEM_PROMPT_MARK" }], source: { kind: "plugin", plugin: "@deepseek-ai/dsh-system-prompt" } },
    { id: "ins", role: "user", content: [{ type: "text", text: "AGENTS_MARK" }], source: { kind: "agent-instructions", form: "instructions", changes: [] } },
    { id: "cat", role: "user", content: [{ type: "text", text: "CATALOG_MARK" }], source: { kind: "skill-catalog", form: "catalog", entries: [] } },
    { id: "snap", role: "user", content: [{ type: "text", text: "SNAPSHOT_MARK" }], source: { kind: "plugin", plugin: "@deepseek-ai/dsh-system-prompt", form: "snapshot", sections: [] } },
    // Already executed natively, so the thread must never be handed it back.
    { id: "codex-executed:t0:turn0:i0", role: "user", content: [{ type: "text", text: "EXECUTED_FACT_MARK" }],
      source: { kind: "plugin", plugin: "dsh-codex-app-provider", form: "notice", summary: "Codex executed: ls" } },
  ];
  const history = [
    ...injected,
    { id: "cp", role: "user", content: [{ type: "text", text: "CHECKPOINT_MARK" }], source: { kind: "plugin", plugin: "compact", compactionId: "c1" } },
    { id: "recall", role: "user", content: [{ type: "text", text: "RECALL_MARK" }], source: { kind: "plugin", plugin: "dsh-session-reference", form: "recall" } },
    { id: "skill", role: "user", content: [{ type: "text", text: "INVOKED_SKILL_MARK" }], source: { kind: "skill-invocation", name: "demo", form: "instructions" } },
    user("u0", "old question"), assistant("a0", "old answer", "deepseek"), user("u1", "continue"),
  ];
  const chunks = await liveTurn(adapter, fixture, "s1", options("s1", history), async server => {
    server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: { type: "agentMessage", phase: "final_answer", text: "imported" } });
    server.notify("turn/completed", { threadId: server.threadId, turn: { id: server.turnId, status: "completed" } });
  });
  assert.equal(chunks.at(-1).reason.kind, "stop");
  const input = sessionServer(fixture.hub).calls.find(call => call.method === "turn/start").params.input;
  assert.equal(input.length, 2);
  const imported = input[0].text;
  assert.match(imported, /^\[DSH history import/);
  for (const mark of ["DSH_SYSTEM_PROMPT_MARK", "AGENTS_MARK", "CATALOG_MARK", "SNAPSHOT_MARK", "EXECUTED_FACT_MARK"]) {
    assert.equal(imported.includes(mark), false, `${mark} must not reach Codex`);
  }
  assert.match(imported, /CHECKPOINT_MARK/);
  assert.match(imported, /RECALL_MARK/);
  assert.match(imported, /INVOKED_SKILL_MARK/);
  assert.match(imported, /old question/);
  assert.equal(input[1].text, "continue");
});

test("isolates concurrent provider Sessions and cancellation", async t => {
  const fixture = setup("dsh-provider-concurrent-");
  t.after(() => { cleanup(fixture); return fixture.backend.close(); });
  const sessions = new Map([
    ["s1", { header: { cwd: fixture.cwd } }],
    ["s2", { header: { cwd: fixture.cwd } }],
  ]);
  const adapter = adapterFor(fixture, { sessions });
  const controller = new AbortController();
  const one = collect(adapter.stream(options("s1", [user("u1", "one")], { signal: controller.signal })));
  const two = collect(adapter.stream(options("s2", [user("u2", "two")])));
  await waitFor(async () =>
    (await fixture.backend.readSession(OWNER, "codex:s1"))?.threadId !== undefined
    && (await fixture.backend.readSession(OWNER, "codex:s2"))?.threadId !== undefined, "both threads");
  const recordOne = await fixture.backend.readSession(OWNER, "codex:s1");
  const recordTwo = await fixture.backend.readSession(OWNER, "codex:s2");
  const first = fixture.hub.servers.find(server => server.threadId === recordOne.threadId);
  const second = fixture.hub.servers.find(server => server.threadId === recordTwo.threadId);
  await waitFor(() => first.calls?.some(call => call.method === "turn/start") && second.calls?.some(call => call.method === "turn/start"), "both turn/start");
  await waitFor(async () => (await fixture.backend.readSession(OWNER, "codex:s1"))?.turnId === first.turnId
    && (await fixture.backend.readSession(OWNER, "codex:s2"))?.turnId === second.turnId, "both turns");

  controller.abort();
  const oneChunks = await one;
  assert.equal(oneChunks.at(-1).reason.kind, "aborted");
  assert.deepEqual(first.interrupted, { threadId: first.threadId, turnId: first.turnId });
  assert.equal(second.interrupted, undefined, "aborting one Session never interrupts the other");

  second.notify("item/completed", { threadId: second.threadId, turnId: second.turnId, item: { type: "agentMessage", phase: "final_answer", text: "two done" } });
  second.notify("turn/completed", { threadId: second.threadId, turn: { id: second.turnId, status: "completed" } });
  const twoChunks = await two;
  assert.equal(twoChunks.at(-1).reason.kind, "stop");
  assert.equal(second.calls.filter(call => call.method === "thread/start").length, 1, "the other Session keeps its own thread");
});

test("uses each Session workspace and explicit model selection", async t => {
  const fixture = setup("dsh-provider-cwd-");
  const otherCwd = mkdtempSync(join(tmpdir(), "dsh-provider-cwd-other-"));
  t.after(() => { cleanup(fixture); rmSync(otherCwd, { recursive: true, force: true }); return fixture.backend.close(); });
  const sessions = new Map([
    ["a", { header: { cwd: fixture.cwd } }],
    ["b", { header: { cwd: otherCwd } }],
  ]);
  const adapter = adapterFor(fixture, { sessions });
  const first = collect(adapter.stream({ ...options("a", [user("u1", "a")]), reasoningEffort: "low" }));
  await waitFor(() => fixture.hub.servers.filter(server => server.calls?.some(call => call.method === "thread/start")).length === 1, "first thread");
  const serverA = sessionServer(fixture.hub);
  await waitFor(async () => {
    const record = await fixture.backend.readSession(OWNER, "codex:a");
    return serverA.threadId !== undefined && record?.turnId !== undefined && record.turnId === serverA.turnId;
  }, "first turn");
  serverA.notify("item/completed", { threadId: serverA.threadId, turnId: serverA.turnId, item: { type: "agentMessage", phase: "final_answer", text: "A" } });
  serverA.notify("turn/completed", { threadId: serverA.threadId, turn: { id: serverA.turnId, status: "completed" } });
  assert.equal((await first).at(-1).reason.kind, "stop");

  const second = collect(adapter.stream({ ...options("b", [user("u2", "b")]), reasoningEffort: "high" }));
  await waitFor(() => fixture.hub.servers.some(server => server.threadId !== undefined && server !== serverA && server.calls?.some(call => call.method === "thread/start")), "second thread");
  const serverB = fixture.hub.servers.find(server => server !== serverA && server.calls?.some(call => call.method === "thread/start"));
  await waitFor(async () => {
    const record = await fixture.backend.readSession(OWNER, "codex:b");
    return serverB.threadId !== undefined && record?.turnId !== undefined && record.turnId === serverB.turnId;
  }, "second turn");
  serverB.notify("item/completed", { threadId: serverB.threadId, turnId: serverB.turnId, item: { type: "agentMessage", phase: "final_answer", text: "B" } });
  serverB.notify("turn/completed", { threadId: serverB.threadId, turn: { id: serverB.turnId, status: "completed" } });
  assert.equal((await second).at(-1).reason.kind, "stop");

  assert.equal(serverA.calls.find(call => call.method === "thread/start").params.cwd, fixture.cwd);
  assert.equal(serverB.calls.find(call => call.method === "thread/start").params.cwd, otherCwd);
  assert.deepEqual(serverA.calls.find(call => call.method === "turn/start").params.effort, "low");
  assert.deepEqual(serverB.calls.find(call => call.method === "turn/start").params.effort, "high");
  assert.notEqual(serverA.threadId, serverB.threadId, "two workspaces never share a native thread");
});

test("isolates title and compaction requests from the user thread and cleans them up", async t => {
  const fixture = setup("dsh-provider-aux-");
  t.after(() => { cleanup(fixture); return fixture.backend.close(); });
  const sessions = new Map([["s1", { header: { cwd: fixture.cwd } }]]);
  const adapter = adapterFor(fixture, { sessions });
  await liveTurn(adapter, fixture, "s1", options("s1", [user("u1", "first")]), async server => {
    server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: { type: "agentMessage", phase: "final_answer", text: "Hello" } });
    server.notify("turn/completed", { threadId: server.threadId, turn: { id: server.turnId, status: "completed" } });
  });
  const main = sessionServer(fixture.hub);

  const done = collect(adapter.stream(options("s1", [user("t1", "summarize this")], { purpose: "session-title" })));
  await waitFor(() => fixture.hub.servers.some(server => server !== main && server.calls?.some(call => call.method === "thread/start")), "auxiliary thread");
  const aux = fixture.hub.servers.find(server => server !== main && server.calls?.some(call => call.method === "thread/start"));
  const threadStart = aux.calls.find(call => call.method === "thread/start");
  // Permissions belong to Codex on every path: the auxiliary request carries no
  // approval policy and no sandbox of this plugin's choosing.
  assert.equal("approvalPolicy" in threadStart.params, false, "the plugin does not author Codex's approval policy");
  assert.equal("sandbox" in threadStart.params, false, "the plugin does not author Codex's sandbox");
  await waitFor(() => aux.calls.some(call => call.method === "turn/start"), "auxiliary turn/start");
  await waitFor(async () => (await fixture.backend.listSessions(OWNER)).some(record => record.threadId === aux.threadId && record.turnId === aux.turnId), "auxiliary turn identity");
  aux.notify("item/completed", { threadId: aux.threadId, turnId: aux.turnId, item: { type: "agentMessage", phase: "final_answer", text: "A title" } });
  aux.notify("turn/completed", { threadId: aux.threadId, turn: { id: aux.turnId, status: "completed" } });
  const chunks = await done;
  assert.equal(chunks.find(chunk => chunk.type === "block-end").block.text, "A title");
  assert.equal(chunks.at(-1).reason.kind, "stop");
  assert.equal(main.calls.filter(call => call.method === "turn/start").length, 1, "the auxiliary request must not start a main-thread turn");
  assert.ok((aux.closed ?? 0) >= 1, "the auxiliary Session is closed");
  assert.equal((await fixture.backend.listSessions(OWNER)).some(record => record.threadId === aux.threadId), false);
});

test("carries a native approval to the DSH answerer and applies its decision", async t => {
  const fixture = setup("dsh-provider-approval-");
  t.after(() => { cleanup(fixture); return fixture.backend.close(); });
  const sessions = new Map([["s1", { header: { cwd: fixture.cwd } }]]);
  const agents = new Map([["s1", { id: "s1", session: sessions.get("s1") }]]);
  const asked = [];
  // The user answers in DSH's own approval surface; this seam is that surface.
  const approval = { request: async request => { asked.push(request); return "allowed-once"; } };
  const adapter = adapterFor(fixture, { sessions, agents, approval });
  const chunks = await liveTurn(adapter, fixture, "s1", options("s1", [user("u1", "run a command")]), async server => {
    server.ask(11, "item/commandExecution/requestApproval", { threadId: server.threadId, turnId: server.turnId, command: "ls -la", reason: null });
    await waitFor(() => server.responded?.length > 0, "approval response");
    server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: { type: "agentMessage", phase: "final_answer", text: "done" } });
    server.notify("turn/completed", { threadId: server.threadId, turn: { id: server.turnId, status: "completed" } });
  });
  assert.equal(asked.length, 1, "the DSH answerer is asked exactly once");
  assert.equal(asked[0].agent.id, "s1", "the question is scoped to the Session whose turn asked");
  assert.equal(asked[0].toolName, "item/commandExecution/requestApproval");
  assert.equal(asked[0].reason, "ls -la", "the command is what the user decides on");
  assert.deepEqual(sessionServer(fixture.hub).responded, [{ id: 11, result: { decision: "accept" } }]);
  assert.equal(chunks.at(-1).reason.kind, "stop");
  assert.equal((await fixture.backend.pendingApprovals(OWNER, "codex:s1")).length, 0);
});

test("declines a native approval fail-closed when no client channel is mounted", async t => {
  const fixture = setup("dsh-provider-approval-failclosed-");
  t.after(() => { cleanup(fixture); return fixture.backend.close(); });
  const sessions = new Map([["s1", { header: { cwd: fixture.cwd } }]]);
  const agents = new Map([["s1", { id: "s1", session: sessions.get("s1") }]]);
  // No approval channel in this composition: nobody can give a real decision,
  // so the request is declined rather than approved, and the record stays.
  const adapter = adapterFor(fixture, { sessions, agents });
  await liveTurn(adapter, fixture, "s1", options("s1", [user("u1", "write a file")]), async server => {
    server.ask(12, "item/fileChange/requestApproval", { threadId: server.threadId, turnId: server.turnId, reason: "writes" });
    await waitFor(() => server.responded?.length > 0, "approval response");
    server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: { type: "agentMessage", phase: "final_answer", text: "declined" } });
    server.notify("turn/completed", { threadId: server.threadId, turn: { id: server.turnId, status: "completed" } });
  });
  const responded = sessionServer(fixture.hub).responded;
  assert.deepEqual(responded, [{ id: 12, result: { decision: "decline" } }]);
  assert.equal((await fixture.backend.pendingApprovals(OWNER, "codex:s1")).length, 0, "a fail-closed decline is a recorded decision, not a dropped request");
});

test("answers permissions requests with the pane's decision, turn-scoped", async t => {
  const fixture = setup("dsh-provider-permissions-");
  t.after(() => { cleanup(fixture); return fixture.backend.close(); });
  const sessions = new Map([["s1", { header: { cwd: fixture.cwd } }]]);
  const agents = new Map([["s1", { id: "s1", session: sessions.get("s1") }]]);
  const outcomes = ["allowed-once", "rejected"];
  const adapter = adapterFor(fixture, { sessions, agents, approval: { request: async () => outcomes.shift() } });
  await liveTurn(adapter, fixture, "s1", options("s1", [user("u1", "need network")]), async server => {
    server.ask(31, "item/permissions/requestApproval", {
      threadId: server.threadId, turnId: server.turnId, itemId: "p1", environmentId: null, startedAtMs: 1,
      cwd: fixture.cwd, reason: "network access", permissions: { network: { enabled: true }, fileSystem: null },
    });
    await waitFor(async () => (await fixture.backend.pendingApprovals(OWNER, "codex:s1")).length === 1, "first permissions request");
    server.ask(32, "item/permissions/requestApproval", {
      threadId: server.threadId, turnId: server.turnId, itemId: "p2", environmentId: null, startedAtMs: 2,
      cwd: fixture.cwd, reason: "write access", permissions: { network: null, fileSystem: { read: [fixture.cwd], write: [fixture.cwd] } },
    });
    await waitFor(() => server.responded?.length > 1, "both permissions answers");
    server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: { type: "agentMessage", phase: "final_answer", text: "checked" } });
    server.notify("turn/completed", { threadId: server.threadId, turn: { id: server.turnId, status: "completed" } });
  });
  const responded = sessionServer(fixture.hub).responded;
  assert.deepEqual(responded[0], { id: 31, result: { permissions: { network: { enabled: true }, fileSystem: null }, scope: "turn" } },
    "an accepted request grants exactly what Codex asked for, for this turn");
  assert.deepEqual(responded[1], { id: 32, result: { permissions: {}, scope: "turn" } });
});

test("leaves a native question for the pane and answers it with the real values", async t => {
  const fixture = setup("dsh-provider-userinput-");
  t.after(() => { cleanup(fixture); return fixture.backend.close(); });
  const sessions = new Map([["s1", { header: { cwd: fixture.cwd } }]]);
  const agents = new Map([["s1", { id: "s1", session: sessions.get("s1") }]]);
  const asked = [];
  const questions = { ask: async request => { asked.push(request); return { answers: [{ id: "q1", selected: ["Yes"], custom: "note" }] }; } };
  const adapter = adapterFor(fixture, { sessions, agents, questions });
  await liveTurn(adapter, fixture, "s1", options("s1", [user("u1", "ask me")]), async server => {
    server.ask(41, "item/tool/requestUserInput", {
      threadId: server.threadId, turnId: server.turnId, itemId: "i1", isBlocking: true, autoResolutionMs: null,
      questions: [{ id: "q1", header: "Pick", question: "Proceed?", isOther: true, isSecret: false, options: [{ label: "Yes", description: "go" }, { label: "No", description: "stop" }] }],
    });
    await waitFor(() => server.responded?.length > 0, "user-input answer");
    server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: { type: "agentMessage", phase: "final_answer", text: "answered" } });
    server.notify("turn/completed", { threadId: server.threadId, turn: { id: server.turnId, status: "completed" } });
  });
  assert.equal(asked.length, 1, "the DSH question seam is asked exactly once");
  assert.deepEqual(asked[0].questions.map(question => question.id), ["q1"]);
  assert.deepEqual(asked[0].questions[0].options.map(option => option.label), ["Yes", "No"]);
  assert.deepEqual(sessionServer(fixture.hub).responded, [
    { id: 41, result: { answers: { q1: { answers: ["Yes", "note"] } } } },
  ]);
  assert.deepEqual(await fixture.backend.pendingUserInputs(OWNER, "codex:s1"), []);
});

/**
 * An auxiliary call runs on the user's behalf like any other turn. Its stream
 * loop already forwards a native question to the DSH seam, but the backend
 * answers empty unless the subscription declared itself interactive, so the
 * forwarding branch could never be reached.
 */
test("carries an auxiliary call's native question to the DSH question seam", async t => {
  const fixture = setup("dsh-provider-aux-question-");
  t.after(() => { cleanup(fixture); return fixture.backend.close(); });
  const sessions = new Map([["s1", { header: { cwd: fixture.cwd } }]]);
  const agents = new Map([["s1", { id: "s1", session: sessions.get("s1") }]]);
  const asked = [];
  const questions = { ask: async request => { asked.push(request); return { answers: [{ id: "q1", selected: ["Yes"], custom: "note" }] }; } };
  const adapter = adapterFor(fixture, { sessions, agents, questions });

  const done = collect(adapter.stream(options("s1", [user("t1", "summarize this")], { purpose: "session-title" })));
  await waitFor(() => fixture.hub.servers.some(server => server.calls?.some(call => call.method === "thread/start")), "auxiliary thread");
  const aux = fixture.hub.servers.find(server => server.calls?.some(call => call.method === "thread/start"));
  await waitFor(() => aux.calls.some(call => call.method === "turn/start"), "auxiliary turn/start");
  await waitFor(async () => (await fixture.backend.listSessions(OWNER)).some(record => record.threadId === aux.threadId && record.turnId === aux.turnId), "auxiliary turn identity");
  aux.ask(61, "item/tool/requestUserInput", {
    threadId: aux.threadId, turnId: aux.turnId, itemId: "i1", isBlocking: true, autoResolutionMs: null,
    questions: [{ id: "q1", header: "Pick", question: "Proceed?", isOther: true, isSecret: false, options: [{ label: "Yes", description: "go" }] }],
  });
  await waitFor(() => aux.responded?.length > 0, "auxiliary user-input answer");
  assert.equal(asked.length, 1, "the auxiliary call reaches the same question seam the main path uses");
  assert.deepEqual(aux.responded, [{ id: 61, result: { answers: { q1: { answers: ["Yes", "note"] } } } }],
    "the real answer reaches the native request instead of the empty fail-closed default");
  aux.notify("item/completed", { threadId: aux.threadId, turnId: aux.turnId, item: { type: "agentMessage", phase: "final_answer", text: "A title" } });
  aux.notify("turn/completed", { threadId: aux.threadId, turn: { id: aux.turnId, status: "completed" } });
  assert.equal((await done).at(-1).reason.kind, "stop");
});

test("fails closed for user input without a seam and for MCP elicitation", async t => {
  const fixture = setup("dsh-provider-failclosed-");
  t.after(() => { cleanup(fixture); return fixture.backend.close(); });
  const sessions = new Map([["s1", { header: { cwd: fixture.cwd } }]]);
  const agents = new Map([["s1", { id: "s1", session: sessions.get("s1") }]]);
  const adapter = adapterFor(fixture, { sessions, agents });
  await liveTurn(adapter, fixture, "s1", options("s1", [user("u1", "interact")]), async server => {
    server.ask(51, "item/tool/requestUserInput", {
      threadId: server.threadId, turnId: server.turnId, itemId: "i1", isBlocking: true, autoResolutionMs: null,
      questions: [{ id: "q1", header: "H", question: "Q?", isOther: false, isSecret: false, options: null }],
    });
    await waitFor(() => server.responded?.length > 0, "empty user input");
    server.ask(52, "mcpServer/elicitation/request", {
      threadId: server.threadId, turnId: server.turnId, serverName: "mcp", mode: "form", _meta: null,
      message: "need input", requestedSchema: { type: "object" },
    });
    await waitFor(() => server.responded?.length > 1, "elicitation decline");
    server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: { type: "agentMessage", phase: "final_answer", text: "done" } });
    server.notify("turn/completed", { threadId: server.threadId, turn: { id: server.turnId, status: "completed" } });
  });
  assert.deepEqual(sessionServer(fixture.hub).responded, [
    { id: 51, result: { answers: {} } },
    { id: 52, result: { action: "decline", content: null, _meta: null } },
  ]);
});

test("isolates the DSH child, the legacy worker, and foreign native-child events", async t => {
  const fixture = setup("dsh-provider-matrix-");
  const childCwd = mkdtempSync(join(tmpdir(), "dsh-provider-matrix-cwd-"));
  t.after(() => { cleanup(fixture); rmSync(childCwd, { recursive: true, force: true }); return fixture.backend.close(); });
  const sessions = new Map([["child-a", { header: { cwd: childCwd } }]]);
  const agents = new Map([["child-a", { id: "child-a", session: sessions.get("child-a") }]]);
  let asked = 0;
  const adapter = adapterFor(fixture, { sessions, agents, approval: { request: async () => { asked += 1; return "allowed-once"; } } });

  const child = collect(adapter.stream(options("child-a", [user("u1", "child work")])));
  await waitFor(() => fixture.hub.servers.some(server => server.calls?.some(call => call.method === "turn/start")), "child turn/start");
  const childServer = fixture.hub.servers.find(server => server.calls?.some(call => call.method === "turn/start"));
  await waitFor(async () => (await fixture.backend.readSession(OWNER, "codex:child-a"))?.turnId === childServer.turnId, "child turn identity");

  childServer.ask(99, "item/commandExecution/requestApproval", { threadId: "native-child-thread", turnId: "native-child-turn" });
  childServer.notify("item/completed", { threadId: "native-child-thread", turnId: "native-child-turn",
    item: { id: "foreign-cmd", type: "commandExecution", command: "printf foreign", status: "completed", exitCode: 0, aggregatedOutput: "foreign" } });
  assert.deepEqual(childServer.rejected, [{ id: 99, message: "Unknown Session thread" }], "native child approvals are rejected fail-closed");
  assert.equal(asked, 0, "another thread's request never reaches the user's approval surface");
  assert.deepEqual(await fixture.backend.readFacts(OWNER, "codex:child-a"), [],
    "another thread's executed item never becomes this Session's execution fact");

  const caller = { nativeSessionId: "parent", source: "agent", parentAgent: { id: "agent", nativeSessionId: "parent" } };
  const uiCaller = { nativeSessionId: "parent", source: "ui", parentAgent: { id: "agent", nativeSessionId: "parent" } };
  const changes = [];
  fixture.backend.subscribeWorkers(uiCaller, event => changes.push(event));
  const worker = await fixture.backend.createWorker(caller, { name: "legacy", cwd: childCwd });
  const workerServer = fixture.hub.servers.find(server => server.threadId === worker.threadId);
  const workerTurn = await fixture.backend.startTurn(caller, worker.id, "legacy work");
  workerServer.emit("request", { id: "worker-approval", method: "item/commandExecution/requestApproval", params: { threadId: worker.threadId, turnId: workerTurn.turnId, command: "ls" } });
  const [workerApproval] = await fixture.backend.pendingApprovals(caller, worker.id);
  await fixture.backend.decideApproval(uiCaller, worker.id, workerApproval.requestId, "accept");
  workerServer.notify("item/completed", { threadId: worker.threadId, turnId: workerTurn.turnId, item: { type: "agentMessage", phase: "final_answer", text: "worker done" } });
  workerServer.notify("turn/completed", { threadId: worker.threadId, turn: { id: workerTurn.turnId, status: "completed" } });

  assert.notEqual(worker.threadId, childServer.threadId, "the legacy worker keeps its own Codex thread");
  assert.equal(changes.some(event => event.workerId === worker.id && event.change === "report"), true, "the parent still receives the worker report notification");
  assert.equal((await fixture.backend.pendingApprovals(caller, worker.id)).length, 0, "the legacy worker's approval was decided on its own record");

  childServer.ask(11, "item/commandExecution/requestApproval", { threadId: childServer.threadId, turnId: childServer.turnId, command: "ls" });
  await waitFor(() => childServer.responded?.length > 0, "child approval response");
  assert.equal(asked, 1, "the Session's own request reaches the user's approval surface");
  assert.deepEqual(childServer.responded, [{ id: 11, result: { decision: "accept" } }]);
  const childStream = [];
  fixture.backend.subscribe(OWNER, "codex:child-a", event => childStream.push(event.type));
  childServer.notify("item/completed", { threadId: childServer.threadId, turnId: childServer.turnId, item: { type: "agentMessage", phase: "final_answer", text: "child done" } });
  childServer.notify("turn/completed", { threadId: childServer.threadId, turn: { id: childServer.turnId, status: "completed" } });
  const chunks = await child;
  assert.equal(chunks.at(-1).reason.kind, "stop");
  assert.equal(childStream.includes("report.ready"), false, "the DSH child stays outside the worker report path");
});

/** One codex reply in the DSH log, carrying the identity that marks the thread's history. */
function appendCodexReply(session, threadId, { id, text, turnId, input }) {
  session.append("assistant/message", { turn: 1, step: 0, stream: [],
    message: assistant(id, text, "codex", { response: { threadId, turnId, input } }) });
}

/**
 * One DSH compaction in the log, in the order the real core writes it: the
 * lifecycle events, the summary carrying its shadowed range, then the
 * checkpoint message that replaced that range on the surface.
 */
function appendCompaction(session, { compactionId, shadowedSeqs, summary, checkpointId }) {
  const start = shadowedSeqs[0], end = shadowedSeqs.at(-1);
  session.append("compaction/start", { compactionId });
  session.append("compaction/summary", { compactionId, shadowedSeqs, shadowedRange: { start, end }, summary });
  const message = checkpoint(checkpointId, summary, compactionId);
  session.append("user/message", message, { surfaceOp: { op: "replace", startSeq: start, endSeq: end }, sourceEventSeqs: shadowedSeqs });
  return message;
}

/** One executed-fact notice the provider appends to the log after a native turn. */
function appendImportedFact(session, threadId, itemId) {
  const message = {
    id: `codex-executed:${threadId}:turn-1:${itemId}`, role: "user",
    content: [{ type: "text", text: `[source: codex thread=${threadId} turn=turn-1 item=${itemId}] command: run-fake-command (exit 0)` }],
    source: { kind: "plugin", plugin: "dsh-codex-app-provider", form: "notice", summary: "Codex executed: run-fake-command" },
  };
  session.append("user/message", message, { surfaceOp: "append" });
  return message;
}

/** The turn/start calls one native server accepted, in order. */
const turnStarts = server => server.calls.filter(call => call.method === "turn/start");

test("native compaction keeps the main thread and takes the summary from an isolated thread", async t => {
  const fixture = setup("dsh-provider-compact-");
  t.after(() => { cleanup(fixture); return fixture.backend.close(); });
  const sessions = new Map([["s1", { header: { cwd: fixture.cwd } }]]);
  const adapter = adapterFor(fixture, { sessions });
  await liveTurn(adapter, fixture, "s1", options("s1", [user("u1", "first")]), async server => {
    server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: { type: "agentMessage", phase: "final_answer", text: "Hello" } });
    server.notify("turn/completed", { threadId: server.threadId, turn: { id: server.turnId, status: "completed" } });
  });
  const main = sessionServer(fixture.hub);
  const threadId = main.threadId;

  const done = collect(adapter.stream(options("s1", [user("u1", "first"), user("t1", "summarize")], { purpose: "compaction" })));
  await waitFor(() => main.calls?.some(call => call.method === "thread/compact/start"), "compact start");
  main.notify("turn/started", { threadId, turn: { id: "compact-turn" } });
  main.notify("turn/completed", { threadId, turn: { id: "compact-turn", status: "completed" } });
  await waitFor(() => fixture.hub.servers.some(server => server !== main && turnStarts(server).length > 0), "auxiliary summary turn");
  const aux = fixture.hub.servers.find(server => server !== main && turnStarts(server).length > 0);
  await waitFor(async () => (await fixture.backend.listSessions(OWNER)).some(record => record.threadId === aux.threadId && record.turnId === aux.turnId), "auxiliary turn identity");
  aux.notify("item/completed", { threadId: aux.threadId, turnId: aux.turnId, item: { type: "agentMessage", phase: "final_answer", text: "Summary" } });
  aux.notify("turn/completed", { threadId: aux.threadId, turn: { id: aux.turnId, status: "completed" } });

  const chunks = await done;
  assert.equal(chunks.find(chunk => chunk.type === "block-end").block.text, "Summary");
  assert.equal(chunks.at(-1).reason.kind, "stop");
  assert.equal((await fixture.backend.readSession(OWNER, "codex:s1")).threadId, threadId, "the compacted thread stays bound to the Session");
  assert.equal(fixture.hub.servers.filter(server => server.calls?.some(call => call.method === "thread/start")).length, 2,
    "only the isolated summary starts a thread; the main thread is never rebuilt");

  // The compacted thread, not a replacement, serves the next turn.
  const session = new FakeAppendSession("s1", fixture.cwd);
  const u1 = user("u1", "first");
  session.append("user/message", u1);
  appendCodexReply(session, threadId, { id: "a1", text: "Hello", turnId: "turn-1", input: "u1" });
  const cp = appendCompaction(session, { compactionId: "c1", shadowedSeqs: [1, 2], summary: "first summary", checkpointId: "cp1" });
  const u2 = user("u2", "second");
  session.append("user/message", u2);
  const next = adapterFor(fixture, { sessions: new Map([["s1", session]]) });
  const before = turnStarts(main).length;
  const doneNext = collect(next.stream(options("s1", [cp, u2])));
  await waitFor(() => turnStarts(main).length === before + 1, "next turn on the compacted thread");
  await waitFor(async () => (await fixture.backend.readSession(OWNER, "codex:s1"))?.turnId === main.turnId, "next turn identity");
  main.notify("item/completed", { threadId: main.threadId, turnId: main.turnId, item: { type: "agentMessage", phase: "final_answer", text: "Again" } });
  main.notify("turn/completed", { threadId: main.threadId, turn: { id: main.turnId, status: "completed" } });
  assert.equal((await doneNext).at(-1).reason.kind, "stop");
  assert.deepEqual(turnStarts(main).at(-1).params.input.map(item => item.text), ["second"],
    "the compacted thread continues without re-importing the history it already owns");
});

test("native compaction hides the replay marker, so only new input reaches the thread", async t => {
  const fixture = setup("dsh-provider-compact-input-");
  t.after(async () => { await fixture.backend.close(); cleanup(fixture); });
  const first = adapterFor(fixture, { sessions: new Map([["s1", { id: "s1", header: { cwd: fixture.cwd } }]]) });
  await liveTurn(first, fixture, "s1", options("s1", [user("u1", "first")]), async server => {
    server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: { type: "agentMessage", phase: "final_answer", text: "Hello" } });
    server.notify("turn/completed", { threadId: server.threadId, turn: { id: server.turnId, status: "completed" } });
  });
  const server = sessionServer(fixture.hub);
  const threadId = (await fixture.backend.readSession(OWNER, "codex:s1")).threadId;

  const session = new FakeAppendSession("s1", fixture.cwd);
  session.append("user/message", user("u1", "first"));
  appendCodexReply(session, threadId, { id: "a1", text: "Hello", turnId: "turn-1", input: "u1" });
  const cp = appendCompaction(session, { compactionId: "c1", shadowedSeqs: [1, 2], summary: "first summary", checkpointId: "cp1" });
  const u2 = user("u2", "second");
  session.append("user/message", u2);

  // No in-memory cursor: the boundary can only come from the Session log.
  const adapter = adapterFor(fixture, { sessions: new Map([["s1", session]]) });
  const before = turnStarts(server).length;
  const done = collect(adapter.stream(options("s1", [cp, u2])));
  await waitFor(() => turnStarts(server).length === before + 1, "next turn/start");
  await waitFor(async () => (await fixture.backend.readSession(OWNER, "codex:s1"))?.turnId === server.turnId, "turn identity");
  server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: { type: "agentMessage", phase: "final_answer", text: "Again" } });
  server.notify("turn/completed", { threadId: server.threadId, turn: { id: server.turnId, status: "completed" } });
  assert.equal((await done).at(-1).reason.kind, "stop");

  const start = turnStarts(server).at(-1);
  assert.deepEqual(start.params.input.map(item => item.text), ["second"],
    "the compacted history and the DSH checkpoint that replaced it are never resent");
  assert.equal(server.calls.filter(call => call.method === "thread/start").length, 1, "the same native thread is continued");
});

test("native compaction chains without resending twice-covered history", async t => {
  const fixture = setup("dsh-provider-compact-chain-");
  t.after(async () => { await fixture.backend.close(); cleanup(fixture); });
  const first = adapterFor(fixture, { sessions: new Map([["s1", { id: "s1", header: { cwd: fixture.cwd } }]]) });
  await liveTurn(first, fixture, "s1", options("s1", [user("u1", "first")]), async server => {
    server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: { type: "agentMessage", phase: "final_answer", text: "Hello" } });
    server.notify("turn/completed", { threadId: server.threadId, turn: { id: server.turnId, status: "completed" } });
  });
  const server = sessionServer(fixture.hub);
  const threadId = (await fixture.backend.readSession(OWNER, "codex:s1")).threadId;

  const session = new FakeAppendSession("s1", fixture.cwd);
  session.append("user/message", user("u1", "first"));
  appendCodexReply(session, threadId, { id: "a1", text: "Hello", turnId: "turn-1", input: "u1" });
  appendCompaction(session, { compactionId: "c1", shadowedSeqs: [1, 2], summary: "first summary", checkpointId: "cp1" });
  session.append("user/message", user("u2", "second"));
  appendCodexReply(session, threadId, { id: "a2", text: "Ok", turnId: "turn-2", input: "u2" });
  const cp2 = appendCompaction(session, { compactionId: "c2", shadowedSeqs: [5, 6, 7], summary: "second summary", checkpointId: "cp2" });
  const u3 = user("u3", "third");
  session.append("user/message", u3);

  const adapter = adapterFor(fixture, { sessions: new Map([["s1", session]]) });
  const before = turnStarts(server).length;
  const done = collect(adapter.stream(options("s1", [cp2, u3])));
  await waitFor(() => turnStarts(server).length === before + 1, "chained turn/start");
  await waitFor(async () => (await fixture.backend.readSession(OWNER, "codex:s1"))?.turnId === server.turnId, "chained turn identity");
  server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: { type: "agentMessage", phase: "final_answer", text: "Third" } });
  server.notify("turn/completed", { threadId: server.threadId, turn: { id: server.turnId, status: "completed" } });
  assert.equal((await done).at(-1).reason.kind, "stop");
  assert.deepEqual(turnStarts(server).at(-1).params.input.map(item => item.text), ["third"],
    "a chained checkpoint is recognized through the range the first one covered");
});

test("native compaction still sends content appended after the checkpoint", async t => {
  const fixture = setup("dsh-provider-compact-suffix-");
  t.after(async () => { await fixture.backend.close(); cleanup(fixture); });
  const first = adapterFor(fixture, { sessions: new Map([["s1", { id: "s1", header: { cwd: fixture.cwd } }]]) });
  await liveTurn(first, fixture, "s1", options("s1", [user("u1", "first")]), async server => {
    server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: { type: "agentMessage", phase: "final_answer", text: "Hello" } });
    server.notify("turn/completed", { threadId: server.threadId, turn: { id: server.turnId, status: "completed" } });
  });
  const server = sessionServer(fixture.hub);
  const threadId = (await fixture.backend.readSession(OWNER, "codex:s1")).threadId;

  const session = new FakeAppendSession("s1", fixture.cwd);
  session.append("user/message", user("u1", "first"));
  appendCodexReply(session, threadId, { id: "a1", text: "Hello", turnId: "turn-1", input: "u1" });
  const cp = appendCompaction(session, { compactionId: "c1", shadowedSeqs: [1, 2], summary: "first summary", checkpointId: "cp1" });
  const pending = notice("n1", "worker says hi");
  session.append("user/message", pending);
  const u2 = user("u2", "second");
  session.append("user/message", u2);

  const adapter = adapterFor(fixture, { sessions: new Map([["s1", session]]) });
  const before = turnStarts(server).length;
  const done = collect(adapter.stream(options("s1", [cp, pending, u2])));
  await waitFor(() => turnStarts(server).length === before + 1, "turn/start after the checkpoint");
  await waitFor(async () => (await fixture.backend.readSession(OWNER, "codex:s1"))?.turnId === server.turnId, "turn identity");
  server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: { type: "agentMessage", phase: "final_answer", text: "Again" } });
  server.notify("turn/completed", { threadId: server.threadId, turn: { id: server.turnId, status: "completed" } });
  assert.equal((await done).at(-1).reason.kind, "stop");

  const input = turnStarts(server).at(-1).params.input;
  assert.equal(input.length, 2, "the unsent notice is imported next to the new message");
  assert.match(input[0].text, /\[DSH history import/);
  assert.match(input[0].text, /worker says hi/, "content the native thread never saw is never dropped");
  assert.doesNotMatch(input[0].text, /first summary/);
  assert.equal(input[1].text, "second");
});

test("native compaction recognizes a checkpoint that also replaced executed facts", async t => {
  const fixture = setup("dsh-provider-compact-facts-");
  t.after(async () => { await fixture.backend.close(); cleanup(fixture); });
  const first = adapterFor(fixture, { sessions: new Map([["s1", { id: "s1", header: { cwd: fixture.cwd } }]]) });
  await liveTurn(first, fixture, "s1", options("s1", [user("u1", "first")]), async server => {
    server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: { type: "agentMessage", phase: "final_answer", text: "Hello" } });
    server.notify("turn/completed", { threadId: server.threadId, turn: { id: server.turnId, status: "completed" } });
  });
  const server = sessionServer(fixture.hub);
  const threadId = (await fixture.backend.readSession(OWNER, "codex:s1")).threadId;

  // The real surface a compaction replaces holds the executed-fact notice the
  // previous turn imported after its assistant message, so the shadowed range
  // reaches past the last native replay marker.
  const session = new FakeAppendSession("s1", fixture.cwd);
  session.append("user/message", user("u1", "first"));
  appendCodexReply(session, threadId, { id: "a1", text: "Hello", turnId: "turn-1", input: "u1" });
  appendImportedFact(session, threadId, "item-1");
  const cp = appendCompaction(session, { compactionId: "c1", shadowedSeqs: [1, 2, 3], summary: "first summary", checkpointId: "cp1" });
  const u2 = user("u2", "second");
  session.append("user/message", u2);

  const adapter = adapterFor(fixture, { sessions: new Map([["s1", session]]) });
  const before = turnStarts(server).length;
  const done = collect(adapter.stream(options("s1", [cp, u2])));
  await waitFor(() => turnStarts(server).length === before + 1, "turn/start after a fact-bearing compaction");
  await waitFor(async () => (await fixture.backend.readSession(OWNER, "codex:s1"))?.turnId === server.turnId, "turn identity");
  server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: { type: "agentMessage", phase: "final_answer", text: "Again" } });
  server.notify("turn/completed", { threadId: server.threadId, turn: { id: server.turnId, status: "completed" } });
  assert.equal((await done).at(-1).reason.kind, "stop");
  assert.deepEqual(turnStarts(server).at(-1).params.input.map(item => item.text), ["second"],
    "an executed fact inside the replaced range does not hide the checkpoint");
});

test("native compaction sends a checkpoint whose replaced range also carried unsent content", async t => {
  const fixture = setup("dsh-provider-compact-unsent-");
  t.after(async () => { await fixture.backend.close(); cleanup(fixture); });
  const first = adapterFor(fixture, { sessions: new Map([["s1", { id: "s1", header: { cwd: fixture.cwd } }]]) });
  await liveTurn(first, fixture, "s1", options("s1", [user("u1", "first")]), async server => {
    server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: { type: "agentMessage", phase: "final_answer", text: "Hello" } });
    server.notify("turn/completed", { threadId: server.threadId, turn: { id: server.turnId, status: "completed" } });
  });
  const server = sessionServer(fixture.hub);
  const threadId = (await fixture.backend.readSession(OWNER, "codex:s1")).threadId;

  // The replaced range also holds a visible notice the native thread never saw.
  // Treating the checkpoint as known here would silently drop that content, so
  // the checkpoint must still be handed over.
  const session = new FakeAppendSession("s1", fixture.cwd);
  session.append("user/message", user("u1", "first"));
  appendCodexReply(session, threadId, { id: "a1", text: "Hello", turnId: "turn-1", input: "u1" });
  session.append("user/message", notice("n1", "worker says hi"));
  const cp = appendCompaction(session, { compactionId: "c1", shadowedSeqs: [1, 2, 3], summary: "first summary", checkpointId: "cp1" });
  const u2 = user("u2", "second");
  session.append("user/message", u2);

  const adapter = adapterFor(fixture, { sessions: new Map([["s1", session]]) });
  const before = turnStarts(server).length;
  const done = collect(adapter.stream(options("s1", [cp, u2])));
  await waitFor(() => turnStarts(server).length === before + 1, "turn/start after a partially covered compaction");
  await waitFor(async () => (await fixture.backend.readSession(OWNER, "codex:s1"))?.turnId === server.turnId, "turn identity");
  server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: { type: "agentMessage", phase: "final_answer", text: "Again" } });
  server.notify("turn/completed", { threadId: server.threadId, turn: { id: server.turnId, status: "completed" } });
  assert.equal((await done).at(-1).reason.kind, "stop");

  const input = turnStarts(server).at(-1).params.input;
  assert.equal(input.length, 2, "the checkpoint is handed over together with the new input");
  assert.match(input[0].text, /first summary/, "the checkpoint that replaced unsent content still reaches the thread");
  assert.equal(input[1].text, "second");
});

test("native compaction reports a failed native compaction without rebuilding or summarizing", async t => {
  const fixture = setup("dsh-provider-compact-failed-");
  t.after(async () => { await fixture.backend.close(); cleanup(fixture); });
  const sessions = new Map([["s1", { header: { cwd: fixture.cwd } }]]);
  const adapter = adapterFor(fixture, { sessions });
  await liveTurn(adapter, fixture, "s1", options("s1", [user("u1", "first")]), async server => {
    server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: { type: "agentMessage", phase: "final_answer", text: "Hello" } });
    server.notify("turn/completed", { threadId: server.threadId, turn: { id: server.turnId, status: "completed" } });
  });
  const main = sessionServer(fixture.hub);
  const threadId = main.threadId;

  const done = collect(adapter.stream(options("s1", [user("u1", "first"), user("t1", "summarize")], { purpose: "compaction" })));
  await waitFor(() => main.calls?.some(call => call.method === "thread/compact/start"), "compact start");
  main.notify("turn/started", { threadId, turn: { id: "compact-turn" } });
  main.notify("turn/completed", { threadId, turn: { id: "compact-turn", status: "failed", error: { message: "compact boom" } } });
  await assert.rejects(done, /native compaction did not complete/);
  assert.equal(main.calls.filter(call => call.method === "thread/start").length, 1, "a failed compaction never starts a replacement thread");
  assert.equal(fixture.hub.servers.filter(server => server !== main && turnStarts(server).length > 0).length, 0,
    "a failed compaction does not fall back to a DSH summary thread");
  assert.equal((await fixture.backend.readSession(OWNER, "codex:s1")).threadId, threadId, "the thread stays bound after a failed compaction");
});

test("native compaction aborted before its turn identity claims nothing was stopped", async t => {
  const fixture = setup("dsh-provider-compact-abort-early-");
  t.after(async () => { await fixture.backend.close(); cleanup(fixture); });
  const sessions = new Map([["s1", { header: { cwd: fixture.cwd } }]]);
  const adapter = adapterFor(fixture, { sessions });
  await liveTurn(adapter, fixture, "s1", options("s1", [user("u1", "first")]), async server => {
    server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: { type: "agentMessage", phase: "final_answer", text: "Hello" } });
    server.notify("turn/completed", { threadId: server.threadId, turn: { id: server.turnId, status: "completed" } });
  });
  const main = sessionServer(fixture.hub);
  const controller = new AbortController();
  const done = collect(adapter.stream(options("s1", [user("u1", "first"), user("t1", "summarize")], { purpose: "compaction", signal: controller.signal })));
  await waitFor(() => main.calls?.some(call => call.method === "thread/compact/start"), "compact start");
  controller.abort();
  await assert.rejects(done, /compaction aborted/);
  assert.equal(main.interrupted, undefined, "a turn whose identity is unknown is not reported as stopped");
});

test("native compaction aborted after its turn identity interrupts that turn", async t => {
  const fixture = setup("dsh-provider-compact-abort-late-");
  t.after(async () => { await fixture.backend.close(); cleanup(fixture); });
  const sessions = new Map([["s1", { header: { cwd: fixture.cwd } }]]);
  const adapter = adapterFor(fixture, { sessions });
  await liveTurn(adapter, fixture, "s1", options("s1", [user("u1", "first")]), async server => {
    server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: { type: "agentMessage", phase: "final_answer", text: "Hello" } });
    server.notify("turn/completed", { threadId: server.threadId, turn: { id: server.turnId, status: "completed" } });
  });
  const main = sessionServer(fixture.hub);
  const threadId = main.threadId;
  const controller = new AbortController();
  const done = collect(adapter.stream(options("s1", [user("u1", "first"), user("t1", "summarize")], { purpose: "compaction", signal: controller.signal })));
  await waitFor(() => main.calls?.some(call => call.method === "thread/compact/start"), "compact start");
  main.notify("turn/started", { threadId, turn: { id: "compact-turn" } });
  await waitFor(async () => (await fixture.backend.readSession(OWNER, "codex:s1"))?.turnId === "compact-turn", "compact turn identity");
  controller.abort();
  await assert.rejects(done, /compaction aborted/);
  await waitFor(() => main.interrupted !== undefined, "compact interrupt");
  assert.deepEqual(main.interrupted, { threadId, turnId: "compact-turn" }, "a compaction with a known identity is stopped");
});

test("native compaction survives a restart and resumes the same thread without replay", async t => {
  const fixture = setup("dsh-provider-compact-restart-");
  const first = adapterFor(fixture, { sessions: new Map([["s1", { id: "s1", header: { cwd: fixture.cwd } }]]) });
  await liveTurn(first, fixture, "s1", options("s1", [user("u1", "first")]), async server => {
    server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: { type: "agentMessage", phase: "final_answer", text: "Hello" } });
    server.notify("turn/completed", { threadId: server.threadId, turn: { id: server.turnId, status: "completed" } });
  });
  const threadId = (await fixture.backend.readSession(OWNER, "codex:s1")).threadId;
  await fixture.backend.close();
  fixture.hub.servers.length = 0;
  const restarted = new CodexSessionBackend(fixture.stateDir, () => new FakeServer(fixture.hub));
  t.after(async () => { await restarted.close(); cleanup(fixture); });

  const session = new FakeAppendSession("s1", fixture.cwd);
  session.append("user/message", user("u1", "first"));
  appendCodexReply(session, threadId, { id: "a1", text: "Hello", turnId: "turn-1", input: "u1" });
  const cp = appendCompaction(session, { compactionId: "c1", shadowedSeqs: [1, 2], summary: "first summary", checkpointId: "cp1" });
  const u2 = user("u2", "second");
  session.append("user/message", u2);

  const adapter = adapterFor({ ...fixture, backend: restarted }, { sessions: new Map([["s1", session]]) });
  const done = collect(adapter.stream(options("s1", [cp, u2])));
  await waitFor(() => fixture.hub.servers.some(server => server.calls?.some(call => call.method === "turn/start")), "recovered turn/start");
  const server = fixture.hub.servers.find(server => server.calls?.some(call => call.method === "turn/start"));
  await waitFor(async () => (await restarted.readSession(OWNER, "codex:s1"))?.turnId === server.turnId, "recovered turn identity");
  server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: { type: "agentMessage", phase: "final_answer", text: "Again" } });
  server.notify("turn/completed", { threadId: server.threadId, turn: { id: server.turnId, status: "completed" } });
  assert.equal((await done).at(-1).reason.kind, "stop");

  const resumed = fixture.hub.servers.flatMap(item => item.calls ?? []).filter(call => call.method === "thread/resume");
  assert.equal(resumed.length, 1, "the compacted thread is resumed, not rebuilt");
  assert.equal(resumed[0].params.threadId, threadId);
  assert.deepEqual(turnStarts(server).at(-1).params.input.map(item => item.text), ["second"],
    "a cold recovery re-derives the same boundary it would have had in memory");
});

test("abort cancels pending approvals, interrupts the turn, and settles interrupted", async t => {
  const fixture = setup("dsh-provider-abort-");
  t.after(() => { cleanup(fixture); return fixture.backend.close(); });
  const sessions = new Map([["s1", { header: { cwd: fixture.cwd } }]]);
  const agents = new Map([["s1", { id: "s1", session: sessions.get("s1") }]]);
  // The user has not answered yet: the request stays open until the turn is
  // cancelled, which is exactly the window the abort has to close.
  const approval = { request: request => new Promise(resolve => {
    request.signal?.addEventListener("abort", () => resolve("cancelled"), { once: true });
  }) };
  const adapter = adapterFor(fixture, { sessions, agents, approval });
  const controller = new AbortController();
  const done = collect(adapter.stream(options("s1", [user("u1", "run")], { signal: controller.signal })));
  await waitFor(() => fixture.hub.servers.some(server => server.calls?.some(call => call.method === "turn/start")), "turn/start");
  const server = fixture.hub.servers.find(server => server.calls?.some(call => call.method === "turn/start"));
  await waitFor(async () => (await fixture.backend.readSession(OWNER, "codex:s1"))?.turnId === server.turnId, "turn identity");
  server.ask(21, "item/commandExecution/requestApproval", { threadId: server.threadId, turnId: server.turnId, command: "rm -rf x" });
  await waitFor(async () => (await fixture.backend.pendingApprovals(OWNER, "codex:s1")).length > 0, "pending approval");
  controller.abort();
  const chunks = await done;
  assert.equal(chunks.at(-1).type, "finish");
  assert.equal(chunks.at(-1).reason.kind, "aborted");
  await waitFor(() => server.responded?.length > 0, "cancel response");
  assert.deepEqual(server.responded, [{ id: 21, result: { decision: "cancel" } }]);
  assert.deepEqual(server.interrupted, { threadId: server.threadId, turnId: server.turnId });
});

test("a failed turn replays without running a second native turn", async t => {
  const fixture = setup("dsh-provider-retry-");
  t.after(() => { cleanup(fixture); return fixture.backend.close(); });
  const sessions = new Map([["s1", { header: { cwd: fixture.cwd } }]]);
  const adapter = adapterFor(fixture, { sessions });
  const chunks = await liveTurn(adapter, fixture, "s1", options("s1", [user("u1", "work")]), async server => {
    server.notify("turn/completed", { threadId: server.threadId, turn: { id: server.turnId, status: "failed", error: { message: "boom" } } });
  });
  assert.equal(chunks.at(-1).reason.kind, "error");
  assert.equal(chunks.at(-1).reason.failure.message, "boom");
  const server = sessionServer(fixture.hub);

  const retried = await collect(adapter.stream(options("s1", [user("u1", "work")])));
  assert.equal(retried.at(-1).reason.kind, "error");
  assert.equal(retried.at(-1).reason.failure.message, "boom");
  assert.equal(server.calls.filter(call => call.method === "turn/start").length, 1, "the retry must not redispatch the turn");
});

test("close aborts in-flight turns and refuses later calls", async t => {
  const fixture = setup("dsh-provider-close-");
  t.after(() => { cleanup(fixture); return fixture.backend.close(); });
  const sessions = new Map([["s1", { header: { cwd: fixture.cwd } }]]);
  const adapter = adapterFor(fixture, { sessions });
  const done = collect(adapter.stream(options("s1", [user("u1", "work")])));
  await waitFor(() => fixture.hub.servers.some(server => server.calls?.some(call => call.method === "turn/start")), "turn/start");
  const server = fixture.hub.servers.find(server => server.calls?.some(call => call.method === "turn/start"));
  await waitFor(async () => (await fixture.backend.readSession(OWNER, "codex:s1"))?.turnId === server.turnId, "turn identity");
  adapter.close();
  const chunks = await done;
  assert.equal(chunks.at(-1).type, "finish");
  assert.equal(chunks.at(-1).reason.kind, "aborted");
  assert.deepEqual(server.interrupted, { threadId: server.threadId, turnId: server.turnId });
  const servers = fixture.hub.servers.length;
  await assert.rejects(collect(adapter.stream(options("s1", [user("u2", "again")]))), /shutting down/);
  assert.equal(fixture.hub.servers.length, servers, "no backend session is created after disposal");
});

test("a closed backend refuses new sessions and temporary reads", async t => {
  const fixture = setup("dsh-provider-closed-");
  t.after(() => cleanup(fixture));
  await fixture.backend.close();
  await assert.rejects(fixture.backend.createSession(OWNER, "codex:x", fixture.cwd), /closed/);
  await assert.rejects(fixture.backend.modelSettings(fixture.cwd), /closed/);
});

test("registers behind the real DSH LlmRuntime and exposes normalized chunk streams", async t => {
  const fixture = setup("dsh-provider-runtime-");
  t.after(() => { cleanup(fixture); return fixture.backend.close(); });
  const sessions = new Map([
    ["s1", { header: { cwd: fixture.cwd } }],
    ["s2", { header: { cwd: fixture.cwd } }],
  ]);
  const ctx = new Context();
  const runtime = new LlmRuntime(ctx);
  const adapter = adapterFor(fixture, { sessions });
  runtime.registerAdapter(["codex"], adapter);
  assert.deepEqual(runtime.listProviders().filter(provider => provider.id === "codex"), [{ id: "codex", name: "Codex" }]);

  const done = collect(runtime.stream(options("s1", [user("u1", "hi")])));
  await waitFor(() => fixture.hub.servers.some(server => server.calls?.some(call => call.method === "turn/start")), "runtime turn/start");
  const server = fixture.hub.servers.find(server => server.calls?.some(call => call.method === "turn/start"));
  await waitFor(async () => (await fixture.backend.readSession(OWNER, "codex:s1"))?.turnId === server.turnId, "runtime turn identity");
  server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: { type: "agentMessage", phase: "final_answer", text: "Hello" } });
  server.notify("turn/completed", { threadId: server.threadId, turn: { id: server.turnId, status: "completed" } });
  const chunks = await done;
  assert.equal(chunks.at(-1).reason.kind, "stop");
  assert.equal(chunks.at(-1).replayState.response.threadId, server.threadId);

  const empty = collect(runtime.stream(options("s2", [user("u2", "nothing")])));
  await waitFor(() => fixture.hub.servers.filter(server => server.calls?.some(call => call.method === "turn/start")).length === 2, "second runtime turn/start");
  const second = fixture.hub.servers.filter(server => server.calls?.some(call => call.method === "turn/start"))[1];
  await waitFor(async () => (await fixture.backend.readSession(OWNER, "codex:s2"))?.turnId === second.turnId, "second turn identity");
  second.notify("turn/completed", { threadId: second.threadId, turn: { id: second.turnId, status: "completed" } });
  const normalized = await empty;
  assert.deepEqual(normalized, [{ type: "finish", reason: { kind: "error", failure: { message: "Codex completed the turn without a visible assistant message", code: "EMPTY_RESULT" } } }]);
});

test("routes images through the real DSH LlmRuntime when the model advertises them", async t => {
  const fixture = setup("dsh-provider-runtime-image-");
  t.after(() => { cleanup(fixture); return fixture.backend.close(); });
  fixture.hub.models = [{ model: "luna", displayName: "Luna", defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "high", description: "Deep" }], inputModalities: ["text", "image"] }];
  const sessions = new Map([["s1", { header: { cwd: fixture.cwd } }]]);
  const ctx = new Context();
  const runtime = new LlmRuntime(ctx);
  const attachments = { imageHostPath: ref => `/attachments/${ref.attachmentId}.png` };
  runtime.registerAdapter(["codex"], adapterFor(fixture, { sessions, attachments }));

  const done = collect(runtime.stream(options("s1", [image("u1", "look")])));
  await waitFor(() => fixture.hub.servers.some(server => server.calls?.some(call => call.method === "turn/start")), "runtime turn/start");
  const server = fixture.hub.servers.find(server => server.calls?.some(call => call.method === "turn/start"));
  await waitFor(async () => (await fixture.backend.readSession(OWNER, "codex:s1"))?.turnId === server.turnId, "runtime turn identity");
  server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: { type: "agentMessage", phase: "final_answer", text: "seen" } });
  server.notify("turn/completed", { threadId: server.threadId, turn: { id: server.turnId, status: "completed" } });
  assert.equal((await done).at(-1).reason.kind, "stop");
  assert.deepEqual(server.calls.find(call => call.method === "turn/start").params.input, [
    { type: "text", text: "look", text_elements: [] },
    { type: "localImage", path: "/attachments/a1.png" },
  ], "runtime image gating follows the advertised modality");
});

test("uncertain RPC ends the stream without replaying, and stale events cannot complete it", async t => {
  const fixture = setup("dsh-provider-uncertain-");
  const sessions = new Map([["s1", { header: { cwd: fixture.cwd } }]]);
  const adapter = adapterFor(fixture, { sessions });
  t.after(async () => { adapter.close(); await fixture.backend.close(); cleanup(fixture); });
  const request = options("s1", [user("u1", "execute once")]);
  let settled = false;
  const done = collect(adapter.stream(request)).then(value => { settled = true; return value; }, error => { settled = true; return error; });
  await waitFor(() => sessionServer(fixture.hub)?.turnId !== undefined);
  const server = sessionServer(fixture.hub);
  server.emit("uncertain", new Error("connection lost"));
  await waitFor(() => settled, "uncertain stream termination");
  assert.match(String(await done), /unknown|uncertain/i);
  server.notify("turn/completed", { threadId: server.threadId, turn: { id: server.turnId, status: "completed" } });
  assert.equal((await fixture.backend.readSession(OWNER, "codex:s1")).state, "unknown");
  assert.equal((await fixture.backend.readReports(OWNER, "codex:s1")).length, 0);
  await assert.rejects(collect(adapter.stream(request)), /unknown|uncertain/i);
  assert.equal(fixture.hub.servers.flatMap(s => s.calls ?? []).filter(c => c.method === "turn/start").length, 1);
  assert.equal(fixture.hub.servers.flatMap(s => s.calls ?? []).filter(c => c.method === "thread/resume").length, 0);
  let closed = false;
  server.close = async () => { await new Promise(resolve => setImmediate(resolve)); closed = true; };
  await fixture.backend.close();
  assert.equal(closed, true, "uncertain transport remains owned until awaited close");
});


test("the deployment's own workspace supplies the default model and effort", async t => {
  const fixture = setup("dsh-provider-workspace-defaults-");
  const workspace = mkdtempSync(join(tmpdir(), "dsh-provider-workspace-"));
  t.after(async () => { await fixture.backend.close(); cleanup(fixture); rmSync(workspace, { recursive: true, force: true }); });
  // The workspace configuration names no model: the catalogue's default model
  // decides, with that model's own default effort.
  fixture.hub.config = {};
  fixture.hub.models = [
    { model: "luna", displayName: "Luna", isDefault: false, defaultReasoningEffort: "low",
      supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Fast" }] },
    { model: "sol", displayName: "Sol", isDefault: true, defaultReasoningEffort: "high",
      supportedReasoningEfforts: [{ reasoningEffort: "high", description: "Deep" }] },
  ];
  const adapter = new CodexProviderAdapter({ backend: fixture.backend, sessions: { get: () => undefined },
    agents: { get: () => undefined }, logger: { warn() {} }, providerCwd: workspace });

  const preferred = await adapter.resolveModel("codex", "sol");
  assert.equal(preferred.reasoning.defaultEffort, "high",
    "the catalogue's default model keeps its own default effort when the workspace names none");
  assert.deepEqual(preferred.reasoning.efforts.map(effort => effort.id), ["high"]);
  const other = await adapter.resolveModel("codex", "luna");
  assert.equal(other.reasoning.defaultEffort, "low", "every other model keeps its own default effort");

  const calls = fixture.hub.servers.flatMap(server => server.calls ?? []);
  assert.equal(calls.find(call => call.method === "config/read")?.params.cwd, workspace,
    "the App Server is asked about this deployment's workspace, not a guessed directory");
  assert.equal(calls.find(call => call.method === "model/list")?.params.cwd, workspace);
  assert.equal(calls.some(call => call.method === "thread/start" || call.method === "turn/start"), false,
    "resolving the defaults performs no execution");
});

test("consumes explicit native execution inputs and rejects changed identity/configuration before sending text", async t => {
  const fixture = setup("dsh-provider-execution-");
  t.after(async () => { await fixture.backend.close(); cleanup(fixture); });
  const execution = { developerInstructions: "Role A instructions", boundary: {
    cwd: fixture.cwd, writableRoots: [fixture.cwd], network: "disabled",
  } };
  fixture.hub.threadResult = { cwd: fixture.cwd, approvalPolicy: "never", sandbox: {
    type: "workspaceWrite", writableRoots: [], networkAccess: false,
    excludeSlashTmp: true, excludeTmpdirEnvVar: true,
  } };
  const session = { id: "child", header: { cwd: fixture.cwd } };
  const agent = { session, options: { model: "luna", reasoningEffort: "high", execution } };
  const adapter = adapterFor(fixture, { sessions: new Map([["child", session]]), agents: new Map([["child", agent]]) });
  await liveTurn(adapter, fixture, "child", options("child", [user("u1", "task")], { execution }), async server => {
    server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: { type: "agentMessage", phase: "final_answer", text: "done" } });
    server.notify("turn/completed", { threadId: server.threadId, turn: { id: server.turnId, status: "completed" } });
  });
  const server = sessionServer(fixture.hub);
  const start = server.calls.find(call => call.method === "thread/start").params;
  assert.equal(start.developerInstructions, execution.developerInstructions);
  assert.equal(start.cwd, fixture.cwd);
  // Permissions are Codex's own subject: approval policy, sandbox and the
  // permission profile are never authored by the plugin, and a declared
  // boundary reaches the thread only as the directory the task runs in.
  assert.equal("approvalPolicy" in start, false, "the plugin never forces an approval policy");
  assert.equal("permissions" in start.config, false, "the plugin never injects a permission profile");
  assert.equal("default_permissions" in start.config, false);
  const stored = await fixture.backend.readSession(OWNER, "codex:child");
  assert.deepEqual(stored.options.boundary, execution.boundary);
  assert.deepEqual(stored.applied, {
    cwd: fixture.cwd,
    approvalPolicy: "never",
    // Native facts are recorded as reported: Codex omits an explicitly
    // writable cwd, and the verification still accepts it as declared.
    sandbox: { type: "workspaceWrite", writableRoots: [], excludeSlashTmp: true, excludeTmpdirEnvVar: true, networkAccess: false },
  });
  const facts = await adapter.readExecution("child");
  assert.equal(facts.nativeSessionId, "child");
  assert.equal(facts.state, "idle");
  assert.equal(facts.reports[0].result, "done");
  assert.equal("acceptance" in facts.reports[0], false);
  assert.equal("options" in facts, false);
  facts.reports[0].result = "changed reader copy";
  assert.equal((await adapter.readExecution("child")).reports[0].result, "done");
  const changed = { ...execution, developerInstructions: "Role B" };
  await assert.rejects(collect(adapter.stream(options("child", [user("u2", "next")], { execution: changed }))), /creation snapshot/);
  agent.options.execution = changed;
  await assert.rejects(collect(adapter.stream(options("child", [user("u2", "next")], { execution: changed }))), /instructions or boundary changed/);
  await assert.rejects(collect(adapter.stream(options("child", [user("u2", "next")]))), /instructions or boundary changed/);
  assert.equal(server.calls.filter(call => call.method === "turn/start").length, 1);
});

test("an instructions-only execution gains no permissions, sandbox or approval policy", async t => {
  const fixture = setup("dsh-provider-instructions-only-");
  t.after(async () => { await fixture.backend.close(); cleanup(fixture); });
  const execution = { developerInstructions: "Role A instructions without a boundary" };
  const session = { id: "child", header: { cwd: fixture.cwd } };
  const agent = { session, options: { model: "luna", reasoningEffort: "high", execution } };
  const adapter = adapterFor(fixture, { sessions: new Map([["child", session]]), agents: new Map([["child", agent]]) });
  await liveTurn(adapter, fixture, "child", options("child", [user("u1", "task")], { execution }), async server => {
    server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: { type: "agentMessage", phase: "final_answer", text: "done" } });
    server.notify("turn/completed", { threadId: server.threadId, turn: { id: server.turnId, status: "completed" } });
  });
  const start = sessionServer(fixture.hub).calls.find(call => call.method === "thread/start").params;
  // Role instructions are not a permission grant: nothing about the sandbox,
  // network, approvals or Codex feature set is written on their behalf.
  assert.equal(start.developerInstructions, execution.developerInstructions, "role instructions still reach the thread");
  assert.equal(start.cwd, fixture.cwd, "without a boundary the thread keeps the Session workspace");
  assert.equal("approvalPolicy" in start, false);
  assert.equal("sandbox" in start, false);
  assert.equal("permissions" in start.config, false, "no permissions profile is injected");
  assert.equal("default_permissions" in start.config, false);
  assert.deepEqual(Object.keys(start.config).filter(key => key.startsWith("features.")), [],
    "no Codex feature is disabled to emulate a sandbox");
  const record = await fixture.backend.readSession(OWNER, "codex:child");
  assert.equal(record.options.boundary, undefined);
  assert.equal(record.executionCwd, fixture.cwd);
});

test("executed native facts are persisted as plugin-sourced DSH messages with stable identity", async t => {
  const fixture = setup("dsh-provider-facts-");
  t.after(async () => { await fixture.backend.close(); cleanup(fixture); });
  const session = new FakeAppendSession("main", fixture.cwd);
  const appended = session.appended;
  const adapter = adapterFor(fixture, { sessions: new Map([["main", session]]) });

  await liveTurn(adapter, fixture, "main", options("main", [user("u1", "run it")]), async server => {
    server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: {
      id: "item-1", type: "commandExecution", command: "echo hi", status: "completed", exitCode: 0, aggregatedOutput: "hi\n" } });
    // A reasoning item carries only its public summary; raw reasoning never crosses.
    server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: {
      id: "item-reasoning", type: "reasoning", summary: ["public summary"], content: ["hidden chain of thought"] } });
    server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: { type: "agentMessage", phase: "final_answer", text: "done" } });
    server.notify("turn/completed", { threadId: server.threadId, turn: { id: server.turnId, status: "completed" } });
  });

  assert.equal(appended.length, 1, "one message per executed native item, and none for model reasoning");
  const [fact] = appended;
  assert.equal(fact.type, "user/message");
  assert.deepEqual(fact.intent, { surfaceOp: "append" }, "the append is a real surface placement, not an inbox injection");
  assert.equal(fact.data.role, "user");
  assert.equal(fact.data.source.kind, "plugin");
  assert.equal(fact.data.source.plugin, "dsh-codex-app-provider");
  assert.equal(fact.data.source.form, "notice");
  assert.ok(fact.data.source.summary.length <= 120);
  const threadId = fact.data.id.split(":")[1], turnId = fact.data.id.split(":")[2], itemId = fact.data.id.split(":")[3];
  assert.equal(fact.data.id, `codex-executed:${threadId}:${turnId}:${itemId}`, "the identity is derived from the native item");
  assert.equal(itemId, "item-1");
  const text = fact.data.content.map(block => block.text).join("\n");
  assert.match(text, /\[source: codex thread=/, "the fact names its durable native source");
  assert.match(text, /command: echo hi \(exit 0/);
  assert.match(text, /hi/);
  assert.doesNotMatch(text, /hidden chain of thought/, "hidden reasoning never enters the DSH log");

  // A later turn re-reads the same log: an already-imported fact is never appended twice.
  await liveTurn(adapter, fixture, "main", options("main", [user("u2", "again")]), async server => {
    server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: {
      id: "item-2", type: "fileChange", status: "completed", changes: [{ path: "src/a.ts", kind: "update" }] } });
    server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: { type: "agentMessage", phase: "final_answer", text: "done" } });
    server.notify("turn/completed", { threadId: server.threadId, turn: { id: server.turnId, status: "completed" } });
  });
  assert.equal(appended.length, 2, "the previous turn's fact is deduplicated, the new one is imported");
  assert.equal(appended[0].data.id, fact.data.id);
  assert.match(appended[1].data.content.map(block => block.text).join("\n"), /file change: src\/a\.ts \(update\)/);
  assert.notEqual(appended[1].data.id, fact.data.id, "a distinct native item gets a distinct identity");
});

test("a declared boundary is snapshotted, so a caller mutating it cannot rewrite the execution", async t => {
  const fixture = setup("dsh-provider-snapshot-");
  t.after(async () => { await fixture.backend.close(); cleanup(fixture); });
  const roots = [fixture.cwd];
  const execution = { developerInstructions: "Role A", boundary: { cwd: fixture.cwd, writableRoots: roots, network: "disabled" } };
  fixture.hub.threadResult = { cwd: fixture.cwd, approvalPolicy: "never", sandbox: {
    type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true } };
  const session = { id: "child", header: { cwd: fixture.cwd } };
  const agent = { session, options: { model: "luna", reasoningEffort: "high", execution } };
  const adapter = adapterFor(fixture, { sessions: new Map([["child", session]]), agents: new Map([["child", agent]]) });
  await liveTurn(adapter, fixture, "child", options("child", [user("u1", "task")], { execution }), async server => {
    server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: { type: "agentMessage", phase: "final_answer", text: "done" } });
    server.notify("turn/completed", { threadId: server.threadId, turn: { id: server.turnId, status: "completed" } });
  });
  const recorded = await fixture.backend.readSession(OWNER, "codex:child");
  // The caller now rewrites the very array it declared; the Session's recorded
  // and effective inputs must not follow it.
  roots.push("/elsewhere");
  assert.deepEqual(recorded.options.boundary.writableRoots, [fixture.cwd]);
  assert.deepEqual((await fixture.backend.readSession(OWNER, "codex:child")).options.boundary.writableRoots, [fixture.cwd]);
  const start = sessionServer(fixture.hub).calls.find(call => call.method === "thread/start").params;
  assert.equal("permissions" in start.config, false, "a rewritten declaration cannot widen a permission profile the plugin no longer sends");
});

test("a cold recovery imports the facts a previous process recorded but never appended", async t => {
  const fixture = setup("dsh-provider-facts-recovery-");
  const session = new FakeAppendSession("main", fixture.cwd);
  const appended = session.appended;
  // First process records the native fact but has no DSH Session face to append to.
  const blind = adapterFor(fixture, { sessions: new Map([["main", { id: "main", header: { cwd: fixture.cwd } }]]) });
  await liveTurn(blind, fixture, "main", options("main", [user("u1", "run it")]), async server => {
    server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: {
      id: "item-1", type: "commandExecution", command: "echo recovered", status: "completed", exitCode: 0, aggregatedOutput: "recovered\n" } });
    server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: { type: "agentMessage", phase: "final_answer", text: "done" } });
    server.notify("turn/completed", { threadId: server.threadId, turn: { id: server.turnId, status: "completed" } });
  });
  t.after(async () => { await fixture.backend.close(); cleanup(fixture); });
  assert.equal(appended.length, 0, "without a Session face the facts stay in the provider store only");

  const adapter = adapterFor(fixture, { sessions: new Map([["main", session]]) });
  await liveTurn(adapter, fixture, "main", options("main", [user("u2", "next")]), async server => {
    server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: { type: "agentMessage", phase: "final_answer", text: "done" } });
    server.notify("turn/completed", { threadId: server.threadId, turn: { id: server.turnId, status: "completed" } });
  });
  assert.equal(appended.length, 1, "the missed fact is caught up on the next request");
  assert.match(appended[0].data.content.map(block => block.text).join("\n"), /echo recovered/);
});

test("a managed child's first creation reads the live Agent execution when the stock request carries none", async t => {
  const fixture = setup("dsh-provider-agent-execution-");
  t.after(async () => { await fixture.backend.close(); cleanup(fixture); });
  const execution = { developerInstructions: "Role A instructions", boundary: { cwd: fixture.cwd, writableRoots: [fixture.cwd], network: "disabled" } };
  fixture.hub.threadResult = { cwd: fixture.cwd, approvalPolicy: "never", sandbox: {
    type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true } };
  const session = { id: "child", header: { cwd: fixture.cwd } };
  const agent = { session, options: { model: "luna", reasoningEffort: "high", execution } };
  const adapter = adapterFor(fixture, { sessions: new Map([["child", session]]), agents: new Map([["child", agent]]) });
  // Stock core never fills `GenerateOptions.execution`; the Agent snapshot is the source.
  await liveTurn(adapter, fixture, "child", options("child", [user("u1", "task")]), async server => {
    server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: { type: "agentMessage", phase: "final_answer", text: "done" } });
    server.notify("turn/completed", { threadId: server.threadId, turn: { id: server.turnId, status: "completed" } });
  });
  const start = sessionServer(fixture.hub).calls.find(call => call.method === "thread/start").params;
  assert.equal(start.developerInstructions, execution.developerInstructions, "role instructions reach the native thread");
  assert.equal("permissions" in start.config, false, "role instructions and the lane cwd travel without a plugin permission profile");
  assert.deepEqual((await fixture.backend.readSession(OWNER, "codex:child")).options.boundary, execution.boundary);
});

test("a managed child cannot request a route its live Agent does not authorize when only the Agent declares execution", async t => {
  const fixture = setup("dsh-provider-agent-route-");
  t.after(async () => { await fixture.backend.close(); cleanup(fixture); });
  fixture.hub.threadResult = { cwd: fixture.cwd, approvalPolicy: "never", sandbox: {
    type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true } };
  const execution = { developerInstructions: "Role A", boundary: { cwd: fixture.cwd, writableRoots: [fixture.cwd], network: "disabled" } };
  const session = { id: "child", header: { cwd: fixture.cwd } };
  const agent = { session, options: { model: "luna", reasoningEffort: "high", execution } };
  const adapter = adapterFor(fixture, { sessions: new Map([["child", session]]), agents: new Map([["child", agent]]) });
  // Stock core fills no `GenerateOptions.execution`, so the Agent snapshot is the
  // only source of the inputs; the route authorization must still be enforced.
  await assert.rejects(collect(adapter.stream(options("child", [user("u1", "must not send")], { model: "sol" }))), /effective configuration/);
  assert.equal(fixture.hub.servers.flatMap(server => server.calls ?? []).filter(call => call.method === "thread/start").length, 0,
    "an unauthorized route never creates a thread");
});

test("a lane-scoped workflow boundary runs the thread in the lane and is never widened", async t => {
  const fixture = setup("dsh-provider-lane-");
  const lane = mkdtempSync(join(tmpdir(), "dsh-provider-lane-path-"));
  t.after(async () => { await fixture.backend.close(); cleanup(fixture); rmSync(lane, { recursive: true, force: true }); });
  const execution = { developerInstructions: "Role A", boundary: { cwd: lane, writableRoots: [lane], network: "loopback" } };
  fixture.hub.threadResult = { cwd: lane, approvalPolicy: "never", sandbox: {
    type: "workspaceWrite", writableRoots: [lane], networkAccess: true, excludeSlashTmp: true, excludeTmpdirEnvVar: true } };
  const session = { id: "child", header: { cwd: fixture.cwd } };
  const agent = { session, options: { model: "luna", reasoningEffort: "high", execution } };
  const adapter = adapterFor(fixture, { sessions: new Map([["child", session]]), agents: new Map([["child", agent]]) });
  await liveTurn(adapter, fixture, "child", options("child", [user("u1", "task")], { execution }), async server => {
    server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: { type: "agentMessage", phase: "final_answer", text: "done" } });
    server.notify("turn/completed", { threadId: server.threadId, turn: { id: server.turnId, status: "completed" } });
  });
  const start = sessionServer(fixture.hub).calls.find(call => call.method === "thread/start").params;
  // The lane is the task's real working location, so the native thread runs
  // there. What the task may write is Codex's own decision, so the declaration
  // is recorded rather than translated into a sandbox the plugin authors.
  assert.equal(start.cwd, lane, "the native thread runs in the lane the task declared");
  assert.equal("permissions" in start.config, false, "the declared write scope is Codex's subject, not a plugin parameter");
  assert.equal("approvalPolicy" in start, false, "a declared boundary does not force an approval policy");
  const record = await fixture.backend.readSession(OWNER, "codex:child");
  assert.deepEqual(record.options.boundary, execution.boundary, "the declared boundary travels verbatim");
  assert.equal(record.cwd, fixture.cwd, "the DSH Session workspace is persisted separately");
  assert.equal(record.executionCwd, lane, "the Codex execution cwd is persisted separately");
  // Only declared boundaries are compared; a changed network policy still conflicts.
  const networkChanged = { ...execution, boundary: { ...execution.boundary, network: "disabled" } };
  agent.options.execution = networkChanged;
  await assert.rejects(collect(adapter.stream(options("child", [user("u2", "next")]))), /instructions or boundary changed/);
});

test("a cold recovery without the live Agent continues from the recorded execution baseline", async t => {
  const fixture = setup("dsh-provider-recovery-");
  const execution = { developerInstructions: "Role A", boundary: { cwd: fixture.cwd, writableRoots: [fixture.cwd], network: "disabled" } };
  fixture.hub.threadResult = { cwd: fixture.cwd, approvalPolicy: "never", sandbox: {
    type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true } };
  const session = { id: "child", header: { cwd: fixture.cwd } };
  const first = adapterFor(fixture, { sessions: new Map([["child", session]]), agents: new Map([["child", { session, options: { model: "luna", reasoningEffort: "high", execution } }]]) });
  await liveTurn(first, fixture, "child", options("child", [user("u1", "task")], { execution }), async server => {
    server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: { type: "agentMessage", phase: "final_answer", text: "done" } });
    server.notify("turn/completed", { threadId: server.threadId, turn: { id: server.turnId, status: "completed" } });
  });
  const threadId = (await fixture.backend.readSession(OWNER, "codex:child")).threadId;
  await fixture.backend.close();
  fixture.hub.servers.length = 0;
  const restarted = new CodexSessionBackend(fixture.stateDir, () => new FakeServer(fixture.hub));
  t.after(async () => { await restarted.close(); cleanup(fixture); });
  const recoveryFixture = { ...fixture, backend: restarted };
  // No live Agent and no request execution: the record alone must carry the baseline.
  const recovered = adapterFor(recoveryFixture, { sessions: new Map([["child", session]]) });
  await liveTurn(recovered, recoveryFixture, "child", options("child", [user("u2", "again")]), async server => {
    server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: { type: "agentMessage", phase: "final_answer", text: "again" } });
    server.notify("turn/completed", { threadId: server.threadId, turn: { id: server.turnId, status: "completed" } });
  });
  const resumed = fixture.hub.servers.flatMap(server => server.calls).filter(call => call.method === "thread/resume");
  assert.equal(resumed.length, 1, "recovery resumes the recorded thread");
  assert.equal(resumed[0].params.threadId, threadId, "the thread identity is unchanged");
  assert.equal(resumed[0].params.developerInstructions, "Role A", "the recorded instructions are restored");
  assert.equal(resumed[0].params.cwd, fixture.cwd, "the recovered thread keeps its recorded working directory");
  assert.equal("permissions" in resumed[0].params.config, false);
});

test("projects recorded native items from the provider store and appends them as DSH facts", async t => {
  const fixture = setup("dsh-provider-facts-");
  t.after(async () => { await fixture.backend.close(); cleanup(fixture); });
  const session = new FakeAppendSession("s1", fixture.cwd);
  const appended = session.appended;
  const adapter = adapterFor(fixture, { sessions: new Map([["s1", session]]) });
  await liveTurn(adapter, fixture, "s1", options("s1", [user("u1", "record facts")]), async server => {
    server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: { id: "i1", type: "commandExecution", command: "pnpm test", exitCode: 0, aggregatedOutput: "3 passed" } });
    server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: { id: "i2", type: "reasoning", summary: ["internal"] } });
    server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: { type: "agentMessage", phase: "final_answer", text: "done" } });
    server.notify("turn/completed", { threadId: server.threadId, turn: { id: server.turnId, status: "completed" } });
  });
  const record = await fixture.backend.readSession(OWNER, "codex:s1");
  const expected = [
    `[source: codex thread=${record.threadId} turn=${record.turnId} item=i1] command: pnpm test (exit 0)`,
    `[source: codex thread=${record.threadId} turn=${record.turnId} item=i1] 3 passed`,
  ];
  // The same facts are readable both ways: the provider store remains the raw
  // record for a cross-provider continuation, and the DSH session log carries
  // the visible, replayable representation.
  assert.deepEqual(await adapter.facts("s1"), expected, "only executed facts cross, each with its durable item identity");
  assert.equal(appended.length, 1, "the executed item is appended once, the reasoning item never");
  const { type, data: message, intent } = appended[0];
  assert.equal(type, "user/message");
  assert.deepEqual(intent, { surfaceOp: "append" });
  assert.deepEqual(message.content, [{ type: "text", text: expected.join("\n") }]);
  assert.deepEqual(message.source, { kind: "plugin", plugin: "dsh-codex-app-provider", form: "notice",
    summary: "Codex executed: " + expected[0] });
  await assert.rejects(adapter.facts("unknown-session"), /Session not found/, "an unknown Session is an error, never empty success");
  await assert.rejects(adapter.facts(""), /identity is required/);
});

test("refuses an unapplied native model before turn/start", async t => {
  const fixture = setup("dsh-provider-model-mismatch-");
  t.after(async () => { await fixture.backend.close(); cleanup(fixture); });
  // Every managed execution now applies an effective boundary, so a model
  // mismatch is only reachable once that boundary has been confirmed.
  fixture.hub.threadResult = { model: "wrong", cwd: fixture.cwd, approvalPolicy: "never",
    sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true } };
  const execution = { developerInstructions: "Role A" };
  const session = { id: "child", header: { cwd: fixture.cwd } };
  const agent = { session, options: { model: "luna", reasoningEffort: "high", execution } };
  const adapter = adapterFor(fixture, { sessions: new Map([["child", session]]), agents: new Map([["child", agent]]) });
  await assert.rejects(collect(adapter.stream(options("child", [user("u1", "must not send")], { execution }))), /requested execution model/);
  assert.equal(fixture.hub.servers.flatMap(server => server.calls).filter(call => call.method === "turn/start").length, 0);
});

test("readExecution reports the execution cwd, not the host workspace", async t => {
  const fixture = setup("dsh-provider-execution-cwd-");
  const lane = mkdtempSync(join(tmpdir(), "dsh-provider-execution-lane-"));
  t.after(async () => { await fixture.backend.close(); cleanup(fixture); rmSync(lane, { recursive: true, force: true }); });
  const execution = { developerInstructions: "Role A", boundary: { cwd: lane, writableRoots: [lane], network: "disabled" } };
  fixture.hub.threadResult = { cwd: lane, sandbox: {
    type: "workspaceWrite", writableRoots: [lane], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true } };
  const session = { id: "child", header: { cwd: fixture.cwd } };
  const agent = { session, options: { model: "luna", reasoningEffort: "high", execution } };
  const adapter = adapterFor(fixture, { sessions: new Map([["child", session]]), agents: new Map([["child", agent]]) });
  await liveTurn(adapter, fixture, "child", options("child", [user("u1", "task")], { execution }), async server => {
    server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: { type: "agentMessage", phase: "final_answer", text: "done" } });
    server.notify("turn/completed", { threadId: server.threadId, turn: { id: server.turnId, status: "completed" } });
  });
  const record = await fixture.backend.readSession(OWNER, "codex:child");
  assert.equal(record.cwd, fixture.cwd, "the DSH Session keeps its host workspace");
  assert.equal(record.executionCwd, lane, "the execution cwd is persisted separately");
  assert.equal((await adapter.readExecution("child")).cwd, lane,
    "a consumer reconciles the assignment against the directory the thread runs in");
});

test("a declaring execution holds the task to its directory while Codex owns permissions", async t => {
  // A declared boundary names a location. A thread that reports another
  // directory did not run the declared task, so it is refused before any text
  // is sent.
  {
    const fixture = setup("dsh-provider-boundary-cwd-");
    t.after(async () => { await fixture.backend.close(); cleanup(fixture); });
    const execution = { boundary: { cwd: fixture.cwd, writableRoots: [fixture.cwd], network: "disabled" } };
    fixture.hub.threadResult = { cwd: "/unexpected", sandbox: {
      type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true } };
    const session = { id: "child", header: { cwd: fixture.cwd } };
    const agent = { session, options: { model: "luna", reasoningEffort: "high", execution } };
    const adapter = adapterFor(fixture, { sessions: new Map([["child", session]]), agents: new Map([["child", agent]]) });
    await assert.rejects(collect(adapter.stream(options("child", [user("u1", "must not send")], { execution }))), /another directory/);
    assert.equal(fixture.hub.servers.flatMap(server => server.calls).filter(call => call.method === "turn/start").length, 0);
    assert.equal((await fixture.backend.readSession(OWNER, "codex:child")).state, "unknown");
  }
  // A read-only deployment is the case that used to break: Codex reports
  // `sandbox.type: "readOnly"` with no writable roots and no tmp flags, which is
  // not an unapplied declaration but a native decision the plugin must record.
  {
    const fixture = setup("dsh-provider-boundary-readonly-");
    t.after(async () => { await fixture.backend.close(); cleanup(fixture); });
    const execution = { boundary: { cwd: fixture.cwd, writableRoots: [], network: "disabled" } };
    fixture.hub.threadResult = { cwd: fixture.cwd, sandbox: { type: "readOnly", networkAccess: false } };
    const session = { id: "child", header: { cwd: fixture.cwd } };
    const agent = { session, options: { model: "luna", reasoningEffort: "high", execution } };
    const adapter = adapterFor(fixture, { sessions: new Map([["child", session]]), agents: new Map([["child", agent]]) });
    await liveTurn(adapter, fixture, "child", options("child", [user("u1", "read only task")], { execution }), async server => {
      server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: { type: "agentMessage", phase: "final_answer", text: "done" } });
      server.notify("turn/completed", { threadId: server.threadId, turn: { id: server.turnId, status: "completed" } });
    });
    const record = await fixture.backend.readSession(OWNER, "codex:child");
    assert.equal(record.applied.sandbox.type, "readOnly", "the native read-only sandbox is recorded as reported");
    assert.equal(record.state, "idle", "a read-only native sandbox never blocks a read-only delegation");
  }
  // The sandbox, its writable roots, the network policy and tmp handling are
  // Codex's own configuration: a difference from the declaration is recorded as
  // native fact rather than refused.
  for (const mismatch of ["roots", "network", "tmp"]) {
    const fixture = setup(`dsh-provider-boundary-${mismatch}-`);
    t.after(async () => { await fixture.backend.close(); cleanup(fixture); });
    const execution = { boundary: { cwd: fixture.cwd, writableRoots: [fixture.cwd], network: "disabled" } };
    fixture.hub.threadResult = { cwd: fixture.cwd, sandbox: {
      type: "workspaceWrite", writableRoots: mismatch === "roots" ? ["/unexpected"] : [],
      networkAccess: mismatch === "network", excludeSlashTmp: mismatch !== "tmp", excludeTmpdirEnvVar: true } };
    const session = { id: "child", header: { cwd: fixture.cwd } };
    const agent = { session, options: { model: "luna", reasoningEffort: "high", execution } };
    const adapter = adapterFor(fixture, { sessions: new Map([["child", session]]), agents: new Map([["child", agent]]) });
    await liveTurn(adapter, fixture, "child", options("child", [user("u1", "task")], { execution }), async server => {
      server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: { type: "agentMessage", phase: "final_answer", text: "done" } });
      server.notify("turn/completed", { threadId: server.threadId, turn: { id: server.turnId, status: "completed" } });
    });
    const record = await fixture.backend.readSession(OWNER, "codex:child");
    assert.equal(record.applied.sandbox.networkAccess, mismatch === "network", "the native sandbox is recorded as reported");
    assert.equal(record.applied.sandbox.writableRoots.length, mismatch === "roots" ? 1 : 0);
    assert.notEqual(record.state, "unknown", `a native ${mismatch} difference never blocks the task`);
  }
});

test("an approval policy the plugin never asked for is recorded as native fact", async t => {
  const fixture = setup("dsh-provider-boundary-approval-");
  t.after(async () => { await fixture.backend.close(); cleanup(fixture); });
  const execution = { boundary: { cwd: fixture.cwd, writableRoots: [fixture.cwd], network: "disabled" } };
  // Codex resolves its own approval policy from its configuration layers.
  fixture.hub.threadResult = { cwd: fixture.cwd, approvalPolicy: "on-request", sandbox: {
    type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true } };
  const session = { id: "child", header: { cwd: fixture.cwd } };
  const agent = { session, options: { model: "luna", reasoningEffort: "high", execution } };
  const adapter = adapterFor(fixture, { sessions: new Map([["child", session]]), agents: new Map([["child", agent]]) });
  await liveTurn(adapter, fixture, "child", options("child", [user("u1", "task")], { execution }), async server => {
    server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: { type: "agentMessage", phase: "final_answer", text: "done" } });
    server.notify("turn/completed", { threadId: server.threadId, turn: { id: server.turnId, status: "completed" } });
  });
  const start = sessionServer(fixture.hub).calls.find(call => call.method === "thread/start").params;
  assert.equal("approvalPolicy" in start, false);
  const record = await fixture.backend.readSession(OWNER, "codex:child");
  assert.equal(record.applied.approvalPolicy, "on-request", "native facts are recorded, not the request");
  assert.equal(record.state, "idle");
});
