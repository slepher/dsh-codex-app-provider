import { spawn } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const browser = process.argv.includes("--browser");
const externalEvents = process.argv.includes("--external-events");
const workflowContract = process.argv.includes("--workflow-contract");
const workflowHandoff = process.argv.includes("--workflow-handoff");
const delegate = process.argv.includes("--delegate");
const compact = process.argv.includes("--compact");
const workflowChild = delegate || workflowContract || workflowHandoff || process.argv.includes("--workflow-child");
const prefix = process.env.DSH_LIVE_EVIDENCE_PREFIX ?? (browser ? workflowChild ? "browser-workflow-live" : "browser-live" : compact ? "compact-live" : delegate ? "delegate-live" : workflowHandoff ? process.env.DSH_HANDOFF_CROSS === "1" ? "workflow-handoff-cross-live" : "workflow-handoff-live" : workflowContract ? "workflow-contract-live" : workflowChild ? "workflow-live" : externalEvents ? "external-live" : "live");
const nativeChild = externalEvents || workflowChild || compact || process.argv.includes("--native-child");
const installedOnly = browser || process.argv.includes("--install-only");
// `--fake` swaps the real Codex CLI for the scripted App Server, so a run needs
// no network, no model and no approval. It replaces the native transport only;
// the workflow assertions that a model must author remain model-dependent.
const fake = process.argv.includes("--fake");
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

/**
 * The DSH generation this package declares for itself, read from the one place
 * that already has to name it: its exact `devDependencies` pin.
 * @param manifest - this package's manifest.
 * @returns the exact generation.
 * @throws when the dsh entries disagree or are not exact versions.
 */
function dshGeneration(manifest) {
  const versions = new Set(Object.entries(manifest.devDependencies ?? {})
    .filter(([name]) => name.startsWith("@deepseek-ai/dsh-"))
    .map(([, spec]) => spec));
  if (versions.size !== 1 || ![...versions].every(spec => /^\d+\.\d+\.\d+/.test(spec))) {
    throw new Error(`devDependencies must pin one exact DSH generation, got: ${[...versions].join(", ") || "none"}`);
  }
  return [...versions][0];
}

const dir = await mkdtemp(join(tmpdir(), "dsh-app-live-"));
const home = join(dir, "home"), profile = join(home, "profiles", "codex-app-test"), workspace = join(dir, "workspace");
await mkdir(profile, { recursive: true }); await mkdir(workspace);
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const version = manifest.version;
const tarball = resolve(root, process.env.DSH_PROVIDER_TEST_TARBALL ?? `dsh-codex-app-provider-${version}.tgz`);
const workflowTarball = resolve(root, process.env.DSH_WORKFLOW_TEST_TARBALL ?? "../dsh-workflow-kit/dsh-workflow-kit-0.1.0.tgz");
// The composed app is the official DSH release, and the generation is the one
// this plugin declares for itself: the isolated profile installs that CLI and
// lets npm resolve the rest of the family from the plugin's own peer ranges,
// exactly as a real profile does. No version snapshot is written down here.
const generation = dshGeneration(manifest);
// The only pin left is the sibling plugin's own tarball, so a workflow child
// resolves `dsh-codex-app-provider` to the build under test.
const overrides = {};
if (workflowChild) overrides["dsh-codex-app-provider"] = `file:${tarball}`;
await writeFile(join(profile, "package.json"), JSON.stringify({
  name: "codex-app-isolated-test", private: true, type: "module",
  dependencies: { "@deepseek-ai/dsh": generation, "dsh-codex-app-provider": `file:${tarball}`, ...(workflowChild ? { "dsh-workflow-kit": `file:${workflowTarball}` } : {}) },
  ...(Object.keys(overrides).length === 0 ? {} : { overrides }),
  dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", browser ? "@deepseek-ai/dsh-web-app" : "@deepseek-ai/dsh-headless", "dsh-codex-app-provider", ...(workflowChild ? ["dsh-workflow-kit"] : [])], patchReload: "startup" } },
}, null, 2));
const model = process.env.DSH_CODEX_TEST_MODEL ?? "gpt-6-luna";
const fakeServer = join(root, "test/fake-codex-app-server.mjs");
await writeFile(join(profile, "cordis.patch.yml"), `- id: agent-default-model\n  config:\n    provider: codex\n    model: ${JSON.stringify(model)}\n- id: dsh-codex-app-provider\n  config:\n    stateDir: ${JSON.stringify(join(dir, "state"))}\n    providerCwd: ${JSON.stringify(workspace)}\n${fake ? `    command: ${JSON.stringify(fakeServer)}\n` : ""}`);
// The managed role protocols are plain files in the installed `codex-workflow`
// skill, and the bundled role prompts name that path, so every workflow run
// points the Host at the adjacent checkout.
const skillDir = process.env.DSH_WORKFLOW_SKILL_DIR ?? resolve(root, "../../codex-workflow/skills/codex-workflow");
if (workflowChild) {
  const patch = await readFile(join(profile, "cordis.patch.yml"), "utf8");
  await writeFile(join(profile, "cordis.patch.yml"), patch
    + `- id: dsh-workflow-kit\n  config:\n    stateDir: ${JSON.stringify(join(dir, "workflow-host-state"))}\n`
    + `    defaultProfile: gpt-workflow\n`
    + `    workflowSkillDir: ${JSON.stringify(skillDir)}\n`
    + `    implementationStandardDir: ${JSON.stringify(resolve(skillDir, "..", "audit-implementation-simplicity"))}\n`);
}
if (workflowHandoff) {
  // The current workflow Host reads the configurations shipped inside its own
  // package and the stored strategy defaults, so the real bootstrap strategy is
  // selected through the settings namespace. The managed `coding_worker` role
  // protocol is read from the installed skill, so the isolated profile points at
  // the adjacent skill checkout.
  const cross = process.env.DSH_HANDOFF_CROSS === "1";
  if (cross) {
    // The other provider's own state lives in the harness home; the isolated
    // home is a fresh directory, so its credentials and attachment index are
    // installed here for the run and removed by the hermetic runner afterwards.
    await cp(join(process.env.HOME ?? "", ".dsh", "llm-deepseek"), join(home, "llm-deepseek"), { recursive: true });
    if (existsSync(join(process.env.HOME ?? "", ".dsh", ".credentials.yaml"))) {
      await cp(join(process.env.HOME ?? "", ".dsh", ".credentials.yaml"), join(home, ".credentials.yaml"));
    }
  }
  const roles = cross
    ? `        planner: { provider: codex, model: gpt-6-astra, reasoningEffort: high }\n        reviewer: { provider: codex, model: gpt-6-sol, reasoningEffort: high }\n        context_collector: { provider: codex, model: gpt-6-luna, reasoningEffort: high }\n        def_coding_worker: { provider: deepseek-official, model: deepseek-flash, reasoningEffort: high }\n        sup_coding_worker: { provider: codex, model: gpt-6-sol, reasoningEffort: medium }\n        evidence_runner: { provider: codex, model: gpt-6-luna, reasoningEffort: medium }\n        full_tester: { provider: codex, model: gpt-6-luna, reasoningEffort: medium }\n`
    : "";
  await writeFile(join(home, "settings.yaml"), cross
    ? `dsh-workflow-kit:\n  defaultConfig: handoff\n  codingStrategy: bootstrap\n  integrateStrategy: economy\n  configs:\n    handoff:\n      roles:\n${roles}`
    : `dsh-workflow-kit:\n  defaultConfig: gpt-workflow\n  codingStrategy: bootstrap\n  integrateStrategy: economy\n  configs: {}\n`);
  const patch = await readFile(join(profile, "cordis.patch.yml"), "utf8");
  await writeFile(join(profile, "cordis.patch.yml"), patch.replace(
    "    defaultProfile: gpt-workflow\n",
    `    defaultProfile: ${cross ? "handoff" : "gpt-workflow"}\n`)
    // The DeepSeek package-inventory request extension enumerates the whole
    // loader graph, which an isolated profile cannot fully resolve; the cross
    // run scopes it out instead of failing the successor's first turn.
    + (cross ? "- id: plugin-package-inventory-deepseek\n  disabled: true\n" : ""));
}
// The workflow contract run needs no role fixture: the installed kit ships its
// own configurations (`gpt-workflow`/`ds-workflow`) and bundles every role
// prompt, so the deployment selects one by name instead of writing role files.
if (nativeChild) {
  await writeFile(join(profile, "native-child-driver.mjs"), await readFile(join(root, compact ? "test/compact-driver.mjs" : delegate ? "test/delegate-driver.mjs" : workflowHandoff ? "test/workflow-handoff-driver.mjs" : workflowContract ? "test/workflow-contract-driver.mjs" : workflowChild ? "test/workflow-child-driver.mjs" : "test/native-child-driver.mjs")));
  const patch = await readFile(join(profile, "cordis.patch.yml"), "utf8");
  await writeFile(join(profile, "cordis.patch.yml"), patch + `- insert:\n    - id: native-child-test\n      name: ${JSON.stringify(join(profile, "native-child-driver.mjs"))}\n`);
}
const env = { ...process.env, DSH_EXTERNAL_EVENTS_TEST: externalEvents ? "1" : "0", DSH_HOME: home, DSH_NATIVE_CHILD_RESULT: join(dir, "native-child-result.json"), ...(workflowHandoff ? { DSH_HANDOFF_DRIVER_EVIDENCE: join(evidence, `${prefix}-driver.json`) } : {}), ...(fake ? { DSH_FAKE_CODEX_LOG: join(dir, "fake-codex-requests.jsonl"), DSH_FAKE_CODEX_STATE: join(dir, "fake-codex-threads") } : {}) };
const report = { status: "UNRUN", directory: dir, profile, workspace, model,
  dshVersion: `registry ${generation}`, pluginVersion: version };
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
    // Report what the driver actually observed before looking for the parent's
    // execution record: a driver that failed cannot have produced one, and its
    // own error is the useful diagnosis.
    if (nativeResult !== undefined && nativeResult.status === "FAIL") throw new Error(`Native child driver failed: ${nativeResult.error ?? "no error reported"}`);
    const main = compact
      // The compaction driver owns its own Agent and Session, so the record to
      // report is that Session rather than the one the launcher prompt ran in.
      ? records.find(record => record.sessionId === `codex:${nativeResult.parentSessionId}`)
      : records.find(record => record.sessionId.startsWith("codex:")
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
    if (compact) {
      if (nativeResult.status !== "PASS_NATIVE_COMPACTION") throw new Error("Native compaction assertions failed");
      report.nativeChild = nativeResult;
      report.compaction = nativeResult.compaction;
      report.status = "PASS_NATIVE_COMPACTION";
    } else if (nativeChild) {
      if (nativeResult.status !== (delegate ? "PASS_DELEGATE_ROLE_TASK" : workflowHandoff ? "PASS_WORKFLOW_SUCCESSOR_HANDOFF" : workflowContract ? "PASS_WORKFLOW_CONTRACT_DELIVERY" : workflowChild ? "PASS_WORKFLOW_PROFILES_COLD_AGENT_RESUME" : externalEvents ? "PASS_EXTERNAL_EXECUTION_EVENTS" : "PASS_NATIVE_SPAWN_COLD_AGENT_RESUME")) throw new Error("Native child assertions failed");
      report.nativeChild = nativeResult;
      report.status = delegate ? "PASS_DELEGATE_ROLE_TASK" : workflowHandoff ? "PASS_WORKFLOW_SUCCESSOR_HANDOFF" : workflowContract ? "PASS_WORKFLOW_CONTRACT_DELIVERY" : workflowChild ? "PASS_WORKFLOW_NATIVE_CHILD_PROFILES" : externalEvents ? "PASS_EXTERNAL_EXECUTION_EVENTS" : "PASS_NATIVE_CHILD_PARAMETER_CHAIN";
      const childIds = (workflowContract || workflowHandoff) ? nativeResult.executions.map(value => value.nativeSessionId)
        : delegate ? [nativeResult.child.id]
        : report.nativeChild.children.map(child => child.id);
      report.childBackendRecords = records.filter(record => childIds.some(id => record.sessionId === `codex:${id}`)).map(record => ({ sessionId: record.sessionId, threadId: record.threadId, turnId: record.turnId, model: record.model, reasoningEffort: record.reasoningEffort, options: record.options, reports: record.reports }));
    }
  }
} catch (error) {
  report.status = "FAIL"; report.error = String(error); process.exitCode = 1;
} finally {
  await writeFile(join(evidence, `${prefix}-result.json`), JSON.stringify(report, null, 2)+"\n");
  console.log(JSON.stringify(report));
}
