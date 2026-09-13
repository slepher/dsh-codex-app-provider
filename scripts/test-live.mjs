import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const browser = process.argv.includes("--browser");
const externalEvents = process.argv.includes("--external-events");
const workflowContract = process.argv.includes("--workflow-contract");
const workflowChild = workflowContract || process.argv.includes("--workflow-child");
const prefix = process.env.DSH_LIVE_EVIDENCE_PREFIX ?? (browser ? workflowChild ? "browser-workflow-live" : "browser-live" : workflowContract ? "workflow-contract-live" : workflowChild ? "workflow-live" : externalEvents ? "external-live" : "live");
const nativeChild = externalEvents || workflowChild || process.argv.includes("--native-child");
const installedOnly = browser || process.argv.includes("--install-only");
const evidence = join(root, "evidence");
const run = (command, args, cwd, env, log) => new Promise((resolveRun, reject) => {
  const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", data => { output += data; });
  child.stderr.on("data", data => { output += data; });
  child.on("error", reject);
  child.on("close", async (code, signal) => {
    try {
      await writeFile(join(evidence, log), output);
      if (code !== 0) throw new Error(`${command} failed: exit=${code} signal=${signal}; see evidence/${log}`);
      resolveRun(output);
    } catch (error) { reject(error); }
  });
});

const dir = await mkdtemp(join(tmpdir(), "dsh-app-live-"));
const home = join(dir, "home"), profile = join(home, "profiles", "codex-app-test"), workspace = join(dir, "workspace");
await mkdir(profile, { recursive: true }); await mkdir(workspace);
const version = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
const tarball = resolve(root, process.env.DSH_PROVIDER_TEST_TARBALL ?? `dsh-codex-app-provider-${version}.tgz`);
const workflowTarball = resolve(root, process.env.DSH_WORKFLOW_TEST_TARBALL ?? "../dsh-workflow-kit/dsh-workflow-kit-0.1.0.tgz");
const pins = JSON.parse(await readFile(join(root, "scripts/dsh-baseline.json"), "utf8"));
const coordinated = JSON.parse(await readFile(join(root, "scripts/dsh-coordinated.json"), "utf8"));
if (workflowChild) pins["dsh-codex-app-provider"] = `file:${tarball}`;
for (const [name, path] of Object.entries(coordinated.packages)) pins[name] = `file:${resolve(root, path)}`;
await writeFile(join(profile, "package.json"), JSON.stringify({
  name: "codex-app-isolated-test", private: true, type: "module",
  dependencies: { "@deepseek-ai/dsh": "0.1.5-rc.1", "dsh-codex-app-provider": `file:${tarball}`, ...(workflowChild ? { "dsh-workflow-kit": `file:${workflowTarball}` } : {}) },
  overrides: pins,
  dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", browser ? "@deepseek-ai/dsh-web-app" : "@deepseek-ai/dsh-headless", "dsh-codex-app-provider", ...(workflowChild ? ["dsh-workflow-kit"] : [])], patchReload: "startup" } },
}, null, 2));
const model = process.env.DSH_CODEX_TEST_MODEL ?? "gpt-5.6-luna";
await writeFile(join(profile, "cordis.patch.yml"), `- id: agent-default-model\n  config:\n    provider: codex\n    model: ${JSON.stringify(model)}\n- id: dsh-codex-app-provider\n  config:\n    stateDir: ${JSON.stringify(join(dir, "state"))}\n    providerCwd: ${JSON.stringify(workspace)}\n`);
if (workflowChild) {
  const patch = await readFile(join(profile, "cordis.patch.yml"), "utf8");
  await writeFile(join(profile, "cordis.patch.yml"), patch + `- id: dsh-workflow-kit\n  config:\n    stateDir: ${JSON.stringify(join(dir, "workflow-host-state"))}\n    subdir: workflow-live-test\n${workflowContract ? "    defaultProfile: live\n" : ""}`);
}
if (workflowContract) {
  const directory = join(home, "workflow-live-test");
  await mkdir(join(directory, "roles"), { recursive: true }); await mkdir(join(directory, "profiles"));
  const roles = {};
  for (const role of ["planner", "context_collector", "evidence_runner", "def_coding_worker", "sup_coding_worker", "reviewer", "full_tester"]) {
    roles[role] = { model, reasoningEffort: "medium" };
    await writeFile(join(directory, "roles", `${role}.md`), "Execute only the assigned frozen contract in the isolated test repository. Use native shell tools for evidence. Preserve owned paths and exact input/candidate identities. Return the required result format. Do not spawn children or contact external services.");
  }
  await writeFile(join(directory, "profiles/live.json"), JSON.stringify({ roles }));
}
if (nativeChild) {
  await writeFile(join(profile, "native-child-driver.mjs"), await readFile(join(root, workflowContract ? "test/workflow-contract-driver.mjs" : workflowChild ? "test/workflow-child-driver.mjs" : "test/native-child-driver.mjs")));
  const patch = await readFile(join(profile, "cordis.patch.yml"), "utf8");
  await writeFile(join(profile, "cordis.patch.yml"), patch + `- insert:\n    - id: native-child-test\n      name: ${JSON.stringify(join(profile, "native-child-driver.mjs"))}\n`);
}
const env = { ...process.env, DSH_EXTERNAL_EVENTS_TEST: externalEvents ? "1" : "0", DSH_HOME: home, DSH_NATIVE_CHILD_RESULT: join(dir, "native-child-result.json") };
const report = { status: "UNRUN", directory: dir, profile, workspace, model, dshVersion: coordinated.version, dshSourceCommit: coordinated.sourceCommit, pluginVersion: version };
await writeFile(join(evidence, `${prefix}-result.json`), JSON.stringify(report, null, 2));
try {
  const args = ["install", "--ignore-scripts", "--fetch-retries=0", "--prefer-offline"];
  if (process.env.DSH_TEST_NPM_CACHE) args.push("--cache", resolve(process.env.DSH_TEST_NPM_CACHE));
  await run("npm", args, profile, env, `${prefix}-install.log`);
  const cli = join(profile, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
  await run(process.execPath, ["--input-type=module", "-e", 'const p=await import("dsh-codex-app-provider"); if(typeof p.apply!=="function") throw Error("Host export missing");'], profile, env, "install-host.log");
  await run(process.execPath, [cli, "--profile", "codex-app-test", "--dump-config"], workspace, env, `${prefix}-config.log`);
  report.install = "PASS";
  if (installedOnly) report.status = "PASS_ISOLATED_INSTALLATION";
  if (!installedOnly) {
    const output = await run(process.execPath, [cli, "--profile", "codex-app-test", "Reply with exactly DSH_CODEX_APP_OK. Do not run tools or change files."], workspace, env, `${prefix}-run.log`);
    if (!nativeChild && output.trim() !== "DSH_CODEX_APP_OK") throw new Error("Live output marker missing");
    if (!output.trim()) throw new Error("Live main output missing");
    const records = await Promise.all((await readdir(join(dir, "state", "sessions"))).filter(name => name.endsWith(".json")).map(async name => JSON.parse(await readFile(join(dir, "state", "sessions", name), "utf8"))));
    const nativeResult = nativeChild ? JSON.parse(await readFile(env.DSH_NATIVE_CHILD_RESULT, "utf8")) : undefined;
    const main = records.find(record => record.sessionId.startsWith("codex:")
      && (nativeResult === undefined || record.sessionId === `codex:${nativeResult.parentSessionId}`)
      && record.reports.some(item => item.status === "completed" && item.result === output.trim()));
    if (!main) throw new Error("Completed native Session execution record missing");
    report.nativeSessionId = main.sessionId.slice("codex:".length);
    report.threadId = main.threadId;
    report.turnId = main.turnId;
    report.actualModel = main.model;
    report.actualReasoningEffort = main.reasoningEffort;
    report.terminal = main.reports.at(-1).status;
    report.status = "PASS_BASIC_MAIN_SESSION";
    if (nativeChild) {
      if (nativeResult.status !== (workflowContract ? "PASS_WORKFLOW_CONTRACT_DELIVERY" : workflowChild ? "PASS_WORKFLOW_PROFILES_COLD_AGENT_RESUME" : externalEvents ? "PASS_EXTERNAL_EXECUTION_EVENTS" : "PASS_NATIVE_SPAWN_COLD_AGENT_RESUME")) throw new Error("Native child assertions failed");
      report.nativeChild = nativeResult;
      report.status = workflowContract ? "PASS_WORKFLOW_CONTRACT_DELIVERY" : workflowChild ? "PASS_WORKFLOW_NATIVE_CHILD_PROFILES" : externalEvents ? "PASS_EXTERNAL_EXECUTION_EVENTS" : "PASS_NATIVE_CHILD_PARAMETER_CHAIN";
      report.childBackendRecords = records.filter(record => (workflowContract ? nativeResult.executions.map(value => value.nativeSessionId) : report.nativeChild.children.map(child => child.id)).some(id => record.sessionId === `codex:${id}`)).map(record => ({ sessionId: record.sessionId, threadId: record.threadId, turnId: record.turnId, model: record.model, reasoningEffort: record.reasoningEffort, options: record.options, reports: record.reports }));
    }
  }
} catch (error) {
  report.status = "FAIL"; report.error = String(error); process.exitCode = 1;
} finally {
  await writeFile(join(evidence, `${prefix}-result.json`), JSON.stringify(report, null, 2)+"\n");
  console.log(JSON.stringify(report));
}
