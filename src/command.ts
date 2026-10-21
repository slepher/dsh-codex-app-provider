/**
 * Locate the Codex CLI the deployment can actually spawn.
 *
 * The App Server is started as `<program> app-server --stdio`, so the resolved
 * program must be directly executable by the process API. On Windows the npm
 * install of Codex is a `.cmd`/`.bat` shim whose JavaScript entry spawns the
 * native binary; running that entry through Node is slower and lets the native
 * child open its own console window, so this module prefers the native
 * `codex.exe` beside the shim and only falls back to the JavaScript entry when
 * no native binary is installed. A configured `command` always wins; an empty
 * one means "detect".
 *
 * Resolution is cached per configured value and `PATH`: repeated App Server
 * runtimes reuse the same answer instead of scanning the file system again.
 * @module dsh-codex-app-provider/command
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

/** Where the resolved program came from, for diagnostics. */
export type CommandSource = "configured" | "path" | "native" | "npm-shim" | "fallback";

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
  /** Directory lister; defaults to `fs.readdirSync(dir, { withFileTypes: true })` names. */
  listDirs?: (path: string) => readonly string[];
  /** Node binary used to launch a shim's JavaScript entry; defaults to this process. */
  nodePath?: string;
  /** Cache override: omit for the module cache, `null` to disable. */
  cache?: Map<string, ResolvedCodexCommand> | null;
}

/** Answers kept per configured value and `PATH`; a live config edit or a new PATH misses. */
const resolutionCache = new Map<string, ResolvedCodexCommand>();

/** Drop the resolution cache, e.g. after a deployment change the key cannot see. */
export function clearCommandCache(): void {
  resolutionCache.clear();
}

/**
 * Resolve the Codex executable for this system.
 *
 * Order: the explicit `command`; then a directly spawnable `codex`/`codex.exe`
 * on `PATH`; then, for a Windows npm shim, the native `codex.exe` the shim's
 * package ships; then the JavaScript entry the shim launches; then the bare
 * `codex` name, whose spawn error names the missing command.
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
  // A caller-supplied cache is honoured even with an injected file probe, so a
  // test can watch the cache; the module cache is only used with the real
  // file system, where its key is the whole observation.
  const cacheable = options.cache === null ? false : options.cache !== undefined || options.isFile === undefined;
  const cacheStore = options.cache ?? resolutionCache;
  // The configured value leads so an explicit command never collides with a
  // detection answer, and a live edit re-resolves.
  const key = [platform, env.PATH ?? env.Path ?? "", configured ?? ""].join("\u0000");
  if (cacheable) {
    const hit = cacheStore.get(key);
    if (hit !== undefined) return hit;
  }
  const isFile = options.isFile ?? (path => { try { return existsSync(path); } catch { return false; } });
  const readText = options.readText ?? (path => readFileSync(path, "utf8"));
  const listDirs = options.listDirs ?? defaultListDirs;
  const nodePath = options.nodePath ?? process.execPath;
  const pathValue = env.PATH ?? env.Path ?? "";
  const separator = platform === "win32" ? ";" : ":";
  const names = platform === "win32" ? ["codex.exe", "codex.cmd", "codex.bat", "codex"] : ["codex"];
  let resolved: ResolvedCodexCommand | undefined;
  for (const directory of pathValue.split(separator).filter(entry => entry !== "")) {
    for (const name of names) {
      const candidate = join(directory, name);
      if (!isFile(candidate)) continue;
      if (/\.(cmd|bat)$/i.test(name)) {
        const script = shimScript(candidate, readText);
        if (script === undefined) continue;
        // Prefer the native binary the shim's package ships: the DSH subprocess
        // service starts native children with a hidden window, while a Node
        // intermediate would let the native child open a console of its own.
        const native = nativeBinary(script, isFile, listDirs);
        if (native !== undefined) { resolved = { program: native, prefixArgs: [], source: "native" }; break; }
        resolved = { program: nodePath, prefixArgs: [script], source: "npm-shim" };
        break;
      }
      resolved = { program: candidate, prefixArgs: [], source: "path" };
      break;
    }
    if (resolved !== undefined) break;
  }
  resolved ??= { program: "codex", prefixArgs: [], source: "fallback" };
  if (cacheable) cacheStore.set(key, resolved);
  return resolved;
}

/** The native binary packaged beside a shim's JavaScript entry, when one is installed. */
function nativeBinary(script: string, isFile: (path: string) => boolean, listDirs: (path: string) => readonly string[]): string | undefined {
  // script is `<...>/node_modules/@openai/codex/bin/codex.js`.
  const packageRoot = dirname(dirname(script));
  const scopeRoot = dirname(packageRoot);
  const platformPackages = [`codex-win32-${process.arch}`, "codex-win32-x64"];
  const roots = platformPackages.flatMap(name => [
    join(packageRoot, "node_modules", "@openai", name, "vendor"),
    join(scopeRoot, name, "vendor"),
  ]);
  for (const root of roots) {
    for (const triple of listDirs(root)) {
      const candidate = join(root, triple, "bin", "codex.exe");
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Directory names under one path; an unreadable directory has none. */
function defaultListDirs(path: string): readonly string[] {
  try {
    return readdirSync(path, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
  } catch {
    return [];
  }
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
