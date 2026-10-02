import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const waitFor = async check => {
  for (let index = 0; index < 200; index++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error("timed out waiting for provider watch fixture");
};

function fixture(t, complete = true) {
  const base = mkdtempSync(join(tmpdir(), "provider-watch-")), root = join(base, "provider"), codex = join(base, "codex");
  for (const path of [join(root, "scripts"), join(root, "src"), join(root, "lib"), join(root, "node_modules"), join(codex, "src/client")]) mkdirSync(path, { recursive: true });
  writeFileSync(join(root, "scripts/watch.mjs"), readFileSync(new URL("../scripts/watch.mjs", import.meta.url)));
  writeFileSync(join(root, "scripts/publish.mjs"), readFileSync(new URL("../scripts/publish.mjs", import.meta.url)));
 writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { build: "fixture" } })); writeFileSync(join(root, "tsconfig.json"), "{}");
  writeFileSync(join(root, "src/index.ts"), "w-0"); writeFileSync(join(root, "src/backend.ts"), "core-0"); writeFileSync(join(codex, "src/backend.ts"), "core-0");
  if (complete) for (const path of ["lib/index.js", "lib/backend.js", "lib/provider.js"]) writeFileSync(join(root, path), "live");
  const npm = join(base, "npm");
  writeFileSync(npm, `#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const home=${JSON.stringify(base)}, cwd=process.cwd();

const text=readFileSync(join(cwd,"src/index.ts"),"utf8");
writeFileSync(join(home,"build-started"),text);
if(text.includes("FAIL")){writeFileSync(join(home,"build-done"),text);process.exit(2);}
if(text.includes("GATE")) await new Promise(resolve=>{const timer=setInterval(()=>{if(existsSync(join(home,"release"))){clearInterval(timer);resolve();}},10)});
if(text.includes("BLOCK")){process.on("SIGINT",()=>setTimeout(()=>process.exit(0),80));await new Promise(()=>{});}
for (const file of ["lib/index.js","lib/backend.js","lib/provider.js"]) { mkdirSync(join(cwd,file,".."),{recursive:true});writeFileSync(join(cwd,file),text); }writeFileSync(join(home,"build-done"),text);
`); chmodSync(npm, 0o755);
  const env = { ...process.env, PATH: `${base}:${process.env.PATH}` }, children = [];
  t.after(async () => { for (const child of children) if (child.exitCode === null && child.signalCode === null) { child.kill("SIGINT"); await new Promise(resolve => child.once("exit", resolve)); } rmSync(base, { recursive: true, force: true }); });
  return { base, root, codex, env, start(args = ["--watch", "--no-initial-build"], script = "publish.mjs") { const child = spawn(process.execPath, [join(root,"scripts",script), ...args], { cwd: root, env, stdio: ["ignore","pipe","pipe"] }); child.output=""; child.stdout.on("data",c=>child.output+=c); child.stderr.on("data",c=>child.output+=c); children.push(child); return child; } };
}

test("Provider no-initial mode requires the complete live baseline", t => {
  const value = fixture(t, false), result = spawnSync(process.execPath, [join(value.root,"scripts/watch.mjs"),"--no-initial-build","--app-provider",value.codex], { cwd:value.root,env:value.env,encoding:"utf8" });
  assert.equal(result.status,1); assert.match(`${result.stdout}${result.stderr}`,/requires baseline artifacts/); assert.equal(existsSync(join(value.base,"build-started")),false);
});

test("Provider publishes only a complete staged build", async t => {
  const value=fixture(t), child=value.start(); await waitFor(()=>child.output.includes("watch ready"));
  writeFileSync(join(value.root,"src/index.ts"),"w-1"); await waitFor(()=>child.output.includes("published"));
  assert.equal(readFileSync(join(value.root,"lib/index.js"),"utf8"),"w-1");
  writeFileSync(join(value.root,"src/index.ts"),"w-FAIL"); await waitFor(()=>existsSync(join(value.base,"build-done"))&&readFileSync(join(value.base,"build-done"),"utf8")==="w-FAIL");
  assert.equal(readFileSync(join(value.root,"lib/index.js"),"utf8"),"w-1");
});

test("development watcher requires a restart for provider source changes", async t => {
  const value=fixture(t), child=value.start(["--no-initial-build"], "watch.mjs");
  await waitFor(()=>child.output.includes("watch ready"));
  writeFileSync(join(value.root,"src/backend.ts"),"core-1");
  await waitFor(()=>child.output.includes("restart required"));
  assert.equal(existsSync(join(value.base,"build-started")),false);
  assert.equal(readFileSync(join(value.root,"lib/index.js"),"utf8"),"live");
});

test("SIGINT during cooperative publication build cannot publish", async t => {
  const value=fixture(t), child=value.start(); await waitFor(()=>child.output.includes("watch ready"));
  writeFileSync(join(value.root,"src/index.ts"),"w-BLOCK"); await waitFor(()=>existsSync(join(value.base,"build-started"))); child.kill("SIGINT");
  await waitFor(()=>child.exitCode!==null||child.signalCode!==null); assert.equal(readFileSync(join(value.root,"lib/index.js"),"utf8"),"live");
});
