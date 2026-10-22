// Build in staging and replace lib only after a complete, successful build.
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, realpathSync, renameSync, rmSync, symlinkSync, watch } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const NAME = "dsh-codex-app-provider";
const required = ["lib/index.js", "lib/backend.js", "lib/provider.js"];
let child, stopped = false;

function replaceDirectory(source, target) {
  const backup = `${target}.watch-backup`;
  rmSync(backup, { recursive: true, force: true });
  try {
    if (existsSync(target)) renameSync(target, backup);
    renameSync(source, target);
    rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    if (!existsSync(target) && existsSync(backup)) renameSync(backup, target);
    throw error;
  }
}

async function publish(canPublish = () => true) {
  const stage = join(root, ".watch", "publish-build");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(join(stage, "scripts"), { recursive: true });
  for (const path of ["src", "package.json", "tsconfig.json", "tsconfig.client.json"]) cpSync(join(root, path), join(stage, path), { recursive: true });
  cpSync(join(root, "scripts", "build-client.mjs"), join(stage, "scripts", "build-client.mjs"));
  symlinkSync(join(root, "node_modules"), join(stage, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const code = await new Promise((resolveExit, rejectExit) => {
    child = spawn("npm", ["run", "build"], { cwd: stage, stdio: "inherit", shell: process.platform === "win32" });
    child.once("error", rejectExit);
    child.once("exit", code => resolveExit(code ?? 1));
  }).finally(() => { child = undefined; });
  if (stopped || !canPublish()) return;
  if (code !== 0) throw new Error(`${NAME} build failed (${code})`);
  const missing = required.filter(path => !existsSync(join(stage, path)));
  if (missing.length) throw new Error(`${NAME} staged build is missing: ${missing.join(", ")}`);
  replaceDirectory(join(stage, "lib"), join(root, "lib"));
  console.log(`${NAME} published`);
}

export async function watchPublication(development = false) {
  let pending = false, building = false, coreChanged = false;
  const watchers = [];
  const stop = () => {
    stopped = true;
    for (const watcher of watchers) watcher.close();
    child?.kill("SIGINT");
  };
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, stop);
  try {
    if (process.argv.includes("--no-initial-build")) {
      const missing = required.filter(path => !existsSync(join(root, path)));
      if (missing.length) throw new Error(`--no-initial-build requires baseline artifacts: ${missing.join(", ")}`);
    } else await publish();
    if (stopped) return;
    const rebuild = async () => {
      if (building || stopped || !pending) return;
      if (coreChanged) { pending = false; console.log(`${NAME} publication skipped: backend restart required`); return; }
      building = true;
      try {
        while (pending && !stopped && !coreChanged) {
          pending = false;
          await publish(() => !coreChanged);
        }
      } catch (error) { console.error(String(error)); process.exitCode = 1; }
      finally { building = false; if (pending && !stopped) void rebuild(); }
    };
    const changed = () => { pending = true; void rebuild(); };
    const restart = () => {
      if (!coreChanged) console.log(`${NAME} execution source changed; restart required; publication paused for this watch run`);
      coreChanged = true;
    };
    watchers.push(watch(join(root, "src"), { recursive: true }, development ? restart : changed));
    console.log(`${NAME} watch ready`);
  } catch (error) { stop(); throw error; }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes("--watch")) await watchPublication();
    else await publish();
  } catch (error) { console.error(String(error)); process.exitCode = 1; }
}
