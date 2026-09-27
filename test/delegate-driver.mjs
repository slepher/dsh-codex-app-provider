import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Workflow, WorkflowConfiguration, WorkflowStore, WorkflowWorkers, ROLES } from "dsh-workflow-kit";
import { setTimeout } from "node:timers/promises";

export const name = "codex-app-delegate-test";
export const inject = ["agents", "sessions", "subagents", "sessionPersistence", "llm", "codexExecution"];

/**
 * Live check of the delegation half: one role task goes to one child without a
 * generation, and the child keeps its handle for a follow-up.
 *
 * The role's instructions are workflow content, so they must arrive as the
 * child's opening prompt, and the role's configured model/effort must be the
 * ones the live host runs. Nothing about permissions travels: the delegation
 * declares no write scope, and Codex's own sandbox is what the child runs under.
 */
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
    const result = { status: "FAIL", requests, failures };
    try {
      const marker = "DSH_ROLE_DELEGATE";
      const model = process.env.DSH_CODEX_TEST_MODEL ?? "gpt-6-luna";
      const effort = "medium";
      // The synthetic layer keeps the shipped role name while pinning one model
      // configuration, so the assertions are about the delegation mechanism and
      // not about whichever model the deployment configures.
      const builtin = { a: { roles: { evidence_runner: { provider: "codex", model, reasoningEffort: effort } } } };
      const catalog = new WorkflowConfiguration(builtin, () => `Your role marker is ${marker}. Reply with only this marker when asked. Do not run tools.`);
      const store = new WorkflowStore(join(process.env.DSH_HOME, "delegate-live-state"));
      const workers = new WorkflowWorkers(ctx, store, catalog, () => "a");
      const workflow = new Workflow(workers, "/skills/codex-workflow");

      // The public action the model calls: no generation, no declared write scope.
      const delegated = await workers.run(parent, signal, () => workflow.execute(String(parent.id),
        { action: "delegate", role: "evidence_runner", text: `Reply with ${marker}.` }));
      const id = delegated.worker.id;
      assert.ok(id, "delegation returns the child's handle");
      assert.equal(delegated.worker.role, "evidence_runner");

      const deadline = Date.now() + 120_000;
      while (ctx.agents.get(id) !== undefined) {
        signal.throwIfAborted();
        if (Date.now() > deadline) throw new Error(`Delegated child ${id} did not settle`);
        await setTimeout(20, undefined, { signal });
      }

      const facts = await workers.run(parent, signal, () => workers.get(String(parent.id), id));
      assert.equal(facts.state, "idle", "the delegated turn completed");
      assert.equal(facts.model, model, "the role's configured model ran the child");
      assert.equal(facts.effort, effort, "and its configured effort");
      assert.equal(facts.reports.length, 1);

      // A follow-up on the same handle reaches the same child.
      await workers.run(parent, signal, () => workflow.execute(String(parent.id),
        { action: "delegate", worker: id, text: `Reply with ${marker} again.` }));
      while (ctx.agents.get(id) !== undefined) {
        signal.throwIfAborted();
        if (Date.now() > deadline) throw new Error(`Delegated child ${id} did not settle after its follow-up`);
        await setTimeout(20, undefined, { signal });
      }
      const after = await workers.run(parent, signal, () => workers.get(String(parent.id), id));
      assert.equal(after.reports.length, 2, "the follow-up ran as a second turn of the same child");

      const handle = await ctx.sessionPersistence.open(id, "read");
      try {
        const { events } = await handle.read();
        assert.equal(handle.header.parentSession, parent.id, "the delegated child is attached to its parent Session");
        assert.equal(handle.header.cwd, parent.session.header.cwd, "and runs where the delegation ran");
        const outputs = events.filter(event => event.type === "assistant/message")
          .map(event => event.data.message.content.filter(block => block.type === "text").map(block => block.text).join(""));
        assert.deepEqual(outputs, [marker, marker],
          `the child answers from the role instructions it was started with; observed=${JSON.stringify(outputs)}`);
      } finally { await handle.close(); }

      result.status = "PASS_DELEGATE_ROLE_TASK";
      result.parentSessionId = parent.id;
      result.child = { id, role: facts.role, model: facts.model, effort: facts.effort, reports: facts.reports.length };
      result.roleCatalogue = ROLES.map(role => role.name);
      result.requests = requests;
    } catch (error) {
      result.error = String(error?.stack ?? error);
    }
    await writeFile(process.env.DSH_NATIVE_CHILD_RESULT, JSON.stringify(result, null, 2));
    return decision;
  });
}
