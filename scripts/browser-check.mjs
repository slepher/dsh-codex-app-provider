#!/usr/bin/env node
/**
 * Load the DSH web UI in a real browser and report what the client applied.
 *
 * The pane's interactive acceptance (parent/child isolation, Stop, drafts,
 * pagination, answering an approval or a question) needs a person at the GUI.
 * What this check covers mechanically is the part that used to be unverifiable
 * without one: that the shipped client bundle resolves its declared externals
 * through the shell's module table, that it applies its registrations and
 * stylesheet in the real client, and that nothing it does raises a console error
 * or exception while the application boots.
 *
 * It starts its own headless Chrome on an OS-chosen debugging port, so it needs
 * a URL that is already serving the UI — normally the isolated profile the live
 * harness installs (`test:live -- --browser` then `dsh web`).
 *
 * Usage:
 *   node scripts/browser-check.mjs --url "http://127.0.0.1:3999/?token=..."
 *   node scripts/browser-check.mjs --url ... --expect dsh-workflow-kit
 *
 * `--expect <package id>` (repeatable) asserts another installed client plugin
 * is part of the composed client, so a combined UI+backend+Workflow deployment
 * can be checked in one run. The plugin's own id is always expected.
 *
 * Two signals are reported for every expected id: whether the shell's boot graph
 * (window.__DSH_BOOT__.entries) contains its client bundle, and whether its
 * stylesheet reached the document. The boot graph is the composition fact and
 * works on any screen; the stylesheet proves `apply` ran, which only an eager
 * installer can show before its own UI renders.
 *
 * Environment:
 *   DSH_CHROME      browser binary; defaults to the cached Playwright headless
 *                   shell, then `google-chrome`, then `chromium`
 *   DSH_CHROME_WAIT milliseconds to let the SPA boot (default 12000)
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromeBinary, connect, launch } from "./lib/browser.mjs";

const PLUGIN = "dsh-codex-app-provider";
const root = fileURLToPath(new URL("../", import.meta.url));

/** The arguments this check accepts. */
function parseArguments(argv) {
  const value = name => {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? undefined : argv[index + 1];
  };
  const expected = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--expect" && typeof argv[index + 1] === "string") expected.push(argv[index + 1]);
  }
  return { url: value("url"), evidence: value("evidence"), expected: [PLUGIN, ...expected.filter(id => id !== PLUGIN)] };
}

const { url, evidence, expected } = parseArguments(process.argv.slice(2));
if (url === undefined || url === "") {
  console.error("usage: node scripts/browser-check.mjs --url <serving URL> [--evidence <path>]");
  process.exit(2);
}
const binary = chromeBinary();
if (binary === undefined) {
  console.error("No Chrome/Chromium binary found; set DSH_CHROME to one.");
  process.exit(2);
}
const waitMs = Number(process.env.DSH_CHROME_WAIT ?? 12_000);
const report = { url, chrome: binary, waitMs, expected, status: "UNRUN" };
const browser = await launch(binary);
const cdp = await connect(browser.webSocketUrl);
try {
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await cdp.send("Page.navigate", { url });
  await new Promise(resolveWait => setTimeout(resolveWait, waitMs));
  const probe = await cdp.send("Runtime.evaluate", {
    returnByValue: true,
    expression: `JSON.stringify({
      htmlLength: document.documentElement.outerHTML.length,
      bodyChildren: document.body.children.length,
      applied: [...document.querySelectorAll('style[data-plugin-css]')].map(node => node.getAttribute('data-plugin-css')).filter(id => ${JSON.stringify(expected)}.includes(id)),
      loaded: ((window.__DSH_BOOT__ ?? {}).entries ?? []).map(entry => entry.id).filter(id => ${JSON.stringify(expected)}.includes(id)),
      boot: typeof window.__DSH_BOOT__,
      moduleLoader: typeof window.__ModuleLoader__
    })`,
  });
  const observed = JSON.parse(probe.result.value);
  report.observed = observed;
  // Every expected plugin must be in the composed client; the plugin's own
  // stylesheet must also be present, because it installs styles at apply time.
  report.missing = expected.filter(id => !observed.loaded.includes(id));
  report.withoutStyles = observed.loaded.filter(id => !observed.applied.includes(id));
  report.errors = cdp.entries.filter(entry => entry.level === "error" || entry.level === "exception").map(entry => entry.text.slice(0, 300));
  report.status = report.missing.length === 0 && observed.applied.includes(PLUGIN)
    && observed.boot === "object" && report.errors.length === 0 ? "PASS_CLIENT_APPLIED" : "FAIL";
} catch (error) {
  report.status = "FAIL";
  report.error = String(error);
} finally {
  cdp.close();
  browser.child.kill("SIGKILL");
}
if (evidence !== undefined) writeFileSync(resolve(root, evidence), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 1));
process.exit(report.status === "PASS_CLIENT_APPLIED" ? 0 : 1);
