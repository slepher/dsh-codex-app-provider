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
    // Record every request: whether a core carries the plugin's execution inputs
    // into the assembled request is one of the facts under observation.
    requests.push({ sessionId: options.sessionId, model: options.model, reasoningEffort: options.reasoningEffort, execution: options.execution ?? null });
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
      // The dispatcher owns the child's execution snapshot, exactly as the
      // workflow does: it hands over a detached value, so changing its own copy
      // afterwards must not reach the child. The core composes `AgentOptions` by
      // spreading the request shallowly (`resolveChildAgentOptions`), so a nested
      // object passed by reference would stay the caller's.
      const dispatched = structuredClone(execution);
      const created = await ctx.subagents.startContinuable({
        provider: "spawn", label: `native role ${role}`,
        request: { parent, prompt: [{ type: "text", text: "Reply with your role marker." }], agentOptions: {
          provider: "codex", model: process.env.DSH_CODEX_TEST_MODEL ?? "gpt-5.6-luna", reasoningEffort: ReasoningEffortId("medium"), execution: dispatched,
        } }, signal,
      });
      children.push({ role, id: created.childId, execution: structuredClone(dispatched) });
      // The caller changes its own configuration after dispatch; the child's
      // dispatched snapshot must be what it runs.
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
        const headers = events.filter(event => event.type === "request/header");
        const outputs = events.filter(event => event.type === "assistant/message")
          .map(event => event.data.message.content.filter(block => block.type === "text").map(block => block.text).join(""));
        // Record what the child's log actually holds beside the result file
        // before asserting, so a mismatch is diagnosable from the evidence
        // directory instead of only from the assertion text.
        child.observed = {
          headers: headers.length,
          outputs,
          turns: events.filter(event => event.type === "turn/start").map(event => event.data.turn),
          turnEnds: events.filter(event => event.type === "turn/end").map(event => event.data),
          steps: events.filter(event => event.type === "step/start" || event.type === "step/end")
            .map(event => `${event.type}:${event.data.turn}/${event.data.step}`),
          eventTypes: [...new Set(events.map(event => event.type))].sort(),
        };
        await writeFile(`${process.env.DSH_NATIVE_CHILD_RESULT}.observed`, JSON.stringify({ status: "CHILD_OBSERVED", children, requests, failures }, null, 2));
        assert.equal(handle.header.parentSession, parent.id);
        assert.equal(handle.header.cwd, child.execution.boundary.cwd);
        const descriptor = events.find(event => event.type === "subagent/descriptor");
        assert.ok(descriptor, "the core records one subagent descriptor per child");
        // The descriptor shape is core-owned: the version number and whether a
        // plugin-declared `execution` field survives are both facts to observe,
        // not assumptions to assert (repair.md §4.7). What must hold is that the
        // child actually runs the role instructions it was dispatched with.
        child.observed.descriptor = { version: descriptor.data.version,
          execution: descriptor.data.execution === undefined ? null : descriptor.data.execution,
          keys: Object.keys(descriptor.data).sort() };
        if (descriptor.data.execution !== undefined) assert.deepEqual(descriptor.data.execution, child.execution);
        assert.ok(headers.length >= (child.role === "A" ? 2 : 1));
        // Whether the plugin's execution inputs appear in the request header is
        // likewise core-owned: observe it, and hold the plugin to it only where
        // the core actually carries it.
        child.observed.headerExecution = headers.map(header => header.data.header.config.execution ?? null);
        for (const header of headers) {
          if (header.data.header.config.execution !== undefined) assert.deepEqual(header.data.header.config.execution, child.execution);
        }
        assert.deepEqual(outputs, child.role === "A" ? ["DSH_ROLE_A", "DSH_ROLE_A"] : ["DSH_ROLE_B"],
          `the child must run the role instructions it was dispatched with; descriptor=${JSON.stringify(child.observed.descriptor)}. `
          + "A core that does not carry the plugin's execution field requires the workflow to restore role instructions through the official Agent/pre-step seam (repair.md §4.7)");
        child.outputs = outputs;
        if (externalEvents) {
          // The provider store keeps the raw record; the DSH session log carries
          // the visible, replayable representation of what actually ran.
          const facts = await ctx.codexExecution.facts(child.id);
          assert.ok(facts.length >= 2, "Native tool facts were projected from the provider store");
          assert.ok(facts.every(line => line.startsWith("[source: codex thread=")), "every projected line carries its durable item identity");
          assert.ok(facts.filter(line => line.includes(`DSH_TOOL_${child.role}`)).length >= (child.role === "A" ? 2 : 1));
          const imported = events.filter(event => event.type === "user/message"
            && event.data?.source?.plugin === "dsh-codex-app-provider");
          assert.ok(imported.length >= 2, "executed facts are persisted in the DSH session log");
          assert.ok(imported.every(event => typeof event.data.id === "string" && event.data.id.startsWith("codex-executed:")),
            "every imported fact carries a stable native-item identity");
          assert.ok(imported.every(event => event.data.source.form === "notice"), "an imported fact is presented as a notice, not a human prompt");
          assert.equal(new Set(imported.map(event => event.data.id)).size, imported.length, "no executed fact is imported twice");
          const importedText = imported.flatMap(event => event.data.content.map(block => block.text)).join("\n");
          assert.ok(importedText.includes(`DSH_TOOL_${child.role}`), "the executed command is readable from the DSH log");
          assert.equal(events.filter(event => event.type === "tool/call").length, 0, "DSH did not execute Codex tools again");
          child.externalExecutionFacts = facts;
        }
      } finally { await handle.close(); }
    }
    // The durable facts: each child ran the turns it was dispatched with, and
    // each turn was one model request. Neither depends on the core carrying a
    // plugin-declared execution field.
    assert.deepEqual(children.map(child => child.observed.turns.length), [2, 1], "each child ran its dispatched turns");
    assert.equal(requests.filter(request => request.sessionId === children[0].id).length, 2);
    assert.equal(requests.filter(request => request.sessionId === children[1].id).length, 1);
    await writeFile(process.env.DSH_NATIVE_CHILD_RESULT, JSON.stringify({ status: externalEvents ? "PASS_EXTERNAL_EXECUTION_EVENTS" : "PASS_NATIVE_SPAWN_COLD_AGENT_RESUME", parentSessionId: parent.id, children, requests }, null, 2));
    return decision;
  });
}
