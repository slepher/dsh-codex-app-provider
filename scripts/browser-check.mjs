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
  return { url: value("url"), evidence: value("evidence") };
}

const { url, evidence } = parseArguments(process.argv.slice(2));
if (url === undefined) {
  console.error("usage: node scripts/browser-check.mjs --url <serving URL> [--evidence <path>]");
  process.exit(2);
}
const binary = chromeBinary();
if (binary === undefined) {
  console.error("No Chrome/Chromium binary found; set DSH_CHROME to one.");
  process.exit(2);
}
const waitMs = Number(process.env.DSH_CHROME_WAIT ?? 12_000);
const report = { url, chrome: binary, waitMs, status: "UNRUN" };
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
      pluginApplied: [...document.querySelectorAll('style[data-plugin-css]')].some(node => node.getAttribute('data-plugin-css') === ${JSON.stringify(PLUGIN)}),
      boot: typeof window.__DSH_BOOT__,
      moduleLoader: typeof window.__ModuleLoader__
    })`,
  });
  const observed = JSON.parse(probe.result.value);
  report.observed = observed;
  report.errors = cdp.entries.filter(entry => entry.level === "error" || entry.level === "exception").map(entry => entry.text.slice(0, 300));
  report.status = observed.pluginApplied && observed.boot === "object" && report.errors.length === 0
    ? "PASS_CLIENT_APPLIED" : "FAIL";
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
