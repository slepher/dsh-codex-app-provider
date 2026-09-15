import assert from "node:assert/strict";
import test from "node:test";
import { projectExecutionFacts, reduceExecutionEvents } from "../lib/execution-events.js";

/** One recorded backend event with the durable sequence the provider store keeps. */
const recorded = (sequence, event) => ({ sequence, event });

test("Codex tool facts replay once across the whole session transcript and keep reasoning private", () => {
  const started = { type: "thread.notification", method: "item/started", params: { threadId: "thread-a", turnId: "turn-a", item: { id: "tool-a", type: "commandExecution", command: "echo safe", status: "inProgress" } } };
  const delta = { type: "thread.notification", method: "item/commandExecution/outputDelta", params: { threadId: "thread-a", turnId: "turn-a", itemId: "tool-a", delta: "safe\n" } };
  const events = [
    recorded(1, started), recorded(2, delta), recorded(2, delta),
    recorded(3, { ...delta, params: { ...delta.params, turnId: "old-turn" } }),
    recorded(4, { ...delta, params: { ...delta.params, threadId: "other-thread" } }),
    recorded(5, { ...started, params: { ...started.params, item: { id: "reasoning", type: "reasoning", text: "private" } } }),
  ];
  const reduced = reduceExecutionEvents(events);
  assert.equal(reduced.length, 4, "every recorded item crosses once across the session transcript");
  assert.deepEqual(reduced.map(data => `${data.threadId}/${data.turnId}`),
    ["thread-a/turn-a", "thread-a/turn-a", "thread-a/old-turn", "other-thread/turn-a"]);
  assert.deepEqual(reduceExecutionEvents(events), reduced, "the projection is a pure function of the recorded events");
  assert.equal(JSON.stringify(reduced).includes("private"), false, "model-authored reasoning text never crosses");
  const completed = recorded(6, { ...started, method: "item/completed", params: { ...started.params, item: { ...started.params.item, status: "completed", aggregatedOutput: "safe\n", exitCode: 0 } } });
  assert.equal(reduceExecutionEvents([...events, completed]).length, 5);
});

test("unfinished item statuses follow only the bound terminal turn and retain uncertainty", () => {
  const started = id => recorded(id === "one" ? 1 : 2, { type: "thread.notification", method: "item/started", params: { threadId: "thread", turnId: "turn", item: { id, type: "commandExecution", command: id, status: "inProgress" } } });
  const otherTurn = recorded(3, { type: "turn.state", turn: { threadId: "thread", turnId: "other-turn", state: "interrupted" } });
  assert.equal(reduceExecutionEvents([started("one"), started("two"), otherTurn]).length, 2, "a terminal turn never resolves another turn's items");
  const uncertain = recorded(4, { type: "session.uncertain", error: "lost connection" });
  const facts = reduceExecutionEvents([started("one"), started("two"), otherTurn, uncertain]);
  assert.equal(facts.length, 4);
  assert.ok(facts.slice(2).every(data => data.params.status === "unknown"), "an uncertain session reports every unfinished item as unknown");
  assert.deepEqual(reduceExecutionEvents([started("one"), started("two"), otherTurn, uncertain, uncertain]), facts, "one backend sequence may update each item once");
  const resolved = reduceExecutionEvents([started("one"), started("two"), otherTurn, uncertain,
    recorded(5, { type: "turn.state", turn: { threadId: "thread", turnId: "turn", state: "interrupted" } })]);
  assert.equal(resolved.length, 6, "an unknown item stays pending until its own turn ends");
});

// Sourced history for continuation under another provider adapter.
test("projects recorded native items into sourced facts without model-authored text", () => {
  const event = (method, item, itemId = "i1", turnId = "t1") => ({ threadId: "th1", turnId, itemId, backendSequence: 1, method, params: { threadId: "th1", turnId, item } });
  const lines = projectExecutionFacts([
    event("item/completed", { id: "i1", type: "commandExecution", command: "pnpm test", cwd: "/w", exitCode: 0, aggregatedOutput: "12 passed" }),
    event("item/completed", { id: "i2", type: "fileChange", changes: [{ path: "src/a.ts", kind: { type: "update" } }] }, "i2"),
    event("item/completed", { id: "i3", type: "reasoning", summary: ["thinking about the design"] }, "i3"),
    event("item/completed", { id: "i5", type: "mcpToolCall", server: "repo", tool: "search", result: { hits: 2 } }, "i5", "t2"),
    event("item/started", { id: "i6", type: "commandExecution", command: "pnpm build" }, "i6", "t2"),
    { threadId: "th1", turnId: "t2", itemId: "i6", backendSequence: 6, method: "item/status", params: { threadId: "th1", turnId: "t2", itemId: "i6", status: "interrupted" } },
  ].map((entry, index) => ({ ...entry, backendSequence: index + 1 })));
  assert.deepEqual(lines.map(line => line.text), [
    "[source: codex thread=th1 turn=t1 item=i1] command: pnpm test (exit 0, cwd /w)",
    "[source: codex thread=th1 turn=t1 item=i1] 12 passed",
    "[source: codex thread=th1 turn=t1 item=i2] file change: src/a.ts (update)",
    "[source: codex thread=th1 turn=t2 item=i5] tool repo/search: {\"hits\":2}",
    "[source: codex thread=th1 turn=t2 item=i6] item i6 ended as interrupted",
  ], "reasoning stays out and an unfinished item reports only its terminal status");
  assert.deepEqual(lines[0], { text: lines[0].text, threadId: "th1", turnId: "t1", itemId: "i1" });
});

test("shortens long output and names the durable item that holds it", () => {
  const lines = projectExecutionFacts([{ threadId: "th1", turnId: "t1", itemId: "i1", backendSequence: 1, method: "item/completed",
    params: { threadId: "th1", turnId: "t1", item: { id: "i1", type: "commandExecution", command: "run", exitCode: 1, aggregatedOutput: "x".repeat(2000) } } }]);
  assert.equal(lines.length, 2);
  assert.match(lines[1].text, /truncated; full output at codex thread=th1 turn=t1 item=i1/);
  assert.ok(lines[1].text.length < 900);
});
