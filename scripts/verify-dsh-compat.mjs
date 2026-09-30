/**
 * Verify both plugins against each declared DSH release, isolated per release.
 *
 * The plugins declare every host package as an optional `*` peer, so the harness
 * compatibility gate never judges them by a pinned generation — one build loads
 * on several releases. This script is what makes `dsh.compatibility.dshReleases`
 * true: for one release it installs that CLI, adds both plugin tarballs to a
 * throwaway `DSH_HOME` profile, composes the profile, runs
 * `compat-surface-probe.mjs` against that release's own gate, metadata reader and
 * tool-result recovery, boots the web server, and asserts the plugins' own
 * surfaces answer. A release is `compatible` only when every step holds;
 * verdicts and logs stay under the run directory.
 *
 * Usage:
 *   node scripts/verify-dsh-compat.mjs                    every declared release
 *   node scripts/verify-dsh-compat.mjs 0.1.7-rc.2 0.2.0-rc.2
 *
 * npm reads its cache from `npm_config_cache`, so a sandbox with a read-only home
 * cache runs this with `npm_config_cache=<writable dir>`.
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const declared = Object.keys(manifest.dsh?.compatibility?.dshReleases ?? {});
const versions = process.argv.slice(2).length > 0 ? process.argv.slice(2) : declared;
if (versions.length === 0) throw new Error("no releases to verify: pass versions or declare dsh.compatibility.dshReleases");

const providerTarball = resolve(process.env.DSH_PROVIDER_TEST_TARBALL ?? join(root, `dsh-codex-app-provider-${manifest.version}.tgz`));
// The sibling's version lives in its own manifest: hardcoding the filename here
// would silently keep verifying a stale build after the sibling's next bump.
const workflowRoot = resolve(root, "../dsh-workflow-kit");
const workflowTarball = resolve(process.env.DSH_WORKFLOW_TEST_TARBALL
  ?? join(workflowRoot, `dsh-workflow-kit-${JSON.parse(readFileSync(join(workflowRoot, "package.json"), "utf8")).version}.tgz`));
for (const path of [providerTarball, workflowTarball]) {
  if (!existsSync(path)) throw new Error(`missing plugin tarball: ${path} (build and pack first)`);
}

// Workspace-local by default: a sandbox that clears tmp would take the evidence
// with it, and the boot log is the diagnosis when a release fails to come up.
const base = process.env.DSH_COMPAT_BASE ?? mkdtempSync(join(root, ".watch", "compat-"));
console.log(`compat evidence: ${base}`);

/**
 * Run one command to completion, keeping its output as evidence.
 * @param command - executable.
 * @param args - arguments.
 * @param options - cwd and environment.
 * @returns exit code and combined output.
 */
function run(command, args, { cwd, env }) {
  return new Promise(resolveRun => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    child.on("error", error => resolveRun({ code: -1, output: `${output}${String(error)}` }));
    child.on("close", code => resolveRun({ code: code ?? -1, output }));
  });
}

/** Any HTTP response means the server is up; the plugin's own route is probed separately. */
async function waitReachable(url, tries = 60) {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      return response.status;
    } catch { /* not up yet */ }
    await new Promise(resume => setTimeout(resume, 2000));
  }
  return undefined;
}

/** The plugin's channel answers anything but 404 once it is registered. */
async function channelStatus(url) {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId: "compat", method: "profiles", payload: { sessionId: "compat" } }),
      signal: AbortSignal.timeout(5000),
    });
    return response.status;
  } catch { return undefined; }
}

const verdicts = [];
for (const [index, version] of versions.entries()) {
  const work = join(base, version);
  const profile = join(work, "home", "profiles", "compat");
  mkdirSync(profile, { recursive: true });
  const logPath = name => join(work, name);
  console.log(`\n=== @deepseek-ai/dsh@${version}`);
  let verdict = "unknown";

  // 1. install — the release itself plus both plugin builds under a fresh DSH_HOME.
  writeFileSync(join(profile, "package.json"), `${JSON.stringify({
    name: "dsh-compat", private: true, type: "module",
    dependencies: { "@deepseek-ai/dsh": version, "dsh-codex-app-provider": `file:${providerTarball}`, "dsh-workflow-kit": `file:${workflowTarball}` },
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-codex-app-provider", "dsh-workflow-kit"], patchReload: "startup" } },
  }, null, 2)}\n`);
  const state = join(work, "state");
  writeFileSync(join(profile, "cordis.patch.yml"), `- id: dsh-codex-app-provider\n  config:\n    stateDir: ${JSON.stringify(join(state, "codex"))}\n- id: dsh-workflow-kit\n  config:\n    stateDir: ${JSON.stringify(join(state, "workflow"))}\n`);
  const env = { DSH_HOME: join(work, "home") };
  const install = await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--fetch-retries=0", ...(process.env.DSH_TEST_NPM_CACHE ? ["--cache", process.env.DSH_TEST_NPM_CACHE] : [])], { cwd: profile, env });
  writeFileSync(logPath("install.log"), install.output);
  if (install.code !== 0) { console.log("  ✖ install failed"); verdict = "INSTALL_FAIL"; }
  const cli = join(profile, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");

  // 2. compose — the loader accepts both rows under this release.
  if (verdict === "unknown") {
    const composed = await run(process.execPath, [cli, "--profile", "compat", "--dump-config"], { cwd: work, env });
    writeFileSync(logPath("compose.log"), composed.output);
    const rows = ["dsh-codex-app-provider", "dsh-workflow-kit"].filter(name => composed.output.includes(name));
    if (composed.code !== 0 || rows.length !== 2) { console.log(`  ✖ compose failed (rows: ${rows.join(", ") || "none"})`); verdict = "COMPOSE_FAIL"; }
    else console.log("  ✔ both plugin rows compose");
  }

  // 3. surface — this release's own judge and metadata reader accept both
  // plugins, and its tool-result recovery is exactly-once (see the probe).
  if (verdict === "unknown") {
    copyFileSync(join(root, "scripts", "compat-surface-probe.mjs"), join(profile, "compat-surface-probe.mjs"));
    const probed = await run(process.execPath, ["compat-surface-probe.mjs"], { cwd: profile, env });
    writeFileSync(logPath("surface.log"), probed.output);
    if (probed.code !== 0) { console.log("  ✖ surface probe failed"); verdict = "SURFACE_FAIL"; }
    else console.log("  ✔ surface probe: gate, localized metadata and exactly-once recovery");
  }

  // 4. boot — the web server comes up and the workflow channel answers.
  if (verdict === "unknown") {
    const port = 3090 + index;
    // The launcher boots a profile by positional name: `dsh <profile> [options]`.
    const server = spawn(process.execPath, [cli, "compat", "--port", String(port), "--no-open"], { cwd: work, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let bootlog = "";
    server.stdout.on("data", chunk => { bootlog += chunk; });
    server.stderr.on("data", chunk => { bootlog += chunk; });
    try {
      const status = await waitReachable(`http://127.0.0.1:${port}/`);
      // The page is token-gated and the boot line carries that token. The
      // plugin's channel counts as registered only when it answers differently
      // from a path that does not exist.
      const token = /[?&]token=([\w-]+)/.exec(bootlog)?.[1];
      const query = token === undefined ? "" : `?token=${token}`;
      const channel = token === undefined ? undefined : await channelStatus(`http://127.0.0.1:${port}/workflow/profiles${query}`);
      const control = token === undefined ? undefined : await channelStatus(`http://127.0.0.1:${port}/definitely-absent-endpoint${query}`);
      if (token === undefined || channel === undefined || control === undefined) {
        console.log(`  ✖ web unreachable or no access token (root ${status ?? "unreachable"})`);
        verdict = "BOOT_FAIL";
      } else if (channel === control) {
        console.log(`  ✖ channel ${channel} is indistinguishable from an absent path ${control}`);
        verdict = "CHANNEL_NOT_DISTINCT";
      } else {
        console.log(`  ✔ web up (root ${status}); workflow channel ${channel} vs absent path ${control}`);
      }
    } finally {
      server.kill();
      writeFileSync(logPath("boot.log"), bootlog);
    }
  }

  if (verdict === "unknown") verdict = "PASS compatible";
  verdicts.push(`${version} ${verdict}`);
  console.log(`  → ${verdict}`);
}

writeFileSync(join(base, "verdicts.txt"), `${verdicts.join("\n")}\n`);
console.log(`\nverdicts:\n${verdicts.join("\n")}`);
if (verdicts.some(line => !line.includes(" compatible"))) {
  console.error("verify-dsh-compat: RED — at least one release did not pass every step");
  process.exitCode = 1;
} else {
  console.log(`verify-dsh-compat: OK — ${verdicts.length} release(s), all compatible`);
}
