#!/usr/bin/env node
/**
 * Scripted Codex App Server for deterministic integration runs.
 *
 * Speaks the same stdio JSON-RPC the provider drives (`initialize`, the thread
 * lifecycle, `turn/start`, `model/list`, `config/read`) and answers every turn
 * with a scripted `turn/started`, one completed `commandExecution` item, one
 * final `agentMessage` and `turn/completed`. Thread metadata is persisted per
 * thread id under `DSH_FAKE_CODEX_STATE`, so a temporary reader process (the one
 * `thread/read` hand-off verification spawns) sees the same cwd as the process
 * that created the thread.
 *
 * Every inbound request is appended to `DSH_FAKE_CODEX_LOG` as one JSON line, so
 * a test can assert which native calls actually happened, in order.
 *
 * Environment:
 *   DSH_FAKE_CODEX_LOG             request log path (JSONL)
 *   DSH_FAKE_CODEX_STATE           durable thread-state directory
 *   DSH_FAKE_CODEX_FINAL           final assistant text (default "fake-final-answer")
 *   DSH_FAKE_CODEX_COMMAND_OUTPUT  command item output (default "fake-command-output")
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { join } from "node:path";

const logPath = process.env.DSH_FAKE_CODEX_LOG;
const stateDir = process.env.DSH_FAKE_CODEX_STATE ?? join(process.cwd(), ".fake-codex-state");
const finalText = process.env.DSH_FAKE_CODEX_FINAL ?? "fake-final-answer";
const commandOutput = process.env.DSH_FAKE_CODEX_COMMAND_OUTPUT ?? "fake-command-output";

mkdirSync(stateDir, { recursive: true });

const write = message => { process.stdout.write(`${JSON.stringify(message)}\n`); };
const notify = (method, params) => write({ method, params });
const remember = (threadId, state) => writeFileSync(join(stateDir, `${encodeURIComponent(threadId)}.json`), JSON.stringify(state));
const recall = threadId => {
  try { return JSON.parse(readFileSync(join(stateDir, `${encodeURIComponent(threadId)}.json`), "utf8")); }
  catch { return undefined; }
};

let turnCounter = 0;

/**
 * The configuration the App Server reports it applied for one thread request.
 *
 * The report is derived from the request the way real Codex derives it: the
 * `dsh-task` permissions profile when one was sent, otherwise the explicitly
 * requested sandbox mode, otherwise Codex's own configuration (reported as
 * absent). Approval policy is only ever what the request declared — this fake
 * never invents one, exactly as an unmodified App Server would not.
 */
function applied(params) {
  const permissions = params.config?.permissions?.["dsh-task"];
  const writableRoots = permissions === undefined
    ? []
    : Object.entries(permissions.filesystem).filter(([, mode]) => mode === "write").map(([path]) => path);
  return {
    cwd: params.cwd,
    model: params.model ?? "luna",
    reasoningEffort: params.config?.model_reasoning_effort,
    ...(params.approvalPolicy === undefined ? {} : { approvalPolicy: params.approvalPolicy }),
    sandbox: permissions !== undefined ? {
      type: "workspaceWrite",
      writableRoots,
      excludeSlashTmp: true,
      excludeTmpdirEnvVar: true,
      networkAccess: permissions.network?.enabled === true,
    } : params.sandbox !== undefined ? { type: params.sandbox === "read-only" ? "readOnly" : "workspaceWrite", writableRoots, excludeSlashTmp: true, excludeTmpdirEnvVar: true, networkAccess: false } : undefined,
  };
}

function threadResult(threadId, state) {
  return {
    cwd: state.cwd,
    thread: { id: threadId, status: { type: "idle" }, turns: [], cwd: state.cwd },
    model: state.model,
    ...(state.reasoningEffort === undefined ? {} : { reasoningEffort: state.reasoningEffort }),
    ...(state.approvalPolicy === undefined ? {} : { approvalPolicy: state.approvalPolicy }),
    ...(state.sandbox === undefined ? {} : { sandbox: state.sandbox }),
  };
}

function completeTurn(threadId, id) {
  notify("turn/started", { threadId, turn: { id, status: "inProgress" } });
  notify("item/completed", { threadId, turnId: id, item: {
    id: `item-${id}`, type: "commandExecution", command: "run-fake-command", status: "completed",
    exitCode: 0, cwd: recall(threadId)?.cwd, aggregatedOutput: `${commandOutput}\n` } });
  notify("item/completed", { threadId, turnId: id, item: { type: "agentMessage", phase: "final_answer", text: finalText } });
  notify("turn/completed", { threadId, turn: { id, status: "completed" } });
}
const lines = createInterface({ input: process.stdin });
lines.on("line", line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (typeof message?.method !== "string") return;
  const params = message.params ?? {};
  if (logPath !== undefined) appendFileSync(logPath, `${JSON.stringify({ method: message.method, params })}\n`);
  const reply = result => { if (message.id !== undefined) write({ id: message.id, result }); };
  switch (message.method) {
    case "initialize": return reply({ userAgent: "fake-codex-app-server" });
    case "initialized": return;
    case "model/list": return reply({ data: [{ id: "luna", model: "luna", displayName: "Luna", defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Fast" }, { reasoningEffort: "medium", description: "Balanced" }, { reasoningEffort: "high", description: "Deep" }] },
      { id: "sol", model: "sol", displayName: "Sol", defaultReasoningEffort: "high",
        supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }, { reasoningEffort: "high", description: "Deep" }] }], nextCursor: null });
    case "config/read": return reply({ config: { model: "luna", model_reasoning_effort: "high", model_context_window: 200000 } });
    case "thread/list": return reply({ data: [], nextCursor: null });
    case "skills/list": return reply({ data: [] });
    case "thread/start": {
      const threadId = `thread-${randomUUID()}`;
      const state = applied(params);
      remember(threadId, state);
      return reply(threadResult(threadId, state));
    }
    case "thread/resume": {
      const threadId = String(params.threadId);
      const state = { ...recall(threadId), ...applied(params) };
      remember(threadId, state);
      return reply(threadResult(threadId, state));
    }
    case "thread/read": {
      const threadId = String(params.threadId);
      const state = recall(threadId);
      return reply(threadResult(threadId, state ?? { cwd: params.cwd, model: params.model ?? "luna" }));
    }
    case "turn/start": {
      const threadId = String(params.threadId);
      const id = `turn-${++turnCounter}`;
      reply({ turn: { id, status: "inProgress" } });
      setImmediate(() => completeTurn(threadId, id));
      return;
    }
    case "turn/interrupt": return reply({});
    case "thread/compact/start": return reply({});
    default: return reply({});
  }
});
