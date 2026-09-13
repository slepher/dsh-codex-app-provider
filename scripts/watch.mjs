import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, renameSync, rmSync, symlinkSync, watch } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url)), args = process.argv.slice(2);
const stageRoot = join(root, ".watch");
const required = ["lib/index.js", "lib/backend.js", "lib/provider.js", "lib/client.js", "lib/client/index.d.ts"];
let current, pending = false, stopped = false, coreChanged = false;

const run = (command, argv, options = {}) => new Promise(resolveExit => {
  const child = current = spawn(command, argv, { cwd: root, stdio: "inherit", shell: process.platform === "win32", ...options });
  let settled = false;
  const finish = code => { if (settled) return; settled = true; if (current === child) current = undefined; resolveExit(code); };
  child.once("error", error => { console.error(String(error)); finish(1); });
  child.once("exit", code => finish(code ?? 1));
});

function replaceDirectory(source, target) {
  const backup = `${target}.watch-backup`; rmSync(backup, { recursive: true, force: true });
  try {
    if (existsSync(target)) renameSync(target, backup);
    renameSync(source, target); rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    if (!existsSync(target) && existsSync(backup)) renameSync(backup, target);
    throw error;
  }
}

async function rebuild() {
  if (current || stopped || !pending) return;
  pending = false;
  if (coreChanged) { console.log("dsh-codex-app-provider publication skipped: backend restart required"); return; }
  const stage = join(stageRoot, "provider-build"); rmSync(stage, { recursive: true, force: true });
  mkdirSync(join(stage, "scripts"), { recursive: true });
  for (const path of ["src", "package.json", "tsconfig.json", "tsconfig.client.json"]) cpSync(join(root, path), join(stage, path), { recursive: true });
  for (const file of ["build-client.mjs"]) cpSync(join(root, "scripts", file), join(stage, "scripts", file));
  symlinkSync(join(root, "node_modules"), join(stage, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const code = await run("npm", ["run", "build"], { cwd: stage });
  if (stopped) return;
  if (code !== 0 || coreChanged) { if (code !== 0) process.exitCode = code; void rebuild(); return; }
  replaceDirectory(join(stage, "lib"), join(root, "lib"));
  console.log("dsh-codex-app-provider published");
  void rebuild();
}

const watchers = [];
function stop() {
  if (stopped) return; stopped = true;
  for (const watcher of watchers) watcher.close();
  current?.kill("SIGINT");
}
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, stop);

try {
  if (args.includes("--no-initial-build")) {
    const missing = required.filter(path => !existsSync(join(root, path)));
    if (missing.length) throw new Error(`--no-initial-build requires baseline artifacts: ${missing.join(", ")}`);
  } else {
    const code = await run("npm", ["run", "build"]);
    if (stopped) process.exit(0);
    if (code !== 0) throw new Error(`Initial build failed (${code})`);
  }
  if (!stopped) {
    watchers.push(watch(join(root, "src"), { recursive: true }, (_event, filename) => {
      if (String(filename ?? "").split(/[\\/]/)[0] === "client") { pending = true; void rebuild(); return; }
      if (!coreChanged) console.log("dsh-codex-app-provider execution source changed; restart required; publication paused for this watch run");
      coreChanged = true;
    }));
    console.log("dsh-codex-app-provider watch ready");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;
}
