/**
 * Durable worker-report delivery to the parent Agent.
 *
 * A worker's report is committed before anyone is told, and a notice is only
 * ever *claimed* once per parent Agent, so a restart, a repeated event or a
 * second delivery path cannot make the parent act on the same report twice.
 * An idle parent is woken with `followup`; a busy parent receives the same
 * notice at its next step. Neither path fabricates a decision: acceptance and
 * acknowledgement stay explicit tool actions.
 * @module dsh-codex-app-provider/worker-delivery
 */

import type { Agent } from "@deepseek-ai/dsh-agent";
import type { Context } from "@deepseek-ai/cordis";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

import type { CodexBackend, Report, WorkerProjection } from "./browser-types.js";
import { FACT_PLUGIN } from "./facts.js";
import { agentCaller, assertAgentIdentity, captureAgentIdentity, type HostAgentIdentity } from "./identity.js";

/** A placement whose ownership is unknown, reported as a notice rather than a result. */
interface UnknownReport {
  workerId: string;
  threadId?: string;
  turnId?: string;
  status: "unknown";
  result: string;
}

/** The installed delivery consumer for one backend. */
export interface WorkerDelivery {
  /** Subscribe one parent Agent and flush anything it has not been told yet. */
  refresh(identity: HostAgentIdentity): Promise<void>;
  close(): void;
}

/**
 * Install the report-delivery consumer for one backend.
 * @param ctx - host context carrying the Agent registry and lifecycle events.
 * @param backend - the single Codex backend whose workers report.
 * @returns the delivery handle the tool surface refreshes after each action.
 */
export function installWorkerDelivery(ctx: Context, backend: CodexBackend): WorkerDelivery {
  if (consumers.has(backend)) throw new Error("Codex worker report delivery is already installed");
  consumers.add(backend);
  const sent = new WeakMap<Agent, Set<string>>();
  const parents = new Map<Agent, () => void>();
  const hooks: Array<() => void> = [];
  let closed = false;

  const candidates = async (identity: HostAgentIdentity): Promise<Array<Report | UnknownReport>> => {
    const caller = agentCaller(identity);
    const [reports, workers] = await Promise.all([backend.pendingReports(caller), backend.listWorkers(caller)]);
    return [...reports, ...workers.filter(unknownWorker).map(unknownReport)];
  };
  const claim = async (identity: HostAgentIdentity, idleOnly: boolean): Promise<Array<Report | UnknownReport>> => {
    const reports = await candidates(identity);
    assertAgentIdentity(ctx, identity);
    if (closed || (idleOnly && identity.agent.status !== "idle")) return [];
    const keys = sent.get(identity.agent) ?? new Set<string>();
    const claimed = reports.filter(report => !keys.has(key(report)));
    if (claimed.length > 0) sent.set(identity.agent, keys);
    for (const report of claimed) keys.add(key(report));
    return claimed;
  };
  const withdraw = (identity: HostAgentIdentity, reports: readonly (Report | UnknownReport)[]): void => {
    for (const report of reports) sent.get(identity.agent)?.delete(key(report));
  };
  const flush = async (identity: HostAgentIdentity): Promise<void> => {
    const reports = await claim(identity, true);
    if (reports.length === 0) return;
    try {
      assertAgentIdentity(ctx, identity);
      identity.agent.followup(notice(reports));
    } catch (error) {
      // A notice that never reached the model is not delivered: let the next
      // event re-claim it instead of losing the report.
      withdraw(identity, reports);
      ctx.logger.warn(`Codex report remains pending: ${String(error)}`);
    }
  };
  const schedule = (identity: HostAgentIdentity): void => {
    queueMicrotask(() => void flush(identity).catch(error => ctx.logger.warn(`Codex report delivery failed: ${String(error)}`)));
  };
  const release = (agent: Agent): void => { parents.get(agent)?.(); parents.delete(agent); };
  const refresh = async (identity: HostAgentIdentity): Promise<void> => {
    assertAgentIdentity(ctx, identity);
    if (closed) return;
    if (!parents.has(identity.agent)) {
      const off = backend.subscribeWorkers(agentCaller(identity), () => schedule(identity));
      try {
        assertAgentIdentity(ctx, identity);
        parents.set(identity.agent, off);
      } catch (error) {
        off();
        throw error;
      }
    }
    schedule(identity);
  };
  const close = (): void => {
    if (closed) return;
    closed = true;
    for (const off of parents.values()) off();
    parents.clear();
    for (const off of hooks.splice(0)) off();
    consumers.delete(backend);
  };
  try {
    // `agent/created` declares an undefined result, so the handler reports the
    // start as a statement and returns nothing rather than forwarding `void`.
    hooks.push(ctx.on("agent/created", ({ agent }) => { start(agent); return undefined; }));
    hooks.push(ctx.on("agent/disposed", ({ agent }) => release(agent)));
    hooks.push(ctx.on("session/disposed", session => { for (const agent of parents.keys()) if (agent.session === session) release(agent); }));
    hooks.push(ctx.on("agent/status", ({ agent, status }) => { if (status === "idle") start(agent); }));
    hooks.push(ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
      const identity = captureAgentIdentity(ctx, agent), decision = await next();
      if (closed || signal.aborted || decision.kind !== "enter") return decision;
      const reports = await claim(identity, false);
      if (reports.length === 0) return decision;
      try {
        assertAgentIdentity(ctx, identity);
        return { ...decision, messages: [...decision.messages, notice(reports)] };
      } catch (error) {
        withdraw(identity, reports);
        throw error;
      }
    }));
    ctx.effect(() => close, "codex worker report delivery");
    for (const agent of ctx.agents.list()) start(agent);
  } catch (error) {
    close();
    throw error;
  }
  return { refresh, close };

  function start(agent: Agent): void {
    try {
      void refresh(captureAgentIdentity(ctx, agent)).catch(error => ctx.logger.warn(`Codex worker refresh failed: ${String(error)}`));
    } catch (error) {
      ctx.logger.warn(`Codex worker identity unavailable: ${String(error)}`);
    }
  }
}

/** One backend owns exactly one delivery consumer. */
const consumers = new WeakSet<CodexBackend>();

function unknownWorker(worker: WorkerProjection): boolean {
  return worker.owner === "agent" && (worker.state === "unknown" || (worker.state === "saved" && worker.savedState !== "idle"));
}

function unknownReport(worker: WorkerProjection): UnknownReport {
  return {
    workerId: worker.id,
    ...(worker.threadId === undefined ? {} : { threadId: worker.threadId }),
    ...(worker.turnId === undefined ? {} : { turnId: worker.turnId }),
    status: "unknown",
    result: "Execution status unknown; recover and confirm the original worker/turn. Do not dispatch a replacement.",
  };
}

function key(report: Report | UnknownReport): string {
  return `${report.workerId}/${report.turnId ?? ""}/${report.status}`;
}

/**
 * The one notice shape the parent model sees.
 *
 * It is plugin-sourced, explicitly a notice (not a human prompt), and states
 * both what to do and what not to do, because a repeated notice must never cause
 * repeated work.
 */
function notice(reports: readonly (Report | UnknownReport)[]) {
  return createUserMessage({
    content: [{
      type: "text",
      text: "Codex worker reports are ready. Process each independently, then accept, request changes, or acknowledge it. "
        + "Do not repeat work merely because a notice is repeated.\n"
        + reports.map(report => JSON.stringify(report)).join("\n"),
    }],
    source: { kind: FACT_PLUGIN, form: "notice", summary: `${reports.length} Codex report(s) ready` },
  });
}
