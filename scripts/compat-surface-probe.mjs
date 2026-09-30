/**
 * Judge one installed dsh release's treatment of the two plugins installed beside it.
 *
 * `verify-dsh-compat.mjs` copies this file into an isolated profile and runs it
 * from there, so every bare specifier resolves to that profile's own release
 * instead of this checkout's devDependencies. It answers questions a boot log
 * cannot:
 *   - the harness compatibility gate accepts both plugins on this runtime,
 *   - the Plugin Manager reads both plugins' localized metadata without errors,
 *   - the release's tool-result recovery records exactly one result per call,
 *     so the provider never renders the same `callId` twice,
 *   - the seams the plugins compose against are still where the plugins expect
 *     them: the settings layering and the structured-question answerer.
 *
 * The tool-result check is measurement, not decoration: `ToolCallRecovery`
 * deletes a pending call as soon as the run records its result, and the
 * agent-loop records every ordinary result with `surfaceOp: 'append'`. A release
 * without the class is pre-0.2.0 and has nothing to duplicate, so that check
 * reports SKIP rather than passing silently.
 *
 * Usage: node compat-surface-probe.mjs   (located in, and run from, the profile root)
 */
import { readFileSync } from "node:fs";

const PLUGINS = ["dsh-codex-app-provider", "dsh-workflow-kit"];
const checks = [];
const skips = [];
const failures = [];

/** Read one installed plugin's own manifest, exactly as the Plugin Manager does. */
function manifestOf(name) {
  return JSON.parse(readFileSync(new URL(`./node_modules/${name}/package.json`, import.meta.url), "utf8"));
}

/**
 * Describe a locale map's defect, or nothing when it is usable.
 *
 * The Plugin Manager renders one language per UI locale with English as the
 * anchor, so a missing or empty `en` degrades the row, and an empty translation
 * would replace a real title with a blank one. `zh` is required here because the
 * upgrade's acceptance names the Chinese title and description explicitly.
 */
function localeDefect(value, field, name) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return `${name} ${field} is not a locale map: ${JSON.stringify(value)}`;
  if (typeof value.en !== "string" || value.en === "") return `${name} ${field} has no English anchor`;
  if (typeof value.zh !== "string" || value.zh === "") return `${name} ${field} has no Chinese translation`;
  for (const [language, text] of Object.entries(value)) if (typeof text !== "string" || text === "") return `${name} ${field} is empty for ${language}`;
  return undefined;
}

const appBoot = await import("@deepseek-ai/dsh-app-boot");
const { evaluatePluginCompatibility, readPluginMeta } = appBoot;

// 1. The compatibility gate the boot preflight and `dsh plugin add` both use.
for (const name of PLUGINS) {
  const issue = evaluatePluginCompatibility(manifestOf(name));
  if (issue === undefined) checks.push(`${name} passes the compatibility gate`);
  else failures.push(`${name} is incompatible with ${issue.runtimeVersion}: peerDependencies ${JSON.stringify(issue.peers)}`);
}

// 2. The display metadata the Plugins page reads without evaluating plugin code.
for (const name of PLUGINS) {
  const meta = readPluginMeta(name, import.meta.url);
  if (meta === undefined) failures.push(`${name} exposes no display metadata`);
  else if (meta.error !== undefined) failures.push(`${name} display metadata failed: ${meta.error}`);
  else {
    const defect = localeDefect(meta.title, "title", name) ?? localeDefect(meta.description, "description", name);
    if (defect !== undefined) failures.push(defect);
    else checks.push(`${name} displays as ${meta.title.zh} / ${meta.title.en}`);
  }
}

// 3. Exactly-once tool results: the behaviour that decides whether the provider
//    can render two `[tool result …]` lines for one `callId`.
let ToolCallRecovery;
try {
  ({ ToolCallRecovery } = await import("@deepseek-ai/dsh-session"));
} catch {
  ToolCallRecovery = undefined;
}
if (typeof ToolCallRecovery !== "function") {
  skips.push("this release has no ToolCallRecovery: a step failure cannot append a second tool result");
} else {
  const call = (id, seq) => ({
    type: "assistant/message",
    seq,
    time: 1,
    data: { turn: 1, step: 1, message: { content: [{ type: "tool-call", id, name: "probe", arguments: "{}" }] } },
  });
  const recorded = (id, seq) => ({
    type: "tool/result",
    seq,
    time: 1,
    surfaceOp: "append",
    data: { turn: 1, step: 1, message: { source: { kind: "tool", callId: id } } },
  });

  const recovery = new ToolCallRecovery();
  recovery.observe(call("call-recorded", 1));
  recovery.observe(recorded("call-recorded", 2));
  if (recovery.results().length !== 0) failures.push("recovery re-emits a tool result that was already recorded");
  else checks.push("a recorded tool result is not duplicated");

  recovery.observe(call("call-missing", 3));
  const emitted = recovery.results();
  if (emitted.length !== 1 || emitted[0].data.message.toolCallId !== "call-missing") {
    failures.push(`recovery did not supply exactly the missing result: ${JSON.stringify(emitted.map(event => event.data.message.toolCallId))}`);
  } else checks.push("an unrecorded tool result is supplied exactly once");
}

// 4. The settings layering behind the Plugin configuration page's "inherited
//    vs override" split. The plugins never call it, but a release that dropped
//    it would leave the required `stateDir` field unexplained in the UI.
const missingLayering = ["loadProfileDirectory", "composeEntries"].filter(name => typeof appBoot[name] !== "function");
if (missingLayering.length > 0) failures.push(`app-boot no longer exports ${missingLayering.join(", ")}: the settings page cannot separate inherited from override values`);
else checks.push("the profile layering behind the settings page still composes");

// 5. The seams the provider composes against. Absence is a supported deployment
//    (the provider fails closed), but a renamed entry point is not: the provider
//    would silently stop carrying the question to the human.
const questions = await import("@deepseek-ai/dsh-user-questions").catch(() => undefined);
if (questions === undefined) skips.push("this release installs no user-questions seam");
else if (typeof questions.UserQuestionService?.prototype?.ask !== "function") failures.push("the structured-question seam no longer offers ask(...): the provider would stop asking the human");
else checks.push("the structured-question ask(...) seam still exists");

const askTool = await import("@deepseek-ai/dsh-tool-ask-user").catch(() => undefined);
if (askTool === undefined) skips.push("this release installs no ask_user_question tool");
else if (typeof askTool.Config !== "function") skips.push("this release's ask_user_question has no configurable mode: the timed path arrives with 0.2.0");
else {
  const { mode, timeout } = askTool.Config({});
  checks.push(`ask_user_question defaults to ${JSON.stringify(mode)} mode (${timeout}s foreground wait)`);
}

for (const line of checks) console.log(`  · ${line}`);
for (const line of skips) console.log(`  ~ SKIP: ${line}`);
for (const line of failures) console.error(`  ✖ ${line}`);
if (failures.length > 0) throw new Error(`${failures.length} surface check(s) failed on this release`);
