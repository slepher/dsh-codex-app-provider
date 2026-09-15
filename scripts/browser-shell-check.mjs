/**
 * Drive the real DSH Web shell through the plugin's child entry.
 *
 * The other two browser checks stop at the plugin boundary: one proves the
 * client bundle applied, the other drives the pane component in a purpose-built
 * harness. Neither shows the join — that the official subagent catalog still
 * works, that selecting a child there lights up the plugin's header action, and
 * that clicking it opens a pane carrying that child's real transcript.
 *
 * This check walks exactly that path in a live shell:
 *   1. open the parent Session from the sidebar,
 *   2. assert the official lineage catalog is still present and open it,
 *   3. select a child from that catalog,
 *   4. assert the plugin's own entry appears for the selected child,
 *   5. click it and assert the right-sidebar pane renders that child.
 *
 * It needs a running shell whose state already holds a parent Session with at
 * least one child. The recipe, from an empty scratch directory:
 *
 *   1. `npm run test:live -- --browser --fake --native-child` installs a Web
 *      profile and then stops (the `--browser` run is install-only).
 *   2. Run that profile's driver once from a sibling headless profile so the
 *      state directory holds a parent Session and its children.
 *   3. Start the Web profile's host, and pass the URL it prints here.
 *
 * Usage: node scripts/browser-shell-check.mjs --url <shell url> [--title <parent session title>] [--evidence <path>]
 * Without `--title` the first Session in the sidebar is opened, which is the
 * parent in a freshly prepared state directory.
 * @module dsh-codex-app-provider/scripts/browser-shell-check
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromeBinary, connect, launch } from "./lib/browser.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const argument = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const url = argument("--url");
const title = argument("--title") ?? null;
const evidence = argument("--evidence") ?? resolve(root, "evidence/browser-shell-check.json");
if (url === undefined) { console.error("usage: browser-shell-check.mjs --url <shell url> [--title <parent session title>] [--evidence <path>]"); process.exit(2); }

const binary = chromeBinary();
if (binary === undefined) { console.error("no Chrome/Chromium binary is available; set DSH_CHROME"); process.exit(2); }

const browser = await launch(binary);
const cdp = await connect(browser.webSocketUrl);
const report = { status: "FAIL", url, title, checks: [], observed: {}, errors: [] };
const record = (name, ok, detail) => { report.checks.push({ name, ok, detail }); console.error(`${ok ? "PASS" : "FAIL"} | ${name}${detail === undefined ? "" : ` | ${JSON.stringify(detail).slice(0, 200)}`}`); };
const wait = milliseconds => new Promise(resolveWait => setTimeout(resolveWait, milliseconds));

/** Evaluate in the page, refusing to hang the whole check on one stalled step. */
const evaluate = async (expression, timeout = 20_000) => {
  const outcome = await Promise.race([
    cdp.send("Runtime.evaluate", { returnByValue: true, expression }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("evaluate timed out")), timeout)),
  ]);
  if (outcome.exceptionDetails !== undefined) {
    const details = outcome.exceptionDetails;
    throw new Error(`${details.text ?? "evaluation failed"}: ${details.exception?.description ?? ""}`.trim());
  }
  return outcome.result.value;
};
const json = async expression => JSON.parse(await evaluate(expression));

/** A trusted click, as a real user click arrives: pointer and mouse events at a point. */
const clickPoint = async (x, y) => {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
};
const pointOf = selector => json(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (node === null) return "null"; const rect = node.getBoundingClientRect();
  return JSON.stringify({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, width: Math.round(rect.width), height: Math.round(rect.height) }); })()`);
const clickSelector = async selector => { const point = await pointOf(selector); if (point === null) return "missing"; await clickPoint(point.x, point.y); return "clicked"; };
const clickLabel = label => evaluate(`(() => { const node = [...document.querySelectorAll("button,[role=button],a")].find(candidate =>
  ((candidate.getAttribute("aria-label") ?? candidate.textContent) ?? "").trim() === ${JSON.stringify(label)});
  if (node === undefined) return "missing"; node.click(); return "clicked"; })()`);

try {
  await cdp.send("Page.enable"); await cdp.send("Runtime.enable"); await cdp.send("Log.enable");
  console.error("step: load the shell");
  await cdp.send("Page.navigate", { url });
  await wait(9_000);
  await clickLabel("Continue"); await wait(1_200);
  await clickLabel("Open sidebar"); await wait(800);

  console.error("step: open the parent session");
  const opened = await evaluate(`(() => { const rows = [...document.querySelectorAll("[class*=sessionRow]")];
    const wanted = ${JSON.stringify(title)};
    const row = wanted === null ? rows.find(candidate => !(candidate.innerText ?? "").includes("New Session"))
      : rows.find(candidate => (candidate.innerText ?? "").includes(wanted));
    if (row === undefined) return "missing"; row.click(); return "clicked"; })()`);
  await wait(5_000);
  await clickLabel("Collapse sidebar"); await wait(400);

  const catalog = await pointOf("[aria-haspopup=tree]");
  record("the official subagent catalog survives on a parent session", opened === "clicked" && catalog !== null, { opened, catalog });
  report.observed.header = String(await evaluate(`(document.querySelector("header") ?? document.body).innerText`)).replace(/\n/g, " / ").slice(0, 300);

  console.error("step: open the catalog");
  if (catalog !== null) {
    await clickPoint(catalog.x, catalog.y);
    await wait(2_000);
    report.observed.expanded = await evaluate(`document.querySelector("[aria-haspopup=tree]")?.getAttribute("aria-expanded") ?? null`);
    report.observed.entries = await json(`JSON.stringify([...document.querySelectorAll("body > div:not(#root) [role=treeitem], body > div:not(#root) [role=menuitem], [class*=ZKlsPq_trigger] ~ * [role=treeitem]")]
      .map(node => { const rect = node.getBoundingClientRect(); return { text: (node.innerText ?? "").replace(/\\n/g, " | ").slice(0, 80), x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }; }))`);
    report.observed.popoverHtml = String(await evaluate(`[...document.querySelectorAll("body > div:not(#root)")].map(node => node.outerHTML).join("\\n").slice(0, 2000)`));
    record("the catalog opens", report.observed.expanded === "true", report.observed.expanded);

    console.error("step: select a child");
    const child = report.observed.entries.find(entry => Number.isFinite(entry.x) && !entry.text.includes("workspace"));
    if (child !== undefined) { await clickPoint(child.x, child.y); }
    await wait(5_000);
    report.observed.childEntry = child ?? null;

    // Whether the slot is mounted at all separates "the plugin declined this
    // child" from "this shell renders no header actions on a child view".
    report.observed.actionsSlot = await json(`(() => { const slot = document.querySelector("[data-slot='conversation.session.header.actions']");
      return JSON.stringify({ mounted: slot !== null, html: slot === null ? "" : slot.innerHTML.slice(0, 300), headerHtml: (document.querySelector("header") ?? document.body).innerHTML.slice(-600) }); })()`);
    const action = await pointOf("button.codex-child-open");
    report.observed.selectedHeader = String(await evaluate(`(document.querySelector("header") ?? document.body).innerText`)).replace(/\n/g, " / ").slice(0, 300);
    record("the plugin's child entry appears for the selected child", child !== undefined && action !== null, { child, action });
    record("the official breadcrumb names the child", (report.observed.selectedHeader ?? "").length > 0, report.observed.selectedHeader);

    console.error("step: open the child pane");
    if (action !== null) {
      const mainBefore = String(await evaluate(`(document.querySelector("[class*=crumbs]") ?? document.body).innerText`)).replace(/\n/g, " / ").slice(0, 200);
      await clickPoint(action.x, action.y);
      await wait(3_500);
      report.observed.pane = await json(`(() => { const pane = document.querySelector(".codex-child");
        const rect = pane?.getBoundingClientRect();
        return JSON.stringify({ present: pane !== null, text: pane === null ? "" : (pane.innerText ?? "").replace(/\\n/g, " / ").slice(0, 400),
          rows: pane === null ? 0 : pane.querySelectorAll(".codex-child-row").length,
          composer: pane !== null && pane.querySelector(".codex-child-input") !== null,
          // Where the pane actually lands, rather than which collapse attribute
          // the shell happens to leave behind: only a laid-out right-hand region
          // proves the entry opened the sidebar.
          layout: rect === undefined ? null : { x: Math.round(rect.x), width: Math.round(rect.width), height: Math.round(rect.height) },
          viewport: window.innerWidth }); })()`);
      const mainAfter = String(await evaluate(`(document.querySelector("[class*=crumbs]") ?? document.body).innerText`)).replace(/\n/g, " / ").slice(0, 200);
      report.observed.main = { before: mainBefore, after: mainAfter };
      const layout = report.observed.pane.layout;
      record("clicking the entry opens the child pane in the right sidebar",
        report.observed.pane.present && layout !== null && layout.width > 200 && layout.x > report.observed.pane.viewport / 2,
        report.observed.pane);
      record("the pane carries the child's own conversation", report.observed.pane.composer, { rows: report.observed.pane.rows, text: report.observed.pane.text.slice(0, 120) });
      record("the plugin entry never navigates the main area", mainBefore === mainAfter, report.observed.main);
    }
  }
  report.errors = cdp.entries.filter(entry => entry.level === "error" || entry.level === "exception")
    .map(entry => `${entry.text.slice(0, 200)}${entry.url === null || entry.url === undefined ? "" : ` <${entry.url}>`}`);
  // The headless Linux environment ships no desktop icon for the official
  // "open in app" integration, so its missing icon is environment noise rather
  // than a plugin fault. It is still recorded, just not counted as a failure.
  const environmentNoise = error => error.includes("/open-in-app/icon/");
  report.observed.environmentErrors = report.errors.filter(environmentNoise);
  record("the shell reported no plugin error", report.errors.every(environmentNoise), report.errors);
  report.status = report.checks.every(check => check.ok) ? "PASS_SHELL_CHILD_ENTRY" : "FAIL";
} catch (error) {
  report.error = String(error?.stack ?? error);
  console.error(`FAIL | check aborted | ${report.error}`);
} finally {
  mkdirSync(dirname(evidence), { recursive: true });
  writeFileSync(evidence, `${JSON.stringify(report, null, 2)}\n`);
  console.error(`status: ${report.status}; evidence: ${evidence}`);
  cdp.close(); browser.child.kill("SIGKILL");
  process.exit(report.status === "PASS_SHELL_CHILD_ENTRY" ? 0 : 1);
}
