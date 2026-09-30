import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

/**
 * The version this plugin reports to the App Server.
 *
 * Read from the manifest rather than written down twice: the package version is
 * the one source of truth, and a stale literal here would misreport the client
 * to the backend after every bump. `lib/rpc.js` and `src/rpc.ts` are both one
 * directory below the manifest.
 */
const PLUGIN_VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

export class RpcError extends Error {
  constructor(message: string, readonly code?: number, readonly data?: unknown) {
    super(message);
  }
}

export class UncertainError extends Error {}

export interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export class AppServer extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private readonly pending = new Map<number, {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: NodeJS.Timeout;
  }>();
  private closed = false;
  /** Recent App Server stderr lines, kept only to explain an unexpected exit. */
  private readonly diagnostics: string[] = [];

  constructor(readonly options: { command?: string; args?: string[]; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}) {
    super();
  }

  async connect(): Promise<void> {
    if (this.child !== undefined) throw new Error("App server already started");
    this.child = spawn(this.options.command ?? "codex", this.options.args ?? ["app-server", "--stdio"], {
      stdio: "pipe",
      // A gated runtime is told where its hook transport lives through the
      // spawn environment; the process environment itself is never modified, so
      // an ungated runtime keeps exactly the environment it had.
      ...(this.options.env === undefined ? {} : { env: { ...process.env, ...this.options.env } }),
    });
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", line => {
      try {
        const value: unknown = JSON.parse(line);
        if (typeof value !== "object" || value === null) throw new Error("Invalid RPC message");
        const message = value as RpcMessage;
        if (typeof message.method === "string") {
          this.emit(message.id === undefined ? "notification" : "request", message);
          return;
        }
        if (typeof message.id !== "number") throw new Error("Invalid RPC envelope");
        const pending = this.pending.get(message.id);
        if (pending === undefined) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error !== undefined) {
          pending.reject(new RpcError(message.error.message ?? "RPC request failed", message.error.code, message.error.data));
        } else if ("result" in message) {
          pending.resolve(message.result);
        } else {
          pending.reject(new UncertainError("Malformed RPC response; execution state unknown"));
        }
      } catch (error) {
        this.disconnect(new UncertainError(`Invalid app-server stream: ${String(error)}`));
      }
    });
    this.child.stderr.on("data", chunk => {
      const text = String(chunk);
      // The App Server explains a refusal on stderr and then exits; keep the tail
      // so the resulting uncertain-execution error names the real reason.
      this.diagnostics.push(...text.split("\n").filter(line => line.trim() !== ""));
      if (this.diagnostics.length > 20) this.diagnostics.splice(0, this.diagnostics.length - 20);
      this.emit("diagnostic", text);
    });
    this.child.on("error", error => { this.disconnect(new UncertainError(error.message)); });
    this.child.stdin.on("error", error => { this.disconnect(new UncertainError(error.message)); });
    this.child.on("exit", (code, signal) => {
      lines.close();
      const reason = this.diagnostics.slice(-4).join(" | ");
      this.disconnect(new UncertainError(`App server exited (${code ?? signal})${reason === "" ? "" : `: ${reason}`}; execution state unknown`));
    });
    await this.request("initialize", {
      clientInfo: { name: "dsh-codex-app-provider", version: PLUGIN_VERSION },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: "initialized" });
  }

  request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (this.child === undefined || this.closed) {
      return Promise.reject(new UncertainError("App server disconnected"));
    }
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new UncertainError(`${method} response timed out; do not redispatch`);
        reject(error);
        this.emit("uncertain", error);
      }, this.options.timeoutMs ?? 30_000);
      this.pending.set(id, { resolve: value => { resolve(value as T); }, reject, timer });
      this.send({ id, method, params });
    });
  }

  respond(id: number | string, result: unknown): void {
    this.send({ id, result });
  }

  reject(id: number | string, message: string): void {
    this.send({ id, error: { code: -32601, message } });
  }

  async close(): Promise<void> {
    const child = this.child;
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>(resolve => { child.once("exit", () => { resolve(); }); });
    child.stdin.end();
    const term = setTimeout(() => { child.kill("SIGTERM"); }, 1_000);
    const kill = setTimeout(() => { child.kill("SIGKILL"); }, 3_000);
    await exited;
    clearTimeout(term);
    clearTimeout(kill);
  }

  private send(message: RpcMessage): void {
    if (this.child === undefined || this.closed) throw new UncertainError("App server disconnected");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private disconnect(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit("uncertain", error);
  }
}
