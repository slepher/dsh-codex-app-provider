/**
 * One-shot publication of this plugin's built artifacts.
 *
 * The dev profile resolves this package through a symlink to this checkout, so
 * publishing means writing `lib/` here — never copying a tarball into DSH_HOME.
 * The build runs in a staging directory and replaces `lib/` in one rename, so a
 * host watching this directory never observes a half-written bundle.
 *
 * Usage: node scripts/publish.mjs            # build and publish once
 *        node scripts/publish.mjs --watch    # republish on every source change
 */
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, renameSync, rmSync, symlinkSync, watch } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const NAME = "dsh-codex-app-provider";
const root = fileURLToPath(new URL("../", import.meta.url));
const stageRoot = join(root, ".watch");
const required = ["lib/index.js", "lib/backend.js", "lib/provider.js", "lib/client.js", "lib/client/index.d.ts"];
const watchMode = process.argv.includes("--watch");
let child, pending = false, stopping = false;

/** Replace a directory with a freshly built stage, restoring the original on failure. */
export function replaceDirectory(source, target) {
  const backup = `${target}.watch-backup`; rmSync(backup, { recursive: true, force: true });
  try {
    if (existsSync(target)) renameSync(target, backup);
    renameSync(source, target); rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    if (!existsSync(target) && existsSync(backup)) renameSync(backup, target);
    throw error;
  }
}

const build = () => new Promise((resolveExit, rejectExit) => {
  child = spawn("npm", ["run", "build"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
  child.once("error", rejectExit);
  child.once("exit", code => resolveExit(code ?? 1));
});

/** Build in staging, verify the expected artifacts, then publish atomically. */
export async function publish() {
  const stage = join(stageRoot, "publish-build");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(join(stage, "scripts"), { recursive: true });
  for (const path of ["src", "package.json", "tsconfig.json", "tsconfig.client.json"]) cpSync(join(root, path), join(stage, path), { recursive: true });
  cpSync(join(root, "scripts/build-client.mjs"), join(stage, "scripts/build-client.mjs"));
  symlinkSync(join(root, "node_modules"), join(stage, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const staged = await new Promise((resolveExit, rejectExit) => {
    const build = spawn("npm", ["run", "build"], { cwd: stage, stdio: "inherit", shell: process.platform === "win32" });
    build.once("error", rejectExit);
    build.once("exit", code => resolveExit(code ?? 1));
  });
  if (staged !== 0) throw new Error(`${NAME} build failed (${staged})`);
  const missing = required.filter(path => !existsSync(join(stage, path)));
  if (missing.length) throw new Error(`${NAME} staged build is missing: ${missing.join(", ")}`);
  replaceDirectory(join(stage, "lib"), join(root, "lib"));
  console.log(`${NAME} published`);
}

if (!watchMode) {
  try { await publish(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
} else {
  const rebuild = async () => {
    if (child !== undefined || stopping || !pending) return;
    pending = false;
    try { await publish(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
    if (!stopping) void rebuild();
  };
  const stop = () => { stopping = true; child?.kill("SIGINT"); };
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, stop);
  const watcher = watch(join(root, "src"), { recursive: true }, () => { pending = true; void rebuild(); });
  console.log(`${NAME} publish watch ready`);
  process.once("exit", () => watcher.close());
}
