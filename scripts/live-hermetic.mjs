/**
 * Run the real-model live harness with every writable path relocated inside this
 * checkout.
 *
 * DSH's file sandbox confines a whole process tree, so a live run started from a
 * sandboxed session cannot write the Codex CLI's own home (`~/.codex`), the npm
 * cache, or the DSH home without an escalation prompt. Codex honours
 * `CODEX_HOME`/`HOME`, npm honours `npm_config_cache`/`npm_config_logs_dir`, and
 * the provider spawns `codex` with the inherited environment, so pointing all of
 * them at a run directory under this checkout makes the same verification run
 * with no prompt and no writes outside the repository.
 *
 * Usage: node scripts/live-hermetic.mjs [--cross] [-- <extra test-live flags>]
 *   --cross   run the Codex -> DeepSeek continuation instead of Codex -> Codex
 *
 * Credentials copied for the run (`auth.json`, the provider credential store)
 * are removed again when it finishes; everything else stays for diagnosis.
 */
import { spawn } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const argv = process.argv.slice(2);
const separator = argv.indexOf("--");
const flags = separator === -1 ? argv : argv.slice(0, separator);
const extra = separator === -1 ? [] : argv.slice(separator + 1);
const cross = flags.includes("--cross");
const realHome = resolve(process.env.DSH_LIVE_REAL_HOME ?? process.env.HOME ?? "/home");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = join(root, ".live", stamp);
const home = join(runRoot, "home");

const seed = async (source, target) => {
  if (existsSync(source)) await cp(source, target, { recursive: true });
};
const ensure = async (...paths) => { for (const path of paths) await mkdir(path, { recursive: true }); };

await ensure(
  join(runRoot, "npm-cache"), join(runRoot, "npm-logs"), join(runRoot, "npm-prefix"), join(runRoot, "tmp"),
  join(home, ".codex"), join(home, ".local", "bin"), join(home, ".cache"), join(home, ".config"), join(home, ".dsh"),
);
// Codex's own home: configuration and login state are read from copies so the
// real home is never written, and the CLI's PATH aliases land in this copy.
await seed(join(realHome, ".codex", "config.toml"), join(home, ".codex", "config.toml"));
await seed(join(realHome, ".codex", "auth.json"), join(home, ".codex", "auth.json"));
await seed(join(realHome, ".codex", "skills"), join(home, ".codex", "skills"));
await seed(join(realHome, ".dsh", "llm-deepseek"), join(home, ".dsh", "llm-deepseek"));
await seed(join(realHome, ".dsh", ".credentials.yaml"), join(home, ".dsh", ".credentials.yaml"));
await seed(join(realHome, ".gitconfig"), join(home, ".gitconfig"));
await seed(join(realHome, ".npmrc"), join(home, ".npmrc"));
if (!existsSync(join(home, ".gitconfig"))) await writeFile(join(home, ".gitconfig"), "");

/**
 * The other provider's API key, read from the launching environment or from the
 * harness credential store. It is handed to the child as an environment variable
 * so no credential file is copied into the checkout.
 */
const deepseekKey = async () => {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try {
    const text = await readFile(join(realHome, ".dsh", ".credentials.yaml"), "utf8");
    const match = /^\s*DEEPSEEK_API_KEY:\s*(\S+)\s*$/m.exec(text);
    return match?.[1]?.replace(/^["']|["']$/g, "");
  } catch { return undefined; }
};

const env = {
  ...process.env,
  HOME: home,
  CODEX_HOME: join(home, ".codex"),
  GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
  TMPDIR: join(runRoot, "tmp"),
  npm_config_cache: join(runRoot, "npm-cache"),
  npm_config_logs_dir: join(runRoot, "npm-logs"),
  npm_config_prefix: join(runRoot, "npm-prefix"),
  npm_config_update_notifier: "false",
  DSH_TEST_NPM_CACHE: join(runRoot, "npm-cache"),
  ...(cross ? { DSH_HANDOFF_CROSS: "1" } : {}),
};
if (cross) {
  // The credential service is preferred (some DeepSeek extensions resolve
  // credentials through it); the environment variable is only a fallback.
  const seeded = existsSync(join(home, ".dsh", ".credentials.yaml"));
  const key = seeded ? undefined : await deepseekKey();
  if (key === undefined && !seeded) console.warn("live-hermetic: no DEEPSEEK_API_KEY found; the cross-provider successor will fail with MISSING_CREDENTIAL");
  else if (key !== undefined) env.DEEPSEEK_API_KEY = key;
}
console.log(`live-hermetic: HOME=${home}`);
console.log(`live-hermetic: CODEX_HOME=${env.CODEX_HOME}`);
console.log(`live-hermetic: run root=${runRoot}`);

const child = spawn(process.execPath, ["scripts/test-live.mjs", "--workflow-handoff", ...extra], {
  cwd: root, env, stdio: "inherit",
});
child.on("error", error => { console.error(`live-hermetic: ${String(error)}`); process.exitCode = 1; });
child.on("exit", async code => {
  let cleaned = false;
  for (const path of [join(home, ".codex", "auth.json"), join(home, ".dsh")]) {
    if (existsSync(path)) { await rm(path, { recursive: true, force: true }); cleaned = true; }
  }
  // The isolated profile copies the credential store into its own home; no
  // secret may survive the run inside the checkout.
  for (const entry of readdirSync(runRoot, { recursive: true })) {
    const name = String(entry);
    if (!name.endsWith(".credentials.yaml") && !name.endsWith("auth.json")) continue;
    await rm(join(runRoot, name), { force: true }); cleaned = true;
  }
  console.log(`live-hermetic: exit=${code ?? 1} credentials-removed=${cleaned ? "yes" : "no"} evidence=evidence/workflow-handoff${cross ? "-cross" : ""}-live-result.json`);
  process.exitCode = code ?? 1;
});
