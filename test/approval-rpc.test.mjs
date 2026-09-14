import assert from "node:assert/strict";
import test from "node:test";

import { installApprovalRpc } from "../lib/approval-rpc.js";

/** One authenticated channel call through the route the plugin registered. */
async function call(route, method, payload, { rpcId = "r1", path, headers = { "content-type": "application/json" } } = {}) {
  const body = Buffer.from(JSON.stringify({ type: "client-request", rpcId, method, payload }));
  const request = {
    url: path ?? `/codex-approval/${method}`,
    method: "POST",
    headers: { ...headers, "content-length": String(body.byteLength) },
    [Symbol.asyncIterator]: async function* () { yield body; },
  };
  let status, responseBody;
  const response = { writeHead(value) { status = value; }, end(value) { responseBody = value; } };
  await route.handler(request, response);
  const text = responseBody === undefined ? undefined : String(responseBody);
  return { status, text, body: text === undefined || !text.startsWith("{") ? undefined : JSON.parse(text) };
}

/**
 * A backend stub holding one pending native approval on `codex:parent`.
 *
 * The channel defers every state check to the backend, so the stub records what
 * it was asked to do instead of re-implementing the state machine.
 */
function harness({ reject } = {}) {
  const routes = [], decisions = [];
  const state = { interactive: false };
  const pending = [{ requestId: "req-1", sessionId: "codex:parent", threadId: "thread-1", turnId: "turn-1",
    method: "item/commandExecution/requestApproval", params: { command: "ls" } }];
  const backend = {
    readSession: async (_owner, id) => (id === "codex:parent" ? { sessionId: id } : undefined),
    pendingApprovals: async (_owner, id) => (id === "codex:parent"
      ? pending.filter(request => !decisions.some(decision => decision.requestId === request.requestId)) : []),
    decideApproval: async (_owner, requestId, decision) => {
      if (!pending.some(request => request.requestId === requestId)) throw new Error("Approval no longer pending");
      decisions.push({ requestId, decision });
    },
  };
  const ctx = {
    connection: { requestRejection: () => reject },
    webServer: { register(route) { routes.push(route); return () => {}; } },
    sessions: { get: id => (String(id) === "parent" ? { header: { id: "parent" } } : undefined) },
    get: name => (name === "sessionPersistence" ? { stat: async () => undefined } : undefined),
    effect(fn) { return fn(); },
  };
  return { ctx, backend, routes, state, decisions };
}

test("the approval channel mounts, lists native approvals and applies a real decision", () => {
  const { ctx, backend, routes, state, decisions } = harness();
  const dispose = installApprovalRpc(ctx, backend, state);
  assert.equal(state.interactive, true, "the provider can see that a client can decide");
  const route = routes.find(candidate => candidate.path === "/codex-approval");
  assert.ok(route, "the channel is registered on the injecting Context, not through connection's own registry");
  return (async () => {
    const listed = await call(route, "pending", { sessionId: "parent" });
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body, { type: "server-response", rpcId: "r1", result: { ok: true, value: { approvals: [
      { requestId: "req-1", turnId: "turn-1", method: "item/commandExecution/requestApproval", reason: "ls" }] } } });

    const decided = await call(route, "decide", { sessionId: "parent", requestId: "req-1", decision: "accept" });
    assert.deepEqual(decided.body.result, { ok: true, value: { decided: true } });
    assert.deepEqual(decisions, [{ requestId: "req-1", decision: "accept" }], "the pane's decision reaches the backend, not DSH's approval policy");

    assert.deepEqual((await call(route, "pending", { sessionId: "parent" })).body.result.value.approvals, []);
    const stale = await call(route, "decide", { sessionId: "parent", requestId: "req-1", decision: "accept" });
    assert.equal(stale.body.result.ok, false);
    assert.match(stale.body.result.error.message, /no longer pending/);
    assert.deepEqual(decisions.length, 1, "a repeated or stale decision never applies twice");

    dispose();
    assert.equal(state.interactive, false, "unmounting the channel removes the interactive path");
  })();
});

test("the approval channel refuses unauthenticated, malformed and cross-Session calls", async () => {
  const unauthenticated = harness({ reject: 401 });
  installApprovalRpc(unauthenticated.ctx, unauthenticated.backend, unauthenticated.state);
  const route = unauthenticated.routes[0];
  assert.equal((await call(route, "pending", { sessionId: "parent" })).status, 401);
  assert.deepEqual(unauthenticated.decisions, []);

  const second = harness();
  installApprovalRpc(second.ctx, second.backend, second.state);
  const channel = second.routes[0];
  const decisions = second.decisions;
  // A well-formed but undeclared endpoint is answered with the channel's own
  // error envelope, exactly like the sibling plugin channel; only a path outside
  // the channel is a 404.
  const unknownEndpoint = await call(channel, "delete", {});
  assert.equal(unknownEndpoint.status, 200);
  assert.match(unknownEndpoint.body.result.error.message, /Unknown approval endpoint/);
  const outside = await call(channel, "pending", {}, { path: "/elsewhere/pending" });
  assert.equal(outside.status, 404, "a path outside the channel is not routed");
  const wrongType = await call(channel, "pending", { sessionId: "parent" }, { headers: { "content-type": "text/plain" } });
  assert.equal(wrongType.status, 415);
  const missingSession = await call(channel, "pending", {});
  assert.equal(missingSession.body.result.ok, false);
  assert.match(missingSession.body.result.error.message, /Session address is required/);
  const foreignSession = await call(channel, "pending", { sessionId: "other" });
  assert.equal(foreignSession.body.result.ok, false);
  assert.match(foreignSession.body.result.error.message, /Native Session is unavailable/);
  const unknownDecision = await call(channel, "decide", { sessionId: "parent", requestId: "req-1", decision: "maybe" });
  assert.equal(unknownDecision.body.result.ok, false);
  assert.match(unknownDecision.body.result.error.message, /Unknown approval decision/);
  const overflow = await call(channel, "pending", { sessionId: "parent", extra: true });
  assert.equal(overflow.body.result.ok, false);
  assert.match(overflow.body.result.error.message, /Session address is required/);
  assert.deepEqual(decisions, []);
});
