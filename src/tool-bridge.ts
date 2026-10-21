/**
 * Native DSH tool bridge for the Codex route.
 *
 * Codex App Server accepts dynamic tool declarations on `thread/start` and calls
 * them back through `item/tool/call`. This module maps that native surface onto
 * DSH's own tool registry: which DSH tools one request may expose, what
 * declaration a thread froze, how a callback is bound to the live Agent, and how
 * a DSH execution result becomes a native answer.
 *
 * The declaration is frozen per thread because the protocol only carries it on
 * `thread/start`: `thread/resume` cannot add tools. A request whose selection
 * changed therefore refuses the existing thread instead of silently running with
 * a stale declaration.
 * @module dsh-codex-app-provider/tool-bridge
 */

import { createHash } from "node:crypto";

import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ToolSchema } from "@deepseek-ai/dsh-llm";
import type { ToolExecutionResult } from "@deepseek-ai/dsh-tools";

/** The DSH tools the first bridge version admits, in exposure order. */
export const DEFAULT_BRIDGED_TOOLS: readonly string[] = [
  "cordis_inspect_list",
  "cordis_inspect_query",
  "plugin_manager",
  "plugin_market",
  "skill",
  "read",
];

/** Native declarations carry this prefix so a DSH tool name never collides with a Codex tool. */
export const NATIVE_TOOL_PREFIX = "dsh_";

/** One frozen native declaration; `name` already carries {@link NATIVE_TOOL_PREFIX}. */
export interface BridgeToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** The declaration one thread froze plus the fingerprint a later request is compared against. */
export interface BridgeDeclaration {
  tools: readonly BridgeToolSpec[];
  fingerprint: string;
}

/** One `item/tool/call` request as the App Server sends it. */
export interface BridgeCallRequest {
  threadId: string;
  turnId: string;
  callId: string;
  tool: string;
  arguments: unknown;
  namespace?: string | null;
}

/** One native answer: text only in the first version; any other content fails explicitly. */
export interface BridgeResponse {
  contentItems: { type: "inputText"; text: string }[];
  success: boolean;
}

/** The DSH tool registry seams the bridge reads and calls. */
export interface ToolBridgeSeam {
  schemas(agent: Agent): readonly ToolSchema[];
  execute(input: { callId: string; name: string; arguments: unknown; agent: Agent; signal: AbortSignal }): Promise<ToolExecutionResult>;
}

/** Where the bridge is configured and where an unmapped selection is reported. */
export interface ToolBridgeOptions {
  enabled: boolean;
  allow: readonly string[];
  log(message: string): void;
}

/** The settled answer for one call identity, kept so a replayed request returns it. */
interface SettledCall {
  arguments: string;
  response: BridgeResponse;
}

/**
 * Compute the exposure set for one request.
 *
 * The result is the intersection of the configured allow list, the tools the
 * main request presented to the model, and the scoped schemas the DSH registry
 * currently serves. The registry copy is authoritative for description and
 * parameters; a name present in only one source is not exposed.
 * @param allow - configured exposure ceiling, in exposure order.
 * @param presented - schemas the main LLM request carried.
 * @param scoped - schemas the DSH registry currently serves for this Agent.
 * @returns native declarations for the intersection, in allow order.
 */
export function selectBridgeTools(
  allow: readonly string[],
  presented: readonly ToolSchema[],
  scoped: readonly ToolSchema[],
): BridgeToolSpec[] {
  const available = new Map(scoped.map(schema => [schema.name, schema]));
  const exposed = new Set(presented.map(schema => schema.name));
  const selected: BridgeToolSpec[] = [];
  for (const name of allow) {
    if (!exposed.has(name)) continue;
    const schema = available.get(name);
    if (schema === undefined) continue;
    selected.push({
      name: `${NATIVE_TOOL_PREFIX}${name}`,
      description: schema.description,
      inputSchema: schema.parameters,
    });
  }
  return selected;
}

/**
 * Freeze one declaration and fingerprint it.
 *
 * Sorted by native name so the fingerprint is independent of registry order; a
 * changed description or schema changes the fingerprint and therefore refuses a
 * thread that froze the old one.
 * @param tools - the selected native declarations.
 * @returns the declaration and its stable fingerprint.
 */
export function declarationOf(tools: readonly BridgeToolSpec[]): BridgeDeclaration {
  const sorted = [...tools].sort((left, right) => left.name.localeCompare(right.name));
  const fingerprint = createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
  return { tools: sorted, fingerprint };
}

/**
 * Convert one DSH execution result into the native answer.
 *
 * The first version carries text only: a result with an image, file or any other
 * block fails explicitly rather than dropping content and reporting success.
 * @param result - the DSH execution outcome.
 * @returns the native answer.
 */
export function responseOf(result: ToolExecutionResult): BridgeResponse {
  const texts: string[] = [];
  for (const block of result.content) {
    if (block.type !== "text") {
      return failure(`tool bridge: ${block.type} content is not supported by the first bridge version`);
    }
    texts.push(block.text);
  }
  const text = texts.join("\n");
  if (result.isError) return { contentItems: texts.length === 0 ? [] : [{ type: "inputText", text }], success: false };
  return { contentItems: [{ type: "inputText", text }], success: true };
}

/** A failure answer with an explicit reason instead of an empty success. */
function failure(text: string): BridgeResponse {
  return { contentItems: [{ type: "inputText", text }], success: false };
}

/** Stable JSON for argument comparison; an unserializable value reads as its message. */
function stableArguments(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

/**
 * The bridge itself: selection, binding-independent dedup, serialized execution
 * and the native answer.
 */
export class ToolBridge {
  private readonly settled = new Map<string, SettledCall>();
  private readonly inflight = new Map<string, Promise<BridgeResponse>>();
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(readonly deps: { seam: ToolBridgeSeam; options: ToolBridgeOptions }) {}

  /** Whether the bridge is configured on at all. */
  get enabled(): boolean {
    return this.deps.options.enabled;
  }

  /**
   * The declaration this request's thread would freeze.
   * @param agent - the live Agent the main request runs on, when one is registered.
   * @param presented - tool schemas the main request carried.
   * @returns the declaration, or undefined when nothing is exposed.
   */
  declaration(agent: Agent | undefined, presented: readonly ToolSchema[] | undefined): BridgeDeclaration | undefined {
    if (agent === undefined || !this.enabled || presented === undefined || presented.length === 0) return undefined;
    let scoped: readonly ToolSchema[];
    try {
      scoped = this.deps.seam.schemas(agent);
    } catch (error) {
      this.deps.options.log(`tool bridge: the DSH tool catalog could not be read: ${messageOf(error)}`);
      return undefined;
    }
    const tools = selectBridgeTools(this.deps.options.allow, presented, scoped);
    if (tools.length === 0) {
      // PTC presents only the `run_code` transport to the model, so there is no
      // native function to declare. This is a configuration mismatch to report,
      // not a silently empty bridge.
      if (presented.every(schema => schema.name === "run_code")) {
        this.deps.options.log("tool bridge: PTC presentation exposes only run_code; the bridge supports native tool presentation only");
      } else {
        this.deps.options.log("tool bridge: the request presented no tool the bridge may expose");
      }
      return undefined;
    }
    return declarationOf(tools);
  }

  /**
   * Answer one native tool call.
   *
   * Calls of one Session run one at a time so plugin-management and inspection
   * calls cannot interleave. A repeated call identity returns the settled answer
   * instead of executing twice; the same identity with different arguments is a
   * conflict, not a retry.
   * @param request - the native request.
   * @param agent - the live Agent bound to the calling thread.
   * @param scope - stable per-Session queue key.
   * @param signal - the turn's cancellation signal.
   * @returns the native answer.
   */
  async call(request: BridgeCallRequest, agent: Agent | undefined, scope: string, signal: AbortSignal): Promise<BridgeResponse> {
    const key = `${request.threadId}\u0000${request.turnId}\u0000${request.callId}`;
    const argumentsKey = stableArguments(request.arguments);
    const settled = this.settled.get(key);
    if (settled !== undefined) {
      return settled.arguments === argumentsKey ? settled.response : failure(`tool bridge: a call with this identity already ran with different arguments`);
    }
    const running = this.inflight.get(key);
    if (running !== undefined) return running;
    const previous = this.queues.get(scope) ?? Promise.resolve();
    const operation = previous.then(() => this.run(request, agent, argumentsKey, signal), () => this.run(request, agent, argumentsKey, signal));
    this.queues.set(scope, operation.catch(() => {}));
    this.inflight.set(key, operation);
    try {
      return await operation;
    } finally {
      this.inflight.delete(key);
    }
  }

  private async run(
    request: BridgeCallRequest,
    agent: Agent | undefined,
    argumentsKey: string,
    signal: AbortSignal,
  ): Promise<BridgeResponse> {
    const key = `${request.threadId}\u0000${request.turnId}\u0000${request.callId}`;
    if (agent === undefined) return this.settle(key, argumentsKey, failure("tool bridge: the calling Session has no live Agent"));
    const name = request.tool.startsWith(NATIVE_TOOL_PREFIX) ? request.tool.slice(NATIVE_TOOL_PREFIX.length) : undefined;
    if (name === undefined) return this.settle(key, argumentsKey, failure(`tool bridge: ${request.tool} is not a bridged DSH tool`));
    let scoped: readonly ToolSchema[];
    try {
      scoped = this.deps.seam.schemas(agent);
    } catch (error) {
      return this.settle(key, argumentsKey, failure(`tool bridge: the DSH tool catalog could not be read: ${messageOf(error)}`));
    }
    if (!scoped.some(schema => schema.name === name) || !this.deps.options.allow.includes(name)) {
      return this.settle(key, argumentsKey, failure(`tool bridge: ${name} is not exposed to this Session`));
    }
    if (signal.aborted) return this.settle(key, argumentsKey, failure("tool bridge: the turn was cancelled before the tool ran"));
    try {
      const result = await this.deps.seam.execute({ callId: request.callId, name, arguments: request.arguments, agent, signal });
      const response = responseOf(result);
      this.deps.options.log(`tool bridge: ${request.tool} ${result.isError ? "failed" : "succeeded"}`);
      return this.settle(key, argumentsKey, response);
    } catch (error) {
      const response = failure(`tool bridge: ${request.tool} failed: ${messageOf(error)}`);
      this.deps.options.log(response.contentItems[0].text);
      return this.settle(key, argumentsKey, response);
    }
  }

  /** Remember one settled answer, bounding the replay cache. */
  private settle(key: string, argumentsKey: string, response: BridgeResponse): BridgeResponse {
    this.settled.set(key, { arguments: argumentsKey, response });
    if (this.settled.size > 512) {
      const oldest = this.settled.keys().next().value;
      if (oldest !== undefined) this.settled.delete(oldest);
    }
    return response;
  }
}

/** A message from any thrown value. */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
