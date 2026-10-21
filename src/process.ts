import { spawn } from "node:child_process";

/**
 * Process and timer seams the App Server transport runs on.
 *
 * The transport owns the JSON-RPC protocol and nothing else: framing,
 * request correlation, deadlines and the uncertain-execution verdict. Which
 * process runs under it, how a process range is signalled and how a timer is
 * released belong to the deployment, so both arrive as injected seams.
 *
 * `ctx.subprocess` (`@deepseek-ai/dsh-subprocess`) satisfies
 * {@link AppServerSpawner} and `ctx.timer` (`@deepseek-ai/cordis-plugin-timer`)
 * satisfies {@link AppServerTimer}; `index.ts` passes them when the composition
 * provides them. The node fallbacks below keep the plugin usable on a
 * deployment that loads neither — a release predating those services, or a
 * bare host built without the base bundle — where the App Server instead runs
 * as an unmanaged child of this process. That path is why {@link nodeSpawner}
 * still carries a signal ladder of its own; it is the compatibility path, not
 * the intended one, and `index.ts` warns once when it is selected.
 */

/** One managed child process, as the transport consumes it. */
export interface AppServerChild {
  /** The child's standard input; `undefined` when the start never produced pipes. */
  readonly stdin?: NodeJS.WritableStream;
  /** The child's standard output, the JSON-RPC line channel. */
  readonly stdout?: NodeJS.ReadableStream;
  /** The child's standard error, kept only to explain an unexpected exit. */
  readonly stderr?: NodeJS.ReadableStream;
  /** The direct command's outcome; rejects when the command never started. */
  readonly done: Promise<{ exitCode?: number | null; signal?: string | null }>;
  /**
   * Start the provider's termination procedure for the managed range
   * (idempotent, no-op once the range is empty). It does not await quiescence.
   */
  terminate(): void;
  /**
   * Resolve only once the provider proves its managed range quiescent; reject
   * when it cannot prove that.
   */
  waitForExit(): Promise<unknown>;
}

/** A fully specified spawn request: no shell, no hidden defaults. */
export interface AppServerSpawnSpec {
  /** The program and its arguments; `argv[0]` is already resolved when possible. */
  argv: string[];
  /** Working directory for the child. */
  cwd: string;
  /** The three dispositions this transport needs. */
  stdio: { stdin: "pipe"; stdout: "pipe"; stderr: "pipe" };
  /** The provider's own TERM-to-KILL window for `terminate()`. */
  graceMs: number;
  /** The complete child environment. */
  env: Record<string, string>;
}

/** The process capability the transport starts App Servers through. */
export interface AppServerSpawner {
  spawn(spec: AppServerSpawnSpec): AppServerChild;
  /** Resolve a bare command name against the execution world's `PATH`. */
  resolveExecutable?(command: string, env?: Record<string, string>): Promise<string>;
}

/** The timer capability the transport runs deadlines on. */
export interface AppServerTimer {
  /** Run `callback` once after `delay`, returning a canceller. */
  timeout(callback: () => void, delay: number): () => void;
}

/**
 * The plain-node child-process implementation of {@link AppServerSpawner}.
 *
 * It spawns without a process group and signals the direct child only, so a
 * descendant that outlives it is not tracked; the platform service is the
 * implementation that owns a managed range, and the transport is written to
 * the service's contract rather than to this one.
 * @returns a spawner usable without any DSH service.
 */
export function nodeSpawner(): AppServerSpawner {
  return {
    spawn(spec) {
      const [program, ...args] = spec.argv;
      if (program === undefined || program === "") throw new Error("App Server command must not be empty");
      const child = spawn(program, args, { cwd: spec.cwd, stdio: ["pipe", "pipe", "pipe"], env: spec.env, windowsHide: true });
      let exited = false;
      let terminated = false;
      let killTimer: NodeJS.Timeout | undefined;
      // `spawn` reports a start failure asynchronously; the promise carries it to
      // the transport instead of an unhandled 'error' event.
      const outcome = Promise.withResolvers<{ exitCode?: number | null; signal?: string | null }>();
      child.once("error", error => { outcome.reject(error); });
      child.once("exit", (exitCode, signal) => {
        exited = true;
        if (killTimer !== undefined) clearTimeout(killTimer);
        outcome.resolve({ exitCode, signal });
      });
      // A child whose stdin is gone reports EPIPE on the socket; the transport
      // listens for it, but the shim must not turn it into an unhandled event.
      child.stdin?.on("error", () => {});
      return {
        ...(child.stdin === null ? {} : { stdin: child.stdin }),
        ...(child.stdout === null ? {} : { stdout: child.stdout }),
        ...(child.stderr === null ? {} : { stderr: child.stderr }),
        done: outcome.promise,
        terminate() {
          if (exited || terminated) return;
          terminated = true;
          try { child.kill("SIGTERM"); } catch {}
          killTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, spec.graceMs);
        },
        async waitForExit() { await outcome.promise; },
      };
    },
  };
}

/** The plain-node timer implementation of {@link AppServerTimer}. */
export function nodeTimer(): AppServerTimer {
  return {
    timeout(callback, delay) {
      const timer = setTimeout(callback, delay);
      return () => { clearTimeout(timer); };
    },
  };
}
