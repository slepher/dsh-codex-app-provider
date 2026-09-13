import assert from "node:assert/strict";
import test from "node:test";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { createExecutionEventWriter } from "../lib/execution-events.js";

test("Codex tool facts remain informational and replay once for the exact thread/turn", () => {
  const session = Session.create(SessionId("external-events"));
  const write = createExecutionEventWriter(session, "thread-a", "turn-a");
  const started = { type: "thread.notification", method: "item/started", params: { threadId: "thread-a", turnId: "turn-a", item: { id: "tool-a", type: "commandExecution", command: "echo safe", status: "inProgress" } } };
  const delta = { type: "thread.notification", method: "item/commandExecution/outputDelta", params: { threadId: "thread-a", turnId: "turn-a", itemId: "tool-a", delta: "safe\n" } };
  write(started, 1); write(delta, 2); write(delta, 2);
  write({ ...delta, params: { ...delta.params, turnId: "old-turn" } }, 3);
  write({ ...delta, params: { ...delta.params, threadId: "other-thread" } }, 4);
  write({ ...started, params: { ...started.params, item: { id: "reasoning", type: "reasoning", text: "private" } } }, 5);
  assert.equal(session.snapshotEvents().length, 2);
  assert.deepEqual(session.deriveMessages(), []);
  assert.ok(session.snapshotEvents().every(event => event.type === "codex/execution" && event.ignorable === true));
  const resumed = createExecutionEventWriter(session, "thread-a", "turn-a"); resumed(started, 1); resumed(delta, 2);
  assert.equal(session.snapshotEvents().length, 2);
  resumed({ ...started, method: "item/completed", params: { ...started.params, item: { ...started.params.item, status: "completed", aggregatedOutput: "safe\n", exitCode: 0 } } }, 6);
  assert.equal(session.snapshotEvents().length, 3);
  assert.deepEqual(session.deriveMessages(), []);
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
  const session = Session.create(SessionId("public-summary"));
  const write = createExecutionEventWriter(session, "thread", "turn");
  const params = { threadId: "thread", turnId: "turn", itemId: "reason", delta: "Public", summaryIndex: 0, content: "PRIVATE" };
  write({ type: "thread.notification", method: "item/started", params: { threadId: "thread", turnId: "turn", item: { id: "reason", type: "reasoning", summary: [], content: ["PRIVATE"] } } }, 0);
  write({ type: "thread.notification", method: "item/reasoning/textDelta", params }, 1);
  write({ type: "thread.notification", method: "item/reasoning/summaryTextDelta", params }, 2);
  write({ type: "thread.notification", method: "item/reasoning/summaryTextDelta", params: { ...params, delta: " summary" } }, 3);
  write({ type: "thread.notification", method: "item/completed", params: { threadId: "thread", turnId: "turn", item: { id: "reason", type: "reasoning", summary: ["Public summary"], content: ["PRIVATE"] } } }, 4);
  const events = session.snapshotEvents();
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
  assert.deepEqual(session.deriveMessages(), []);
  const interrupted = JSON.stringify(ExecutionNode({ node: { ...node, data: { ...node.data, status: "interrupted" } }, useTurnData: () => undefined, t: key => key }));
  assert.match(interrupted, /reasoningSummary.*executionInterrupted/);
});

test("unfinished item statuses follow only the bound terminal turn and retain uncertainty", async () => {
  const { executionDefinition: definition } = await import("../lib/client/ExecutionNode.js");
  const session = Session.create(SessionId("terminal-items"));
  const write = createExecutionEventWriter(session, "thread", "turn");
  for (const [index, id] of ["one", "two"].entries()) write({ type: "thread.notification", method: "item/started", params: { threadId: "thread", turnId: "turn", item: { id, type: "commandExecution", command: id, status: "inProgress" } } }, index + 1);
  write({ type: "turn.state", turn: { threadId: "thread", turnId: "other-turn", state: "interrupted" } }, 3);
  assert.equal(session.snapshotEvents().length, 2);
  write({ type: "session.uncertain", error: "lost connection" }, 4);
  const facts = session.snapshotEvents();
  assert.equal(facts.length, 4);
  assert.ok(facts.slice(2).every(event => event.data.params.status === "unknown"));
  const resumed = createExecutionEventWriter(session, "thread", "turn");
  resumed({ type: "session.uncertain", error: "lost connection" }, 4);
  assert.equal(session.snapshotEvents().length, 4, "one backend sequence may update each item once");
  resumed({ type: "turn.state", turn: { threadId: "thread", turnId: "turn", state: "interrupted" } }, 5);
  assert.equal(session.snapshotEvents().length, 6);
  const first = facts[0], context = { key: "one", id: definition.match(first).id, start: { event: first, location: { kind: "session" } } };
  context.state = definition.start(context, context.start);
  for (const event of session.snapshotEvents().slice(2).filter(event => event.data.itemId === "one")) context.state = definition.update(context, { event });
  assert.equal(definition.buildViewNode(context).data.status, "interrupted");
  assert.deepEqual(session.deriveMessages(), []);
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
