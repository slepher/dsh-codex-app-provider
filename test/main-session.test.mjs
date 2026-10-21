import assert from "node:assert/strict";
import test from "node:test";

import { CodexProviderAdapter } from "../lib/provider.js";
import { fallbackSelection, retireMainSessionSelection } from "../lib/main-session.js";

const CATALOG = {
  models: [{
    model: "luna", displayName: "Luna",
    supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Low" }, { reasoningEffort: "high", description: "High" }],
    defaultReasoningEffort: "low",
  }],
  model: null,
  effort: null,
};

async function collect(iterable) {
  const out = [];
  for await (const chunk of iterable) out.push(chunk);
  return out;
}

function adapterWith(overrides = {}) {
  return new CodexProviderAdapter({
    backend: { modelSettings: async () => CATALOG, ...overrides.backend },
    sessions: { get: () => ({ header: { cwd: "/work" } }), ...overrides.sessions },
    agents: { get: () => undefined, ...overrides.agents },
    currentCwd: () => "/work",
    logger: { warn() {} },
    providerCwd: "/work",
    allowMainSession: false,
  });
}

/** The stable machine code this provider's failures carry. */
function codeOf(error) {
  return error?.failure?.code ?? error?.code;
}

test("a hidden main-session route still advertises its own catalog", async () => {
  const adapter = adapterWith();
  assert.deepEqual(await adapter.listModels("codex-app"), [], "the composer menu must not see the route");
  const group = await adapter.catalogGroup();
  assert.equal(group.provider, "codex-app");
  assert.equal(group.name, "codex app");
  assert.deepEqual(group.models.map(model => model.id), ["luna"]);
  assert.deepEqual(group.models[0].efforts.map(effort => effort.id), ["low", "high"]);
  assert.equal(group.models[0].defaultEffort, "low");
  const allowed = new CodexProviderAdapter({
    backend: { modelSettings: async () => CATALOG },
    sessions: { get: () => ({ header: { cwd: "/work" } }) },
    agents: { get: () => undefined },
    currentCwd: () => "/work",
    logger: { warn() {} },
    providerCwd: "/work",
    allowMainSession: true,
  });
  assert.equal((await allowed.listModels("codex-app")).length, 1, "an opted-in deployment keeps the route in the menu");
});

test("a top-level Session is refused before any process or backend work", async () => {
  let backendCalls = 0;
  const adapter = adapterWith({ backend: { readSession: async () => { backendCalls += 1; throw new Error("backend reached"); } } });
  await assert.rejects(
    collect(adapter.stream({ provider: "codex-app", sessionId: "s1", model: "luna", messages: [] })),
    error => codeOf(error) === "MAIN_SESSION_DISABLED",
  );
  assert.equal(backendCalls, 0, "the gate runs before the backend is touched");
});

test("an auxiliary call for a top-level Session degrades without a process", async () => {
  const adapter = adapterWith();
  for (const purpose of ["session-title"]) {
    assert.deepEqual(await collect(adapter.stream({ provider: "codex-app", sessionId: "s1", messages: [], purpose })), []);
  }
  await assert.rejects(
    collect(adapter.stream({ provider: "codex-app", sessionId: "s1", messages: [], purpose: "compaction" })),
    error => codeOf(error) === "MAIN_SESSION_DISABLED",
  );
});

test("a managed child passes the gate and reaches the backend", async () => {
  const calls = [];
  const execution = { developerInstructions: "run the lane task", boundary: { cwd: "/lane", writableRoots: ["/lane"], network: "disabled" } };
  const agent = { id: "s1", session: { id: "s1" }, options: { model: "luna", execution } };
  const adapter = adapterWith({
    backend: { readSession: async () => { calls.push("readSession"); throw new Error("backend reached"); } },
    agents: { get: () => agent },
  });
  await assert.rejects(
    collect(adapter.stream({ provider: "codex-app", sessionId: "s1", model: "luna", messages: [], execution })),
    /backend reached/,
  );
  assert.deepEqual(calls, ["readSession"], "the child's request is executed rather than refused");
});

test("the fallback route skips this plugin's own route and prefers the DSH routes", async () => {
  const llm = {
    listProviders: () => [{ id: "codex-app" }, { id: "second" }, { id: "deepseek-account" }],
    listModels: async provider => {
      if (provider === "deepseek-account") return [{ id: "dsh-model" }];
      if (provider === "second") return [{ id: "other-model" }];
      throw new Error("the withdrawn route must not be a candidate");
    },
  };
  assert.deepEqual(await fallbackSelection(llm), { provider: "deepseek-account", model: "dsh-model" });
});

test("retiring the route rewrites the default and open Sessions but not managed children", async () => {
  const appends = [];
  const saved = [];
  const plain = { id: "plain", append: (type, data) => appends.push({ session: "plain", type, data }) };
  const managed = { id: "managed", append: (type, data) => appends.push({ session: "managed", type, data }) };
  const llm = {
    listProviders: () => [{ id: "codex-app" }, { id: "deepseek-account" }],
    listModels: async provider => (provider === "deepseek-account" ? [{ id: "dsh-model" }] : []),
  };
  const deps = {
    llm,
    sessions: { list: () => [plain, managed] },
    agents: { get: id => (id === "managed" ? { options: { execution: { developerInstructions: "lane" } } } : undefined) },
    projections: { stateOf: () => ({ lastUsed: { provider: "deepseek" }, pending: { provider: "codex-app" } }) },
    defaultModel: {
      currentSelection: () => ({ provider: "codex-app", model: "luna" }),
      saveSelection: async next => { saved.push(next); },
    },
    log() {},
  };
  assert.equal(await retireMainSessionSelection(deps), true);
  assert.deepEqual(saved, [{ provider: "deepseek-account", model: "dsh-model" }]);
  assert.deepEqual(appends.map(entry => entry.session), ["plain"], "only a top-level Session is rewritten");
  assert.equal(appends[0].type, "model/selection");
  assert.deepEqual(appends[0].data, { provider: "deepseek-account", model: "dsh-model" });

  // Idempotent: once the selection has moved, a second pass finds nothing.
  deps.projections = { stateOf: () => ({ lastUsed: { provider: "deepseek-account" }, pending: null }) };
  deps.defaultModel = { currentSelection: () => ({ provider: "deepseek-account", model: "dsh-model" }), saveSelection: async () => { throw new Error("no save expected"); } };
  assert.equal(await retireMainSessionSelection(deps), false);
  assert.equal(appends.length, 1);
});

test("retiring reports rather than throws when nothing can replace the route", async () => {
  const messages = [];
  const changed = await retireMainSessionSelection({
    llm: { listProviders: () => [{ id: "codex-app" }], listModels: async () => [] },
    sessions: { list: () => [] },
    log: message => messages.push(message),
  });
  assert.equal(changed, false);
  assert.match(messages.join("\n"), /no other model route/);
});
