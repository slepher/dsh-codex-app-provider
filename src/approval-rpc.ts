/**
 * The plugin's own channel for Codex approval decisions.
 *
 * Codex owns its approval configuration, so the plugin must not hand a native
 * request to DSH's approval service for a second policy judgement. A request
 * that reaches the client is one Codex decided it cannot settle itself; it is
 * published here and answered from the plugin's own child pane with the real
 * decision. The channel reuses the public Connection trust fence and envelope
 * format, registers its route on the injecting Context (the Connection-owned
 * registry reads a webServer its own fiber does not declare), and defers every
 * state check to the backend request state machine, which keeps each decision
 * bound to its Session, thread, turn and request identity.
 * @module dsh-codex-app-provider/approval-rpc
 */

import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-connection";
import type { ConnectionRpcResult, ConnectionTrustRequest, HostConnectionHandle } from "@deepseek-ai/dsh-client-connection";
import { clientRequestSchema, serverResponseSchema } from "@deepseek-ai/dsh-client-connection";
import type {} from "@deepseek-ai/dsh-session-persistence";
import { SessionId } from "@deepseek-ai/dsh-session";

import type { ApprovalDecision, ApprovalRequest, CodexBackend } from "./browser-types.js";
import { CODEX_OWNER_ID, backendSessionId } from "./provider.js";

const CHANNEL = "/codex-approval";
/** The browser carrier buffers one JSON body; approval payloads are small. */
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const INVALID_REQUEST_RPC_ID = "invalid-request";

/** One pending native approval as the child pane renders it. */
export interface CodexApprovalView {
  requestId: string;
  turnId: string;
  method: string;
  /** Human-readable account of what Codex is asking about. */
  reason: string;
}

/** Whether this composition can reach an interactive client for a decision. */
export interface ApprovalChannelState {
  interactive: boolean;
}

/** HTTP carrier facts this channel reads; the Web server's `node:http` request satisfies it structurally. */
interface RpcRequest extends ConnectionTrustRequest {
  readonly url?: string | undefined;
  readonly method?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  [Symbol.asyncIterator](): AsyncIterator<Buffer | string>;
}

/** HTTP carrier the Web server hands a route; `node:http` `ServerResponse` satisfies it structurally. */
interface RpcResponse {
  writeHead(status: number, headers?: Readonly<Record<string, string>>): unknown;
  end(body?: string): unknown;
}

/** Route carrier the Web server exposes; the package's `WebServer` satisfies it structurally. */
interface WebServer {
  register(route: { kind: "prefix"; path: string; handler: (req: RpcRequest, res: RpcResponse) => Promise<void> }): () => void;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    webServer: WebServer;
  }
}

/** Read one carrier header; the request exposes either Fetch `Headers` or a node header record. */
function headerOf(request: ConnectionTrustRequest, name: string): string | undefined {
  if (typeof Headers !== "undefined" && request.headers instanceof Headers) return request.headers.get(name) ?? undefined;
  const value = (request.headers as Readonly<Record<string, string | readonly string[] | undefined>>)[name];
  return typeof value === "string" ? value : value?.[0];
}

/** Absolute endpoint segments below the channel prefix; an empty or malformed path has none. */
function endpointOf(pathname: string): string | undefined {
  if (!pathname.startsWith(`${CHANNEL}/`)) return undefined;
  const endpoint = pathname.slice(CHANNEL.length + 1);
  const malformed = endpoint.split("/").some(segment => segment === "" || segment === "." || segment === ".."
    || !/^[A-Za-z0-9_$.-]+$/.test(segment));
  return malformed ? undefined : endpoint;
}

/** The human account of one native approval request. */
export function approvalReason(request: ApprovalRequest): string {
  const params = typeof request.params === "object" && request.params !== null ? request.params as Record<string, unknown> : {};
  if (typeof params.reason === "string" && params.reason.trim() !== "") return params.reason;
  if (typeof params.command === "string" && params.command.trim() !== "") return params.command;
  if (typeof params.grantRoot === "string" && params.grantRoot.trim() !== "") return `write access under ${params.grantRoot}`;
  return request.method;
}

/** Project one pending request into the pane's view. */
function approvalView(request: ApprovalRequest): CodexApprovalView {
  return { requestId: request.requestId, turnId: request.turnId, method: request.method, reason: approvalReason(request) };
}

/**
 * Mount the approval channel for one backend.
 *
 * Registers the route only when the composition has both a Connection trust
 * fence and a web server; the returned disposer clears the channel state so a
 * composition that lost its client stops waiting on one.
 * @param ctx - the injecting Context that owns the route.
 * @param backend - the backend whose pending requests are answered.
 * @param state - shared flag the provider reads to decide fail-closed behaviour.
 * @returns a disposer that unmounts the route.
 */
export function installApprovalRpc(ctx: Context, backend: CodexBackend, state: ApprovalChannelState): () => void {
  const scope = ctx as unknown as Context & {
    connection: HostConnectionHandle;
    webServer: WebServer;
    sessions: { get(id: unknown): { header?: { id?: unknown } } | undefined };
    get(name: string): unknown;
    effect(fn: () => (() => void), name?: string): unknown;
  };
  const dispose = scope.effect(() => scope.webServer.register({
    kind: "prefix",
    path: CHANNEL,
    handler: async (req: RpcRequest, res: RpcResponse) => {
      const connection = scope.connection;
      const rejection = connection.requestRejection(req);
      if (rejection !== undefined) { respond(res, rejection, rejection === 401 ? "unauthorized" : "forbidden"); return; }
      const endpoint = endpointOf(new URL(req.url ?? "/", "http://dsh.internal").pathname);
      if (req.method !== "POST" || endpoint === undefined) { respond(res, 404); return; }
      if (headerOf(req, "content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") { respond(res, 415); return; }
      const declaredLength = headerOf(req, "content-length");
      if (declaredLength !== undefined && Number(declaredLength) > MAX_REQUEST_BODY_BYTES) { respond(res, 413); return; }
      const chunks: Buffer[] = [];
      let received = 0;
      for await (const chunk of req) {
        received += (chunk as Buffer).byteLength;
        if (received > MAX_REQUEST_BODY_BYTES) { respond(res, 413); return; }
        chunks.push(chunk as Buffer);
      }
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { respond(res, 400, "body is not JSON"); return; }
      const parsed = clientRequestSchema.safeParse(body);
      if (!parsed.success) {
        envelope(res, 400, (body as { rpcId?: unknown } | null)?.rpcId,
          { ok: false, error: { code: "codex/rejected", message: "Invalid approval request envelope", details: {} } });
        return;
      }
      const message = parsed.data;
      if (message.method !== endpoint) {
        envelope(res, 200, message.rpcId, { ok: false,
          error: { code: "codex/rejected", message: `method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(endpoint)}`, details: {} } });
        return;
      }
      envelope(res, 200, message.rpcId, await dispatch(endpoint, message.payload, req.signal ?? new AbortController().signal));
    },
  }), `dsh-codex-app-provider: ${CHANNEL} rpc channel`);
  state.interactive = true;

  /** One channel call: the body returns the canonical value, the wrapper owns the envelope. */
  function dispatch(endpoint: string, payload: unknown, signal: AbortSignal): Promise<ConnectionRpcResult<unknown>> {
    const operation = (async () => {
      signal.throwIfAborted();
      if (endpoint !== "pending" && endpoint !== "decide") throw new Error("Unknown approval endpoint");
      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid approval request");
      const value = payload as Record<string, unknown>;
      const fields = endpoint === "pending" ? ["sessionId"] : ["sessionId", "requestId", "decision"];
      if (Object.keys(value).some(key => !fields.includes(key)) || typeof value.sessionId !== "string" || !value.sessionId) {
        throw new Error("A native Session address is required; caller identities are not accepted");
      }
      const sessionId = value.sessionId;
      const id = SessionId(sessionId);
      const persistence = scope.get("sessionPersistence") as
        { stat?(session: unknown, options: { signal: AbortSignal }): Promise<{ header?: { id?: unknown } } | undefined> } | undefined;
      const header = scope.sessions.get(id)?.header ?? (await persistence?.stat?.(id, { signal }))?.header;
      signal.throwIfAborted();
      if (header?.id !== id) throw new Error("Native Session is unavailable");
      const session = await backend.readSession(CODEX_OWNER_ID, backendSessionId(sessionId));
      if (session === undefined) throw new Error("This Session has no Codex execution");
      const pending = () => backend.pendingApprovals(CODEX_OWNER_ID, backendSessionId(sessionId));
      if (endpoint === "pending") return { approvals: (await pending()).map(approvalView) };
      if (typeof value.requestId !== "string" || !value.requestId) throw new Error("requestId is required");
      if (value.decision !== "accept" && value.decision !== "decline" && value.decision !== "cancel") throw new Error("Unknown approval decision");
      // The decision must name a request this Session still has pending; the
      // backend then re-checks that it belongs to the live thread and turn, so a
      // stale or forged response can never apply to a later turn.
      if (!(await pending()).some(request => request.requestId === value.requestId)) {
        throw new Error("Approval is no longer pending for this Session");
      }
      await backend.decideApproval(CODEX_OWNER_ID, value.requestId, value.decision as ApprovalDecision);
      return { decided: true };
    })();
    return operation.then(
      value => ({ ok: true as const, value }),
      error => ({ ok: false as const, error: { code: "codex/rejected", message: error instanceof Error ? error.message : String(error), details: {} } }),
    );
  }

  function respond(res: RpcResponse, status: number, body?: unknown): void {
    if (body === undefined) { res.writeHead(status); res.end(); return; }
    const text = String(body);
    res.writeHead(status, { "content-type": "text/plain", "content-length": String(Buffer.byteLength(text)) });
    res.end(text);
  }

  function envelope(res: RpcResponse, status: number, rpcId: unknown, result: ConnectionRpcResult<unknown>): void {
    const payload = JSON.stringify(serverResponseSchema.parse({ type: "server-response",
      rpcId: typeof rpcId === "string" ? rpcId : INVALID_REQUEST_RPC_ID, result }));
    res.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) });
    res.end(payload);
  }

  return () => {
    state.interactive = false;
    if (typeof dispose === "function") dispose();
  };
}
