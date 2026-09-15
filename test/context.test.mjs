import assert from "node:assert/strict";
import test from "node:test";

test("drops DSH-injected context from Codex steps only and keeps task input", async () => {
  const hooks = new Map();
  const projections = { stateOf: () => undefined };
  const ctx = {
    logger: { warn() {} },
    get: name => name === "sessionProjections" ? projections : undefined,
    on(name, callback) { hooks.set(name, callback); return () => hooks.delete(name); },
  };
  const { installCodexContextFilter } = await import("../lib/context.js");
  const dispose = installCodexContextFilter(ctx);
  const preStep = hooks.get("agent/pre-step");
  const injected = [
    { id: "sys", role: "system", content: [{ type: "text", text: "DSH system prompt" }], source: { kind: "plugin", plugin: "@deepseek-ai/dsh-system-prompt" } },
    { id: "agents", role: "user", content: [{ type: "text", text: "AGENTS" }], source: { kind: "agent-instructions", form: "instructions", changes: [] } },
    { id: "catalog", role: "user", content: [{ type: "text", text: "catalog" }], source: { kind: "skill-catalog", form: "catalog", entries: [] } },
    { id: "snapshot", role: "user", content: [{ type: "text", text: "snapshot" }], source: { kind: "plugin", plugin: "@deepseek-ai/dsh-system-prompt", form: "snapshot", sections: [] } },
    // An imported executed fact is shaped exactly like a worker notice, so only
    // its identity distinguishes native work the thread already performed.
    { id: "codex-executed:t1:turn1:i1", role: "user", content: [{ type: "text", text: "executed" }], source: { kind: "plugin", plugin: "dsh-codex-app-provider", form: "notice", summary: "Codex executed: ls" } },
  ];
  const kept = [
    { id: "user", role: "user", content: [{ type: "text", text: "hello" }], source: { kind: "user" } },
    { id: "notice", role: "user", content: [{ type: "text", text: "report" }], source: { kind: "plugin", plugin: "dsh-codex-kit-backend", form: "notice", summary: "1 report" } },
    { id: "checkpoint", role: "user", content: [{ type: "text", text: "summary" }], source: { kind: "plugin", plugin: "compact", compactionId: "c1" } },
    { id: "invoked-skill", role: "user", content: [{ type: "text", text: "skill body" }], source: { kind: "skill-invocation", name: "demo", form: "instructions" } },
  ];
  const codex = { id: "codex", options: { provider: "codex" }, session: { id: "s1" } };
  const decision = await preStep({ agent: codex, signal: new AbortController().signal }, async () => ({ kind: "enter", messages: [...injected, ...kept] }));
  assert.deepEqual(decision.messages.map(message => message.id), ["user", "notice", "checkpoint", "invoked-skill"]);

  const other = { id: "other", options: { provider: "deepseek" }, session: { id: "s2" } };
  const untouched = await preStep({ agent: other, signal: new AbortController().signal }, async () => ({ kind: "enter", messages: [...injected, ...kept] }));
  assert.equal(untouched.messages.length, 9, "other providers keep their injected context");
  const sameArray = untouched.messages;

  projections.stateOf = () => ({ lastUsed: null, pending: { provider: "codex", model: "x" } });
  const pending = await preStep({ agent: other, signal: new AbortController().signal }, async () => ({ kind: "enter", messages: [...injected, ...kept] }));
  assert.deepEqual(pending.messages.map(message => message.id), ["user", "notice", "checkpoint", "invoked-skill"], "a pending Codex selection wins over the configured route");

  const rejected = await preStep({ agent: codex, signal: new AbortController().signal }, async () => ({ kind: "reject" }));
  assert.equal(rejected.kind, "reject");
  assert.equal(sameArray.includes(injected[0]), true, "non-Codex decisions keep their exact messages");
  dispose();
  assert.equal(hooks.has("agent/pre-step"), false);
});
