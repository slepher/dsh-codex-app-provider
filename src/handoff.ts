/**
 * Trusted-Host thread handoff surface.
 *
 * The workflow Host continues one assignment on a successor DSH child while the
 * Codex thread stays the same. Only the Host may ask for that transfer: the
 * source record is de-authorized, the successor owns the original thread, and
 * the provider never creates a replacement thread when the binding fails.
 *
 * Every identity here is a DSH Session id, exactly like the workflow Host sees
 * it; the provider owns the native-namespace mapping.
 * @module dsh-codex-app-provider/handoff
 */

import type { ApprovalPolicy, ExecutionBoundary, RunState, SandboxMode } from "./browser-types.js";

/**
 * One controlled native-thread handover from a source DSH Session to a reserved
 * successor DSH Session.
 */
export interface CodexThreadHandoffRequest {
  /** Host request identity; a repeated request reuses its recorded handover. */
  requestId: string;
  /** DSH Session whose thread is handed over. */
  fromSessionId: string;
  /** Reserved successor DSH Session that continues it. */
  toSessionId: string;
  /** Target model and effort the successor runs on. */
  model: string;
  reasoningEffort?: string;
  /** Full execution inputs the successor's first request will carry. */
  developerInstructions?: string;
  boundary?: ExecutionBoundary;
  approvalPolicy?: ApprovalPolicy;
  sandbox?: SandboxMode;
}

/** The recorded outcome of one thread handover. */
export interface CodexThreadHandoffResult {
  toSessionId: string;
  threadId: string;
  state: RunState;
}

/** Read-only view of one DSH Session's native thread ownership. */
export interface CodexThreadOwnership {
  sessionId: string;
  threadId?: string;
  /** Successor DSH Session that now owns the thread, when this one handed it over. */
  handedOffTo?: string;
  /** Source DSH Session that handed the thread over, when this one continues it. */
  handoffFrom?: string;
}

/**
 * Trusted-Host access to controlled thread handover. Ordinary children never
 * receive it: the provider publishes it as `ctx.codexHandoff` for the workflow
 * Host only, the same way `ctx.codexExecution` exposes read-only facts.
 */
export interface CodexThreadHandoffService {
  /** Hand a stopped source's thread to the reserved successor. */
  handoff(request: CodexThreadHandoffRequest): Promise<CodexThreadHandoffResult>;
  /** Read one DSH Session's recorded thread ownership; performs no model request. */
  read(nativeSessionId: string): Promise<CodexThreadOwnership | undefined>;
}

/**
 * The provider's native Session id for one DSH Session. The mapping is the
 * provider's own namespace, so it lives next to the seam that translates
 * between them.
 */
export const nativeSessionId = (sessionId: string): string => `codex:${sessionId}`;

/** The DSH Session id behind one provider-native Session id. */
export const dshSessionId = (native: string): string =>
  native.startsWith("codex:") ? native.slice("codex:".length) : native;

declare module "@deepseek-ai/cordis" {
  interface Context { codexHandoff: CodexThreadHandoffService }
}
