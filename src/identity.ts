/**
 * Live host-agent identity for ordinary delegation.
 *
 * A worker action is authorized by the Agent that issued it, not by a string a
 * caller supplied. The identity is captured once, revalidated against the live
 * registry before every mutation, and converted into the backend's contextual
 * caller, which is what fences one parent Session's workers from another's.
 * @module dsh-codex-app-provider/identity
 */

import type { Agent } from "@deepseek-ai/dsh-agent";
import type { Context } from "@deepseek-ai/cordis";

import type { Caller } from "./browser-types.js";

/** One live parent Agent together with the exact Session it is running. */
export interface HostAgentIdentity {
  agent: Agent;
  session: Agent["session"];
}

/**
 * Capture the identity of the calling Agent, or refuse.
 * @param ctx - host context carrying the live registries.
 * @param agent - the Agent the tool execution ran on behalf of.
 * @returns the captured identity, already validated against the registries.
 * @throws when there is no live parent Agent, or the registries disagree with it.
 */
export function captureAgentIdentity(ctx: Context, agent: Agent | undefined): HostAgentIdentity {
  if (agent === undefined) throw new Error("A live parent agent is required");
  const identity: HostAgentIdentity = { agent, session: agent.session };
  assertAgentIdentity(ctx, identity);
  return identity;
}

/**
 * Revalidate one captured identity against the live registries.
 *
 * A parent that was replaced, disposed or detached from its Session must not be
 * able to keep mutating workers on its old authority.
 * @param ctx - host context carrying the live registries.
 * @param identity - the identity captured before the operation.
 * @throws when the captured Agent or Session is no longer the registered one.
 */
export function assertAgentIdentity(ctx: Context, identity: HostAgentIdentity): void {
  if (ctx.agents.get(identity.agent.id) !== identity.agent
    || ctx.sessions.get(identity.session.id) !== identity.session
    || identity.agent.session !== identity.session) {
    throw new Error("Parent agent identity changed");
  }
}

/**
 * Convert one captured identity into the backend's contextual caller.
 * @param identity - the validated parent identity.
 * @returns the caller the backend fences workers by.
 */
export function agentCaller(identity: HostAgentIdentity): Caller {
  const nativeSessionId = String(identity.session.id);
  return { nativeSessionId, source: "agent", parentAgent: { id: String(identity.agent.id), nativeSessionId } };
}
