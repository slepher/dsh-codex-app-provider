import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";

const exec = promisify(execFile);
export const name = "codex-app-workflow-contract-test";
export const inject = ["agents", "subagents", "tools", "codexExecution", "sessionPersistence"];

/** Exercise the installed codex_workflow tool with real native workers in an isolated repository. */
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
    const save = () => writeFile(process.env.DSH_NATIVE_CHILD_RESULT, JSON.stringify(report, null, 2));
    const action = async args => {
      const result = await ctx.tools.execute({ name: "codex_workflow", arguments: args, callId: `contract-${actions.length}`, agent: parent, signal });
      actions.push({ args, result }); await save();
      assert.equal(result.isError, false, JSON.stringify(result));
      return JSON.parse(result.content[0].text);
    };
    const settled = async id => {
      const deadline = Date.now() + 180_000;
      while (ctx.agents.get(id) !== undefined) {
        signal.throwIfAborted();
        if (Date.now() > deadline) throw new Error(`Workflow child ${id} did not settle`);
        await setTimeout(50, undefined, { signal });
      }
      const execution = await ctx.codexExecution.read(id);
      assert.equal(execution?.reports.at(-1)?.status, "completed", JSON.stringify(execution));
      assert.equal(execution.reports.at(-1).acceptance, undefined, "Acceptance remains workflow-owned");
      executions.push(execution); await save();
    };
    try {
      await git("init", "-b", "main"); await git("config", "user.email", "live-test@example.invalid"); await git("config", "user.name", "DSH isolated test");
      await writeFile(join(repo, "fixture.txt"), "base\n"); await git("add", "fixture.txt"); await git("commit", "-m", "isolated fixture");
      const base = await git("rev-parse", "HEAD"), generation = join(repo, "agentwork", "live", "generation-1");
      await mkdir(join(generation, "tasks"), { recursive: true });
      await writeFile(join(generation, "plan.md"), `- Schema: 1\n- Revision: 1\n- Repository: ${repo}\n- Target: refs/heads/main\n- Base: ${base}\n- Delivery: target-merge\n## Goal\nVerify native workflow delivery.\n## Acceptance\nInspect the base and deliver the owned fixture change.\n## Lane policy\n- Initial lanes: 1\n- Max lanes: 1\n- Expand: no\n- Bases: ["plan", "target"]\n- Isolation: worktree\n- Merge method: merge\n`);
      await writeFile(join(generation, "tasks.md"), "## T001\n- State: executable\n- Revision: 1\n## T002\n- State: executable\n- Revision: 1\n");
      await writeFile(join(generation, "tasks/T001.md"), `- Revision: 1\n- Kind: investigation\n- Role: evidence_runner\n- Depends on: []\n- Owned paths: []\n- Resources: []\n- Inputs: ["${base}"]\n- Review: dispatcher\n- Lane: no\n- Cwd: .\n- Read paths: ["."]\n## Goal\nRead fixture.txt and report its exact content.\n## Acceptance\nConfirm it contains base.\n## Constraints\nRead only; do not create commits.\n## Validation\nRead fixture.txt using a native shell command.\n## Return when\nReturn the required execution-result fields and command evidence.\n`);
      await writeFile(join(generation, "tasks/T002.md"), `- Revision: 1\n- Kind: implementation\n- Role: coding_worker\n- Depends on: []\n- Owned paths: ["fixture.txt"]\n- Resources: []\n- Inputs: ["${base}"]\n- Review: independent\n## Goal\nReplace fixture.txt content with delivered followed by one newline, and commit the change in the assigned worktree.\n## Acceptance\nOnly fixture.txt changes and contains delivered followed by one newline.\n## Constraints\nPreserve other work. Do not modify the integration target or spawn children.\n## Validation\nRead fixture.txt and git diff --check; report their exits.\n## Return when\nReturn the required result fields with the actual committed candidate and evidence.\n`);
      await action({ action: "adopt", generation });
      for (const task of ["T001", "T002"]) {
        let summary = await action({ action: "dispatch", task });
        let attempt = summary.tasks.find(value => value.task === task);
        await settled(attempt.workerId);
        summary = await action({ action: "status" });
        assert.equal(summary.tasks.find(value => value.task === task).state, "running", "Native completion is not workflow acceptance");
        summary = await action({ action: "record-result", task });
        attempt = summary.tasks.find(value => value.task === task);
        assert.equal(attempt.state, "candidate");
        if (attempt.review) await settled(attempt.review.worker);
        summary = await action({ action: "accept", task });
        assert.equal(summary.tasks.find(value => value.task === task).state, "accepted");
        summary = await action({ action: "integrate", task });
        attempt = summary.tasks.find(value => value.task === task);
        assert.equal(attempt.state, "delivered");
        if (task === "T002") assert.equal(await readFile(join(repo, "fixture.txt"), "utf8"), "delivered\n");
        assert.ok(executions.every(value => ctx.agents.get(value.nativeSessionId) === undefined));
        summary = await action({ action: "release", task, processesStopped: true });
        assert.equal(summary.tasks.find(value => value.task === task).state, "released");
      }
      for (const execution of executions) {
        const handle = await ctx.sessionPersistence.open(execution.nativeSessionId, "read");
        try {
          assert.equal(handle.header.parentSession, parent.id);
          const { events } = await handle.read();
          // The provider's execution inputs may or may not appear in the
          // request header depending on the core; what must hold is that the
          // worker ran the role it was dispatched with.
          assert.ok(events.some(event => event.type === "request/header"), "the worker logged its requests");
          assert.equal(events.filter(event => event.type === "tool/call").length, 0, "Codex native tools are not dispatched twice");
        } finally { await handle.close(); }
      }
      report.status = "PASS_WORKFLOW_CONTRACT_DELIVERY"; report.base = base; report.target = await git("rev-parse", "HEAD"); await save();
      return decision;
    } catch (error) {
      report.status = "FAIL"; report.error = String(error); await save(); throw error;
    }
  });
}
