import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

import {
  nodeSpawner,
  nodeTimer,
  type AppServerChild,
  type AppServerSpawner,
  type AppServerSpawnSpec,
  type AppServerTimer,
} from "./process.js";
import { resolveCodexCommand } from "./command.js";

/**
 * The version this plugin reports to the App Server.
 *
 * Read from the manifest rather than written down twice: the package version is
 * the one source of truth, and a stale literal here would misreport the client
 * to the backend after every bump. `lib/rpc.js` and `src/rpc.ts` are both one
 * directory below the manifest.
 */
const PLUGIN_VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

/**
 * How long a closing App Server may take to exit on its own.
 *
 * The transport closes the child's stdin first and treats an exit inside this
 * window as the clean shutdown; only then does the provider's own termination
 * procedure start.
 */
const SHUTDOWN_GRACE_MS = 1_000;

/**
 * The provider's TERM-to-KILL window for one termination request.
 *
 * Chosen so the escalation ladder matches the one this transport used before
 * it delegated process ownership: TERM at the close deadline, KILL two seconds
 * later.
 */
const TERMINATION_GRACE_MS = 2_000;

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

export interface AppServerOptions {
  /** Program to run; `codex` by default. */
  command?: string;
  /** Arguments; `app-server --stdio` by default. */
  args?: string[];
  /** Deadline for one request/response exchange. */
  timeoutMs?: number;
  /** Environment overrides merged over this process's own environment. */
  env?: NodeJS.ProcessEnv;
  /** The process capability; `nodeSpawner()` when the deployment provides none. */
  spawner?: AppServerSpawner;
  /** The timer capability; `nodeTimer()` when the deployment provides none. */
  timer?: AppServerTimer;
}

/**
 * The Codex App Server speaking JSON-RPC over stdio.
 *
 * This class owns the protocol: line framing, request correlation, per-request
 * deadlines, and the rule that a broken exchange means an *uncertain*
 * execution rather than a failed one. It owns no process policy — the child's
 * lifetime, its termination ladder and the timers all come from injected seams.
 */
export class AppServer extends EventEmitter {
  private child?: AppServerChild;
  private readonly spawner: AppServerSpawner;
  private readonly timer: AppServerTimer;
  private sequence = 0;
  private closed = false;
  /** Set once the child's outcome is known, so a later close is a no-op. */
  private exited = false;
  private readonly pending = new Map<number, {
    resolve(value: unknown): void;
    reject(error: Error): void;
    cancel(): void;
  }>();
  /** Recent App Server stderr lines, kept only to explain an unexpected exit. */
  private readonly diagnostics: string[] = [];

  constructor(readonly options: AppServerOptions = {}) {
    super();
    this.spawner = options.spawner ?? nodeSpawner();
    this.timer = options.timer ?? nodeTimer();
  }

  async connect(): Promise<void> {
    if (this.child !== undefined) throw new Error("App server already started");
    // An explicit command wins; otherwise the local system is searched for a
    // spawnable Codex. A Windows npm shim is resolved to the JavaScript entry it
    // launches, because Node cannot spawn the `.cmd` itself.
    const resolved = resolveCodexCommand({ configured: this.options.command });
    const args = [...resolved.prefixArgs, ...(this.options.args ?? ["app-server", "--stdio"])];
    // Codex is the user's own CLI and owns its own authentication, so it starts
    // from this process's environment; only the gate's per-runtime injection is
    // layered on top. The platform subprocess service scrubs credentials and
    // `DSH_*` facts by default, which is why the whole environment is handed
    // over as an explicit override rather than left ambient.
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries({ ...process.env, ...this.options.env })) if (value !== undefined) env[key] = value;
    const executable = await this.resolveProgram(resolved.program, env);
    const child = this.spawn({ argv: [executable, ...args], cwd: process.cwd(), stdio: { stdin: "pipe", stdout: "pipe", stderr: "pipe" }, graceMs: TERMINATION_GRACE_MS, env });
    this.child = child;
    const stdout = child.stdout, stdin = child.stdin;
    if (stdout === undefined || stdin === undefined) {
      // A command that never started has no channel to speak over; its outcome
      // carries the reason, and the execution it would have served is unknown.
      const error = new UncertainError(await child.done.then(
        () => "App server produced no stdio stream to speak over",
        reason => messageOf(reason),
      ));
      this.disconnect(error);
      throw error;
    }
    const lines = createInterface({ input: stdout });
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
        pending.cancel();
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
    stdin.on("error", error => { this.disconnect(new UncertainError(messageOf(error))); });
    child.stderr?.on("data", chunk => {
      const text = String(chunk);
      // The App Server explains a refusal on stderr and then exits; keep the tail
      // so the resulting uncertain-execution error names the real reason.
      this.diagnostics.push(...text.split("\n").filter(line => line.trim() !== ""));
      if (this.diagnostics.length > 20) this.diagnostics.splice(0, this.diagnostics.length - 20);
      this.emit("diagnostic", text);
    });
    child.done.then(
      outcome => {
        this.exited = true;
        lines.close();
        const reason = this.diagnostics.slice(-4).join(" | ");
        this.disconnect(new UncertainError(`App server exited (${outcome.exitCode ?? outcome.signal})${reason === "" ? "" : `: ${reason}`}; execution state unknown`));
      },
      failure => {
        this.exited = true;
        lines.close();
        this.disconnect(new UncertainError(messageOf(failure)));
      },
    );
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
      const cancel = this.timer.timeout(() => {
        this.pending.delete(id);
        const error = new UncertainError(`${method} response timed out; do not redispatch`);
        reject(error);
        this.emit("uncertain", error);
      }, this.options.timeoutMs ?? 30_000);
      this.pending.set(id, { resolve: value => { resolve(value as T); }, reject, cancel });
      try {
        this.send({ id, method, params });
      } catch (error) {
        // A request that never reached the wire must not hold a deadline open.
        this.pending.delete(id);
        cancel();
        reject(error instanceof Error ? error : new UncertainError(String(error)));
      }
    });
  }

  respond(id: number | string, result: unknown): void {
    this.send({ id, result });
  }

  reject(id: number | string, message: string): void {
    this.send({ id, error: { code: -32601, message } });
  }

  /**
   * Stop the App Server: ask it to exit, then start the provider's termination
   * procedure when it does not.
   *
   * The first wait is bounded by `SHUTDOWN_GRACE_MS`, so a child that ignores a
   * closed stdin cannot hold a teardown open; after that the provider's own
   * ladder escalates up to its `graceMs` and the final wait is the provider's
   * proof that the range is gone, which a caller has no better way to observe.
   */
  async close(): Promise<void> {
    const child = this.child;
    if (child === undefined || this.exited) return;
    try { child.stdin?.end(); } catch {}
    if (await this.exitedWithin(child, SHUTDOWN_GRACE_MS)) return;
    child.terminate();
    await child.waitForExit().catch(() => {});
  }

  /** Whether the managed range reports itself gone within `delay`. */
  private exitedWithin(child: AppServerChild, delay: number): Promise<boolean> {
    return new Promise<boolean>(resolve => {
      let settled = false;
      const cancel = this.timer.timeout(() => {
        if (settled) return;
        settled = true;
        resolve(false);
      }, delay);
      child.waitForExit().then(
        () => { if (!settled) { settled = true; cancel(); resolve(true); } },
        // A provider that cannot prove quiescence is told to terminate; the
        // second wait after `terminate()` is what actually observes the range.
        () => { if (!settled) { settled = true; cancel(); resolve(false); } },
      );
    });
  }

  /** Resolve the command through the platform's executable lookup when it has one. */
  private async resolveProgram(program: string, env: Record<string, string>): Promise<string> {
    if (this.spawner.resolveExecutable === undefined || program.trim() === "") return program;
    try {
      return await this.spawner.resolveExecutable(program, env);
    } catch (error) {
      throw new UncertainError(messageOf(error));
    }
  }

  /** Start the child, mapping a synchronous provider refusal to the same verdict. */
  private spawn(spec: AppServerSpawnSpec): AppServerChild {
    try {
      return this.spawner.spawn(spec);
    } catch (error) {
      const failure = new UncertainError(messageOf(error));
      this.disconnect(failure);
      throw failure;
    }
  }

  private send(message: RpcMessage): void {
    const stdin = this.child?.stdin;
    if (stdin === undefined || this.closed) throw new UncertainError("App server disconnected");
    stdin.write(`${JSON.stringify(message)}\n`);
  }

  private disconnect(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      pending.cancel();
      pending.reject(error);
    }
    this.pending.clear();
    this.emit("uncertain", error);
  }
}

/** A message from any thrown or rejected value. */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
