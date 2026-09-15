import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CodexSessionBackend } from "../lib/backend.js";
import { UncertainError } from "../lib/rpc.js";

class FaultServer extends EventEmitter {
  calls = [];
  responses = [];
  failCreate = false;
  failTurn = false;
  completeBeforeResponse = false;
  turn = 0;
  async connect() {}
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === "thread/start") {
      if (this.failCreate) throw new UncertainError("thread/start timed out");
      return { thread: { id: "thread" } };
    }
    if (method === "turn/start") {
      if (this.failTurn) throw new UncertainError("turn/start timed out");
      const turnId = `turn-${++this.turn}`;
      this.emit("notification", {
        method: "turn/started",
        params: { threadId: "thread", turn: { id: turnId } },
      });
      if (this.completeBeforeResponse) {
        this.emit("notification", {
          method: "item/completed",
          params: {
            threadId: "thread",
            turnId,
            item: { type: "agentMessage", text: "done", phase: "final_answer" },
          },
        });
        this.emit("notification", {
          method: "turn/completed",
          params: { threadId: "thread", turn: { id: turnId, status: "completed" } },
        });
      }
      return { turn: { id: turnId, status: "inProgress" } };
    }
    return {};
  }
  respond(id, result) { this.responses.push({ id, result }); }
  reject(id, message) { this.responses.push({ id, message }); }
  async close() {}
}

test("does not redispatch uncertain creation or turn starts and rejects wrong-thread approvals", async () => {
  const failedDir = mkdtempSync(join(tmpdir(), "dsh-codex-create-failure-"));
  const failedServer = new FaultServer();
  failedServer.failCreate = true;
  const failed = new CodexSessionBackend(failedDir, () => failedServer);
  try {
    await assert.rejects(failed.createSession("owner", "session", "/work"), /uncertain/);
    assert.equal((await failed.createSession("owner", "session", "/work")).state, "unknown");
    assert.equal(failedServer.calls.filter(call => call.method === "thread/start").length, 1);
  } finally {
    await failed.close();
    rmSync(failedDir, { recursive: true });
  }

  const stateDir = mkdtempSync(join(tmpdir(), "dsh-codex-turn-failure-"));
  const server = new FaultServer();
  const backend = new CodexSessionBackend(stateDir, () => server);
  try {
    await backend.createSession("owner", "session", "/work");
    server.completeBeforeResponse = true;
    const completed = await backend.startTurn("owner", "session", "first", { idempotencyKey: "1:1" });
    assert.equal(completed.state, "completed");
    assert.equal((await backend.readReports("owner", "session"))[0].result, "done");

    server.completeBeforeResponse = false;
    const next = await backend.startTurn("owner", "session", "second", { idempotencyKey: "2:1" });
    server.emit("notification", {
      method: "turn/completed",
      params: { threadId: "thread", turn: { id: "older-turn", status: "completed" } },
    });
    assert.equal((await backend.readSession("owner", "session")).state, "running");
    assert.equal((await backend.readReports("owner", "session")).length, 1);
    server.emit("request", {
      id: "wrong",
      method: "item/fileChange/requestApproval",
      params: { threadId: "another-thread", turnId: next.turnId },
    });
    assert.equal((await backend.pendingApprovals("owner", "session")).length, 0);
    assert.deepEqual(server.responses, [{ id: "wrong", message: "Unknown Session thread" }]);

    server.failTurn = true;
    server.emit("notification", {
      method: "turn/completed",
      params: { threadId: "thread", turn: { id: next.turnId, status: "failed" } },
    });
    await assert.rejects(
      backend.startTurn("owner", "session", "uncertain", { idempotencyKey: "3:1" }),
      UncertainError,
    );
    assert.equal((await backend.readSession("owner", "session")).state, "unknown");
    await assert.rejects(
      backend.startTurn("owner", "session", "uncertain", { idempotencyKey: "3:1" }),
      /unknown; do not redispatch/,
    );
    assert.equal(server.calls.filter(call => call.method === "turn/start").length, 3);
  } finally {
    await backend.close();
    rmSync(stateDir, { recursive: true });
  }
});
