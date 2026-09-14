import assert from "node:assert/strict";
import test from "node:test";
import { projectExecutionFacts, reduceExecutionEvents } from "../lib/execution-events.js";

/** One recorded backend event with the durable sequence the provider store keeps. */
const recorded = (sequence, event) => ({ sequence, event });
/** Client-visible form of one reduced fact. */
const visible = data => ({ type: "codex/execution", seq: data.backendSequence, time: data.backendSequence, ignorable: true, data });

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

test("native Conversation fold merges started, output and completed into one execution item", async () => {
  const { executionDefinition: definition } = await import("../lib/client/ExecutionNode.js");
  const params = { threadId: "thread", turnId: "turn", item: { id: "item", type: "commandExecution", command: "printf ok", status: "inProgress" } };
  const event = (seq, method, fields) => ({ type: "codex/execution", seq, time: seq, ignorable: true, data: { threadId: "thread", turnId: "turn", itemId: "item", backendSequence: seq, method, params: fields } });
  const started = event(1, "item/started", params), progress = event(2, "item/commandExecution/outputDelta", { threadId: "thread", turnId: "turn", itemId: "item", delta: "ok" });
  const complete = event(3, "item/completed", { ...params, item: { ...params.item, status: "completed", aggregatedOutput: "ok", exitCode: 0 } });
  const start = { event: started, location: { kind: "session" } };
  const context = { key: "stable", id: definition.match(started).id, start, matches: [start] };
  context.state = definition.start(context, start);
  const first = definition.buildViewNode(context);
  for (const next of [progress, complete]) {
    assert.equal(definition.match(next).id, context.id);
    assert.equal(definition.match(next).role, "update");
    context.state = definition.update(context, { event: next });
  }
  const last = definition.buildViewNode(context);
  assert.equal(first.key, last.key); assert.equal(last.data.output, "ok"); assert.equal(last.data.exitCode, 0);
  assert.equal(last.data.status, "completed"); assert.equal(definition.publication({ event: progress }), "animation-frame");
  assert.equal(definition.match({ type: "tool/call", data: {} }), null);
});

test("public reasoning summary streams and completes without exposing raw reasoning", async () => {
  const { executionDefinition: definition, ExecutionNode } = await import("../lib/client/ExecutionNode.js");
  const params = { threadId: "thread", turnId: "turn", itemId: "reason", delta: "Public", summaryIndex: 0, content: "PRIVATE" };
  const reduced = reduceExecutionEvents([
    recorded(0, { type: "thread.notification", method: "item/started", params: { threadId: "thread", turnId: "turn", item: { id: "reason", type: "reasoning", summary: [], content: ["PRIVATE"] } } }),
    recorded(1, { type: "thread.notification", method: "item/reasoning/textDelta", params }),
    recorded(2, { type: "thread.notification", method: "item/reasoning/summaryTextDelta", params }),
    recorded(3, { type: "thread.notification", method: "item/reasoning/summaryTextDelta", params: { ...params, delta: " summary" } }),
    recorded(4, { type: "thread.notification", method: "item/completed", params: { threadId: "thread", turnId: "turn", item: { id: "reason", type: "reasoning", summary: ["Public summary"], content: ["PRIVATE"] } } }),
  ]);
  const events = reduced.map(visible);
  assert.equal(events.length, 4);
  assert.equal(definition.match(events[0]).role, "start");
  assert.equal(JSON.stringify(events).includes("PRIVATE"), false);
  const context = { key: "summary", id: definition.match(events[0]).id, start: { event: events[0], location: { kind: "session" } } };
  context.state = definition.start(context, context.start);
  assert.equal(context.state.item.text, "");
  assert.equal(definition.buildViewNode(context), null, "empty public summary reserves the native start without a blank card");
  for (const event of events.slice(1)) context.state = definition.update(context, { event });
  const node = definition.buildViewNode(context);
  assert.equal(node.data.text, "Public summary");
  assert.equal(node.data.status, "completed");
  const interrupted = JSON.stringify(ExecutionNode({ node: { ...node, data: { ...node.data, status: "interrupted" } }, useTurnData: () => undefined, t: key => key }));
  assert.match(interrupted, /reasoningSummary.*executionInterrupted/);
});

test("unfinished item statuses follow only the bound terminal turn and retain uncertainty", async () => {
  const { executionDefinition: definition } = await import("../lib/client/ExecutionNode.js");
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
  const events = resolved.map(visible);
  const first = events[0], context = { key: "one", id: definition.match(first).id, start: { event: first, location: { kind: "session" } } };
  context.state = definition.start(context, context.start);
  for (const event of events.slice(2).filter(event => event.data.itemId === "one")) context.state = definition.update(context, { event });
  assert.equal(definition.buildViewNode(context).data.status, "interrupted");
});

test("native Stop renders an unconfirmed request instead of claiming the Codex item terminated", async () => {
  const { executionEndDefinition: definition, ExecutionNode } = await import("../lib/client/ExecutionNode.js");
  const start = { event: { type: "turn/start", data: { turn: 4 } } };
  const context = { state: definition.start({}, start) };
  context.state = definition.update(context, { event: { type: "turn/end", data: { turn: 4, reason: { kind: "aborted", reason: "user" } } } });
  const data = definition.buildLocationData(context, "turn");
  assert.equal(data.turn, 4); assert.equal(data.key, "codex-turn-end");
  assert.equal(definition.buildLocationData(context, "step"), null);
  const props = { node: { data: { kind: "commandExecution", status: "inProgress", text: "sleep 20" } }, useTurnData: key => { assert.equal(key, data.key); return data.value; }, t: key => key };
  const rendered = ExecutionNode(props);
  assert.equal(rendered.props.open, false);
  assert.match(JSON.stringify(rendered), /executionStopRequested/);
  assert.doesNotMatch(JSON.stringify(rendered), /executionInterrupted/);
  props.node.data.status = "completed";
  assert.match(JSON.stringify(ExecutionNode(props)), /executed/);
});

// Sourced history for continuation under another provider adapter.
test("projects recorded native items into sourced facts without model-authored text", async () => {
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

test("shortens long output and names the durable item that holds it", async () => {
  const lines = projectExecutionFacts([{ threadId: "th1", turnId: "t1", itemId: "i1", backendSequence: 1, method: "item/completed",
    params: { threadId: "th1", turnId: "t1", item: { id: "i1", type: "commandExecution", command: "run", exitCode: 1, aggregatedOutput: "x".repeat(2000) } } }]);
  assert.equal(lines.length, 2);
  assert.match(lines[1].text, /truncated; full output at codex thread=th1 turn=t1 item=i1/);
  assert.ok(lines[1].text.length < 900);
});
