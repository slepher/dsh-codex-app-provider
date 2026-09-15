/**
 * The Codex PreToolUse hook command.
 *
 * Codex runs this program before every tool call and reads its stdout as the
 * permission decision. It carries the operation to the Host over a Unix socket
 * and returns whatever the Host decided. It holds no rules of its own: a
 * missing transport, an unusable answer, a timeout and a broken connection all
 * become an explicit deny, never a silent allow.
 *
 * Without the arming environment the program exits 0 with no output, so one
 * managed hook configuration can be deployed globally without changing the
 * behaviour of ordinary Codex Sessions.
 *
 * The runtime key is never printed, to stdout or to stderr.
 * @module dsh-codex-app-provider/pretool-client
 */

import { connect } from "node:net";
import { PRETOOL_ENABLED, PRETOOL_RUNTIME, PRETOOL_SOCKET } from "./tool-gate.js";

/** How long to wait for the Host's answer; the installed hook timeout is longer. */
const ANSWER_TIMEOUT_MS = 3_000;

/** Upper bound on one response; a longer one is refused, not buffered. */
const MAX_RESPONSE_BYTES = 100_000;

/**
 * Print one PreToolUse decision in the shape Codex reads.
 * @param decision - allow, or deny with the reason to report.
 */
function emit(decision: { kind: "allow" } | { kind: "deny"; reason: string }): void {
  const reason = decision.kind === "deny" ? decision.reason : undefined;
  const output = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision.kind,
    ...(reason === undefined ? {} : { permissionDecisionReason: reason }) } };
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

/** Read the whole of stdin. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Send one request line and read one decision line.
 * @param socketPath - the Host's receiving socket.
 * @param request - `{ runtime, event }`, with the event exactly as Codex sent it.
 * @returns the Host's decision, or a deny explaining why there is none.
 */
function ask(socketPath: string, request: unknown): Promise<{ kind: "allow" } | { kind: "deny"; reason: string }> {
  return new Promise(resolve => {
    let settled = false, buffer = "";
    const socket = connect(socketPath);
    const finish = (decision: { kind: "allow" } | { kind: "deny"; reason: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(decision);
    };
    const timer = setTimeout(() => finish({ kind: "deny", reason: "workflow gate: the Host did not answer in time" }), ANSWER_TIMEOUT_MS);
    socket.on("connect", () => { try { socket.write(`${JSON.stringify(request)}\n`); } catch { finish({ kind: "deny", reason: "workflow gate: the Host connection failed" }); } });
    socket.on("data", chunk => {
      buffer += String(chunk);
      if (buffer.length > MAX_RESPONSE_BYTES) { finish({ kind: "deny", reason: "workflow gate: the Host answer is too large" }); return; }
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      let decision: unknown;
      try { decision = JSON.parse(buffer.slice(0, index)); } catch { finish({ kind: "deny", reason: "workflow gate: the Host answer is not valid JSON" }); return; }
      if (typeof decision === "object" && decision !== null && (decision as { kind?: unknown }).kind === "allow") { finish({ kind: "allow" }); return; }
      const reason = typeof decision === "object" && decision !== null && typeof (decision as { reason?: unknown }).reason === "string"
        ? (decision as { reason: string }).reason : "workflow gate: the Host refused without a reason";
      finish({ kind: "deny", reason });
    });
    socket.on("error", () => finish({ kind: "deny", reason: "workflow gate: the Host connection failed" }));
    socket.on("close", () => finish({ kind: "deny", reason: "workflow gate: the Host closed without answering" }));
  });
}

async function main(): Promise<void> {
  if (process.env[PRETOOL_ENABLED] !== "1") return;
  const socketPath = process.env[PRETOOL_SOCKET], runtime = process.env[PRETOOL_RUNTIME];
  if (socketPath === undefined || socketPath === "" || runtime === undefined || runtime === "") {
    emit({ kind: "deny", reason: "workflow gate: this gated Session has no gate transport configured" });
    return;
  }
  const input = await readStdin();
  let event: unknown;
  try { event = JSON.parse(input); } catch { emit({ kind: "deny", reason: "workflow gate: the hook input is not valid JSON" }); return; }
  if (typeof event !== "object" || event === null) { emit({ kind: "deny", reason: "workflow gate: the hook input is not an object" }); return; }
  emit(await ask(socketPath, { runtime, event }));
}

main().catch(error => {
  // The decision protocol is the only thing stdout may carry; the failure is
  // reported as a denial so Codex never runs the operation unchecked.
  emit({ kind: "deny", reason: `workflow gate: the gate client failed: ${String(error)}` });
});
