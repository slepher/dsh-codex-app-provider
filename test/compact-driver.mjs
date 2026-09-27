import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

export const name = "codex-app-native-compaction-test";
export const inject = ["agents", "compaction", "sessionPersistence", "codexExecution"];

const FIRST = "Reply with only DSH_COMPACT_FIRST_TURN. Do not run tools or change files.";
const SECOND = "Reply with only DSH_COMPACT_SECOND_TURN. Do not run tools or change files.";

/**
 * Test-only profile plugin: drive one real DSH Session through the official
 * compaction commit path and then through a following turn.
 *
 * The driver owns its own Agent and Session so the sequence is deterministic:
 * turn one gives the Session a native thread, the manual compaction commits a
 * real checkpoint over the visible range, and turn two must continue the same
 * native thread without re-importing the history the checkpoint replaced.
 */
export function apply(ctx) {
  let started = false;
  const observed = { requests: [] };
  const write = payload => writeFile(process.env.DSH_NATIVE_CHILD_RESULT, JSON.stringify(payload, null, 2));

  ctx.on("llm/stream", async function* (options, next) {
    observed.requests.push({ sessionId: options.sessionId, purpose: options.purpose ?? null });
    yield* next();
  });

  ctx.on("agent/pre-step", async ({ agent }, next) => {
    const decision = await next();
    if (started || agent.session.header.parentSession !== undefined || decision.kind !== "enter") return decision;
    started = true;
    // The sequence runs inside the launcher's turn. The driver's own Agent and
    // Session are independent, but the one-shot launcher exits as soon as its
    // turn settles, so a detached driver would be cancelled mid-compaction.
    try {
      await run();
    } catch (error) {
      await write({ status: "FAIL", error: String(error), observed });
    }
    return decision;
  });

  async function sessionEvents(sessionId) {
    const handle = await ctx.sessionPersistence.open(sessionId, "read");
    try {
      return (await handle.read()).events;
    } finally {
      await handle.close();
    }
  }

  async function run() {
    const selection = ctx.get("agentDefaultModel")?.currentSelection?.();
    const { agent } = await ctx.agents.create({
      sessionId: `session-compact-${Date.now()}`,
      meta: { cwd: process.cwd() },
      agentOptions: { provider: "codex", model: selection?.model ?? process.env.DSH_CODEX_TEST_MODEL ?? "gpt-6-luna" },
    });
    const sessionId = String(agent.session.id);
    const ask = async text => {
      agent.followup(createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } }));
      await agent.whenIdle();
    };

    await agent.whenIdle();
    await ask(FIRST);
    const before = await ctx.codexExecution.read(sessionId);
    assert.ok(before?.threadId, "the first turn must give the Session a native thread");

    const result = await ctx.compaction.compactNow(agent, new AbortController().signal);
    assert.ok(result, "the official manual compaction must commit a checkpoint");
    const committed = await sessionEvents(sessionId);
    const summary = committed.find(event => event.type === "compaction/summary");
    assert.ok(summary !== undefined, "the Session log must record the compaction summary");
    assert.ok(summary.data.shadowedSeqs.length > 0, "the summary must name the visible range it replaced");
    const checkpoint = committed.find(event => event.type === "user/message"
      && event.data?.source?.plugin === "compact" && event.data.source.compactionId === summary.data.compactionId);
    assert.ok(checkpoint !== undefined, "the replaced range must be one checkpoint user message");
    const after = await ctx.codexExecution.read(sessionId);
    assert.equal(after.threadId, before.threadId, "native compaction must continue the same thread");
    assert.equal(after.state, "idle", "the compacted Session must be idle for the next turn");

    await ask(SECOND);
    const done = await ctx.codexExecution.read(sessionId);
    assert.equal(done.threadId, before.threadId, "the second turn must still run on the compacted thread");
    assert.equal(done.reports.filter(report => report.status === "completed").length >= 2, true, "both user turns must complete");

    const log = process.env.DSH_FAKE_CODEX_LOG;
    if (log !== undefined) {
      const calls = (await readFile(log, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));
      const turns = calls.filter(call => call.method === "turn/start" && call.params.threadId === before.threadId);
      assert.equal(turns.length, 2, "the compacted thread must serve exactly the two user turns");
      const text = turns.at(-1).params.input.map(block => block.text ?? "").join("\n");
      assert.equal(text.includes("[DSH history import"), false, "the replaced history must never be re-imported");
      assert.match(text, /DSH_COMPACT_SECOND_TURN/, "the second turn's own input must reach the thread");
      const compactions = calls.filter(call => call.method === "thread/compact/start" && call.params.threadId === before.threadId);
      assert.equal(compactions.length, 1, "exactly one native compaction must run on that thread");
      // The Session-title and compaction-summary requests each start their own
      // isolated thread, so the count is not the main thread's identity. What
      // proves the main thread was created once is that its first turn follows
      // exactly one `thread/start`, and that both turns above stayed on it.
      const firstMainTurn = calls.findIndex(call => call.method === "turn/start" && call.params.threadId === before.threadId);
      const startsBeforeMainTurn = calls.slice(0, firstMainTurn).filter(call => call.method === "thread/start").length;
      assert.equal(startsBeforeMainTurn, 1, "the main thread is created once, before its first turn");
      observed.nativeCalls = { turns: turns.length, secondInput: text, compactStarts: compactions.length,
        threadStarts: calls.filter(call => call.method === "thread/start").length };
    }

    await write({
      status: "PASS_NATIVE_COMPACTION", parentSessionId: sessionId, threadId: before.threadId,
      compaction: { compactionId: summary.data.compactionId, shadowedSeqs: summary.data.shadowedSeqs, checkpointId: checkpoint.data.id },
      completedTurns: done.reports.filter(report => report.status === "completed").length,
      observed,
    });
  }
}
