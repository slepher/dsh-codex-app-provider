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
  for (const mark of ["DSH_SYSTEM_PROMPT_MARK", "AGENTS_MARK", "CATALOG_MARK", "SNAPSHOT_MARK"]) {
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
  assert.equal(threadStart.params.approvalPolicy, "never");
  assert.equal(threadStart.params.sandbox, "read-only");
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

test("bridges Codex approvals through the DSH approval seam", async t => {
  const fixture = setup("dsh-provider-approval-");
  t.after(() => { cleanup(fixture); return fixture.backend.close(); });
  const sessions = new Map([["s1", { header: { cwd: fixture.cwd } }]]);
  const prompts = [];
  const agents = new Map([["s1", { id: "s1", session: sessions.get("s1") }]]);
  const adapter = adapterFor(fixture, { sessions, agents, approval: { async request(request) { prompts.push(request); return "allowed-once"; } } });
  const chunks = await liveTurn(adapter, fixture, "s1", options("s1", [user("u1", "run a command")]), async server => {
    server.ask(11, "item/commandExecution/requestApproval", { threadId: server.threadId, turnId: server.turnId, command: "ls -la", reason: null });
    await waitFor(() => server.responded?.length > 0, "approval response");
    server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: { type: "agentMessage", phase: "final_answer", text: "done" } });
    server.notify("turn/completed", { threadId: server.threadId, turn: { id: server.turnId, status: "completed" } });
  });
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].toolName, "codex:commandExecution");
  assert.equal(prompts[0].reason, "ls -la");
  assert.equal(prompts[0].agent.id, "s1");
  assert.deepEqual(sessionServer(fixture.hub).responded, [{ id: 11, result: { decision: "accept" } }]);
  assert.equal(chunks.at(-1).reason.kind, "stop");

  const rejectFixture = setup("dsh-provider-reject-");
  t.after(() => { cleanup(rejectFixture); return rejectFixture.backend.close(); });
  const rejectSessions = new Map([["s1", { header: { cwd: rejectFixture.cwd } }]]);
  const rejectAgents = new Map([["s1", { id: "s1", session: rejectSessions.get("s1") }]]);
  const rejecting = adapterFor(rejectFixture, { sessions: rejectSessions, agents: rejectAgents, approval: { async request() { return "rejected"; } } });
  await liveTurn(rejecting, rejectFixture, "s1", options("s1", [user("u1", "run a command")]), async server => {
    server.ask(12, "item/fileChange/requestApproval", { threadId: server.threadId, turnId: server.turnId, reason: "writes" });
    await waitFor(() => server.responded?.length > 0, "approval response");
    server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: { type: "agentMessage", phase: "final_answer", text: "declined" } });
    server.notify("turn/completed", { threadId: server.threadId, turn: { id: server.turnId, status: "completed" } });
  });
  assert.deepEqual(sessionServer(rejectFixture.hub).responded, [{ id: 12, result: { decision: "decline" } }]);
});

test("maps permissions requests onto turn-scoped DSH approvals", async t => {
  const fixture = setup("dsh-provider-permissions-");
  t.after(() => { cleanup(fixture); return fixture.backend.close(); });
  const sessions = new Map([["s1", { header: { cwd: fixture.cwd } }]]);
  const agents = new Map([["s1", { id: "s1", session: sessions.get("s1") }]]);
  const prompts = [];
  const approval = { async request(request) { prompts.push(request); return prompts.length === 1 ? "allowed-once" : "rejected"; } };
  const adapter = adapterFor(fixture, { sessions, agents, approval });
  await liveTurn(adapter, fixture, "s1", options("s1", [user("u1", "need network")]), async server => {
    server.ask(31, "item/permissions/requestApproval", {
      threadId: server.threadId, turnId: server.turnId, itemId: "p1", environmentId: null, startedAtMs: 1,
      cwd: fixture.cwd, reason: "network access", permissions: { network: { enabled: true }, fileSystem: null },
    });
    await waitFor(() => server.responded?.length > 0, "permissions approval");
    server.ask(32, "item/permissions/requestApproval", {
      threadId: server.threadId, turnId: server.turnId, itemId: "p2", environmentId: null, startedAtMs: 2,
      cwd: fixture.cwd, reason: "write access", permissions: { network: null, fileSystem: { read: [fixture.cwd], write: [fixture.cwd] } },
    });
    await waitFor(() => server.responded?.length > 1, "second permissions approval");
    server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: { type: "agentMessage", phase: "final_answer", text: "checked" } });
    server.notify("turn/completed", { threadId: server.threadId, turn: { id: server.turnId, status: "completed" } });
  });
  assert.deepEqual(prompts.map(prompt => prompt.toolName), ["codex:permissions", "codex:permissions"]);
  assert.equal(prompts[0].reason, "network access");
  assert.deepEqual(sessionServer(fixture.hub).responded, [
    { id: 31, result: { permissions: { network: { enabled: true }, fileSystem: null }, scope: "turn" } },
    { id: 32, result: { permissions: {}, scope: "turn" } },
  ]);
});

test("maps native user-input requests onto DSH structured questions", async t => {
  const fixture = setup("dsh-provider-userinput-");
  t.after(() => { cleanup(fixture); return fixture.backend.close(); });
  const sessions = new Map([["s1", { header: { cwd: fixture.cwd } }]]);
  const agents = new Map([["s1", { id: "s1", session: sessions.get("s1") }]]);
  const asked = [];
  const questions = { async ask(request) { asked.push(request); return { answers: [{ id: "q1", selected: ["Yes"], custom: "note" }] }; } };
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
  assert.equal(asked.length, 1);
  assert.equal(asked[0].agent.id, "s1");
  assert.deepEqual(asked[0].questions, [{
    id: "q1", header: "Pick", question: "Proceed?",
    options: [{ label: "Yes", description: "go" }, { label: "No", description: "stop" }],
  }]);
  assert.deepEqual(sessionServer(fixture.hub).responded, [
    { id: 41, result: { answers: { q1: { answers: ["Yes", "note"] } } } },
  ]);
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
  const prompts = [];
  const adapter = adapterFor(fixture, { sessions, agents, approval: { async request(request) { prompts.push(request); return "allowed-once"; } } });

  const child = collect(adapter.stream(options("child-a", [user("u1", "child work")])));
  await waitFor(() => fixture.hub.servers.some(server => server.calls?.some(call => call.method === "turn/start")), "child turn/start");
  const childServer = fixture.hub.servers.find(server => server.calls?.some(call => call.method === "turn/start"));
  await waitFor(async () => (await fixture.backend.readSession(OWNER, "codex:child-a"))?.turnId === childServer.turnId, "child turn identity");

  const childEvents = (await fixture.backend.readEvents(OWNER, "codex:child-a")).length;
  childServer.ask(99, "item/commandExecution/requestApproval", { threadId: "native-child-thread", turnId: "native-child-turn" });
  childServer.notify("item/agentMessage/delta", { threadId: "native-child-thread", turnId: "native-child-turn", delta: "foreign" });
  assert.deepEqual(childServer.rejected, [{ id: 99, message: "Unknown Session thread" }], "native child approvals are rejected fail-closed");
  assert.equal((await fixture.backend.readEvents(OWNER, "codex:child-a")).length, childEvents, "native child events never enter the DSH child record");

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
  assert.equal(prompts.length, 0, "legacy worker approvals never leak into the provider approval seam");

  childServer.ask(11, "item/commandExecution/requestApproval", { threadId: childServer.threadId, turnId: childServer.turnId, command: "ls" });
  await waitFor(() => prompts.length === 1, "child approval");
  assert.equal(prompts[0].agent.id, "child-a");
  childServer.notify("item/completed", { threadId: childServer.threadId, turnId: childServer.turnId, item: { type: "agentMessage", phase: "final_answer", text: "child done" } });
  childServer.notify("turn/completed", { threadId: childServer.threadId, turn: { id: childServer.turnId, status: "completed" } });
  const chunks = await child;
  assert.equal(chunks.at(-1).reason.kind, "stop");
  assert.equal((await fixture.backend.readEvents(OWNER, "codex:child-a")).some(item => item.event.type === "report.ready"), false, "the DSH child stays outside the worker report path");
});

test("compacts the native thread and rebuilds it before the DSH summary", async t => {
  const fixture = setup("dsh-provider-compact-");
  t.after(() => { cleanup(fixture); return fixture.backend.close(); });
  const sessions = new Map([["s1", { header: { cwd: fixture.cwd } }]]);
  const adapter = adapterFor(fixture, { sessions });
  await liveTurn(adapter, fixture, "s1", options("s1", [user("u1", "first")]), async server => {
    server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: { type: "agentMessage", phase: "final_answer", text: "Hello" } });
    server.notify("turn/completed", { threadId: server.threadId, turn: { id: server.turnId, status: "completed" } });
  });
  const main = sessionServer(fixture.hub);
  const oldThread = main.threadId;

  const done = collect(adapter.stream(options("s1", [user("u1", "first"), user("t1", "summarize")], { purpose: "compaction" })));
  await waitFor(() => main.calls?.some(call => call.method === "thread/compact/start"), "compact start");
  main.notify("turn/started", { threadId: oldThread, turn: { id: "compact-turn" } });
  main.notify("turn/completed", { threadId: oldThread, turn: { id: "compact-turn", status: "completed" } });
  await waitFor(() => (main.closed ?? 0) >= 1, "old runtime closed");
  await waitFor(() => fixture.hub.servers.some(server => server !== main && server.calls?.some(call => call.method === "thread/start")), "rebuilt thread");
  const rebuilt = fixture.hub.servers.find(server => server !== main && server.calls?.some(call => call.method === "thread/start"));
  await waitFor(async () => (await fixture.backend.readSession(OWNER, "codex:s1"))?.threadId === rebuilt.threadId, "rebuilt identity");
  assert.notEqual(rebuilt.threadId, oldThread, "the rebuilt Session never reuses the compacted thread");

  const doneSummary = await (async () => {
    await waitFor(() => fixture.hub.servers.some(server => server !== main && server !== rebuilt && server.calls?.some(call => call.method === "thread/start")), "auxiliary thread");
    const aux = fixture.hub.servers.find(server => server !== main && server !== rebuilt && server.calls?.some(call => call.method === "thread/start"));
    await waitFor(() => aux.calls.some(call => call.method === "turn/start"), "auxiliary turn/start");
    await waitFor(async () => (await fixture.backend.listSessions(OWNER)).some(record => record.threadId === aux.threadId && record.turnId === aux.turnId), "auxiliary turn identity");
    aux.notify("item/completed", { threadId: aux.threadId, turnId: aux.turnId, item: { type: "agentMessage", phase: "final_answer", text: "Summary" } });
    aux.notify("turn/completed", { threadId: aux.threadId, turn: { id: aux.turnId, status: "completed" } });
    return done;
  })();
  const chunks = await doneSummary;
  assert.equal(chunks.find(chunk => chunk.type === "block-end").block.text, "Summary");
  assert.equal(chunks.at(-1).reason.kind, "stop");

  const next = collect(adapter.stream(options("s1", [
    user("u1", "first"),
    assistant("a1", "Summary", "codex", { response: { threadId: oldThread, turnId: "turn-1", input: "u1" } }),
    user("u2", "second"),
  ])));
  await waitFor(() => rebuilt.calls.filter(call => call.method === "turn/start").length === 1, "rebuilt turn/start");
  await waitFor(async () => (await fixture.backend.readSession(OWNER, "codex:s1"))?.turnId === rebuilt.turnId, "rebuilt turn identity");
  rebuilt.notify("item/completed", { threadId: rebuilt.threadId, turnId: rebuilt.turnId, item: { type: "agentMessage", phase: "final_answer", text: "Again" } });
  rebuilt.notify("turn/completed", { threadId: rebuilt.threadId, turn: { id: rebuilt.turnId, status: "completed" } });
  assert.equal((await next).at(-1).reason.kind, "stop");
  assert.equal((await fixture.backend.readSession(OWNER, "codex:s1")).threadId, rebuilt.threadId, "the rebuilt thread serves the next turn");
  const turnStart = rebuilt.calls.find(call => call.method === "turn/start");
  assert.equal(turnStart.params.input.length, 2, "the rebuilt thread imports the post-compaction visible history");
  assert.match(turnStart.params.input[0].text, /^\[DSH history import/);
  assert.equal(turnStart.params.input[1].text, "second");
});

test("abort cancels pending approvals, interrupts the turn, and settles interrupted", async t => {
  const fixture = setup("dsh-provider-abort-");
  t.after(() => { cleanup(fixture); return fixture.backend.close(); });
  const sessions = new Map([["s1", { header: { cwd: fixture.cwd } }]]);
  const agents = new Map([["s1", { id: "s1", session: sessions.get("s1") }]]);
  let prompt;
  const adapter = adapterFor(fixture, { sessions, agents, approval: { request(request) { prompt = request; return new Promise(resolve => request.signal.addEventListener("abort", () => resolve("cancelled"))); } } });
  const controller = new AbortController();
  const done = collect(adapter.stream(options("s1", [user("u1", "run")], { signal: controller.signal })));
  await waitFor(() => fixture.hub.servers.some(server => server.calls?.some(call => call.method === "turn/start")), "turn/start");
  const server = fixture.hub.servers.find(server => server.calls?.some(call => call.method === "turn/start"));
  await waitFor(async () => (await fixture.backend.readSession(OWNER, "codex:s1"))?.turnId === server.turnId, "turn identity");
  server.ask(21, "item/commandExecution/requestApproval", { threadId: server.threadId, turnId: server.turnId, command: "rm -rf x" });
  await waitFor(() => prompt !== undefined, "approval prompt");
  controller.abort();
  const chunks = await done;
  assert.equal(chunks.at(-1).type, "finish");
  assert.equal(chunks.at(-1).reason.kind, "aborted");
  assert.equal(prompt.signal.aborted, true);
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
  assert.equal(start.approvalPolicy, "never");
  assert.equal(start.config.permissions["dsh-task"].filesystem[fixture.cwd], "write");
  const stored = await fixture.backend.readSession(OWNER, "codex:child");
  assert.deepEqual(stored.options.boundary, execution.boundary);
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
  assert.equal(start.config.permissions["dsh-task"].filesystem[fixture.cwd], "write");
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

test("a lane-scoped workflow boundary is converted to the child Session workspace", async t => {
  const fixture = setup("dsh-provider-lane-");
  const lane = mkdtempSync(join(tmpdir(), "dsh-provider-lane-path-"));
  t.after(async () => { await fixture.backend.close(); cleanup(fixture); rmSync(lane, { recursive: true, force: true }); });
  const execution = { developerInstructions: "Role A", boundary: { cwd: lane, writableRoots: [lane], network: "loopback" } };
  fixture.hub.threadResult = { cwd: fixture.cwd, approvalPolicy: "never", sandbox: {
    type: "workspaceWrite", writableRoots: [], networkAccess: true, excludeSlashTmp: true, excludeTmpdirEnvVar: true } };
  const session = { id: "child", header: { cwd: fixture.cwd } };
  const agent = { session, options: { model: "luna", reasoningEffort: "high", execution } };
  const adapter = adapterFor(fixture, { sessions: new Map([["child", session]]), agents: new Map([["child", agent]]) });
  await liveTurn(adapter, fixture, "child", options("child", [user("u1", "task")], { execution }), async server => {
    server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: { type: "agentMessage", phase: "final_answer", text: "done" } });
    server.notify("turn/completed", { threadId: server.threadId, turn: { id: server.turnId, status: "completed" } });
  });
  const start = sessionServer(fixture.hub).calls.find(call => call.method === "thread/start").params;
  const filesystem = start.config.permissions["dsh-task"].filesystem;
  assert.equal(start.cwd, fixture.cwd, "the native thread runs in the Session workspace, not the lane");
  assert.equal(filesystem[fixture.cwd], "write", "the Session workspace is writable");
  assert.equal(filesystem[lane], undefined, "the lane path never becomes a sandbox root");
  assert.equal(start.config.permissions["dsh-task"].network.enabled, true, "the requested network policy is preserved");
  assert.deepEqual((await fixture.backend.readSession(OWNER, "codex:child")).options.boundary,
    { cwd: fixture.cwd, writableRoots: [fixture.cwd], network: "loopback" });
  // Only the workspace scope is rewritten: an explicit network change still conflicts.
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
  assert.equal(resumed[0].params.config.permissions["dsh-task"].filesystem[fixture.cwd], "write");
});

test("projects recorded native items from the provider store and never appends execution facts to the session log", async t => {
  const fixture = setup("dsh-provider-facts-");
  t.after(async () => { await fixture.backend.close(); cleanup(fixture); });
  const appended = [];
  const session = { id: "s1", header: { cwd: fixture.cwd }, append: (...args) => appended.push(args), snapshotEvents: () => [] };
  const adapter = adapterFor(fixture, { sessions: new Map([["s1", session]]) });
  await liveTurn(adapter, fixture, "s1", options("s1", [user("u1", "record facts")]), async server => {
    server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: { id: "i1", type: "commandExecution", command: "pnpm test", exitCode: 0, aggregatedOutput: "3 passed" } });
    server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: { id: "i2", type: "reasoning", summary: ["internal"] } });
    server.notify("item/completed", { threadId: server.threadId, turnId: server.turnId, item: { type: "agentMessage", phase: "final_answer", text: "done" } });
    server.notify("turn/completed", { threadId: server.threadId, turn: { id: server.turnId, status: "completed" } });
  });
  assert.deepEqual(appended, [], "execution facts are never written to the DSH session log on stock core");
  const record = await fixture.backend.readSession(OWNER, "codex:s1");
  assert.deepEqual(await adapter.facts("s1"), [
    `[source: codex thread=${record.threadId} turn=${record.turnId} item=i1] command: pnpm test (exit 0)`,
    `[source: codex thread=${record.threadId} turn=${record.turnId} item=i1] 3 passed`,
  ], "only executed facts cross, each with its durable item identity");
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

test("implicit writable cwd does not admit extra roots, changed cwd, network or approval", async t => {
  for (const mismatch of ["roots", "cwd", "network", "approval", "tmp"]) {
    const fixture = setup(`dsh-provider-boundary-${mismatch}-`);
    t.after(async () => { await fixture.backend.close(); cleanup(fixture); });
    const execution = { boundary: { cwd: fixture.cwd, writableRoots: [fixture.cwd], network: "disabled" } };
    fixture.hub.threadResult = { cwd: mismatch === "cwd" ? "/unexpected" : fixture.cwd,
      approvalPolicy: mismatch === "approval" ? "on-request" : "never", sandbox: {
        type: "workspaceWrite", writableRoots: mismatch === "roots" ? ["/unexpected"] : [],
        networkAccess: mismatch === "network", excludeSlashTmp: mismatch !== "tmp", excludeTmpdirEnvVar: true,
      } };
    const session = { id: "child", header: { cwd: fixture.cwd } };
    const agent = { session, options: { model: "luna", reasoningEffort: "high", execution } };
    const adapter = adapterFor(fixture, { sessions: new Map([["child", session]]), agents: new Map([["child", agent]]) });
    await assert.rejects(collect(adapter.stream(options("child", [user("u1", "must not send")], { execution }))), /requested execution boundary/);
    assert.equal(fixture.hub.servers.flatMap(server => server.calls).filter(call => call.method === "turn/start").length, 0);
    assert.equal((await fixture.backend.readSession(OWNER, "codex:child")).state, "unknown");
  }
});
