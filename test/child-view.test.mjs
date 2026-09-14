import assert from "node:assert/strict";
import test from "node:test";

import { createChildViews, reduceChildJournal } from "../lib/client/child-view.js";

const event = (type, seq, data) => ({ type: "event", event: { type, seq, time: seq, data } });
const transient = (attemptId, chunk) => ({ type: "transient", event: { type: "assistant/live-chunk", seq: 0, data: { attemptId, chunk } } });

test("the journal fold keeps public text and drops reasoning and framing", () => {
  const snapshot = reduceChildJournal([
    event("turn/start", 1, { turn: 1 }),
    event("user/message", 2, { id: "u1", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "do it" }] }),
    event("user/message", 3, { id: "f1", role: "user", source: { kind: "plugin", plugin: "dsh-codex-app-provider", form: "notice" },
      content: [{ type: "text", text: "[source: codex thread=t turn=1 item=i1] command: ls (exit 0)" }] }),
    event("assistant/message", 4, { turn: 1, step: 1, message: { id: "a1", role: "assistant",
      source: { kind: "model", provider: "codex" }, content: [{ type: "text", text: "visible" }, { type: "reasoning", text: "hidden" }] } }),
    event("tool/result", 5, { turn: 1, step: 1, callId: "c1", message: { content: [{ type: "text", text: "tool out" }], source: { kind: "tool", callId: "c1" } } }),
    event("turn/end", 6, { turn: 1, reason: { kind: "stop" } }),
  ]);
  assert.deepEqual(snapshot.rows.map(row => [row.role, row.text]), [
    ["user", "do it"],
    ["notice", "[source: codex thread=t turn=1 item=i1] command: ls (exit 0)"],
    ["assistant", "visible"],
    ["tool", "tool out"],
  ]);
  assert.equal(snapshot.running, false);
  assert.equal(JSON.stringify(snapshot).includes("hidden"), false, "hidden reasoning never reaches a row");
});

test("a live streamed prefix renders only until its committed message settles it", () => {
  const streaming = reduceChildJournal([
    event("turn/start", 1, { turn: 1 }),
    transient("attempt-1", { type: "text-delta", index: 0, text: "partial " }),
    transient("attempt-1", { type: "text-delta", index: 0, text: "answer" }),
  ]);
  assert.deepEqual(streaming.rows.map(row => [row.role, row.text, row.streaming === true]), [["assistant", "partial answer", true]]);
  assert.equal(streaming.running, true);

  const settled = reduceChildJournal([
    event("turn/start", 1, { turn: 1 }),
    transient("attempt-1", { type: "text-delta", index: 0, text: "partial " }),
    event("assistant/message", 3, { turn: 1, step: 1, message: { id: "a1", role: "assistant",
      source: { kind: "model", provider: "codex" }, content: [{ type: "text", text: "partial answer" }] } }),
  ]);
  assert.deepEqual(settled.rows.map(row => [row.role, row.text, row.streaming === true]), [["assistant", "partial answer", false]],
    "the committed message supersedes the streamed prefix instead of duplicating it");
});

test("approval rows pair the ask with its decision", () => {
  const asked = reduceChildJournal([event("approval/asked", 1, { id: "req-1", toolName: "codex:commandExecution", reason: "run rm" })]);
  assert.equal(asked.pendingApprovals, 1);
  assert.deepEqual(asked.rows[0].approval, { toolName: "codex:commandExecution", reason: "run rm", pending: true });
  const decided = reduceChildJournal([
    event("approval/asked", 1, { id: "req-1", toolName: "codex:commandExecution", reason: "run rm" }),
    event("approval/decided", 2, { id: "req-1", outcome: "rejected" }),
  ]);
  assert.equal(decided.pendingApprovals, 0);
  assert.equal(decided.rows[0].approval.pending, false);
  assert.equal(decided.rows[0].approval.outcome, "rejected");
});

/** One tab's independent stream, recording everything the pane asked for. */
function port() {
  const calls = [];
  let options;
  const stream = {
    async open(request) { calls.push({ open: request }); },
    async prepend(request) { calls.push({ prepend: request }); },
    restart() { calls.push({ restart: true }); },
    async dispose() { calls.push({ dispose: true }); },
  };
  return { calls, create: (_address, opts) => { options = opts; return stream; }, publish: change => options.publish(change), fail: error => options.failed(error) };
}

function views(p) {
  const sent = [], stopped = [];
  const controller = createChildViews({
    create: p.create,
    prompt: async (address, text, delivery) => { sent.push({ address, text, delivery }); },
    stop: async address => { stopped.push(address); },
  });
  return { controller, sent, stopped };
}

const ADDRESS = { parentSessionId: "parent", childSessionId: "child", mode: "continuable" };

test("each tab drives its own stream, page, repair and draft", async () => {
  const p = port();
  const { controller, sent, stopped } = views(p);
  let latest;
  const handle = controller.attach(ADDRESS, snapshot => { latest = snapshot; });
  assert.deepEqual(p.calls[0], { open: { maxMessages: 50 } }, "opening the pane opens exactly one addressed stream");
  assert.equal(latest.loading, true);

  p.publish({ type: "replace", page: { entries: [event("user/message", 1, { id: "u1", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "hi" }] })], hasMore: true } });
  assert.deepEqual(latest.rows.map(row => row.text), ["hi"]);
  assert.equal(latest.hasMore, true);
  assert.equal(latest.loading, false);

  await handle.loadMore();
  assert.deepEqual(p.calls.find(call => call.prepend !== undefined), { prepend: { beforeSeq: 1, maxMessages: 50 } });
  p.publish({ type: "prepend", entries: [event("user/message", 0, { id: "u0", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "older" }] })], hasMore: false });
  assert.deepEqual(latest.rows.map(row => row.text), ["older", "hi"], "older history prepends in order");
  assert.equal(latest.hasMore, false);

  handle.setDraft("keep me");
  assert.equal(handle.getDraft(), "keep me");
  await handle.send("keep me", "queue");
  assert.deepEqual(sent, [{ address: ADDRESS, text: "keep me", delivery: "queue" }]);
  assert.equal(handle.getDraft(), "", "a delivered prompt clears the draft");
  await handle.stop();
  assert.deepEqual(stopped, [ADDRESS], "stopping asks the parent to interrupt the child");

  p.publish({ type: "append", entry: event("assistant/message", 2, { turn: 1, step: 1, message: { id: "a1", role: "assistant",
    source: { kind: "model", provider: "codex" }, content: [{ type: "text", text: "answer" }] } }) });
  assert.deepEqual(latest.rows.map(row => row.text), ["older", "hi", "answer"]);

  handle.restart();
  assert.equal(p.calls.some(call => call.restart === true), true, "a broken stream can re-baseline itself without a new tab");
});

test("closing a tab releases only its display state and reuses its draft", () => {
  const p = port();
  const { controller } = views(p);
  const first = controller.attach(ADDRESS, () => {});
  first.setDraft("unfinished");
  first.release();
  assert.equal(p.calls.some(call => call.dispose === true), true, "closing disposes the stream");
  assert.equal(p.calls.some(call => call.restart === true || call.dispose === true), true);
  const second = controller.attach(ADDRESS, () => {});
  assert.equal(second.getDraft(), "unfinished", "reopening the same address restores the draft");
  second.release();
});

test("a failed stream is reported instead of presenting a partial transcript", () => {
  const p = port();
  const { controller } = views(p);
  let latest;
  controller.attach(ADDRESS, snapshot => { latest = snapshot; });
  p.publish({ type: "replace", page: { entries: [], hasMore: false } });
  p.fail(new Error("carrier lost"));
  assert.equal(latest.error, "carrier lost");
});
