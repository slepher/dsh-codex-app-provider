/**
 * The plugin declares its dsh dependencies section by section
 * (`docs/user/develop/basic/publish.md`): packages whose instances it shares
 * with the host under `peerDependencies` and `devDependencies`; stateless dsh
 * utilities and independently versioned libraries under `dependencies`.
 *
 * It deliberately keeps no family-wide `overrides` snapshot: such a list drifts
 * against the real closure, and `npm ci` ignores it anyway because the lock
 * records no overrides. What actually holds one generation in the development
 * tree is the exact `devDependencies` pin plus the lockfile, so these tests
 * assert that outcome directly.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

/** Whether a package name belongs to the DSH package family. */
const isDshFamily = name => name === "@deepseek-ai/dsh" || name.startsWith("@deepseek-ai/dsh-");

/**
 * Every `@deepseek-ai/dsh*` package installed under one `node_modules` tree.
 * @param directory - package directory holding the tree to walk.
 * @returns installed versions, by package name.
 */
function installedDshPackages(directory) {
  const found = new Map();
  const visited = new Set();
  const record = packageDir => {
    let installed;
    try { installed = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")); }
    catch { return; }
    if (typeof installed.name !== "string" || !isDshFamily(installed.name)) return;
    const versions = found.get(installed.name) ?? new Set();
    versions.add(installed.version);
    found.set(installed.name, versions);
  };
  const visit = nodeModules => {
    let real;
    try { real = realpathSync(nodeModules); } catch { return; }
    if (visited.has(real)) return;
    visited.add(real);
    let entries;
    try { entries = readdirSync(real, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === ".bin") continue;
      const path = join(real, entry.name);
      // A `file:` dependency is a symlink; stat follows it so a linked package
      // is walked like an installed one.
      let isDirectory = false;
      try { isDirectory = statSync(path).isDirectory(); } catch { continue; }
      if (!isDirectory) continue;
      if (!entry.name.startsWith("@")) { record(path); visit(join(path, "node_modules")); continue; }
      let scoped = [];
      try { scoped = readdirSync(path, { withFileTypes: true }); } catch { continue; }
      for (const child of scoped) {
        const scopedPath = join(path, child.name);
        let scopedDirectory = false;
        try { scopedDirectory = statSync(scopedPath).isDirectory(); } catch { continue; }
        if (!scopedDirectory) continue;
        record(scopedPath);
        visit(join(scopedPath, "node_modules"));
      }
    }
  };
  visit(join(directory, "node_modules"));
  return found;
}

test("the manifest pins no family-wide dependency snapshot", () => {
  assert.equal(manifest.overrides, undefined,
    "dsh dependencies are declared per section; a family snapshot drifts and npm ci ignores it");
});

test("no package is declared in two dependency sections at once", () => {
  const sections = ["dependencies", "peerDependencies", "devDependencies"];
  const declared = sections.flatMap(section => Object.keys(manifest[section] ?? {}).filter(isDshFamily).map(name => ({ name, section })));
  const byName = new Map();
  for (const { name, section } of declared) byName.set(name, [...byName.get(name) ?? [], section]);
  const bothRuntime = [...byName].filter(([, where]) => where.includes("dependencies") && where.includes("peerDependencies"));
  assert.deepEqual(bothRuntime, [], "a shared-instance package belongs under peerDependencies + devDependencies, not dependencies");
});

test("no script writes a DSH version down", () => {
  const scripts = readdirSync(join(root, "scripts")).filter(name => name.endsWith(".mjs"));
  assert.ok(scripts.length > 0, "the package carries its scripts");
  const hardcoded = scripts.flatMap(name => readFileSync(join(root, "scripts", name), "utf8")
    .split("\n")
    .map((line, index) => ({ name, line: line.trim(), number: index + 1 }))
    // A quoted DSH package name given a concrete version is the pinned snapshot
    // this package deliberately does without; the generation is read from the
    // manifest instead.
    .filter(({ line }) => /["']@deepseek-ai\/dsh[a-z-]*["']\s*:\s*["']\d/.test(line)));
  assert.deepEqual(hardcoded, [], "scripts derive the DSH generation from the manifest instead of pinning one");
});

test("the development tree holds exactly one generation of every dsh package", () => {
  const declared = Object.entries(manifest.devDependencies ?? {})
    .filter(([name]) => isDshFamily(name))
    .map(([, spec]) => spec);
  const generations = new Set(declared);
  assert.equal(generations.size, 1, `devDependencies declare one generation, got: ${[...generations].join(", ")}`);
  const generation = [...generations][0];
  assert.match(generation, /^\d+\.\d+\.\d+/, "devDependencies pin the generation exactly");

  const installed = installedDshPackages(root);
  assert.ok(installed.size > 0, "the development tree carries the dsh packages the plugin needs");
  const drifted = [...installed]
    .filter(([, versions]) => versions.size !== 1 || !versions.has(generation))
    .map(([name, versions]) => `${name}@${[...versions].join(" / ")}`);
  assert.deepEqual(drifted, [], `every installed dsh package must be ${generation}`);
});
