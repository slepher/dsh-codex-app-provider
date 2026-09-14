import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";

const exec = promisify(execFile);
export const name = "codex-app-workflow-handoff-test";
export const inject = ["agents", "subagents", "tools", "codexExecution", "codexHandoff", "sessionPersistence"];

/**
 * Exercise one real bootstrap handoff: a sup opening phase hands the assignment
 * to a def successor that keeps the original Codex thread.
 *
 * The contract makes the opening phase stop after reconnaissance and return the
 * authorized control report, so the Host's mechanical handoff is what the run
 * observes. Every identity that matters is read back from the real provider:
 * same thread, different DSH child, target model, revoked source.
 */
export function apply(ctx) {
  let started = false;
  ctx.on("agent/pre-step", async ({ agent: parent, signal }, next) => {
    const decision = await next();
    if (started || parent.session.header.parentSession !== undefined || decision.kind !== "enter") return decision;
    started = true;
    const repo = parent.session.header.cwd;
    const git = async (...args) => (await exec("git", ["-C", repo, ...args])).stdout.trim();
    const actions = [], executions = [];
    const report = { status: "RUNNING", parentSessionId: parent.id, repository: repo, actions, executions };
    const save = async () => {
      const text = JSON.stringify(report, null, 2);
      await writeFile(process.env.DSH_NATIVE_CHILD_RESULT, text);
      if (process.env.DSH_HANDOFF_DRIVER_EVIDENCE !== undefined) await writeFile(process.env.DSH_HANDOFF_DRIVER_EVIDENCE, text);
    };
    const action = async args => {
      const result = await ctx.tools.execute({ name: "codex_workflow", arguments: args, callId: `handoff-${actions.length}`, agent: parent, signal });
      actions.push({ args, result }); await save();
      assert.equal(result.isError, false, JSON.stringify(result));
      return JSON.parse(result.content[0].text);
    };
    const settled = async id => {
      const deadline = Date.now() + 240_000;
      while (ctx.agents.get(id) !== undefined) {
        signal.throwIfAborted();
        if (Date.now() > deadline) throw new Error(`Workflow child ${id} did not settle`);
        await setTimeout(50, undefined, { signal });
      }
      const execution = await ctx.codexExecution.read(id);
      if (execution === undefined) {
        let log;
        try {
          const handle = await ctx.sessionPersistence.open(id, "read");
          try { log = (await handle.read()).events.map(event => ({ type: event.type, data: event.data })); } finally { await handle.close(); }
        } catch (error) { log = String(error); }
        report.missingExecution = { id, live: ctx.agents.get(id) !== undefined, summary: await action({ action: "status" }), log };
        throw new Error(`No native execution record for child ${id}`);
      }
      if (execution.reports.at(-1)?.status !== "completed") {
        report.incompleteExecution = execution;
        throw new Error(`Workflow child ${id} did not complete: ${JSON.stringify(execution)}`);
      }
      executions.push(execution); await save();
      return execution;
    };
    try {
      await git("init", "-b", "main"); await git("config", "user.email", "live-test@example.invalid"); await git("config", "user.name", "DSH isolated test");
      await writeFile(join(repo, "fixture.txt"), "base\n"); await git("add", "fixture.txt"); await git("commit", "-m", "isolated fixture");
      const base = await git("rev-parse", "HEAD"), generation = join(repo, "agentwork", "live", "generation-1");
      await mkdir(join(generation, "tasks"), { recursive: true });
      await writeFile(join(generation, "plan.md"), `- Schema: 1\n- Revision: 1\n- Repository: ${repo}\n- Target: refs/heads/main\n- Base: ${base}\n- Delivery: target-merge\n## Goal\nVerify a real bootstrap handoff to a def successor.\n## Acceptance\nThe opening phase hands off, the successor delivers fixture.txt.\n## Lane policy\n- Initial lanes: 1\n- Max lanes: 1\n- Expand: no\n- Bases: ["plan", "target"]\n- Isolation: worktree\n- Merge method: merge\n`);
      await writeFile(join(generation, "tasks.md"), "## T001\n- State: executable\n- Revision: 1\n");
      await writeFile(join(generation, "tasks/T001.md"), `- Revision: 1\n- Kind: implementation\n- Role: coding_worker\n- Depends on: []\n- Owned paths: ["fixture.txt"]\n- Resources: []\n- Inputs: ["${base}"]\n- Review: independent\n## Goal\nTwo-phase delivery of fixture.txt. This is a bootstrap assignment: the opening phase must NOT implement anything. Inspect the workspace, then end your turn with exactly the authorized execution-control handoff report your phase prompt defines (Execution control: handoff, Target tier: def, Summary, Remaining). A successor continues the assignment on the def configuration.\n## Acceptance\nThe successor replaces fixture.txt content with delivered followed by one newline, commits it in the assigned worktree, and only fixture.txt changes.\n## Constraints\nPreserve other work. Do not modify the integration target, do not implement in the opening phase and do not spawn children.\n## Validation\nRead fixture.txt and git diff --check; report their exits.\n## Return when\nThe successor returns the required execution-result fields with the actual committed candidate and evidence.\n`);
      await action({ action: "adopt", generation });
      let summary = await action({ action: "dispatch", task: "T001" });
      const opening = summary.tasks.find(value => value.task === "T001");
      const source = await settled(opening.workerId);
      report.sourceWorkerId = opening.workerId;
      report.sourceThreadId = source.threadId;
      report.sourceModel = source.model;

      // The Host settles the control report mechanically and creates the successor.
      summary = await action({ action: "status" });
      let attempt = summary.tasks.find(value => value.task === "T001");
      const handoff = attempt.handoff;
      assert.equal(handoff.fromWorker, opening.workerId, JSON.stringify(attempt));
      assert.notEqual(handoff.toWorker, opening.workerId, "the successor is a new DSH child");
      assert.equal(handoff.targetTier, "def");
      assert.equal(handoff.targetConfig.provider, "codex");
      assert.equal(handoff.status, "started");
      assert.notEqual(handoff.targetConfig.model, report.sourceModel, "the target is a different model configuration");
      assert.equal(handoff.threadId, source.threadId, "the successor continues the original thread");
      assert.equal(handoff.messageId.startsWith("inbox-") || typeof handoff.messageId === "string", true);
      report.handoff = handoff;

      const successor = await settled(handoff.toWorker);
      report.successorThreadId = successor.threadId;
      report.successorModel = successor.model;
      report.successorNativeSessionId = successor.nativeSessionId;
      assert.equal(successor.nativeSessionId, handoff.toWorker, "the successor runs as its own DSH Session");
      assert.notEqual(successor.nativeSessionId, source.nativeSessionId, "the DSH child identity changed");
      assert.equal(successor.threadId, source.threadId, "the Codex thread identity is unchanged");
      assert.equal(successor.model, handoff.targetConfig.model, "the successor ran on the bound def model");

      // The provider records agree on one thread with one owner each.
      const sourceOwnership = await ctx.codexHandoff.read(opening.workerId);
      const successorOwnership = await ctx.codexHandoff.read(handoff.toWorker);
      report.ownership = { source: sourceOwnership, successor: successorOwnership };
      assert.equal(sourceOwnership.threadId, source.threadId);
      assert.equal(sourceOwnership.handedOffTo, handoff.toWorker, "the source lost ownership");
      assert.equal(successorOwnership.threadId, source.threadId);
      assert.equal(successorOwnership.handoffFrom, opening.workerId, "the successor records its source");

      // The successor completes the assignment and its candidate is delivered.
      summary = await action({ action: "status" });
      attempt = summary.tasks.find(value => value.task === "T001");
      assert.equal(attempt.handoff.status, "confirmed", "the successor turn confirms the handover");
      assert.equal(attempt.handoff.targetTurnId, successor.reports.at(-1).turnId);
      assert.equal(attempt.activeWorker, handoff.toWorker);
      summary = await action({ action: "record-result", task: "T001" });
      attempt = summary.tasks.find(value => value.task === "T001");
      assert.equal(attempt.state, "candidate", JSON.stringify(attempt));
      assert.equal(attempt.activeWorker, handoff.toWorker, "the candidate belongs to the successor");
      if (attempt.review) {
        await settled(attempt.review.worker);
        summary = await action({ action: "status" });
        attempt = summary.tasks.find(value => value.task === "T001");
      }
      summary = await action({ action: "accept", task: "T001" });
      assert.equal(summary.tasks.find(value => value.task === "T001").state, "accepted");
      summary = await action({ action: "integrate", task: "T001" });
      assert.equal(summary.tasks.find(value => value.task === "T001").state, "delivered");
      assert.equal(await readFile(join(repo, "fixture.txt"), "utf8"), "delivered\n");
      summary = await action({ action: "release", task: "T001", processesStopped: true });
      assert.equal(summary.tasks.find(value => value.task === "T001").state, "released");
      assert.equal(ctx.agents.get(handoff.toWorker), undefined, "the successor is disposed after release");

      // Both executions carried explicit native execution inputs, and neither
      // replayed its native tools through the DSH dispatcher.
      for (const execution of executions) {
        const handle = await ctx.sessionPersistence.open(execution.nativeSessionId, "read");
        try {
          assert.equal(handle.header.parentSession, parent.id);
          const { events } = await handle.read();
          assert.ok(events.some(event => event.type === "request/header" && event.data.header.config.execution));
          assert.equal(events.filter(event => event.type === "tool/call").length, 0, "Codex native tools are not dispatched twice");
        } finally { await handle.close(); }
      }
      report.base = base; report.target = await git("rev-parse", "HEAD");
      report.status = "PASS_WORKFLOW_SUCCESSOR_HANDOFF"; await save();
      return decision;
    } catch (error) {
      report.status = "FAIL"; report.error = String(error); await save(); throw error;
    }
  });
}
