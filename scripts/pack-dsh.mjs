import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repository = resolve("../deepseek-harness");
const directory = process.argv[2] === undefined ? "evidence/dsh-packages" : `evidence/dsh-packages/${process.argv[2]}`;
const destination = resolve(directory);
mkdirSync(destination, { recursive: true });
const paths = ["llm/llm", "core/agent", "core/session", "core/agent-loop", "subagent/subagent", "subagent/subagent-in-process-driver", "subagent/subagent-dsh-sdk"];
if (process.argv[2]?.startsWith("e4")) paths.push("api/session-controller", "client/ui-slots", "client/ui-renderer", "client/ui-conversation", "client/ui-subagent", "extensions/tool-cordis");
const packagePaths = paths.map(path => `packages/${path}`);
if (process.argv[2]?.startsWith("e4")) packagePaths.push("apps/web");
const packages = {};
for (const path of packagePaths) {
  execFileSync("pnpm", ["--dir", `${repository}/${path}`, "pack", "--pack-destination", destination], { stdio: "pipe" });
  const { name, version } = JSON.parse(readFileSync(`${repository}/${path}/package.json`, "utf8"));
  packages[name] = `${directory}/${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
}
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
const sourceStatus = execFileSync("git", ["status", "--short"], { cwd: repository, encoding: "utf8" });
let patch = execFileSync("git", ["diff", "--", ...packagePaths], { cwd: repository, encoding: "utf8" });
const added = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "--", ...packagePaths], { cwd: repository, encoding: "utf8" }).trim().split("\n").filter(Boolean);
for (const path of added) {
  const diff = spawnSync("git", ["diff", "--no-index", "--", "/dev/null", path], { cwd: repository, encoding: "utf8" });
  if (diff.status !== 1) throw new Error(`Cannot record added source ${path}`);
  patch += diff.stdout;
}
writeFileSync("evidence/dsh-source.patch", patch);
writeFileSync("scripts/dsh-coordinated.json", JSON.stringify({ sourceCommit, sourceStatus, build: process.argv[2]?.startsWith("e4") ? "pnpm run build:lib:host && pnpm run build:lib:client && pnpm run build:web" : "pnpm run build:lib:host", version: "0.1.5-rc.1 with local changes; not registry rc.1", packages }, null, 2) + "\n");
