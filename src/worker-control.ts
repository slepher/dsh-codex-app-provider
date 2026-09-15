/**
 * Native request bridging for ordinary Codex workers.
 *
 * A `codex_workers` turn is started by the tool rather than by an
 * `adapter.stream` call, so no stream loop watches the worker's Session and a
 * request Codex addresses to the user would be recorded and left waiting. This
 * installs the provider's bridge for every worker a parent Agent owns, before
 * the turn that needs it and again after an action that may have created one,
 * and drops a watch once its worker leaves the group. Per-child ownership stays
 * the backend's: the watch is installed through the same validated caller every
 * other worker operation uses.
 * @module dsh-codex-app-provider/worker-control
 */

import type { Agent } from "@deepseek-ai/dsh-agent";
import type { Context } from "@deepseek-ai/cordis";

import type { Caller, WorkerProjection } from "./browser-types.js";
import { agentCaller, assertAgentIdentity, type HostAgentIdentity } from "./identity.js";

/** Subscribe one worker's native requests to its parent Agent; returns the unsubscribe. */
export type WatchWorkerRequests = (caller: Caller, workerId: string, agent: Agent) => () => void;

/** What the control module reads from the backend and the provider bridge. */
export interface WorkerControlDeps {
  /** The open workers one validated parent caller owns. */
  listWorkers(caller: Caller): Promise<readonly Pick<WorkerProjection, "id">[]>;
  /** The provider bridge that carries one worker's native requests to the user. */
  watchWorkerRequests: WatchWorkerRequests;
}

/** The installed bridge for one backend. */
export interface WorkerControl {
  /** Ensure every worker of this parent Agent is watched before its next action. */
  ensure(identity: HostAgentIdentity): Promise<void>;
  /** Stop every watch. */
  close(): void;
}

/**
 * Install the ordinary-worker request bridge.
 * @param ctx - host context carrying the Agent and Session registries.
 * @param deps - the backend listing and the provider bridge to install.
 * @returns the control handle the tool surface refreshes around each action.
 */
export function installWorkerControl(ctx: Context, deps: WorkerControlDeps): WorkerControl {
  /** One parent Session's watches, keyed by worker id, with the Agent that answers. */
  const watched = new Map<string, { agent: Agent; off: Map<string, () => void> }>();
  const hooks: Array<() => void> = [];
  let closed = false;

  const drop = (sessionId: string): void => {
    const entry = watched.get(sessionId);
    if (entry === undefined) return;
    watched.delete(sessionId);
    for (const off of entry.off.values()) off();
  };
  const ensure = async (identity: HostAgentIdentity): Promise<void> => {
    assertAgentIdentity(ctx, identity);
    if (closed) return;
    const caller = agentCaller(identity), sessionId = String(identity.session.id);
    const workers = await deps.listWorkers(caller);
    // The caller is revalidated after the async read, exactly as a mutation is.
    assertAgentIdentity(ctx, identity);
    const entry = watched.get(sessionId) ?? { agent: identity.agent, off: new Map<string, () => void>() };
    watched.set(sessionId, entry);
    const present = new Set(workers.map(worker => worker.id));
    // A worker that left the group keeps no watch; the backend already dropped
    // its own subscribers, so this only releases the handle.
    for (const id of [...entry.off.keys()]) {
      if (present.has(id)) continue;
      entry.off.get(id)!();
      entry.off.delete(id);
    }
    for (const id of present) {
      if (entry.off.has(id)) continue;
      const off = deps.watchWorkerRequests(caller, id, entry.agent);
      assertAgentIdentity(ctx, identity);
      entry.off.set(id, off);
    }
  };
  const close = (): void => {
    if (closed) return;
    closed = true;
    for (const sessionId of [...watched.keys()]) drop(sessionId);
    for (const off of hooks.splice(0)) off();
  };
  try {
    hooks.push(ctx.on("agent/disposed", ({ agent }) => drop(String(agent.session.id))));
    hooks.push(ctx.on("session/disposed", session => drop(String(session.id))));
    ctx.effect(() => close, "codex worker request control");
  } catch (error) {
    close();
    throw error;
  }
  return { ensure, close };
}
