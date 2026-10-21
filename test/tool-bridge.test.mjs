import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CodexSessionBackend } from "../lib/backend.js";
import { AppServer } from "../lib/rpc.js";
import { declarationOf, responseOf, selectBridgeTools, ToolBridge } from "../lib/tool-bridge.js";

const fakeServer = fileURLToPath(new URL("./fake-codex-app-server.mjs", import.meta.url));

/** A scoped tool schema in the shape the DSH registry serves. */
function schema(name, description = name) {
  return { name, description, parameters: { type: "object", properties: {}, required: [] } };
}

/** A live-Agent stand-in: only identity and creation options are read here. */
const AGENT = { session: { id: "s1" }, options: {} };

/** One successful DSH tool result carrying plain text. */
const OK = { isError: false, value: null, content: [{ type: "text", text: "tool-ok" }] };

/** A seam that records execution and answers with a fixed result. */
function seam(result = OK) {
  const calls = [];
  return {
    calls,
    schemas: () => [schema("cordis_inspect_list"), schema("plugin_manager"), schema("read")],
    execute: async input => { calls.push(input); return result; },
  };
}

async function waitFor(predicate, timeoutMs = 15_000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

test("selection is the allow ∩ presented ∩ scoped intersection, native-prefixed", () => {
  const tools = selectBridgeTools(
    ["cordis_inspect_list", "plugin_manager", "read", "skill"],
    [schema("cordis_inspect_list"), schema("plugin_manager")],
    [schema("cordis_inspect_list"), schema("plugin_manager"), schema("skill")],
  );
  assert.deepEqual(tools.map(tool => tool.name), ["dsh_cordis_inspect_list", "dsh_plugin_manager"]);
  assert.deepEqual(tools[0].inputSchema, { type: "object", properties: {}, required: [] });
});

test("the declaration fingerprint is order-independent and changes with the schema", () => {
  const left = declarationOf(selectBridgeTools(["read", "skill"], [schema("read"), schema("skill")], [schema("read"), schema("skill")]));
  const right = declarationOf(selectBridgeTools(["skill", "read"], [schema("read"), schema("skill")], [schema("read"), schema("skill")]));
  assert.equal(left.fingerprint, right.fingerprint);
  assert.deepEqual(left.tools.map(tool => tool.name), ["dsh_read", "dsh_skill"]);
  const changed = declarationOf([{ name: "dsh_read", description: "changed", inputSchema: { type: "object" } }]);
  assert.notEqual(changed.fingerprint, left.fingerprint);
});

test("a non-text result fails explicitly instead of reporting success", () => {
  const text = responseOf(OK);
  assert.deepEqual(text, { contentItems: [{ type: "inputText", text: "tool-ok" }], success: true });
  const failed = responseOf({ isError: true, error: { message: "boom" }, content: [{ type: "text", text: "boom" }] });
  assert.equal(failed.success, false);
  const unsupported = responseOf({ isError: false, value: null, content: [{ type: "image", url: "x" }] });
  assert.equal(unsupported.success, false);
  assert.match(unsupported.contentItems[0].text, /image content is not supported/);
});

test("the bridge executes once, replays the settled answer and refuses conflicting arguments", async () => {
  const registry = seam();
  const bridge = new ToolBridge({ seam: registry, options: { enabled: true, allow: ["cordis_inspect_list"], log() {} } });
  const request = { threadId: "t1", turnId: "u1", callId: "c1", tool: "dsh_cordis_inspect_list", arguments: { a: 1 } };
  const first = await bridge.call(request, AGENT, "s1", new AbortController().signal);
  assert.equal(first.success, true);
  assert.equal(registry.calls.length, 1);
  assert.equal(registry.calls[0].name, "cordis_inspect_list");
  assert.equal(registry.calls[0].agent, AGENT);
  const replay = await bridge.call(request, AGENT, "s1", new AbortController().signal);
  assert.deepEqual(replay, first);
  assert.equal(registry.calls.length, 1, "a replayed call identity is not executed twice");
  const conflict = await bridge.call({ ...request, arguments: { a: 2 } }, AGENT, "s1", new AbortController().signal);
  assert.equal(conflict.success, false);
  assert.match(conflict.contentItems[0].text, /different arguments/);
});

test("the bridge refuses a name outside allow and a call with no live Agent", async () => {
  const registry = seam();
  const bridge = new ToolBridge({ seam: registry, options: { enabled: true, allow: ["read"], log() {} } });
  const refused = await bridge.call({ threadId: "t", turnId: "u", callId: "c", tool: "dsh_plugin_manager", arguments: {} }, AGENT, "s", new AbortController().signal);
  assert.equal(refused.success, false);
  assert.match(refused.contentItems[0].text, /not exposed/);
  const unbound = await bridge.call({ threadId: "t", turnId: "u", callId: "c2", tool: "dsh_read", arguments: {} }, undefined, "s", new AbortController().signal);
  assert.equal(unbound.success, false);
  assert.equal(registry.calls.length, 0);
});

test("the declaration is withheld when disabled or when nothing may be exposed", () => {
  const registry = seam();
  const disabled = new ToolBridge({ seam: registry, options: { enabled: false, allow: ["read"], log() {} } });
  assert.equal(disabled.declaration(AGENT, [schema("read")]), undefined);
  const empty = new ToolBridge({ seam: registry, options: { enabled: true, allow: ["skill"], log() {} } });
  assert.equal(empty.declaration(AGENT, [schema("read")]), undefined);
  const selected = new ToolBridge({ seam: registry, options: { enabled: true, allow: ["read"], log() {} } });
  assert.deepEqual(selected.declaration(AGENT, [schema("read")]).tools.map(tool => tool.name), ["dsh_read"]);
});

test("a frozen declaration travels on thread/start and its callback is answered", async t => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-tool-bridge-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const logPath = join(dir, "calls.jsonl"), stateDir = join(dir, "fake-state");
  const backend = new CodexSessionBackend(join(dir, "records"), () => new AppServer({
    command: process.execPath,
    args: [fakeServer],
    env: { DSH_FAKE_CODEX_LOG: logPath, DSH_FAKE_CODEX_STATE: stateDir, DSH_FAKE_CODEX_DYNAMIC: "1" },
  }));
  t.after(() => backend.close());
  const calls = [];
  backend.attachToolBridge({
    call: async (request, sessionId) => {
      calls.push({ request, sessionId });
      return { contentItems: [{ type: "inputText", text: `native:${request.tool}` }], success: true };
    },
  });
  const declaration = declarationOf([{ name: "dsh_cordis_inspect_list", description: "List the inspect providers", inputSchema: { type: "object", properties: {} } }]);
  await backend.createSession("owner", "codex:bridge", process.cwd(), { model: "luna", toolBridge: declaration });
  const events = [];
  const off = backend.subscribe("owner", "codex:bridge", event => { events.push(event); }, { interactive: true });
  t.after(off);
  await backend.startTurn("owner", "codex:bridge", "run the probe");
  await waitFor(() => events.some(event => event.type === "turn.state" && event.turn.state === "completed"));

  const log = readFileSync(logPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
  const started = log.find(entry => entry.method === "thread/start");
  assert.equal(started.params.dynamicTools.length, 1);
  assert.equal(started.params.dynamicTools[0].name, "dsh_cordis_inspect_list");
  assert.equal(started.params.dynamicTools[0].type, "function");
  assert.deepEqual(started.params.dynamicTools[0].inputSchema, { type: "object", properties: {} });
  const resumed = log.find(entry => entry.method === "thread/resume");
  assert.equal(resumed, undefined, "the first request starts the thread");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionId, "bridge", "the callback carries the DSH Session identity, not the native one");
  assert.equal(calls[0].request.tool, "dsh_cordis_inspect_list");
  assert.deepEqual(calls[0].request.arguments, { probe: "turn-1" });
  const answer = log.find(entry => entry.response?.id !== undefined && entry.response.result?.contentItems !== undefined);
  assert.deepEqual(answer.response.result, { contentItems: [{ type: "inputText", text: "native:dsh_cordis_inspect_list" }], success: true });
});
