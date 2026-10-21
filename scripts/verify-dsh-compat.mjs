/** Check the two built local folders before adding them through DSH's plugin page. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const providerRoot = fileURLToPath(new URL("../", import.meta.url));
const workflowRoot = resolve(providerRoot, "../dsh-workflow-kit");
const roots = [providerRoot, workflowRoot];
const manifests = roots.map(root => JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")));
const target = manifests[0].engines.dsh;
assert.ok(target, "provider must declare engines.dsh");
const runtimeVersions = process.argv.slice(2);
const requireHost = createRequire(resolve(workflowRoot, "package.json"));
const { evaluatePluginCompatibility } = await import(pathToFileURL(requireHost.resolve("@deepseek-ai/dsh-app-boot")));

for (const [index, manifest] of manifests.entries()) {
  const root = roots[index];
  assert.equal(manifest.engines.dsh, target);
  const pins = Object.entries(manifest.devDependencies).filter(([name]) => name.startsWith("@deepseek-ai/dsh-"));
  assert.ok(pins.length > 0 && pins.every(([, version]) => version === "0.2.1-rc.2"), `${manifest.name}: mixed DSH generations`);
  for (const version of new Set(["0.2.1-rc.1", "0.2.1-rc.2", "0.2.1", ...runtimeVersions])) {
    assert.equal(evaluatePluginCompatibility(manifest, {}, version), undefined, `${manifest.name}: ${version} must pass the gate`);
  }
  for (const version of ["0.2.0", "0.2.1-alpha.5", "0.2.1-rc.0", "0.2.2-alpha.1", "0.2.2", "0.3.0"]) {
    assert.ok(evaluatePluginCompatibility(manifest, {}, version), `${manifest.name}: ${version} must be rejected`);
  }
  const plugin = await import(pathToFileURL(resolve(root, "lib/index.js")));
  assert.equal(typeof plugin.apply, "function");
  assert.ok(plugin.inject.includes("workingDirectory"));
  for (const locale of ["en", "zh"]) {
    const meta = JSON.parse(readFileSync(resolve(root, `locale/${locale}.json`), "utf8")).meta;
    assert.ok(meta.title && meta.description, `${manifest.name}: missing ${locale} display metadata`);
  }
  readFileSync(resolve(root, "cordis.patch.yml"));
  console.log(`PASS ${manifest.name}@${manifest.version}: ${root}`);
}
assert.equal(manifests[1].peerDependencies[manifests[0].name], manifests[0].version);
assert.ok(readFileSync(resolve(workflowRoot, "lib/client.js"), "utf8").includes("__ModuleLoader__"));
console.log(`Folder preflight passed for DSH ${target}. Add provider, then workflow in DSH's plugin page.`);
console.log("Live activation, settings and child execution still require verification in the running DSH profile.");
