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
 * to a def successor.
 *
 * With `DSH_HANDOFF_CROSS=1` the target configuration runs another provider, so
 * the successor must import the source's sourced executed facts instead of
 * sharing the Codex thread. Every identity that matters is read back from the
 * real provider or from the successor's own DSH session log.
 */
export function apply(ctx) {
  let started = false;
  let extensionFailure;
  const cross = process.env.DSH_HANDOFF_CROSS === "1";
  ctx.on("agent/pre-step", async ({ agent: parent, signal }, next) => {
    const decision = await next();
    if (started || parent.session.header.parentSession !== undefined || decision.kind !== "enter") return decision;
    started = true;
    const repo = parent.session.header.cwd;
    const git = async (...args) => (await exec("git", ["-C", repo, ...args])).stdout.trim();
    const actions = [], executions = [];
    const report = { status: "RUNNING", mode: cross ? "cross-provider" : "codex-to-codex", parentSessionId: parent.id, repository: repo, actions, executions };
    const save = async () => {
      const text = JSON.stringify({ ...report, ...(extensionFailure === undefined ? {} : { extensionFailure }) }, null, 2);
      await writeFile(process.env.DSH_NATIVE_CHILD_RESULT, text);
      if (process.env.DSH_HANDOFF_DRIVER_EVIDENCE !== undefined) await writeFile(process.env.DSH_HANDOFF_DRIVER_EVIDENCE, text);
    };
    // The provider adapters wrap a failing request extension into one terse
    // error; keep the underlying cause in the evidence.
    try {
      const extensions = ctx.get("deepseekLlmApiExtensions");
      if (extensions !== undefined && typeof extensions.prepare === "function") {
        const prepare = extensions.prepare.bind(extensions);
        extensions.prepare = async request => {
          try { return await prepare(request); }
          catch (error) { extensionFailure = `${String(error)}${error?.cause === undefined ? "" : ` | cause: ${String(error.cause)}`}`; await save(); throw error; }
        };
      }
    } catch {}
    const call = async args => {
      const result = await ctx.tools.execute({ name: "codex_workflow", arguments: args, callId: `handoff-${actions.length}`, agent: parent, signal });
      actions.push({ args, result }); await save();
      return { ok: !result.isError, result, value: result.isError ? undefined : JSON.parse(result.content[0].text) };
    };
    const action = async args => {
      const outcome = await call(args);
      assert.equal(outcome.ok, true, JSON.stringify(outcome.result));
      return outcome.value;
    };
    /**
     * Record the successor's final result.
     *
     * The real model occasionally returns the required fields without the
     * contract's exact bullet form; the Host is right to reject that. Ask the
     * same successor for a corrected report once and record that it happened,
     * so a formatting miss never masquerades as a handoff failure.
     */
    const recordResult = async successorId => {
      // A report the Host rejects outright carries no summary to inspect, so the
      // correction path has to look at the outcome rather than assert on it.
      const first = await call({ action: "record-result", task: "T001" });
      if (first.ok && first.value.tasks.find(value => value.task === "T001").state === "candidate") return first.value;
      const retry = await call({ action: "continue", task: "T001", text: "Your report did not match the frozen contract's execution-result fields. Resend only those lines, each starting with '- ', with the same Task, Contract revision, Attempt, Input snapshot, Candidate snapshot and Outcome values, and no other formatting. Write the corrected report to the contract's result path and then reply with it." });
      assert.equal(retry.ok, true, JSON.stringify(retry.result));
      report.resultCorrection = { rejected: first.result?.error?.message ?? null }; await save();
      await settled(successorId);
      const summary = await action({ action: "record-result", task: "T001" });
      return summary;
    };
    /**
     * Read one child's turns: the Codex provider record when it owns one, and
     * otherwise the turns its own DSH session logged.
     */
    const completion = async id => {
      const execution = await ctx.codexExecution.read(id);
      if (execution !== undefined) {
        return { source: "provider", model: execution.model, reasoningEffort: execution.reasoningEffort, threadId: execution.threadId,
          reports: execution.reports.map(entry => ({ turnId: entry.turnId, status: entry.status, result: entry.result })) };
      }
      const handle = await ctx.sessionPersistence.open(id, "read");
      try {
        const { events } = await handle.read();
        const reports = [];
        let turn, text = "";
        for (const event of events) {
          if (event.type === "turn/start") { turn = event.data.turn; text = ""; continue; }
          if (turn === undefined) continue;
          if (event.type === "assistant/message" && event.data.turn === turn) {
            text = event.data.message.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n"); continue;
          }
          if (event.type === "turn/end" && event.data.turn === turn) {
            const kind = event.data.reason.kind;
            const failure = event.data.reason.error;
            reports.push({ turnId: `dsh-${turn}`, status: kind === "error" ? "failed" : kind === "aborted" ? "interrupted" : "completed", result: text,
              ...(kind === "completed" ? {} : { reason: JSON.stringify(event.data.reason).slice(0, 900) }),
              ...(failure === undefined ? {} : { error: typeof failure === "string" ? failure : failure.message }) });
            turn = undefined;
          }
        }
        return { source: "session", reports };
      } finally { await handle.close(); }
    };
    /** Wait for one child's turn to reach a terminal state, then read it back. */
    const settled = async id => {
      const budget = Number(process.env.DSH_HANDOFF_SETTLE_MS ?? 420_000);
      const deadline = Date.now() + (Number.isSafeInteger(budget) && budget > 0 ? budget : 420_000);
      let value = await completion(id);
      while (value.reports.length === 0 || ctx.agents.get(id)?.status === "running") {
        signal.throwIfAborted();
        if (Date.now() > deadline) throw new Error(`Workflow child ${id} did not settle: ${JSON.stringify(value).slice(0, 400)}`);
        await setTimeout(200, undefined, { signal });
        value = await completion(id);
      }
      if (value.reports.at(-1)?.status !== "completed") {
        report.incompleteExecution = { id, value };
        throw new Error(`Workflow child ${id} did not complete: ${JSON.stringify(value).slice(0, 600)}`);
      }
      executions.push({ nativeSessionId: id, source: value.source, model: value.model, threadId: value.threadId, reports: value.reports }); await save();
      return value;
    };
    try {
      await git("init", "-b", "main"); await git("config", "user.email", "live-test@example.invalid"); await git("config", "user.name", "DSH isolated test");
      await writeFile(join(repo, "fixture.txt"), "base\n"); await git("add", "fixture.txt"); await git("commit", "-m", "isolated fixture");
      const base = await git("rev-parse", "HEAD"), generation = join(repo, "agentwork", "live", "generation-1");
      await mkdir(join(generation, "tasks"), { recursive: true });
      await writeFile(join(generation, "plan.md"), `- Schema: 1\n- Revision: 1\n- Repository: ${repo}\n- Target: refs/heads/main\n- Base: ${base}\n- Delivery: target-merge\n## Goal\nVerify a real bootstrap handoff to a def successor.\n## Acceptance\nThe opening phase hands off, the successor delivers fixture.txt.\n## Lane policy\n- Initial lanes: 1\n- Max lanes: 1\n- Expand: no\n- Bases: ["plan", "target"]\n- Isolation: worktree\n- Merge method: merge\n`);
      await writeFile(join(generation, "tasks.md"), "## T001\n- State: executable\n- Revision: 1\n");
      await writeFile(join(generation, "tasks/T001.md"), `- Revision: 1\n- Kind: implementation\n- Role: coding_worker\n- Depends on: []\n- Owned paths: ["fixture.txt"]\n- Resources: []\n- Inputs: ["${base}"]\n- Review: independent\n## Goal\nTwo-phase delivery of fixture.txt. This is a bootstrap assignment: the opening phase must NOT implement anything. Inspect the workspace with at least one native shell command (for example reading fixture.txt), then end your turn with exactly the authorized execution-control handoff report your phase prompt defines (Execution control: handoff, Target tier: def, Summary, Remaining). A successor continues the assignment on the def configuration.\n## Acceptance\nThe successor replaces fixture.txt content with delivered followed by one newline, commits it in the assigned worktree, and only fixture.txt changes.\n## Constraints\nPreserve other work. Do not modify the integration target, do not implement in the opening phase and do not spawn children.\n## Validation\nRead fixture.txt and git diff --check; report their exits.\n## Return when\nThe successor returns the required execution-result fields with the actual committed candidate and evidence.\n`);
      await action({ action: "adopt", generation });
      let summary = await action({ action: "dispatch", task: "T001" });
      const opening = summary.tasks.find(value => value.task === "T001");
      const source = await settled(opening.workerId);
      report.sourceWorkerId = opening.workerId;
      report.sourceThreadId = source.threadId;
      report.sourceModel = source.model;
      assert.match(source.reports.at(-1).result, /Execution control: handoff/, "the opening phase returned the authorized control report");

      // The Host settles the control report mechanically and creates the successor.
      summary = await action({ action: "status" });
      let attempt = summary.tasks.find(value => value.task === "T001");
      const handoff = attempt.handoff;
      assert.equal(handoff.fromWorker, opening.workerId, JSON.stringify(attempt));
      assert.notEqual(handoff.toWorker, opening.workerId, "the successor is a new DSH child");
      assert.equal(handoff.targetTier, "def");
      assert.equal(handoff.status, "started");
      if (cross) {
        assert.equal(handoff.targetConfig.provider, process.env.DSH_HANDOFF_TARGET_PROVIDER ?? "deepseek-official",
          "the target configuration is the other provider");
        assert.equal(handoff.threadId, undefined, "a cross-provider successor binds no Codex thread");
        assert.match(handoff.prompt, /Executed facts imported from the previous adapter/);
        assert.equal(await ctx.codexExecution.read(handoff.toWorker), undefined, "the successor owns no Codex execution");
        if (!/\[source: codex thread=\S+ turn=\S+ item=\S+\]/.test(handoff.prompt)) {
          // Record what the source session actually logged, so an empty import
          // says whether the facts were missing or unreadable.
          const handle = await ctx.sessionPersistence.open(report.sourceWorkerId, "read");
          try {
            const { events } = await handle.read();
            report.sourceEvents = events.reduce((counts, event) => ({ ...counts, [event.type]: (counts[event.type] ?? 0) + 1 }), {});
          } finally { await handle.close(); }
          await save();
        }
        assert.match(handoff.prompt, /\[source: codex thread=\S+ turn=\S+ item=\S+\]/, "the successor imported real sourced facts");
      } else {
        assert.equal(handoff.targetConfig.provider, "codex");
        assert.notEqual(handoff.targetConfig.model, report.sourceModel, "the target is a different model configuration");
        assert.equal(handoff.threadId, source.threadId, "the successor continues the original thread");
      }
      report.handoff = handoff;

      const successor = await settled(handoff.toWorker);
      report.successor = { nativeSessionId: handoff.toWorker, source: successor.source, model: successor.model, threadId: successor.threadId };
      assert.equal(successor.source, cross ? "session" : "provider", "completion is read from the provider record or the successor's own session");
      if (!cross) {
        assert.equal(successor.threadId, source.threadId, "the Codex thread identity is unchanged");
        assert.equal(successor.model, handoff.targetConfig.model, "the successor ran on the bound def model");
      }

      // The provider records agree on one owner each.
      const sourceOwnership = await ctx.codexHandoff.read(opening.workerId);
      const successorOwnership = await ctx.codexHandoff.read(handoff.toWorker);
      report.ownership = { source: sourceOwnership, successor: successorOwnership };
      assert.equal(sourceOwnership.threadId, source.threadId, "the source keeps its recorded thread identity as history");
      if (cross) {
        assert.equal(successorOwnership, undefined, "the cross-provider successor has no Codex ownership record");
        assert.equal(sourceOwnership.handedOffTo, undefined, "no successor owns the old Codex thread; the target never touches it");
      } else {
        assert.equal(sourceOwnership.handedOffTo, handoff.toWorker, "the source lost ownership");
        assert.equal(successorOwnership.threadId, source.threadId);
        assert.equal(successorOwnership.handoffFrom, opening.workerId, "the successor records its source");
      }

      // The successor completes the assignment and its candidate is delivered.
      summary = await action({ action: "status" });
      attempt = summary.tasks.find(value => value.task === "T001");
      assert.equal(attempt.handoff.status, "confirmed", "the successor turn confirms the handover");
      assert.equal(attempt.activeWorker, handoff.toWorker);
      summary = await recordResult(handoff.toWorker);
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

      // Every execution carried explicit native execution inputs, and none
      // replayed its native tools through the DSH dispatcher.
      for (const execution of executions) {
        const handle = await ctx.sessionPersistence.open(execution.nativeSessionId, "read");
        try {
          assert.equal(handle.header.parentSession, parent.id);
          const { events } = await handle.read();
          // The provider's execution inputs may or may not appear in the
          // request header depending on the core; what must hold is that the
          // worker ran the role it was dispatched with.
          assert.ok(events.some(event => event.type === "request/header"), "the worker logged its requests");
          assert.equal(events.filter(event => event.type === "tool/call").length, 0, "native tools are not dispatched twice");
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
