#!/usr/bin/env node
/**
 * Drive the child pane's interaction contract in a real browser.
 *
 * `browser-check.mjs` proves the shipped bundle loads and applies in the GUI.
 * This check goes one level deeper into the part of §4.4's acceptance that is
 * pane-scoped and can be driven mechanically: two panes run side by side over
 * scripted streams, and a real browser performs the interactions a person would
 * — read a transcript, keep a draft, send/steer, stop, page backwards, answer a
 * native approval and a native question, and reopen a closed tab.
 *
 * What it does not cover, because it needs the whole shell: the main area
 * staying put, late navigation after repeated clicks, and leaving the parent.
 *
 * Usage:
 *   node scripts/browser-pane-check.mjs [--evidence <path>]
 */
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

import { chromeBinary, connect, launch } from "./lib/browser.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const evidenceIndex = process.argv.indexOf("--evidence");
const evidence = evidenceIndex === -1 ? undefined : process.argv[evidenceIndex + 1];
const checks = [];
const record = (name, ok, detail) => {
  checks.push({ name, ok, detail });
  if (ok !== true) console.error(`FAIL ${name}: ${JSON.stringify(detail)}`);
};

const directory = mkdtempSync(join(tmpdir(), "dsh-pane-check-"));
// One React instance for the harness and the components it mounts: the
// plugin's `react-dom` is a symlink into another tree, so a plain bundle would
// resolve `react` twice and every hook call would fail.
const require = createRequire(import.meta.url);
const reactModules = dirname(dirname(require.resolve("react-dom/package.json")));
await build({
  entryPoints: [join(root, "test/browser/pane-harness.tsx")],
  outfile: join(directory, "harness.js"),
  bundle: true, format: "iife", platform: "browser", target: "es2022", jsx: "automatic", logLevel: "silent",
  alias: {
    react: join(reactModules, "react/index.js"),
    "react/jsx-runtime": join(reactModules, "react/jsx-runtime.js"),
    "react-dom/client": join(reactModules, "react-dom/client.js"),
  },
});
writeFileSync(join(directory, "index.html"),
  `<!doctype html><html><head><meta charset="utf-8"><title>pane harness</title></head><body><div id="root"></div><script src="harness.js"></script></body></html>`);

const binary = chromeBinary();
if (binary === undefined) {
  console.error("No Chrome/Chromium binary found; set DSH_CHROME to one.");
  process.exit(2);
}
const browser = await launch(binary);
const cdp = await connect(browser.webSocketUrl);

/** Evaluate one expression in the page and return its value. */
const evaluate = async (expression) => {
  const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails !== undefined) {
    const details = result.exceptionDetails;
    throw new Error(`${details.text ?? "evaluation failed"}: ${details.exception?.description ?? ""}`.trim());
  }
  return result.result.value;
};
const text = which => `document.querySelector("#pane-${which} .codex-child-log").innerText`;
const clickButton = (which, label) =>
  `[...document.querySelectorAll("#pane-${which} button")].find(node => node.textContent === ${JSON.stringify(label)})?.click(), true`;
const setDraft = (which, value) => `(() => {
  const field = document.querySelector("#pane-${which} .codex-child-input");
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  setter.call(field, ${JSON.stringify(value)});
  field.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
})()`;

const message = (id, type, data, seq) => ({ type: "event", event: { type, seq, time: seq, data } });
const userRow = (id, body) => message(id, "user/message", { id, role: "user", source: { kind: "user" }, content: [{ type: "text", text: body }] }, 2);
const answerRow = (id, body) => message(id, "assistant/message", { turn: 1, step: 1, message: { id, role: "assistant", source: { kind: "model", provider: "codex" }, content: [{ type: "text", text: body }] } }, 3);
const turnStart = message("t", "turn/start", { turn: 1 }, 1);
const turnEnd = message("t", "turn/end", { turn: 1, reason: { kind: "stop" } }, 4);

try {
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await cdp.send("Page.navigate", { url: `file://${join(directory, "index.html")}` });
  await new Promise(resolveWait => setTimeout(resolveWait, 2500));
  const ready = await evaluate(`typeof window.__PANE__`);
  if (ready !== "object") throw new Error(`the harness did not apply: ${String(ready)}`);
  const shape = await evaluate(`JSON.stringify({ rootLength: (document.getElementById("root")?.innerHTML ?? "").length, body: document.body.innerHTML.slice(0, 400) })`);
  if (process.env.DSH_PANE_DEBUG === "1") { console.error(shape); console.error(JSON.stringify(cdp.entries.slice(0, 6), null, 1)); }

  // One child's transcript lands in its own pane only.
  await evaluate(`__PANE__.publish("a", { type: "replace", page: { entries: [${JSON.stringify(turnStart)}, ${JSON.stringify(userRow("u1", "child A task"))}, ${JSON.stringify(answerRow("m1", "child A answer"))}, ${JSON.stringify(turnEnd)}], hasMore: true } })`);
  await new Promise(resolveWait => setTimeout(resolveWait, 300));
  record("transcript lands in its own pane", (await evaluate(text("a"))).includes("child A answer")
    && (await evaluate(text("b"))).includes("childNothing") === false, { a: await evaluate(text("a")) });
  record("the idle pane stays empty", (await evaluate(text("b"))).trim() === "" || !(await evaluate(text("b"))).includes("child A"));

  // Drafts are per tab, and a later keystroke in the other pane cannot move it.
  await evaluate(setDraft("a", "half typed"));
  await evaluate(setDraft("b", "other draft"));
  await new Promise(resolveWait => setTimeout(resolveWait, 200));
  record("drafts are per pane", (await evaluate(`document.querySelector("#pane-a .codex-child-input").value`)) === "half typed"
    && (await evaluate(`document.querySelector("#pane-b .codex-child-input").value`)) === "other draft");

  // A finished child queues the next turn; a running child is steered.
  await evaluate(clickButton("a", "childSend"));
  await new Promise(resolveWait => setTimeout(resolveWait, 200));
  let calls = await evaluate(`__PANE__.calls.slice()`);
  record("an idle child queues the next turn", calls.some(call => call.kind === "prompt" && call.delivery === "queue" && call.text === "half typed"), calls);

  await evaluate(`__PANE__.publish("a", { type: "replace", page: { entries: [${JSON.stringify(turnStart)}], hasMore: true } })`);
  await new Promise(resolveWait => setTimeout(resolveWait, 300));
  await evaluate(setDraft("a", "steer this"));
  await evaluate(clickButton("a", "childSteer"));
  await new Promise(resolveWait => setTimeout(resolveWait, 200));
  calls = await evaluate(`__PANE__.calls.slice()`);
  record("a running child is steered", calls.some(call => call.kind === "prompt" && call.delivery === "steer" && call.text === "steer this"), calls);

  // Pagination asks for older entries.
  await evaluate(clickButton("a", "childLoadEarlier"));
  await new Promise(resolveWait => setTimeout(resolveWait, 200));
  calls = await evaluate(`__PANE__.calls.slice()`);
  record("load earlier pages backwards", calls.some(call => call.kind === "prepend"), calls);

  // A native approval is answered with the real decision.
  await evaluate(`__PANE__.setApprovals([{ requestId: "req-1", turnId: "turn-1", method: "item/commandExecution/requestApproval", reason: "run ls" }])`);
  // A native approval arrives while the turn streams, so the journal moves: the
  // pane re-reads interactions whenever the transcript does.
  await evaluate(`__PANE__.publish("a", { type: "append", entry: ${JSON.stringify(answerRow("m2", "still working"))} })`);
  await new Promise(resolveWait => setTimeout(resolveWait, 400));
  record("a pending approval is offered", (await evaluate(`document.querySelector("#pane-a .codex-child-approvals") !== null`)) === true);
  await evaluate(clickButton("a", "childAllow"));
  await new Promise(resolveWait => setTimeout(resolveWait, 300));
  calls = await evaluate(`__PANE__.calls.slice()`);
  record("allow returns the real decision", calls.some(call => call.kind === "decide" && call.decision === "accept" && call.requestId === "req-1"), calls);

  // A native question is answered with the chosen option.
  await evaluate(`__PANE__.setQuestions([{ requestId: "q-1", turnId: "turn-1", questions: [{ id: "q1", header: "Pick", question: "Proceed?", isOther: true, options: [{ label: "Yes", description: "go" }, { label: "No", description: "stop" }] }] }])`);
  await evaluate(`__PANE__.publish("a", { type: "append", entry: ${JSON.stringify(answerRow("m3", "asking now"))} })`);
  await new Promise(resolveWait => setTimeout(resolveWait, 400));
  record("a pending question is offered", (await evaluate(`document.querySelector("#pane-a .codex-child-questions") !== null`)) === true);
  await evaluate(clickButton("a", "Yes"));
  await new Promise(resolveWait => setTimeout(resolveWait, 300));
  calls = await evaluate(`__PANE__.calls.slice()`);
  record("the chosen option is returned", calls.some(call => call.kind === "answer" && call.requestId === "q-1" && call.answers?.q1?.[0] === "Yes"), calls);

  // Stop asks the parent to interrupt, and closing a tab releases display only.
  await evaluate(clickButton("a", "childStop"));
  await new Promise(resolveWait => setTimeout(resolveWait, 200));
  calls = await evaluate(`__PANE__.calls.slice()`);
  record("stop interrupts the child", calls.some(call => call.kind === "stop"), calls);
  await evaluate(`__PANE__.hideB()`);
  await new Promise(resolveWait => setTimeout(resolveWait, 200));
  await evaluate(`__PANE__.showB()`);
  await new Promise(resolveWait => setTimeout(resolveWait, 300));
  calls = await evaluate(`__PANE__.calls.slice()`);
  record("closing a tab stops exercising no model request", calls.filter(call => call.kind === "prompt").length === 2, calls.filter(call => call.kind === "prompt"));

  // The official subagent policy: a one-shot child is read-only, and so is a
  // child whose direct parent is unavailable while it is not running.
  await evaluate(`__PANE__.showOneShot()`);
  await new Promise(resolveWait => setTimeout(resolveWait, 400));
  const composerState = (which) => `(() => {
    const pane = document.querySelector("#pane-${which}");
    const field = pane.querySelector(".codex-child-input");
    const send = [...pane.querySelectorAll("button")].find(node => node.textContent === "childSend");
    return JSON.stringify({ disabled: field.disabled, send: send === undefined ? "missing" : send.disabled,
      notice: pane.querySelector(".codex-child-readonly")?.textContent ?? "" });
  })()`;
  record("a one-shot child is read-only", (await evaluate(composerState("oneshot"))).includes('"disabled":true')
    && (await evaluate(composerState("oneshot"))).includes("childOneShot"), await evaluate(composerState("oneshot")));
  record("an ordinary child is writable", (await evaluate(composerState("a"))).includes('"disabled":false'), await evaluate(composerState("a")));
  record("a one-shot child offers no stop", (await evaluate(`(() => {
    const button = [...document.querySelectorAll("#pane-oneshot button")].find(node => node.textContent === "childStop");
    return button === undefined ? "missing" : String(button.disabled);
  })()`)) === "true");

  await evaluate(`__PANE__.setNative("a", { parentAvailable: false, running: false })`);
  await new Promise(resolveWait => setTimeout(resolveWait, 300));
  record("a child whose parent is gone is read-only", (await evaluate(composerState("a"))).includes("childParentUnavailable"),
    await evaluate(composerState("a")));
  await evaluate(`__PANE__.setNative("a", { parentAvailable: false, running: true })`);
  await new Promise(resolveWait => setTimeout(resolveWait, 300));
  record("a running turn stays steerable while its parent is gone", (await evaluate(composerState("a"))).includes('"disabled":false'),
    await evaluate(composerState("a")));
  await evaluate(`__PANE__.setNative("a", { parentAvailable: true, running: false })`);
  await new Promise(resolveWait => setTimeout(resolveWait, 300));

  // Opening or interacting with a pane never selects a Session: the plugin only
  // ever adds a right-pane resource, so the main area cannot move under it and
  // no navigation can arrive late.
  calls = await evaluate(`__PANE__.calls.slice()`);
  record("no pane action navigates the main area", calls.every(call => call.kind !== "openMain"), calls.filter(call => call.kind === "openMain"));

  // A refused prompt surfaces in the pane instead of being swallowed. The child
  // is idle again, so the composer sends rather than steers.
  await evaluate(`__PANE__.publish("a", { type: "append", entry: ${JSON.stringify(turnEnd)} })`);
  await new Promise(resolveWait => setTimeout(resolveWait, 300));
  await evaluate(`__PANE__.failNextPrompt()`);
  await evaluate(setDraft("a", "this will be refused"));
  await evaluate(clickButton("a", "childSend"));
  await new Promise(resolveWait => setTimeout(resolveWait, 300));
  record("a refused prompt is shown", (await evaluate(`document.querySelector("#pane-a .codex-child-error")?.textContent ?? ""`)).includes("parent is unavailable"),
    await evaluate(`document.querySelector("#pane-a .codex-child-error")?.textContent ?? ""`));

  const errors = cdp.entries.filter(entry => entry.level === "error" || entry.level === "exception").map(entry => entry.text.slice(0, 200));
  record("no console error while interacting", errors.length === 0, errors);
} catch (error) {
  record("the check ran to completion", false, String(error));
} finally {
  cdp.close();
  browser.child.kill("SIGKILL");
}

const report = { status: checks.every(check => check.ok) ? "PASS_PANE_INTERACTION" : "FAIL", checks, chrome: binary };
if (evidence !== undefined) writeFileSync(resolve(root, evidence), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 1));
process.exit(report.status === "PASS_PANE_INTERACTION" ? 0 : 1);
