import assert from "node:assert/strict";
import test from "node:test";

import { factMessage, factMessages, importedFactIds } from "../lib/facts.js";

const line = (threadId, turnId, itemId, text) => ({ threadId, turnId, itemId, text });

test("fact lines group into one stable message per native item", () => {
  const messages = factMessages([
    line("t1", "turn1", "i1", "[source: codex thread=t1 turn=turn1 item=i1] command: pnpm test (exit 0)"),
    line("t1", "turn1", "i1", "[source: codex thread=t1 turn=turn1 item=i1] 3 passed"),
    line("t1", "turn1", "i2", "[source: codex thread=t1 turn=turn1 item=i2] file change: src/a.ts (update)"),
  ]);
  assert.deepEqual(messages.map(message => message.id), [
    "codex-executed:t1:turn1:i1",
    "codex-executed:t1:turn1:i2",
  ]);
  assert.equal(messages[0].text.split("\n").length, 2);
  assert.match(messages[1].text, /file change/);
});

test("a fact message is plugin-sourced, bounded, and carries no tool-call identity", () => {
  const [fact] = factMessages([line("t1", "turn1", "i1", `[source: codex thread=t1 turn=turn1 item=i1] command: ${"x".repeat(200)}`)]);
  const message = factMessage(fact);
  assert.equal(message.id, "codex-executed:t1:turn1:i1");
  assert.equal(message.role, "user");
  assert.deepEqual(message.content.map(block => block.type), ["text"]);
  assert.equal(message.source.kind, "dsh-codex-app-provider");
  assert.equal(message.source.form, "notice");
  assert.ok(message.source.summary.length <= 120, "the collapsed account respects the core bound");
  assert.doesNotMatch(message.source.summary, /\n/, "the account is one line");
  assert.equal("toolCallId" in message.content[0], false);
});

test("imported fact identities are read back from the session log", () => {
  const ids = importedFactIds([
    { type: "user/message", data: { id: "codex-executed:t1:turn1:i1" } },
    { type: "user/message", data: { id: "human-message" } },
    { type: "assistant/message", data: { id: "codex-executed:t1:turn1:i2" } },
    { type: "user/message", data: {} },
  ]);
  assert.deepEqual([...ids], ["codex-executed:t1:turn1:i1"]);
  assert.deepEqual([...importedFactIds(undefined)], [], "a Session without a snapshot imports nothing as already done");
});
