/**
 * The browser-facing availability check route.
 *
 * The provider ships no page of its own, so the settings page needs one narrow
 * carrier to ask the Host "can this deployment start Codex, and what does it
 * advertise". Only one owner-only action exists (`check`), the request envelope
 * is the same Connection contract every client channel uses, and the answer is
 * the cached probe result — this route starts no process beyond the probe's own
 * one-shot `--version` and model catalog read.
 * @module dsh-codex-app-provider/check-rpc
 */

import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-connection";
import type { ConnectionTrustRequest, HostConnectionHandle } from "@deepseek-ai/dsh-client-connection";
import { clientRequestSchema, serverResponseSchema } from "@deepseek-ai/dsh-client-connection";
import type { CodexAvailability } from "./check.js";

/** The one channel path this provider serves. */
const CHANNEL = "/codex-app";
/** One buffered browser request; the envelope carries a boolean at most. */
const MAX_REQUEST_BODY_BYTES = 64 * 1024;
const INVALID_REQUEST_RPC_ID = "invalid-request";

/** HTTP carrier facts this channel reads; `node:http` requests satisfy it structurally. */
interface RpcRequest extends ConnectionTrustRequest {
  readonly url?: string | undefined;
  readonly method?: string | undefined;
  [Symbol.asyncIterator](): AsyncIterator<Buffer | string>;
}

/** HTTP carrier the Web server hands a route; `node:http` responses satisfy it. */
interface RpcResponse {
  readonly writableEnded?: boolean | undefined;
  on(event: "close", listener: () => void): unknown;
  writeHead(status: number, headers?: Readonly<Record<string, string>>): unknown;
  end(body?: string): unknown;
}

/** Route carrier the Web server exposes. */
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

/**
 * Serve the owner-only availability check.
 * @param ctx - the Host context carrying Connection and the Web server.
 * @param check - the cached probe the action calls.
 */
export function installCodexAppRpc(ctx: Context, check: (force: boolean) => Promise<CodexAvailability>): void {
  ctx.inject(["connection", "webServer"], scope => {
    const respond = (res: RpcResponse, status: number, body?: unknown): void => {
      if (body === undefined) { res.writeHead(status); res.end(); return; }
      const payload = JSON.stringify(body);
      res.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) });
      res.end(payload);
    };
    const envelope = (res: RpcResponse, status: number, rpcId: unknown, result: unknown): void => {
      respond(res, status, serverResponseSchema.parse({
        type: "server-response",
        rpcId: typeof rpcId === "string" ? rpcId : INVALID_REQUEST_RPC_ID,
        result,
      }));
    };
    scope.effect(() => scope.webServer.register({
      kind: "prefix",
      path: CHANNEL,
      handler: async (req: RpcRequest, res: RpcResponse) => {
        const connection: HostConnectionHandle = scope.connection;
        const admission = connection.admit(req);
        if ("rejection" in admission) { respond(res, admission.rejection); return; }
        if (admission.peer.principal.kind !== "owner") { respond(res, 403); return; }
        if (req.method !== "POST") { respond(res, 404); return; }
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
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { respond(res, 400, "body is not JSON"); return; }
        const parsed = clientRequestSchema.safeParse(body);
        if (!parsed.success) {
          envelope(res, 400, (body as { rpcId?: unknown } | null)?.rpcId, {
            ok: false, error: { code: "codex-app/rejected", message: "Invalid request envelope", details: {} },
          });
          return;
        }
        const message = parsed.data;
        if (message.method !== "check") {
          envelope(res, 200, message.rpcId, {
            ok: false, error: { code: "codex-app/rejected", message: `Unknown action ${JSON.stringify(message.method)}`, details: {} },
          });
          return;
        }
        const payload = message.payload as { force?: unknown } | null;
        try {
          envelope(res, 200, message.rpcId, { ok: true, value: await check(payload?.force === true) });
        } catch (error) {
          envelope(res, 200, message.rpcId, {
            ok: false,
            error: { code: "codex-app/rejected", message: error instanceof Error ? error.message : String(error), details: {} },
          });
        }
      },
    }), `dsh-codex-app-provider: ${CHANNEL} check route`);
  });
}
