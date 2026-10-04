#!/usr/bin/env node
/**
 * Enable source-module watching for this plugin in a DSH profile.
 *
 * The base bundle ships the `hmr` entry with `root: []`, which keeps
 * configuration reloads (installs, enable/disable, patch edits) but watches no
 * module files. The official recipe in `@deepseek-ai/dsh-hmr`'s README is
 * `config.root: ["."]` in the profile patch; that watches the profile tree,
 * where a package installed with `link:` is spelled inside node_modules and is
 * therefore filtered out by the default `ignored` list.
 *
 * Measured on this repository (see README, development section): the official
 * recipe did NOT reload this plugin, while `base` pointed at the checkout plus
 * `root: ["<package>/lib"]` did. This script writes that profile-layer patch
 * entry, idempotently, and never touches the plugin package itself.
 *
 * The profile patch layer is the only place that works at runtime: HMR watches
 * exactly the profile patch file, the home patch file, and the profile
 * manifest, so an edit here applies without a restart.
 *
 * Usage:
 *   node scripts/enable-hmr.mjs                 # dry run, prints the change
 *   node scripts/enable-hmr.mjs --write         # apply (backs up the file)
 *   node scripts/enable-hmr.mjs --write --remove  # drop the entry we manage
 *
 * Profile: `--profile <dir>` or `$DSH_PROFILE_DIR`.
 * Base:    `--base <dir>` (default: this checkout's root, resolved from the
 *          script location). Root: `--root <rel>` (repeatable), default `lib`.
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ENTRY_ID = "hmr";
const PATCH_FILENAME = "cordis.patch.yml";

/** The checkout root: this script lives in `<root>/scripts/`. */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageName = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).name;

function parseArgs(argv) {
  const options = { write: false, remove: false, profile: undefined, base: undefined, roots: [] };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--write") options.write = true;
    else if (arg === "--remove") options.remove = true;
    else if (arg === "--profile") options.profile = argv[++index];
    else if (arg === "--base") options.base = argv[++index];
    else if (arg === "--root") options.roots.push(argv[++index]);
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  return options;
}

function usage() {
  return [
    "usage: node scripts/enable-hmr.mjs [--write] [--remove] [--profile <dir>] [--base <dir>] [--root <rel>]...",
    "",
    "  --write            apply the change (default: dry run)",
    "  --remove           remove the hmr entry this script manages",
    `  --profile <dir>    profile directory (default: $DSH_PROFILE_DIR)`,
    `  --base <dir>       absolute base directory for module watching (default: ${packageRoot})`,
    `  --root <rel>       watch root relative to base (default: lib)`,
  ].join("\n");
}

function resolveProfile(explicit) {
  const dir = explicit ?? process.env.DSH_PROFILE_DIR?.trim();
  if (dir === undefined || dir === "") {
    throw new Error(`no profile given: pass --profile <dir> or set DSH_PROFILE_DIR (look under <DSH_HOME>/profiles/)`);
  }
  return resolve(dir);
}

/** The canonical block this script owns, as profile-patch YAML lines. */
function blockFor(base, roots) {
  return [
    `- id: ${ENTRY_ID}`,
    `  # Managed by ${packageName}/scripts/enable-hmr.mjs: watch only this package's built lib/.`,
    `  disabled: false`,
    `  config:`,
    `    base: ${base}`,
    `    root: ${JSON.stringify(roots)}`,
  ];
}

/** The extent of a top-level `- id: <id>` entry, as [start, end) line indexes. */
function findEntry(lines, id) {
  const start = lines.findIndex(line => new RegExp(`^- id:\\s*['"]?${id}['"]?\\s*(#.*)?$`).test(line));
  if (start === -1) return undefined;
  let end = start + 1;
  while (end < lines.length && !/^- /.test(lines[end])) end++;
  return { start, end };
}

function render(original, lines) {
  const text = `${lines.join("\n").replace(/\n*$/, "")}\n`;
  return { text, changed: text !== original };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const profileDir = resolveProfile(options.profile);
  const patchPath = join(profileDir, PATCH_FILENAME);
  if (!existsSync(patchPath)) throw new Error(`profile patch not found: ${patchPath}`);

  const base = resolve(options.base ?? packageRoot);
  if (!isAbsolute(base)) throw new Error(`--base must be absolute: ${base}`);
  const roots = options.roots.length > 0 ? options.roots : ["lib"];
  for (const root of roots) {
    if (isAbsolute(root)) throw new Error(`--root must be relative to base, got absolute: ${root}`);
  }

  const original = readFileSync(patchPath, "utf8");
  const lines = original.split("\n");
  const found = findEntry(lines, ENTRY_ID);
  const removed = found === undefined ? [] : lines.slice(found.start, found.end);
  let next;
  if (options.remove) {
    if (found === undefined) {
      console.log(`nothing to do: no "- id: ${ENTRY_ID}" entry in ${patchPath}`);
      return;
    }
    lines.splice(found.start, found.end - found.start);
    next = render(original, lines);
  } else {
    const block = blockFor(base, roots);
    if (found === undefined) {
      if (lines.length > 0 && lines[lines.length - 1].trim() !== "") lines.push("");
      lines.splice(lines.length, 0, ...block);
    } else {
      lines.splice(found.start, found.end - found.start, ...block);
    }
    next = render(original, lines);
  }

  console.log(`profile: ${profileDir}`);
  console.log(`patch:   ${patchPath}`);
  console.log(`base:    ${base}`);
  console.log(`roots:   ${JSON.stringify(roots)}`);
  console.log("");
  console.log(options.remove ? "--- entry to remove ---" : "--- entry to write ---");
  console.log((options.remove ? removed.join("\n") : blockFor(base, roots).join("\n")));
  console.log("");

  if (!next.changed) {
    console.log("already in the desired state; nothing written.");
  } else if (!options.write) {
    console.log("dry run: re-run with --write to apply.");
  } else {
    const backup = `${patchPath}.bak-${Date.now()}`;
    copyFileSync(patchPath, backup);
    writeFileSync(patchPath, next.text);
    console.log(`written; backup at ${backup}`);
  }
  console.log("");
  console.log("HMR watches this profile patch, so the change applies without a restart.");
  console.log(`Then rebuild to reload the plugin:  cd ${relative(process.cwd(), packageRoot) || "."} && npm run build`);
}

try {
  main();
} catch (error) {
  console.error(`enable-hmr: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
