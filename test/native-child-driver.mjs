import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { queueHostSubagentPrompt } from "@deepseek-ai/dsh-subagent/internal";

export const name = "codex-app-native-child-test";
export const inject = ["agents", "subagents", "sessionPersistence", "codexExecution", "llm"];

/** Test-only profile plugin: exercise the real spawn/descriptor/cold-resume chain. */
export function apply(ctx) {
  const externalEvents = process.env.DSH_EXTERNAL_EVENTS_TEST === "1";
  let started = false;
  const requests = [], failures = [];
  ctx.on("llm/stream", async function* (options, next) {
    if (options.execution !== undefined) requests.push({ sessionId: options.sessionId, model: options.model, reasoningEffort: options.reasoningEffort, execution: options.execution });
    for await (const chunk of next()) {
      if (chunk.type === "finish" && (chunk.reason.kind === "error" || chunk.reason.kind === "aborted")) {
        failures.push({ sessionId: options.sessionId, reason: chunk.reason });
        await writeFile(process.env.DSH_NATIVE_CHILD_RESULT, JSON.stringify({ status: "FAIL", requests, failures }, null, 2));
      }
      yield chunk;
    }
  });
  ctx.on("agent/pre-step", async ({ agent: parent, signal }, next) => {
    const decision = await next();
    if (started || parent.session.header.parentSession !== undefined || decision.kind !== "enter") return decision;
    started = true;
    const children = [];
    const idle = async id => {
      const deadline = Date.now() + 120_000;
      while (ctx.agents.get(id) !== undefined) {
        signal.throwIfAborted();
        if (Date.now() > deadline) throw new Error(`Native child ${id} did not settle`);
        await setTimeout(20, undefined, { signal });
      }
    };
    for (const role of ["A", "B"]) {
      const execution = {
        developerInstructions: `Your role marker is DSH_ROLE_${role}. Reply with only this marker when asked. ${externalEvents ? `Before every reply, use your native shell to run printf DSH_TOOL_${role}.` : "Do not run tools."}`,
        boundary: { cwd: parent.session.header.cwd, writableRoots: [parent.session.header.cwd], network: "disabled" },
      };
      const created = await ctx.subagents.startContinuable({
        provider: "spawn", label: `native role ${role}`,
        request: { parent, prompt: [{ type: "text", text: "Reply with your role marker." }], agentOptions: {
          provider: "codex", model: process.env.DSH_CODEX_TEST_MODEL ?? "gpt-5.6-luna", reasoningEffort: ReasoningEffortId("medium"), execution,
        } }, signal,
      });
      children.push({ role, id: created.childId, execution: structuredClone(execution) });
      execution.developerInstructions = "Changed caller configuration; must not affect this child.";
      await idle(created.childId);
    }
    await queueHostSubagentPrompt(ctx.subagents, parent, children[0].id,
      [{ type: "text", text: "Reply with your role marker again." }], { kind: "user" }, signal);
    await idle(children[0].id);
    for (const child of children) {
      const handle = await ctx.sessionPersistence.open(child.id, "read");
      try {
        const { events } = await handle.read();
        assert.equal(handle.header.parentSession, parent.id);
        assert.equal(handle.header.cwd, child.execution.boundary.cwd);
        const descriptor = events.find(event => event.type === "subagent/descriptor");
        assert.equal(descriptor.data.version, 4);
        assert.deepEqual(descriptor.data.execution, child.execution);
        const headers = events.filter(event => event.type === "request/header");
        assert.ok(headers.length >= (child.role === "A" ? 2 : 1));
        for (const header of headers) assert.deepEqual(header.data.header.config.execution, child.execution);
        const outputs = events.filter(event => event.type === "assistant/message")
          .map(event => event.data.message.content.filter(block => block.type === "text").map(block => block.text).join(""));
        assert.deepEqual(outputs, child.role === "A" ? ["DSH_ROLE_A", "DSH_ROLE_A"] : ["DSH_ROLE_B"]);
        child.outputs = outputs;
        if (externalEvents) {
          // Execution facts live in the provider store, not the DSH session log:
          // stock core rejects an unknown `codex/execution` session event on read.
          const facts = await ctx.codexExecution.facts(child.id);
          assert.ok(facts.length >= 2, "Native tool facts were projected from the provider store");
          assert.ok(facts.every(line => line.startsWith("[source: codex thread=")), "every projected line carries its durable item identity");
          assert.ok(facts.filter(line => line.includes(`DSH_TOOL_${child.role}`)).length >= (child.role === "A" ? 2 : 1));
          assert.equal(events.filter(event => event.type === "tool/call").length, 0, "DSH did not execute Codex tools again");
          child.externalExecutionFacts = facts;
        }
      } finally { await handle.close(); }
    }
    assert.equal(requests.filter(request => request.sessionId === children[0].id).length, 2);
    assert.equal(requests.filter(request => request.sessionId === children[1].id).length, 1);
    await writeFile(process.env.DSH_NATIVE_CHILD_RESULT, JSON.stringify({ status: externalEvents ? "PASS_EXTERNAL_EXECUTION_EVENTS" : "PASS_NATIVE_SPAWN_COLD_AGENT_RESUME", parentSessionId: parent.id, children, requests }, null, 2));
    return decision;
  });
}
