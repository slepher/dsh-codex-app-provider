import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WorkflowConfiguration, WorkflowStore, WorkflowWorkers } from "dsh-workflow-kit";
import { setTimeout } from "node:timers/promises";

export const name = "codex-app-workflow-child-test";
export const inject = ["agents", "sessions", "subagents", "sessionPersistence", "llm", "codexExecution"];

/** Test-only profile plugin: exercise the real spawn/descriptor/cold-resume chain. */
export function apply(ctx) {
  let started = false;
  const requests = [], failures = [];
  ctx.on("llm/stream", async function* (options, next) {
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
    const model = process.env.DSH_CODEX_TEST_MODEL ?? "gpt-5.6-luna";
    const efforts = { A: "medium", B: "high" };
    let marker = "DSH_ROLE_A";
    // The shipped layer is synthetic: one reviewer role per profile, and a
    // resolver that composes the role instructions captured at dispatch time.
    const builtin = Object.fromEntries(Object.entries(efforts).map(([role, reasoningEffort]) => [role.toLowerCase(), {
      roles: { reviewer: { provider: "codex", model, reasoningEffort } },
    }]));
    const catalog = new WorkflowConfiguration(builtin,
      () => `Your role marker is ${marker}. Reply with only this marker when asked. Do not run tools.`);
    const store = new WorkflowStore(join(process.env.DSH_HOME, "workflow-live-state"));
    const workers = new WorkflowWorkers(ctx, store, catalog, () => "a");
    for (const role of ["A", "B"]) {
      const effort = efforts[role];
      marker = `DSH_ROLE_${role}`;
      store.selectProfile(String(parent.id), role.toLowerCase());
      const child = await workers.run(parent, signal, async () => {
        const captured = workers.captureRole("reviewer");
        const boundary = { cwd: parent.session.header.cwd, writableRoots: [parent.session.header.cwd], network: "disabled" };
        const id = randomUUID();
        await workers.create(String(parent.id), { ...captured, id, name: `workflow role ${role}`, cwd: boundary.cwd, boundary, managed: true });
        await workers.append(String(parent.id), id, "Reply with your role marker.", true, `${id}:first`);
        return { role, id, profile: captured.profile, model, effort, execution: { developerInstructions: captured.execution.developerInstructions, boundary } };
      });
      children.push(child);
      await idle(child.id);
      await workers.run(parent, signal, async () => {
        const facts = await workers.get(String(parent.id), child.id);
        assert.equal(facts.state, "idle");
        assert.equal(facts.reports.at(-1).acceptance, "pending", "Native completion does not imply workflow acceptance");
        assert.equal(facts.model, model); assert.equal(facts.effort, effort);
      });
    }
    // Changing the role instructions after dispatch must not rewrite a child
    // that already captured its own.
    marker = "DSH_ROLE_CHANGED";
    await workers.run(parent, signal, async () => {
      await workers.append(String(parent.id), children[0].id, "Reply with your role marker again.", true, `${children[0].id}:second`);
    });
    await idle(children[0].id);
    await workers.run(parent, signal, async () => {
      const facts = await workers.get(String(parent.id), children[0].id);
      assert.equal(facts.state, "idle"); assert.equal(facts.profile, "a");
      assert.equal(facts.reports.length, 2);
      const accepted = await workers.accept(String(parent.id), facts.id, facts.turnId, "accepted", true);
      assert.equal(accepted.acceptance, "accepted");
      assert.equal((await ctx.codexExecution.read(facts.id)).reports.at(-1).acceptance, undefined);
    });
    for (const child of children) {
      const handle = await ctx.sessionPersistence.open(child.id, "read");
      try {
        const { events } = await handle.read();
        assert.equal(handle.header.parentSession, parent.id);
        assert.equal(handle.header.cwd, child.execution.boundary.cwd);
        const descriptor = events.find(event => event.type === "subagent/descriptor");
        assert.ok(descriptor, "the core records one subagent descriptor per child");
        // Descriptor version and whether a plugin-declared `execution` field
        // survives are core-owned facts to observe, not assumptions to assert
        // (repair.md §4.7). The durable requirement is that the child ran the
        // snapshot it was dispatched with.
        child.observed = { descriptor: { version: descriptor.data.version,
          execution: descriptor.data.execution === undefined ? null : descriptor.data.execution,
          keys: Object.keys(descriptor.data).sort() } };
        if (descriptor.data.execution !== undefined) assert.deepEqual(descriptor.data.execution, child.execution);
        const headers = events.filter(event => event.type === "request/header");
        assert.ok(headers.length >= (child.role === "A" ? 2 : 1));
        for (const header of headers) {
          if (header.data.header.config.execution !== undefined) assert.deepEqual(header.data.header.config.execution, child.execution);
          assert.equal(header.data.header.config.model, child.model);
          assert.equal(header.data.header.config.reasoningEffort, child.effort);
        }
        const outputs = events.filter(event => event.type === "assistant/message")
          .map(event => event.data.message.content.filter(block => block.type === "text").map(block => block.text).join(""));
        assert.deepEqual(outputs, child.role === "A" ? ["DSH_ROLE_A", "DSH_ROLE_A"] : ["DSH_ROLE_B"],
          `each child must run the role instructions it was dispatched with; observed=${JSON.stringify(child.observed)}`);
        child.outputs = outputs;
      } finally { await handle.close(); }
    }
    assert.equal(requests.filter(request => request.sessionId === children[0].id).length, 2, "the first child made one model request per turn");
    assert.equal(requests.filter(request => request.sessionId === children[1].id).length, 1);
    await writeFile(process.env.DSH_NATIVE_CHILD_RESULT, JSON.stringify({ status: "PASS_WORKFLOW_PROFILES_COLD_AGENT_RESUME", parentSessionId: parent.id, children, requests }, null, 2));
    return decision;
  });
}
