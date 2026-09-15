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

/** Read one DSH Session's provider record facts; performs no I/O of its own. */
export type GateRecordReader = (dshSessionId: string) => GateRecordFacts | undefined;

/**
 * The provider-side registry and Session binding table.
 *
 * The record reader is attached after construction because the backend and the
 * gate are created from one another; until it is attached, a binding is only
 * staged, which is exactly the state a Session sits in before its first start.
 */
export class CodexGateBridge implements CodexToolGate {
  private readonly handlers = new Map<string, GateHandler>();
  private readonly bound = new Map<string, GateBinding>();
  private reader?: GateRecordReader;

  /** Attach the provider-record reader used to validate a repeated binding. */
  useRecordReader(reader: GateRecordReader): void {
    this.reader = reader;
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
   * Ask one Session's handler for a decision.
   *
   * A missing registration, a missing binding, a record that can no longer
   * operate and a handler that throws all deny: an unavailable decision is
   * never read as permission.
   * @param sessionId - DSH Session identity.
   * @param event - the operation about to execute.
   * @returns the handler's decision, or a deny naming the missing piece.
   */
  decide(sessionId: string, event: GateEvent): GateDecision {
    const binding = this.bound.get(sessionId) ?? this.reader?.(sessionId)?.gate;
    if (binding === undefined) return { kind: "deny", reason: "workflow gate: this Session has no workflow binding" };
    const handler = this.handlers.get(binding.hook);
    if (handler === undefined) return { kind: "deny", reason: `workflow gate: no handler is registered for ${binding.hook}` };
    try {
      const decision = handler(structuredClone(binding), event);
      if (decision === undefined || decision === null || (decision.kind !== "allow" && decision.kind !== "deny")) {
        return { kind: "deny", reason: "workflow gate: the handler returned no decision" };
      }
      if (decision.kind === "deny") {
        const reason = typeof decision.reason === "string" && decision.reason.length > 0 ? decision.reason : "workflow gate: denied without a reason";
        return { kind: "deny", reason };
      }
      return { kind: "allow" };
    } catch (error) {
      return { kind: "deny", reason: `workflow gate: the handler failed: ${String(error)}` };
    }
  }
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
