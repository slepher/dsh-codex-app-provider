import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CodexSessionBackend } from "../lib/backend.js";
import { AppServer } from "../lib/rpc.js";
import { CodexGateBridge, WORKFLOW_PRE_TOOL_USE } from "../lib/tool-gate.js";

/**
 * The live Codex closed loop, off unless explicitly requested.
 *
 * A real Codex turn must be refused by the workflow gate through this provider's
 * own hook command and socket — not through a scripted App Server and not
 * through a shell probe. It needs `~/.codex` to be writable, because the hook
 * must be installed and trusted there; the file is restored unconditionally and
 * the before/after hashes are printed.
 *
 *   DSH_GATE_LIVE=1 node --test test/integration-gate.test.mjs
 *
 * The deployment prerequisite is part of the acceptance: without a trusted hook
 * entry the provider refuses to start the gated Session, and that is reported as
 * a missing deployment prerequisite rather than as a passing gate.
 */
const live = process.env.DSH_GATE_LIVE === "1";
const client = fileURLToPath(new URL("../lib/pretool-client.js", import.meta.url));
const configPath = process.env.DSH_GATE_LIVE_CONFIG ?? join(homedir(), ".codex", "config.toml");
const TIMEOUT = Number(process.env.DSH_GATE_LIVE_TIMEOUT ?? 900_000);

const digest = path => createHash("sha256").update(readFileSync(path)).digest("hex");

/** The hook entry this deployment must carry, quoted for the deployed shell. */
function hookBlock() {
  return [
    "",
    "[[hooks.PreToolUse]]",
    'matcher = "*"',
    "",
    "[[hooks.PreToolUse.hooks]]",
    'type = "command"',
    `command = ${JSON.stringify(`${process.execPath} ${client}`)}`,
    "timeout = 10",
    "",
  ].join("\n");
}

/** One `hooks/list` entry for this client, in any of the response's shapes. */
function findEntry(response) {
  const found = [];
  const visit = value => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (typeof value !== "object" || value === null) return;
    if (typeof value.command === "string") { found.push(value); return; }
    Object.values(value).forEach(visit);
  };
  visit(response);
  return found.find(entry => entry.command.includes(client));
}

async function listHooks(cwd) {
  const server = new AppServer();
  await server.connect();
  try {
    return await server.request("hooks/list", { cwds: [cwd] });
  } finally {
    await server.close();
  }
}

async function waitForIdle(backend, session, deadline) {
  for (;;) {
    const snapshot = await backend.readSession("owner", session);
    if (snapshot.state === "idle" || snapshot.state === "unknown") return snapshot;
    if (Date.now() > deadline) throw new Error(`the live turn did not settle; last state ${snapshot.state}`);
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

test("a real Codex turn is refused by the workflow gate", { skip: live ? false : "set DSH_GATE_LIVE=1 to run against the installed Codex CLI", timeout: TIMEOUT }, async t => {
  assert.equal(existsSync(configPath), true, `the Codex configuration is required: ${configPath}`);
  const root = mkdtempSync(join(tmpdir(), "dsh-gate-live-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const backup = join(root, "config.toml.bak");
  const before = digest(configPath);
  copyFileSync(configPath, backup);
  // The rollback is unconditional: a failed experiment must never leave the
  // deployment with a hook the user did not ask for. It is registered both as a
  // test hook and as a process exit hook, so an unexpected throw still restores.
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    copyFileSync(backup, configPath);
    console.log(`config.toml sha256 before=${before} after=${digest(configPath)} restores=${digest(configPath) === before}`);
  };
  process.once("exit", restore);
  t.after(restore);
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // 1. Install the hook and make it trusted. A managed requirements file needs
  //    no trust record; a user configuration does, and an untrusted entry is
  //    silently skipped, which is exactly what the preflight exists to catch.
  if (!readFileSync(configPath, "utf8").includes(client)) writeFileSync(configPath, readFileSync(configPath, "utf8") + hookBlock());
  const listed = findEntry(await listHooks(workspace));
  assert.ok(listed, "the installed hook is listed by the App Server");
  if (listed.trustStatus !== "managed" && listed.trustStatus !== "trusted") {
    assert.equal(typeof listed.key, "string", "an untrusted user entry reports the state key to record");
    assert.equal(typeof listed.currentHash, "string");
    writeFileSync(configPath, `${readFileSync(configPath, "utf8")}\n[hooks.state.${JSON.stringify(listed.key)}]\ntrusted_hash = ${JSON.stringify(listed.currentHash)}\n`);
  }
  const trusted = findEntry(await listHooks(workspace));
  assert.ok(["managed", "trusted"].includes(trusted.trustStatus), `the hook is not trusted: ${trusted.trustStatus}`);

  // 2. Start a gated Session through this provider's own bridge.
  const stateDir = join(root, "state");
  const bridge = new CodexGateBridge();
  bridge.useClient(client);
  const backend = new CodexSessionBackend(stateDir, options => new AppServer(options));
  backend.attachGate(bridge);
  t.after(() => bridge.close());
  t.after(() => backend.close());

  const events = [];
  const disposer = bridge.register(WORKFLOW_PRE_TOOL_USE, (binding, event) => {
    events.push(event);
    return event.toolName === "Bash" || event.toolName === "apply_patch"
      ? { kind: "deny", reason: `workflow gate: live gate refused ${event.toolName}` }
      : { kind: "allow" };
  });
  t.after(disposer);
  bridge.bind("session", { role: "coding_worker", hook: WORKFLOW_PRE_TOOL_USE,
    args: { cwd: workspace, productWrites: [], auxiliaryWrites: [], writes: [] } });

  const model = process.env.DSH_GATE_LIVE_MODEL;
  await backend.createSession("owner", "codex:session", workspace, model === undefined ? {} : { model });
  await backend.startTurn("owner", "codex:session", [
    `Run exactly this shell command: touch ${join(workspace, "marker.txt")}`,
    `Then use apply_patch to create ${join(workspace, "apply.txt")} containing the single line hello.`,
    "Do not attempt any other change. Report what each tool answered.",
  ].join("\n"));
  const settled = await waitForIdle(backend, "codex:session", Date.now() + TIMEOUT);

  // 3. Evidence: the hook really ran, the tools were refused, nothing landed.
  const runs = backend.readHookRuns("session");
  const attempted = new Set(events.map(event => event.toolName));
  console.log(`hook runs: ${runs.map(run => run.method).join(", ") || "none"}`);
  console.log(`gate events: ${[...attempted].join(", ") || "none"}`);
  console.log(`report: ${settled.reports.at(-1)?.result ?? "(none)"}`);
  assert.equal(attempted.has("Bash"), true, "Codex attempted the shell tool and the hook carried it to the Host");
  assert.equal(attempted.has("apply_patch"), true, "Codex attempted apply_patch and the hook carried it to the Host");
  assert.ok(runs.length > 0, "hook/started and hook/completed prove the hook ran rather than being skipped");
  assert.equal(existsSync(join(workspace, "marker.txt")), false, "the refused shell wrote no marker");
  assert.equal(existsSync(join(workspace, "apply.txt")), false, "the refused patch wrote no file");

  // 4. The binding survives a resume of the same thread.
  await backend.resumeSession("owner", "codex:session");
  await backend.startTurn("owner", "codex:session", `Run exactly this shell command: touch ${join(workspace, "marker2.txt")}`);
  await waitForIdle(backend, "codex:session", Date.now() + TIMEOUT);
  assert.equal(existsSync(join(workspace, "marker2.txt")), false, "the resumed thread is still gated");
  assert.equal(events.length >= 3, true);
});

test("the live experiment reports an unusable deployment instead of passing", { skip: live ? false : "set DSH_GATE_LIVE=1 to run against the installed Codex CLI", timeout: 120_000 }, async t => {
  // §10.3 case 6: with the hook program absent, the honest outcome is "the
  // deployment prerequisite is unmet". The preflight must refuse to start the
  // Session rather than run it ungated.
  const root = mkdtempSync(join(tmpdir(), "dsh-gate-live-missing-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bridge = new CodexGateBridge();
  bridge.useClient(client);
  const backend = new CodexSessionBackend(join(root, "state"));
  backend.attachGate(bridge);
  t.after(() => bridge.close());
  t.after(() => backend.close());
  bridge.register(WORKFLOW_PRE_TOOL_USE, () => ({ kind: "allow" }));
  bridge.bind("session", { role: "coding_worker", hook: WORKFLOW_PRE_TOOL_USE, args: { cwd: root } });
  // The installed Codex CLI is used as-is; if it has no hook configured for this
  // client the refusal names that fact.
  await assert.rejects(backend.createSession("owner", "codex:session", root), error => {
    console.log(`missing-deployment refusal: ${String(error.message ?? error)}`);
    return true;
  });
  assert.equal(spawnSync("codex", ["--version"]).status, 0, "the Codex CLI itself is installed");
});
