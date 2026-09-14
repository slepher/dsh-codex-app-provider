/**
 * §3 clean-profile acceptance, fully hermetic.
 *
 * Nothing outside the workspace is written: `HOME`, `CODEX_HOME`, `DSH_HOME`,
 * `TMPDIR` and the npm cache all point into `.live/clean-rc1-<stamp>/`, and the
 * real `~/.codex` and `~/.dsh/profiles/clean-rc1` are only READ to seed copies.
 * The run-local profile directory symlinks the installed `node_modules`, so the
 * plugin graph is exactly the clean profile's registry rc.2 graph.
 *
 * The inserted driver is deliberately STOCK-shaped: it asserts the child's DSH
 * session cwd, the native record cwd and a completed report, and does not need
 * the unpublished descriptor v4 or `request/header` execution fields.
 *
 * Usage: node scripts/clean-rc1-live.mjs
 * Writes evidence/clean-rc1/02-live-child-result.json
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const evidence = join(root, "evidence", "clean-rc1");
mkdirSync(evidence, { recursive: true });
const realHome = process.env.DSH_LIVE_REAL_HOME ?? homedir();
const sourceProfile = join(realHome, ".dsh", "profiles", "clean-rc1");
if (!existsSync(join(sourceProfile, "node_modules"))) throw new Error(`clean-rc1 profile missing: ${sourceProfile}`);

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = join(root, ".live", `clean-rc1-${stamp}`);
const home = join(runRoot, "home");
const profile = join(home, ".dsh", "profiles", "clean-rc1");
const workspace = join(runRoot, "workspace");
const cli = join(profile, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
const PROMPT = "Reply with exactly DSH_CLEAN_RC1_MAIN. Do not run tools or change files.";

const DRIVER = `import { writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
export const name = "clean-rc1-stock-child";
export const inject = ["agents", "subagents", "sessionPersistence", "codexExecution", "llm"];
export function apply(ctx) {
  let started = false;
  ctx.on("agent/pre-step", async ({ agent: parent, signal }, next) => {
    const decision = await next();
    if (started || parent.session.header.parentSession !== undefined || decision.kind !== "enter") return decision;
    started = true;
    const cwd = parent.session.header.cwd;
    const lane = cwd + "/lane-a";
    const execution = { developerInstructions: "Your role marker is DSH_CLEAN_RC1. Reply with only this marker and nothing else. Do not run tools.",
      boundary: { cwd: lane, writableRoots: [lane], network: "disabled" } };
    const created = await ctx.subagents.startContinuable({ provider: "spawn", label: "clean rc1 child",
      request: { parent, prompt: [{ type: "text", text: "Reply with your role marker." }], agentOptions: {
        provider: "codex", model: process.env.DSH_CODEX_TEST_MODEL ?? "gpt-5.6-luna", reasoningEffort: ReasoningEffortId("medium"), execution } }, signal });
    const childId = created.childId;
    const deadline = Date.now() + 240_000;
    while (ctx.agents.get(childId) !== undefined) {
      signal.throwIfAborted();
      if (Date.now() > deadline) { await save({ status: "FAIL", checks: { childId, reason: "child did not settle" } }); throw new Error("child did not settle"); }
      await setTimeout(50, undefined, { signal });
    }
    const native = await ctx.codexExecution.read(childId);
    const handle = await ctx.sessionPersistence.open(childId, "read");
    let sessionCwd, outputs = [];
    try {
      const { events } = await handle.read();
      sessionCwd = handle.header.cwd;
      outputs = events.filter(event => event.type === "assistant/message")
        .map(event => event.data.message.content.filter(block => block.type === "text").map(block => block.text).join(""));
    } finally { await handle.close(); }
    const report = native?.reports?.at(-1);
    const checks = { childId, parentCwd: cwd, lane, sessionCwd, nativeCwd: native?.cwd, threadId: native?.threadId,
      turnId: native?.turnId, reportStatus: report?.status, reportResult: report?.result, outputs,
      facts: await ctx.codexExecution.facts(childId).catch(error => "ERROR: " + String(error)) };
    const pass = sessionCwd === cwd && native?.cwd === cwd && report?.status === "completed" && /DSH_CLEAN_RC1/.test(report?.result ?? "");
    await save({ status: pass ? "PASS_CLEAN_RC1_CHILD" : "FAIL", checks });
    return decision;
  });
  async function save(value) { await writeFile(process.env.DSH_CLEAN_RC1_RESULT, JSON.stringify(value, null, 2)); }
}
`;

// --- seed the isolated home (reads only outside the workspace) ---
mkdirSync(join(home, ".codex"), { recursive: true });
mkdirSync(join(home, ".dsh", "profiles"), { recursive: true });
mkdirSync(workspace, { recursive: true });
for (const path of ["config.toml", "auth.json", "skills"]) {
  const source = join(realHome, ".codex", path);
  if (existsSync(source)) cpSync(source, join(home, ".codex", path), { recursive: true });
}
mkdirSync(profile, { recursive: true });
for (const path of ["package.json", "cordis.patch.yml"]) {
  if (existsSync(join(sourceProfile, path))) cpSync(join(sourceProfile, path), join(profile, path));
}
symlinkSync(join(sourceProfile, "node_modules"), join(profile, "node_modules"));
writeFileSync(join(profile, "stock-child-driver.mjs"), DRIVER);
// The profile's own absolute paths (state dirs) come from the real home; every
// entry point must be redirected into the run root so nothing is written outside it.
const seededPatch = readFileSync(join(profile, "cordis.patch.yml"), "utf8")
  .replaceAll(join(realHome, ".dsh"), join(home, ".dsh"));
writeFileSync(join(profile, "cordis.patch.yml"), `${seededPatch}
- insert:
    - id: clean-rc1-stock-child
      name: ${JSON.stringify(join(profile, "stock-child-driver.mjs"))}
`);
// The profile is the one-shot (headless) composition; the GUI profile keeps the web app.
const manifest = JSON.parse(readFileSync(join(profile, "package.json"), "utf8"));
manifest.name = "dsh-profile-clean-rc1-headless";
manifest.dsh.profile.bundles = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless", "dsh-codex-app-provider", "dsh-workflow-kit"];
writeFileSync(join(profile, "package.json"), JSON.stringify(manifest, null, 2));

const env = {
  ...process.env,
  HOME: home,
  CODEX_HOME: join(home, ".codex"),
  DSH_HOME: join(home, ".dsh"),
  TMPDIR: join(runRoot, "tmp"),
  GIT_CONFIG_GLOBAL: join(runRoot, "gitconfig"),
  npm_config_cache: join(runRoot, "npm-cache"),
  npm_config_logs_dir: join(runRoot, "npm-logs"),
  DSH_CLEAN_RC1_RESULT: join(runRoot, "child-result.json"),
};
for (const path of ["tmp", "npm-cache", "npm-logs"]) mkdirSync(join(runRoot, path), { recursive: true });
writeFileSync(env.GIT_CONFIG_GLOBAL, "");

/** One attempt; `flags` vary the resolution mode, `bundles` vary the composition. */
function attempt(label, flags, bundles) {
  if (bundles !== undefined) {
    const current = JSON.parse(readFileSync(join(profile, "package.json"), "utf8"));
    current.dsh.profile.bundles = bundles;
    writeFileSync(join(profile, "package.json"), JSON.stringify(current, null, 2));
  }
  rmSync(env.DSH_CLEAN_RC1_RESULT, { force: true });
  const result = spawnSync(process.execPath, [...flags, cli, "--profile", "clean-rc1", PROMPT], {
    cwd: workspace, env, encoding: "utf8", timeout: 300_000,
  });
  return { label, flags, bundles, exit: result.status, signal: result.signal,
    stdout: (result.stdout ?? "").slice(-2000), stderr: (result.stderr ?? "").slice(-2000),
    child: existsSync(env.DSH_CLEAN_RC1_RESULT) ? JSON.parse(readFileSync(env.DSH_CLEAN_RC1_RESULT, "utf8")) : undefined };
}

const report = { at: new Date().toISOString(), runRoot, sourceProfile, attempts: [] };
const webAppBundles = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless", "dsh-codex-app-provider", "dsh-workflow-kit"];
const providerOnly = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless", "dsh-codex-app-provider"];
const flags = ["--preserve-symlinks", "--preserve-symlinks-main"];

report.attempts.push(attempt("headless+workflow-kit, preserve-symlinks", flags, webAppBundles));
if (!report.attempts.at(-1).child) report.attempts.push(attempt("headless+workflow-kit, default resolution", [], webAppBundles));
if (!report.attempts.at(-1).child) report.attempts.push(attempt("headless provider-only, preserve-symlinks", flags, providerOnly));
if (!report.attempts.at(-1).child) report.attempts.push(attempt("headless provider-only, default resolution", [], providerOnly));

const accepted = report.attempts.find(entry => entry.child?.status === "PASS_CLEAN_RC1_CHILD");
report.status = accepted !== undefined ? accepted.child.status : report.attempts.some(entry => entry.child !== undefined) ? "FAIL_ASSERTIONS" : "FAIL_NO_CHILD";
// Codex login state must not survive inside the workspace.
for (const path of [join(home, ".codex", "auth.json"), join(home, ".dsh")]) rmSync(path, { recursive: true, force: true });
writeFileSync(join(evidence, "02-live-child-result.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ status: report.status, runRoot,
  attempts: report.attempts.map(entry => ({ label: entry.label, exit: entry.exit, childStatus: entry.child?.status,
    childReport: entry.child?.checks?.reportStatus, childResult: entry.child?.checks?.reportResult,
    sessionCwd: entry.child?.checks?.sessionCwd, nativeCwd: entry.child?.checks?.nativeCwd,
    stderrTail: entry.child === undefined ? entry.stderr.slice(-400) : undefined })) }, null, 2));
if (report.status !== "PASS_CLEAN_RC1_CHILD") process.exitCode = 1;
