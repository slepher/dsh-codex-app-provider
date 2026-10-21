/**
 * Locate the Codex CLI the deployment can actually spawn.
 *
 * The App Server is started as `<program> app-server --stdio`, so the resolved
 * program must be directly executable by the process API. On Windows the npm
 * install of Codex is a `.cmd`/`.bat` shim, which Node cannot spawn directly:
 * this module reads the shim's own launcher line and runs its JavaScript entry
 * with the current Node binary instead. The configured `command` always wins;
 * an empty one means "detect".
 * @module dsh-codex-app-provider/command
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

/** Where the resolved program came from, for diagnostics. */
export type CommandSource = "configured" | "path" | "npm-shim" | "fallback";

/** One spawnable program plus any arguments that must precede the CLI arguments. */
export interface ResolvedCodexCommand {
  /** Executable handed to the process API. */
  program: string;
  /** Arguments inserted before `app-server --stdio` (a Node script path for shims). */
  prefixArgs: string[];
  source: CommandSource;
}

/** Inputs of one resolution pass; every system fact is injectable for tests. */
export interface ResolveCodexCommandOptions {
  /** The configured `command`; blank or omitted means auto-detect. */
  configured?: string | undefined;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** File probe; defaults to `fs.existsSync`. */
  isFile?: (path: string) => boolean;
  /** Text reader; defaults to `fs.readFileSync(path, "utf8")`. */
  readText?: (path: string) => string;
  /** Node binary used to launch a shim's JavaScript entry; defaults to this process. */
  nodePath?: string;
}

/**
 * Resolve the Codex executable for this system.
 *
 * Order: the explicit `command`; then a directly spawnable `codex`/`codex.exe`
 * on `PATH`; then the JavaScript entry an npm `.cmd`/`.bat` shim launches (run
 * with the current Node binary); then the bare `codex` name, whose spawn error
 * names the missing command.
 * @param options - configured command and injectable system facts.
 * @returns the program, its prefix arguments and where it came from.
 */
export function resolveCodexCommand(options: ResolveCodexCommandOptions = {}): ResolvedCodexCommand {
  const configured = options.configured?.trim();
  if (configured !== undefined && configured !== "") {
    return { program: configured, prefixArgs: [], source: "configured" };
  }
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const isFile = options.isFile ?? (path => { try { return existsSync(path); } catch { return false; } });
  const readText = options.readText ?? (path => readFileSync(path, "utf8"));
  const nodePath = options.nodePath ?? process.execPath;
  const pathValue = env.PATH ?? env.Path ?? "";
  const separator = platform === "win32" ? ";" : ":";
  const names = platform === "win32" ? ["codex.exe", "codex.cmd", "codex.bat", "codex"] : ["codex"];
  for (const directory of pathValue.split(separator).filter(entry => entry !== "")) {
    for (const name of names) {
      const candidate = join(directory, name);
      if (!isFile(candidate)) continue;
      if (/\.(cmd|bat)$/i.test(name)) {
        const script = shimScript(candidate, readText);
        if (script !== undefined) return { program: nodePath, prefixArgs: [script], source: "npm-shim" };
        continue;
      }
      return { program: candidate, prefixArgs: [], source: "path" };
    }
  }
  return { program: "codex", prefixArgs: [], source: "fallback" };
}

/**
 * The JavaScript entry a Windows shim launches.
 *
 * npm writes `%_prog% "%dp0%\node_modules\<pkg>\bin\<entry>.js" %*`; only the
 * package-relative part is stable, so the shim's directory and that tail are
 * joined to recover the absolute script path.
 * @param shim - the `.cmd`/`.bat` path.
 * @param readText - text reader.
 * @returns the absolute script path, or undefined when the shim names none.
 */
function shimScript(shim: string, readText: (path: string) => string): string | undefined {
  let text: string;
  try {
    text = readText(shim);
  } catch {
    return undefined;
  }
  const start = text.search(/node_modules[\\/]/i);
  if (start < 0) return undefined;
  const tail = text.slice(start);
  const end = tail.search(/["\r\n]/);
  const relative = (end < 0 ? tail : tail.slice(0, end)).trim().replace(/[\\/]+$/, "");
  if (relative === "") return undefined;
  return isAbsolute(relative) ? relative : join(dirname(shim), relative);
}
