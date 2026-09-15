import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {} from "@deepseek-ai/cordis";

/**
 * The workflow session gate: one binding per Session, one handler per hook.
 *
 * The workflow Host registers exactly one business handler and binds each child
 * it starts to `{ role, hook, args }`. The provider never interprets `role`: it
 * is the Host's own business label, not a persona, a model choice or a
 * permission level. The provider only carries the binding to the two execution
 * entry points — the DSH tool pipeline and the Codex PreToolUse hook — and asks
 * the same handler for a decision.
 *
 * Everything here is synchronous except the Codex transport that carries a hook
 * call to the Host; no rule ever calls a model.
 * @module dsh-codex-app-provider/tool-gate
 */

/** The one business hook an installed handler is addressed by. */
export const WORKFLOW_PRE_TOOL_USE = "workflow.preToolUse";

/** Wire name of the hook entry this provider installs; Codex reports it back. */
export const PRE_TOOL_USE_EVENT = "preToolUse";

/** The environment that arms the hook command; absent means exit 0 silently. */
export const PRETOOL_ENABLED = "DSH_PRETOOL_ENABLED";
export const PRETOOL_SOCKET = "DSH_PRETOOL_SOCKET";
export const PRETOOL_RUNTIME = "DSH_PRETOOL_RUNTIME";

/** How long the receiver waits for a complete request line before refusing it. */
const RECEIVE_TIMEOUT_MS = 2_000;

/** Upper bound on one request line; a longer one is refused, not buffered. */
const MAX_REQUEST_BYTES = 1_000_000;


/** One Session's bound business context. `args` is JSON data only. */
export interface GateBinding {
  /** Host business label; the provider never enumerates or interprets it. */
  role: string;
  /** The registered handler this Session's operations are checked by. */
  hook: string;
  /** Host-owned JSON arguments describing the Session's authorization. */
  args: Record<string, unknown>;
}

/** One operation about to execute, from either entry point. */
export interface GateEvent {
  source: "dsh" | "codex";
  /** DSH Session identity, resolved by the Host; never taken from a payload. */
  sessionId: string;
  callId: string;
  /** Trusted Session/operation working directory. */
  cwd: string;
  toolName: string;
  /** The complete original tool arguments, preserved for the handler. */
  toolArgs: unknown;
}

export type GateDecision =
  | { kind: "allow" }
  | { kind: "deny"; reason: string };

export type GateHandler = (
  binding: Readonly<GateBinding>,
  event: Readonly<GateEvent>,
) => GateDecision;

/** The Host-facing gate capability. */
export interface CodexToolGate {
  /**
   * Claim the hook name for one business handler.
   * @param hook - the hook name a binding addresses.
   * @param handler - synchronous decision function.
   * @returns the exact disposer that removes this registration.
   */
  register(hook: string, handler: GateHandler): () => void;
  /**
   * Bind one DSH Session to a hook and its JSON arguments.
   * @param sessionId - DSH Session identity, before its first start.
   * @param binding - the Host's business context for that Session.
   */
  bind(sessionId: string, binding: GateBinding): void;
}

/** The provider's own view of the record a Session is bound to, when one exists. */
export interface GateRecordFacts {
  /** The gate already saved on the provider record, when it has one. */
  gate?: GateBinding;
  /** The Codex execution cwd the native thread runs in. */
  cwd: string;
  /** The native turn currently recorded, when one is in flight. */
  turnId?: string;
  /** Whether this record can no longer operate its thread. */
  closed: boolean;
}

/**
 * One hook run Codex reported.
 *
 * The backend records these from `hook/started` and `hook/completed`, so a
 * refusal can be told apart from a tool call Codex never attempted at all.
 */
export interface HookRunEvidence {
  method: string;
  params: unknown;
  at: number;
}

/** Read one DSH Session's provider record facts; performs no I/O of its own. */
export type GateRecordReader = (dshSessionId: string) => GateRecordFacts | undefined;

/**
 * The provider-side registry, Session binding table and hook transport.
 *
 * The record reader is attached after construction because the backend and the
 * gate are created from one another; until it is attached, a binding is only
 * staged, which is exactly the state a Session sits in before its first start.
 */
export class CodexGateBridge implements CodexToolGate {
  private readonly handlers = new Map<string, GateHandler>();
  private readonly bound = new Map<string, GateBinding>();
  private reader?: GateRecordReader;
  /** Session id → the opaque key its current App Server runtime was given. */
  private readonly keys = new Map<string, string>();
  /** Runtime key → Session id. A key that is not here is stale and refused. */
  private readonly runtimes = new Map<string, string>();
  private client?: string;
  private socketPath?: string;
  private socketDir?: string;
  private server?: Server;
  private listening?: Promise<void>;
  private listenError?: string;
  private closed = false;

  /** Attach the provider-record reader used to validate a repeated binding. */
  useRecordReader(reader: GateRecordReader): void {
    this.reader = reader;
  }

  /**
   * Declare the hook command this deployment installs.
   *
   * The startup preflight matches `hooks/list` entries against it, so a managed
   * or trusted entry belonging to some other hook can never stand in for this
   * one.
   * @param path - absolute path of the built `pretool-client.js`.
   */
  useClient(path: string): void {
    this.client = path;
  }

  /** Whether a handler is registered for one hook. */
  hasHandler(hook: string): boolean {
    return this.handlers.has(hook);
  }

  register(hook: string, handler: GateHandler): () => void {
    if (typeof hook !== "string" || hook.length === 0) throw new Error("A gate hook name is required");
    if (typeof handler !== "function") throw new Error("A gate handler function is required");
    if (this.handlers.has(hook)) throw new Error(`A gate handler is already registered for ${hook}`);
    this.handlers.set(hook, handler);
    return () => {
      if (this.handlers.get(hook) === handler) this.handlers.delete(hook);
    };
  }

  bind(sessionId: string, binding: GateBinding): void {
    const staged = validatedBinding(sessionId, binding);
    if (!this.hasHandler(staged.hook)) throw new Error(`Gate hook is not registered: ${staged.hook}`);
    // An existing provider record is authoritative: a Session may only restate
    // the same binding. A different one would silently widen a running child's
    // authority, so it is refused instead of overwritten.
    const recorded = this.reader?.(sessionId)?.gate;
    if (recorded !== undefined && !sameBinding(recorded, staged)) {
      throw new Error("This Session is already bound to a different gate; start a new Session");
    }
    const previous = this.bound.get(sessionId);
    if (previous !== undefined) {
      if (!sameBinding(previous, staged)) throw new Error("This Session is already bound to a different gate; start a new Session");
      return;
    }
    this.bound.set(sessionId, staged);
  }

  /**
   * The binding a Session's first record must persist, or undefined.
   * @param sessionId - DSH Session identity.
   * @returns an independent copy of the staged binding.
   */
  bindingFor(sessionId: string): GateBinding | undefined {
    const binding = this.bound.get(sessionId) ?? this.reader?.(sessionId)?.gate;
    return binding === undefined ? undefined : structuredClone(binding);
  }

  /** Whether this Session is gated at all. */
  isBound(sessionId: string): boolean {
    return this.bindingFor(sessionId) !== undefined;
  }

  /**
   * The environment one gated runtime needs, or undefined for an ungated one.
   *
   * The runtime key is random and never persisted: a restarted, handed-over or
   * replaced runtime gets a new one, so an old key cannot act on the new
   * runtime. Nothing about the gate is ever read from tool arguments, a prompt
   * or a file.
   * @param sessionId - DSH Session identity about to get an App Server runtime.
   * @returns the injection for that runtime, or undefined when it is not gated.
   */
  envFor(sessionId: string): NodeJS.ProcessEnv | undefined {
    if (this.closed || !this.isBound(sessionId)) return undefined;
    this.ensureListening();
    const key = randomUUID();
    this.keys.set(sessionId, key);
    this.runtimes.set(key, sessionId);
    return { [PRETOOL_ENABLED]: "1", [PRETOOL_SOCKET]: this.socketPath!, [PRETOOL_RUNTIME]: key };
  }

  /**
   * Retire one Session's runtime key.
   *
   * Called whenever a runtime is replaced or released, so a leaked key cannot
   * outlive the process it was issued to.
   * @param sessionId - DSH Session identity.
   */
  releaseRuntime(sessionId: string): void {
    const key = this.keys.get(sessionId);
    if (key === undefined) return;
    this.keys.delete(sessionId);
    this.runtimes.delete(key);
  }

  /** Wait until the receiving socket is listening; rejects when it could not. */
  async ready(): Promise<void> {
    this.ensureListening();
    await this.listening;
    if (this.listenError !== undefined) throw new Error(this.listenError);
  }

  /**
   * Refuse to start a gated Session whose hook Codex would silently skip.
   *
   * This is the one deployment failure that is otherwise invisible: an
   * untrusted or disabled entry is listed and then not run, with no error.
   * @param request - the App Server request function of the runtime about to run.
   * @param cwd - the workspace whose hook configuration applies.
   */
  async preflight(request: (method: string, params: unknown) => Promise<unknown>, cwd: string): Promise<void> {
    if (this.client === undefined) throw new Error("the gate bridge has no installed hook command to verify");
    await this.ready();
    let response: unknown;
    try {
      response = await request("hooks/list", { cwds: [cwd] });
    } catch (error) {
      throw new Error(`the Codex App Server could not list hooks: ${String(error)}`);
    }
    assertPreToolUseHook(response, { client: this.client });
  }

  /** Ask one Session's handler for a decision. */
  decide(sessionId: string, event: GateEvent): GateDecision {
    const binding = this.bound.get(sessionId) ?? this.reader?.(sessionId)?.gate;
    if (binding === undefined) return denyDecision("workflow gate: this Session has no workflow binding");
    const handler = this.handlers.get(binding.hook);
    if (handler === undefined) return denyDecision(`workflow gate: no handler is registered for ${binding.hook}`);
    try {
      const decision = handler(structuredClone(binding), event);
      if (decision === undefined || decision === null || (decision.kind !== "allow" && decision.kind !== "deny")) {
        return denyDecision("workflow gate: the handler returned no decision");
      }
      if (decision.kind === "deny") {
        const reason = typeof decision.reason === "string" && decision.reason.length > 0 ? decision.reason : "workflow gate: denied without a reason";
        return denyDecision(reason);
      }
      return { kind: "allow" };
    } catch (error) {
      return denyDecision(`workflow gate: the handler failed: ${String(error)}`);
    }
  }

  /**
   * Decide one request line from the hook command.
   *
   * The Session identity comes from the runtime key alone. Nothing in the
   * payload — not its `session_id`, not a role or arguments a caller made up —
   * can select or replace a binding.
   * @param line - one complete JSON request line.
   * @returns the decision to return to the hook command.
   */
  receive(line: string): GateDecision {
    let request: { runtime?: unknown; event?: unknown };
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
      request = parsed as { runtime?: unknown; event?: unknown };
    } catch {
      return denyDecision("workflow gate: the hook request is not valid JSON");
    }
    if (typeof request.runtime !== "string" || !this.runtimes.has(request.runtime)) {
      return denyDecision("workflow gate: the hook request names an unknown runtime");
    }
    const sessionId = this.runtimes.get(request.runtime)!;
    const facts = this.reader?.(sessionId);
    if (facts === undefined) return denyDecision("workflow gate: the requesting Session has no record");
    if (facts.closed) return denyDecision("workflow gate: the requesting Session can no longer be checked");
    const payload = typeof request.event === "object" && request.event !== null ? request.event as Record<string, unknown> : {};
    const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "";
    // The trusted cwd is the record's execution cwd, not a value the operation
    // reported; a payload that names a different one is refused rather than
    // resolved against it.
    if (typeof payload.cwd === "string" && payload.cwd !== "" && resolve(payload.cwd) !== resolve(facts.cwd)) {
      return denyDecision(`workflow gate: the operation cwd ${payload.cwd} is not the Session's ${facts.cwd}`);
    }
    if (typeof payload.turn_id === "string" && payload.turn_id !== "" && facts.turnId !== undefined && payload.turn_id !== facts.turnId) {
      return denyDecision("workflow gate: the operation does not belong to the Session's current turn");
    }
    return this.decide(sessionId, { source: "codex", sessionId,
      callId: typeof payload.tool_use_id === "string" ? payload.tool_use_id : "",
      cwd: facts.cwd, toolName, toolArgs: payload.tool_input });
  }

  /** Close the transport and delete the socket this instance created. */
  async close(): Promise<void> {
    this.closed = true;
    for (const key of [...this.runtimes.keys()]) this.runtimes.delete(key);
    this.keys.clear();
    const server = this.server;
    this.server = undefined;
    if (server !== undefined) await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    if (this.socketDir !== undefined) {
      try { rmSync(this.socketDir, { recursive: true, force: true }); } catch {}
      this.socketDir = undefined;
      this.socketPath = undefined;
    }
  }

  /** Start the receiving socket once; the path is assigned synchronously. */
  private ensureListening(): void {
    if (this.listening !== undefined || this.closed) return;
    const dir = mkdtempSync(join(tmpdir(), "dsh-pretool-"));
    const path = join(dir, "gate.sock");
    this.socketDir = dir;
    this.socketPath = path;
    const server = createServer(socket => this.handleConnection(socket));
    this.server = server;
    this.listening = new Promise<void>(resolveListen => {
      server.once("error", error => { this.listenError = `the gate socket could not listen: ${String(error)}`; resolveListen(); });
      server.listen(path, () => {
        try { chmodSync(path, 0o600); } catch {}
        resolveListen();
      });
    });
  }

  /** One connection carries exactly one request and one response. */
  private handleConnection(socket: Socket): void {
    let buffer = "";
    let settled = false;
    const reply = (decision: GateDecision): void => {
      if (settled) return;
      settled = true;
      try { socket.end(`${JSON.stringify(decision)}\n`); } catch {}
    };
    socket.setTimeout(RECEIVE_TIMEOUT_MS, () => reply(denyDecision("workflow gate: the hook request was incomplete")));
    socket.on("error", () => reply(denyDecision("workflow gate: the hook connection failed")));
    socket.on("data", chunk => {
      if (settled) return;
      buffer += String(chunk);
      const index = buffer.indexOf("\n");
      if (index < 0) {
        if (buffer.length > MAX_REQUEST_BYTES) reply(denyDecision("workflow gate: the hook request is too large"));
        return;
      }
      reply(this.receive(buffer.slice(0, index)));
    });
    socket.on("end", () => reply(denyDecision("workflow gate: the hook request ended without a complete line")));
  }
}

/**
 * Whether the listed hook configuration would actually run this provider's
 * PreToolUse command.
 *
 * An entry that is present but untrusted, disabled or erroring is the silent
 * failure this check exists for: Codex lists it and then skips it.
 * @param response - the `hooks/list` response.
 * @param options - the installed client path the entry must name.
 * @throws when no entry would run for this client.
 */
export function assertPreToolUseHook(response: unknown, options: { client: string }): void {
  const entries = hookEntries(response);
  if (entries.length === 0) throw new Error("the Codex hooks/list response named no hooks");
  const mine = entries.filter(entry => typeof entry.command === "string" && entry.command.includes(options.client));
  if (mine.length === 0) throw new Error(`no installed Codex hook runs ${options.client}`);
  const usable = mine.filter(entry => entry.enabled !== false && entry.errors === undefined);
  if (usable.length === 0) throw new Error("the installed Codex hook is disabled or reports errors");
  const trusted = usable.filter(entry => entry.trustStatus === "managed" || entry.trustStatus === "trusted");
  if (trusted.length === 0) {
    const status = usable.map(entry => String(entry.trustStatus ?? "unknown")).join(", ");
    throw new Error(`the installed Codex hook is not trusted (${status}); Codex would skip it without reporting an error`);
  }
  if (!trusted.some(entry => String(entry.eventName ?? "").replace(/[^a-z]/gi, "").toLowerCase() === PRE_TOOL_USE_EVENT.toLowerCase())) {
    throw new Error("the installed Codex hook is not a PreToolUse hook");
  }
}

/** Every hook entry a `hooks/list` response carries, in any of its shapes. */
function hookEntries(response: unknown): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { for (const entry of value) visit(entry); return; }
    if (typeof value !== "object" || value === null) return;
    const record = value as Record<string, unknown>;
    if (typeof record.command === "string" || typeof record.eventName === "string" || typeof record.hookEventName === "string") {
      found.push(record);
      return;
    }
    for (const entry of Object.values(record)) visit(entry);
  };
  visit(response);
  return found;
}

/** One denial, always prefixed the same way on both sides of the bridge. */
function denyDecision(reason: string): GateDecision {
  return { kind: "deny", reason };
}

/**
 * Validate and detach one binding.
 * @param sessionId - DSH Session identity the binding belongs to.
 * @param binding - the declared binding.
 * @returns an independent copy of the binding.
 * @throws when the identity, the labels or the arguments are not usable.
 */
export function validatedBinding(sessionId: string, binding: GateBinding): GateBinding {
  if (typeof sessionId !== "string" || sessionId.length === 0) throw new Error("A DSH Session identity is required to bind a gate");
  if (typeof binding !== "object" || binding === null || Array.isArray(binding)) throw new Error("A gate binding must be an object");
  if (typeof binding.role !== "string" || binding.role.length === 0) throw new Error("A gate binding requires a non-empty role label");
  if (typeof binding.hook !== "string" || binding.hook.length === 0) throw new Error("A gate binding requires a non-empty hook name");
  jsonData(binding.args, "gate args");
  if (typeof binding.args !== "object" || binding.args === null || Array.isArray(binding.args)) throw new Error("A gate binding requires a JSON object as its args");
  return { role: binding.role, hook: binding.hook, args: structuredClone(binding.args) };
}

/** Whether two bindings are the same JSON value, independent of key order. */
export function sameBinding(left: GateBinding, right: GateBinding): boolean {
  return canonical(left) === canonical(right);
}

/** Reject anything that cannot survive a JSON round trip unchanged. */
function jsonData(value: unknown, path: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} must contain only finite numbers`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => jsonData(entry, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error(`${path} must contain only plain objects`);
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) throw new Error(`${path}.${key} must be JSON data, not undefined`);
      jsonData(entry, `${path}.${key}`);
    }
    return;
  }
  throw new Error(`${path} must be JSON data`);
}

/** One canonical JSON rendering, so a key-order difference is not a difference. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}


declare module "@deepseek-ai/cordis" {
  interface Context { codexToolGate: CodexToolGate }
}
