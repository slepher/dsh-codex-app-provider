import type { ConnectionHandle } from "@deepseek-ai/dsh-client-connection/client";
import type { CodexApprovalView } from "../approval-rpc.js";

/** One native approval decision the pane can return. */
export type CodexApprovalDecision = "accept" | "decline" | "cancel";

/** Browser calls this plugin makes on its own `/codex-approval` channel. */
export interface CodexApprovalRpc {
  /** Native approvals this Session's Codex execution is still waiting on. */
  pending(sessionId: string, signal?: AbortSignal): Promise<readonly CodexApprovalView[]>;
  /** Return the real decision for one pending request. */
  decide(sessionId: string, requestId: string, decision: CodexApprovalDecision, signal?: AbortSignal): Promise<void>;
}

/**
 * Wrap the plugin's own approval channel in typed calls.
 *
 * The pane answers native approvals here instead of through DSH's approval
 * service, whose per-Session policy would decide for Codex.
 * @param connection - the client connection carrying the authenticated channel.
 * @returns the call face the child pane uses.
 */
export function createCodexApprovalRpc(connection: ConnectionHandle): CodexApprovalRpc {
  const call = async <T>(method: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> => {
    const result = await connection.rpc.call("/codex-approval", method, payload, signal);
    if (!result.ok) throw new Error(result.error.message);
    return result.value as T;
  };
  return {
    pending: async (sessionId, signal) => (await call<{ approvals: CodexApprovalView[] }>("pending", { sessionId }, signal)).approvals,
    decide: async (sessionId, requestId, decision, signal) => { await call("decide", { sessionId, requestId, decision }, signal); },
  };
}
