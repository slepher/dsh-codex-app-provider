import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

import { projectExecutionFacts, reduceExecutionEvents } from "./execution-events.js";
import type { Session } from "@deepseek-ai/dsh-session";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { NativeExecution } from "./execution.js";
import {
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  type ContentBlock,
  type FinishReason,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type Message,
  type ReplayEnvelope,
  type StreamChunk,
  type TokenUsage,
} from "@deepseek-ai/dsh-llm";

import type {
  ApprovalDecision,
  ApprovalRequest,
  BackendEvent,
  CodexBackend,
  InputModality,
  ModelOption,
  ModelSettings,
  Report,
  SessionSnapshot,
  TurnInput,
  TurnSnapshot,
  Usage,
  UserInputAnswer,
  UserInputQuestion,
  UserInputRequest,
} from "./browser-types.js";
import { isCodexVisible, isInjectedContext } from "./context.js";
import { factMessage, factMessages, importedFactIds } from "./facts.js";
import {
  executionCwd,
  executionInputsEqual,
  readExecutionInputs,
  type ProviderExecutionInputs,
} from "./execution-inputs.js";

export const CODEX_PROVIDER = "codex";
/** Owner identity of every native Session this provider records. */
export const CODEX_OWNER_ID = "dsh-codex-provider";
const OWNER_ID = CODEX_OWNER_ID;
const AUXILIARY_PREFIX = "codex-aux:";
const CATALOG_TTL_MS = 30_000;
const TERMINAL_STATES = new Set<TurnSnapshot["state"]>(["completed", "failed", "interrupted"]);
/** Opening text of one projected DSH history segment (`importedInput`). */
const HISTORY_IMPORT_MARKER = "[DSH history import";

/** The subset of the DSH Session a provider needs: the workspace default. */
export interface ProviderSessionFace {
  append?: Session["append"];
  snapshotEvents?: Session["snapshotEvents"];
  header?: { cwd?: string };
}

export interface ProviderQuestionOption {
  label: string;
  description?: string;
}

export interface ProviderQuestion {
  id: string;
  question: string;
  header?: string;
  options?: readonly ProviderQuestionOption[];
  multiSelect?: boolean;
}

export interface ProviderQuestionAnswer {
  id: string;
  selected: readonly string[];
  custom?: string;
}

/** Durable image reference fields the provider reads; matches DSH `ImageAttachmentRef`. */
export interface ProviderImageRef {
  attachmentId: string;
  mediaType: string;
  bytes: number;
  width: number;
  height: number;
  name?: string;
}

/**
 * Optional durable-attachment seam (`ctx.attachments`). Codex reads images
 * from the host path; `readImage` is the fallback for stores without host
 * files. Absent means images fail closed instead of being dropped.
 */
export interface ProviderAttachmentSeam {
  imageHostPath(ref: ProviderImageRef): string | undefined;
  readImage?(ref: ProviderImageRef, signal?: AbortSignal): Promise<{ data: Uint8Array }>;
}

type ImageKind = "content" | "history";
type ImageResolver = (ref: ProviderImageRef, kind: ImageKind) => Promise<TurnInput>;

/** Optional DSH structured-question seam (`ctx.userQuestions`); absent means fail closed with empty answers. */
export interface ProviderQuestionSeam {
  ask(request: {
    agent: Agent;
    questions: readonly ProviderQuestion[];
    signal?: AbortSignal;
  }): Promise<{ answers: readonly ProviderQuestionAnswer[] }>;
}

export interface CodexProviderDeps {
  backend: CodexBackend;
  sessions: { get(id: string): ProviderSessionFace | undefined };
  agents: { get(id: string): Agent | undefined };
  /**
   * Whether this composition can reach an interactive client for a native
   * approval decision. Absent or inactive means the plugin fails closed rather
   * than asking DSH's approval policy to decide for Codex.
   */
  approvals?: { readonly interactive: boolean } | undefined;
  /** Optional DSH structured-question seam (`ctx.userQuestions`); absent means empty answers. */
  questions?: ProviderQuestionSeam | undefined;
  /** Optional durable-attachment seam (`ctx.attachments`); absent keeps the provider text-only. */
  attachments?: ProviderAttachmentSeam | undefined;
  logger: { warn(message: string): void };
  /** Deployment default cwd for the model catalog when no Session workspace applies. */
  providerCwd: string;
}

interface TurnOutcome {
  status: TurnSnapshot["state"];
  output: string;
  error?: string;
}

export class CodexProviderAdapter extends LlmAdapter {
  private readonly cursors = new Map<string, string>();
  private readonly contextWindows = new Map<string, number>();
  private readonly active = new Set<AbortController>();
  private closed = false;
  private retiredFactChannelNoted = false;
  private catalogCache: { at: number; value: ModelSettings } | undefined;
  private catalogFlight: Promise<ModelSettings> | undefined;

  constructor(private readonly deps: CodexProviderDeps) {
    super();
  }

  /** Stop accepting calls and abort every in-flight turn; the backend owns process teardown. */
  close(): void {
    this.closed = true;
    for (const controller of this.active) controller.abort();
    this.active.clear();
  }

  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: "Codex" };
  }

  async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const settings = await this.catalog();
    return settings.models.map(model => ({
      provider,
      id: model.model,
      name: model.displayName,
      inputModalities: this.modalities(model),
    }));
  }

  async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    if (signal?.aborted) throw new LlmError("Codex model lookup aborted", "ABORTED");
    const settings = await this.catalog();
    const contextWindow = await this.contextWindowFor(model, settings);
    const option = settings.models.find(item => item.model === model);
    if (option === undefined) {
      return { provider, id: model, name: model, inputModalities: this.modalities(undefined), ...(contextWindow === undefined ? {} : { context: { contextWindow } }) };
    }
    const defaultEffort = model === settings.model && settings.effort !== null ? settings.effort : option.defaultReasoningEffort;
    return {
      provider,
      id: model,
      name: option.displayName,
      inputModalities: this.modalities(option),
      ...(contextWindow === undefined ? {} : { context: { contextWindow } }),
      reasoning: {
        efforts: option.supportedReasoningEfforts.map(item => ({
          id: ReasoningEffortId(item.reasoningEffort),
          name: item.reasoningEffort,
          ...(item.description === "" ? {} : { description: item.description }),
        })),
        ...(defaultEffort === undefined ? {} : { defaultEffort: ReasoningEffortId(defaultEffort) }),
      },
    };
  }

  /**
   * Modalities this adapter can actually deliver: the Codex catalogue's own
   * declaration, capped by whether the durable-attachment seam can resolve
   * images. `audio` is never advertised because DSH cannot route it.
   */
  private modalities(option: ModelOption | undefined): readonly InputModality[] {
    const supported: readonly InputModality[] = this.deps.attachments === undefined ? ["text"] : ["text", "image"];
    const declared = option?.inputModalities ?? ["text"];
    const values = declared.filter(value => supported.includes(value));
    return values.length === 0 ? ["text"] : values;
  }

  /** Resolve one durable image into a Codex input, or fail explicitly. */
  private readonly imageResolver: ImageResolver = (ref, kind) =>
    this.imageInput(ref, kind === "content" ? "UNSUPPORTED_CONTENT" : "UNSUPPORTED_HISTORY");

  private async imageInput(ref: ProviderImageRef, code: "UNSUPPORTED_CONTENT" | "UNSUPPORTED_HISTORY"): Promise<TurnInput> {
    const attachments = this.deps.attachments;
    if (attachments !== undefined) {
      try {
        const hostPath = attachments.imageHostPath(ref);
        if (hostPath !== undefined && isAbsolute(hostPath)) return { type: "localImage", path: hostPath };
        if (attachments.readImage !== undefined) {
          const stored = await attachments.readImage(ref);
          return { type: "image", url: `data:${ref.mediaType};base64,${Buffer.from(stored.data).toString("base64")}` };
        }
      } catch (error) {
        this.deps.logger.warn(`Codex image resolution failed; the turn was not started: ${String(error)}`);
      }
    }
    throw new LlmError("The Codex provider cannot represent this image; the turn was not started", code);
  }

  private async contextWindowFor(model: string, settings: ModelSettings): Promise<number | undefined> {
    const cached = this.contextWindows.get(model);
    if (cached !== undefined) return cached;
    const configured = model === settings.model ? settings.contextWindow : undefined;
    if (configured !== undefined) {
      this.contextWindows.set(model, configured);
      return configured;
    }
    const sessions = await this.deps.backend.listSessions(OWNER_ID).catch(() => [] as readonly SessionSnapshot[]);
    for (const record of sessions) {
      if (record.model !== model) continue;
      const learned = usageContextWindow(record.usage);
      if (learned !== undefined) {
        this.contextWindows.set(model, learned);
        return learned;
      }
    }
    return undefined;
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (this.closed) throw new LlmError("Codex provider is shutting down", "DISPOSED");
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    this.active.add(controller);
    try {
      yield* this.streamInternal(options, controller.signal);
    } finally {
      this.active.delete(controller);
      options.signal?.removeEventListener("abort", onAbort);
      controller.abort();
    }
  }

  private async *streamInternal(options: GenerateOptions, signal: AbortSignal): AsyncIterable<StreamChunk> {
    if (options.provider !== CODEX_PROVIDER) throw new LlmError(`Unsupported provider route: ${options.provider}`, "NO_ADAPTER");
    const sessionId = options.sessionId === undefined ? undefined : String(options.sessionId);
    if (sessionId === undefined) throw new LlmError("Codex provider requires a DSH Session identity", "INVALID_REQUEST");
    if (this.closed) throw new LlmError("Codex provider is shutting down", "DISPOSED");
    if (options.purpose !== undefined) {
      if (options.purpose === "compaction") await this.compactNativeThread(sessionId, signal);
      yield* this.streamAuxiliary(options, sessionId, signal);
      return;
    }
    yield* this.streamMain(options, sessionId, signal);
  }

  /**
   * Compact the user's native thread with `thread/compact/start` and then
   * rebuild it as a fresh thread. The DSH checkpoint summary still comes from
   * the isolated auxiliary request; native state is a disposable optimization
   * and the next user turn imports the post-compaction DSH history.
   */
  private async compactNativeThread(sessionId: string, signal: AbortSignal): Promise<void> {
    const owner = OWNER_ID, backendId = backendSessionId(sessionId), backend = this.deps.backend;
    const record = await backend.readSession(owner, backendId).catch(() => undefined);
    if (record === undefined || record.threadId === undefined || record.state !== "idle" || signal.aborted) return;
    const channel = new EventChannel(signal);
    const off = backend.subscribe(owner, backendId, event => channel.push(event));
    try {
      await backend.compactSession(owner, backendId);
      let completed = false;
      for await (const { event, sequence } of channel) {
        if (signal.aborted) break;
        if (event.type === "session.uncertain") throw new LlmError(event.error, "EXECUTION_UNKNOWN");
        if (event.type === "turn.state" && event.operation === "compact") {
          completed = event.turn.state === "completed";
          break;
        }
      }
      if (signal.aborted || !completed) {
        if (!completed && !signal.aborted) this.deps.logger.warn("Codex native compaction did not complete; keeping the current thread");
        return;
      }
      await backend.restartSession(owner, backendId);
      this.cursors.delete(sessionId);
    } catch (error) {
      this.deps.logger.warn(`Codex native compaction failed; the DSH checkpoint still applies: ${String(error)}`);
    } finally {
      off();
      channel.close();
    }
  }

  /**
   * Project the recorded native transcript into sourced history lines.
   *
   * Facts come from the provider's own recorded backend events, not from the DSH
   * session log: stock core rejects an unknown session event on read, so the
   * retired `codex/execution` channel is never written there. The provider store
   * is durable across restarts, so the projection needs no native resume. Model-
   * authored reasoning stays out; long output is shortened and points at its
   * durable item.
   * @param nativeSessionId - DSH Session id whose native transcript to project.
   * @returns the sourced lines, oldest first.
   * @throws when the Session has no recorded execution in the provider store.
   */
  async facts(nativeSessionId: string): Promise<readonly string[]> {
    if (!nativeSessionId) throw new Error("Native Session identity is required");
    const events = await this.deps.backend.readEvents(OWNER_ID, backendSessionId(nativeSessionId));
    return projectExecutionFacts(reduceExecutionEvents(events)).map(line => line.text);
  }

  /**
   * Announce once that execution facts now travel through the DSH session log.
   *
   * The provider store stays the raw record; the session log carries the visible
   * and resumable representation of what actually ran, so a reader of the
   * conversation can see the executed work without the provider.
   */
  private noteFactChannel(): void {
    if (this.retiredFactChannelNoted) return;
    this.retiredFactChannelNoted = true;
    this.deps.logger.warn("Codex execution facts are appended to the DSH session log as plugin-sourced user messages; the provider store keeps the raw record");
  }

  /**
   * Persist newly executed native facts into the DSH session log.
   *
   * `agent.inject()` only queues the next pre-step and a cancelled or exited
   * session would lose the record, so the durable path is a real
   * `user/message` append sourced from this plugin. Reading the current log
   * first makes the import idempotent: the message identity is derived from the
   * native item, so a retried turn, a reconnect or a cold recovery re-derives
   * the same identity instead of duplicating an executed command.
   * @param sessionId - the DSH Session whose executed facts to import.
   */
  private async importExecutionFacts(sessionId: string): Promise<void> {
    const session = this.deps.sessions.get(sessionId);
    if (session === undefined || session.append === undefined) return;
    try {
      const events = await this.deps.backend.readEvents(OWNER_ID, backendSessionId(sessionId));
      const pending = factMessages(projectExecutionFacts(reduceExecutionEvents(events)));
      if (pending.length === 0) return;
      const imported = new Set(importedFactIds(session.snapshotEvents?.() as readonly { type: string; data: unknown }[] | undefined));
      for (const fact of pending) {
        if (imported.has(fact.id)) continue;
        // Called on the Session itself: `append` is an instance method that owns
        // the log, so extracting it would break on the real core.
        session.append("user/message", factMessage(fact), { surfaceOp: "append" });
        imported.add(fact.id);
      }
      this.noteFactChannel();
    } catch (error) {
      this.deps.logger.warn(`Codex execution facts could not be appended to the DSH session log: ${String(error)}`);
    }
  }

  async readExecution(nativeSessionId: string): Promise<NativeExecution | undefined> {
    if (!nativeSessionId) throw new Error("Native Session identity is required");
    const id = backendSessionId(nativeSessionId);
    const snapshot = await this.deps.backend.readSession(OWNER_ID, id);
    if (snapshot === undefined) return undefined;
    const { threadId, turnId, cwd, model, reasoningEffort, pending, state } = snapshot;
    const reports = snapshot.reports.map(({ threadId, turnId, status, result, error, protocolError, usage, createdAt }) =>
      ({ threadId, turnId, status, result, error, protocolError, ...(usage?.last === undefined ? {} : { usage: usage.last }), createdAt }));
    return { nativeSessionId, threadId, turnId, cwd, model, reasoningEffort, ...(pending === undefined ? {} : { pending }), state, reports };
  }

  private async catalog(): Promise<ModelSettings> {
    const cached = this.catalogCache;
    if (cached !== undefined && Date.now() - cached.at < CATALOG_TTL_MS) return cached.value;
    this.catalogFlight ??= this.deps.backend.modelSettings(this.deps.providerCwd).then(value => {
      this.catalogCache = { at: Date.now(), value };
      return value;
    }).finally(() => {
      this.catalogFlight = undefined;
    });
    return this.catalogFlight;
  }

  /**
   * Bind a prepared record's first request to the thread it was handed.
   *
   * A record that already owns a native thread must resume that exact thread.
   * For a successor this also reconciles the recorded handover — the source
   * still points at the same thread and the successor runs the target
   * configuration — and a mismatch fails with its own reason. The provider
   * never falls back to `thread/start`: a missing or unverifiable binding is an
   * error, not a new thread.
   * @param record - the prepared record, already carrying its thread identity.
   * @param options - the request's model/effort, which must match the binding.
   * @returns whether this record continues a handed-over thread.
   */
  private async bindPreparedThread(record: SessionSnapshot, options: GenerateOptions): Promise<boolean> {
    const owner = OWNER_ID, backendId = record.sessionId, backend = this.deps.backend;
    const ownership = await backend.threadOwnership(owner, backendId);
    const source = ownership?.handoffFrom;
    if (source === undefined) {
      await backend.resumeSession(owner, backendId).catch(error => { throw providerError(error); });
      return false;
    }
    if (record.model !== undefined && record.model !== options.model
      || options.reasoningEffort !== undefined && record.reasoningEffort !== options.reasoningEffort) {
      throw new LlmError("The continuation request does not match the handed-over thread configuration", "EXECUTION_MISMATCH");
    }
    // The source record keeps the thread reference after de-authorization, so
    // it still proves which thread this successor was handed.
    const origin = await backend.threadOwnership(owner, source);
    if (origin?.threadId === undefined || origin.threadId !== record.threadId) {
      throw new LlmError("The handed-over Codex thread changed before its successor started", "EXECUTION_MISMATCH");
    }
    // `thread/resume` is the only admitted first call: it verifies the thread
    // identity, the target model/effort and the execution boundary against the
    // prepared record, and it never creates a replacement thread.
    await backend.resumeSession(owner, backendId).catch(error => { throw providerError(error); });
    return true;
  }

  /**
   * Resolve one request's effective execution inputs.
   *
   * Stock core does not fill `GenerateOptions.execution`, so the request is
   * preferred when it carries inputs but the live Agent's creation snapshot is
   * the fallback that keeps a managed child's role instructions and boundary.
   * The declared inputs travel verbatim: this plugin never rewrites a task
   * boundary into the Session workspace or widens its writable roots, and an
   * explicit request must still be authorized by the live Agent's route. A
   * managed child may switch model/effort between turns only through the core's
   * guarded configuration update, which is what keeps them equal.
   * @param options - the assembled request.
   * @param agent - the live Agent for this Session, when one is registered.
   * @returns the effective inputs, or undefined for an ordinary Codex Session.
   */
  private requestedExecution(
    options: GenerateOptions,
    agent: Agent | undefined,
  ): ProviderExecutionInputs | undefined {
    const live = agent !== undefined && String(agent.session.id) === options.sessionId ? agent : undefined;
    let fromRequest: ProviderExecutionInputs | undefined;
    let fromAgent: ProviderExecutionInputs | undefined;
    try {
      fromRequest = readExecutionInputs(options);
      fromAgent = readExecutionInputs(live?.options);
    } catch (error) {
      throw new LlmError(error instanceof Error ? error.message : String(error), "EXECUTION_MISMATCH");
    }
    // A managed child is any request whose authorized inputs came from the core
    // request or from the live Agent's creation snapshot. Stock core fills
    // neither into the other, so the route authorization below must key off the
    // resolved inputs rather than off `options.execution` alone.
    if (fromRequest !== undefined || fromAgent !== undefined) {
      if (live === undefined) {
        throw new LlmError("Native execution inputs require the live Agent creation snapshot", "EXECUTION_MISMATCH");
      }
      if (fromRequest !== undefined && !executionInputsEqual(fromRequest, fromAgent)) {
        throw new LlmError("Native execution inputs must match the live Agent creation snapshot", "EXECUTION_MISMATCH");
      }
      if (live.options.model !== options.model
        || (live.options.reasoningEffort !== undefined && live.options.reasoningEffort !== options.reasoningEffort)) {
        throw new LlmError("Native execution inputs must match the live Agent effective configuration", "EXECUTION_MISMATCH");
      }
    }
    return fromRequest ?? fromAgent;
  }

  private async *streamMain(options: GenerateOptions, sessionId: string, signal: AbortSignal): AsyncIterable<StreamChunk> {
    if (signal.aborted) throw new LlmError("Codex turn aborted before start", "ABORTED");
    const cwd = this.sessionCwd(sessionId);
    if (cwd === undefined) throw new LlmError("Codex provider requires a Session workspace (cwd)", "NO_WORKSPACE");
    const owner = OWNER_ID, backendId = backendSessionId(sessionId), backend = this.deps.backend;
    let record = await backend.readSession(owner, backendId);
    // `cwd` identifies the DSH Session's host workspace and `executionCwd` is
    // where its Codex thread actually runs; a lane worker legitimately has two
    // different values, so neither check may be dropped or conflated.
    if (record !== undefined && record.cwd !== cwd) {
      throw new LlmError("This Session's workspace changed; start a new DSH Session for the new workspace", "WORKSPACE_CHANGED");
    }
    const execution = this.requestedExecution(options, this.deps.agents.get(sessionId));
    const recorded = recordedExecution(record);
    if (recorded !== undefined && execution !== undefined && !executionInputsEqual(recorded, execution)) {
      throw new LlmError("Native execution instructions or boundary changed; create a new child", "EXECUTION_MISMATCH");
    }
    const targetExecutionCwd = execution !== undefined ? executionCwd(execution, cwd) : undefined;
    if (record !== undefined && targetExecutionCwd !== undefined
      && (record.executionCwd ?? recordedExecution(record)?.boundary?.cwd ?? cwd) !== targetExecutionCwd) {
      throw new LlmError("This Session's Codex execution location changed; start a new child", "EXECUTION_MISMATCH");
    }
    // Catch up on facts a previous process recorded but never imported — an
    // interrupted final turn, or a crash between the native turn and the append.
    await this.importExecutionFacts(sessionId);
    // A recorded effective execution is the thread's configuration baseline: a
    // cold recovery that carries no explicit inputs continues it instead of
    // demanding that a missing live Agent snapshot still declares them. A first
    // creation with neither keeps the ordinary, unscoped Codex path.
    const effective = execution ?? recorded;
    // A record that already owns a thread and never ran a turn is a prepared
    // binding: the successor a controlled handover created, a rebuilt thread, or
    // an imported one. Its first request must resume that exact thread.
    const prepared = record !== undefined && record.turnId === undefined && record.threadId !== undefined && record.state === "idle";
    const successor = prepared ? await this.bindPreparedThread(record!, options) : false;
    const plan = await planInput(options.messages, record?.threadId, this.cursors.get(sessionId), this.imageResolver);
    if (successor) assertFreshSuccessorInput(plan.input);
    if (record === undefined) {
      record = await backend.createSession(owner, backendId, cwd, { ...turnOptions(options), ...effective });
    } else if (record.state === "unknown") {
      throw new LlmError("Codex execution ownership unknown; confirm the prior process stopped before resume", "EXECUTION_UNKNOWN");
    } else if (record.state === "saved") {
      record = await backend.resumeSession(owner, backendId).catch(error => { throw providerError(error); });
    }
    // A workflow-managed child authorizes its target through the live Agent's
    // effective configuration, which may differ from the last confirmed value
    // until the App Server reports the applied settings, so its switch is
    // admitted above. A cold recovery with no live Agent authorization must
    // still match the recorded execution baseline. An ordinary Session resolves
    // no native execution inputs at all: its model/effort is the user's own
    // native selection, passed to `turn/start` and confirmed by the App Server,
    // so a second-turn switch must not be refused here.
    const managedSession = execution !== undefined || recorded !== undefined;
    if (managedSession && execution === undefined && (record.model !== options.model
      || (options.reasoningEffort !== undefined && record.reasoningEffort !== options.reasoningEffort))) {
      throw new LlmError("App Server did not apply the requested native execution model/effort", "EXECUTION_MISMATCH");
    }
    const channel = new EventChannel(signal);
    const off = backend.subscribe(owner, backendId, (event, sequence) => channel.push(event, sequence), { interactive: true });
    let turn: TurnSnapshot;
    try {
      turn = await backend.startTurn(owner, backendId, plan.input, { idempotencyKey: plan.key, ...turnOptions(options) });
    } catch (error) {
      off();
      channel.close();
      throw providerError(error);
    }
    this.cursors.set(sessionId, plan.key);
    let text = "", completedText: string | undefined, error: string | undefined;
    let status: TurnSnapshot["state"] | undefined, blockStarted = false;
    try {
      if (turn.state === "unknown") throw new LlmError("Codex execution state unknown; do not redispatch", "EXECUTION_UNKNOWN");
      if (TERMINAL_STATES.has(turn.state)) {
        ({ output: text, error } = await replayTurn(backend, owner, backendId, turn.turnId));
        completedText = text;
        status = turn.state;
      } else {
        for await (const { event } of channel) {
          if (signal?.aborted) break;
          if (event.type === "session.uncertain") throw new LlmError(event.error, "EXECUTION_UNKNOWN");
          if (event.type === "approval.requested") {
            void this.bridgeApproval(owner, event.request);
          } else if (event.type === "userInput.requested") {
            void this.bridgeUserInput(owner, sessionId, event.request, signal);
          } else if (event.type === "turn.output" && event.turnId === turn.turnId) {
            if (typeof event.item === "string") {
              text += event.item;
              if (!blockStarted) {
                blockStarted = true;
                yield { type: "block-start", index: 0, blockType: "text" };
              }
              yield { type: "text-delta", index: 0, text: event.item };
            } else if (isAgentMessage(event.item)) {
              completedText = event.item.text;
            }
          } else if (event.type === "turn.state" && event.turn.turnId === turn.turnId && TERMINAL_STATES.has(event.turn.state)) {
            status = event.turn.state;
            error = event.error;
            if (event.finalOutput !== undefined) completedText = event.finalOutput;
            break;
          }
        }
      }
    } finally {
      off();
      channel.close();
      // The backend committed every recorded fact before the channel closed, so
      // the projection is complete for a completed, failed or observed
      // interrupted turn. A turn interrupted while the process was still
      // waiting is imported by the next request's catch-up below.
      await this.importExecutionFacts(sessionId);
    }
    const output = completedText ?? text;
    if (signal?.aborted) {
      await cancelTurn(backend, owner, backendId, turn.turnId, this.deps.logger);
      yield* finishChunks(blockStarted, output, { kind: "aborted", failure: { message: "Codex turn aborted", code: "ABORTED" } });
      return;
    }
    if (status === "completed" && output.trim() === "") {
      throw new LlmError("Codex completed the turn without a visible assistant message", "EMPTY_RESULT");
    }
    if (status === "failed") {
      yield* finishChunks(blockStarted, output, { kind: "error", failure: { message: error ?? "Codex turn failed", code: "PROVIDER_ERROR" } });
      return;
    }
    if (status === "interrupted") {
      yield* finishChunks(blockStarted, output, { kind: "aborted", failure: { message: error ?? "Codex turn interrupted", code: "INTERRUPTED" } });
      return;
    }
    if (!blockStarted) yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "block-end", index: 0, block: { type: "text", text: output } };
    const usage = await this.readUsage(owner, backendId, turn.turnId, options.model);
    if (usage !== undefined) yield { type: "usage", usage };
    yield { type: "finish", reason: { kind: "stop" }, replayState: replayState(turn, plan.key) };
  }

  private async *streamAuxiliary(options: GenerateOptions, sessionId: string, signal: AbortSignal): AsyncIterable<StreamChunk> {
    if (signal.aborted) throw new LlmError("Codex auxiliary call aborted before start", "ABORTED");
    const cwd = this.sessionCwd(sessionId) ?? this.deps.providerCwd;
    const owner = OWNER_ID, backendId = `${AUXILIARY_PREFIX}${randomUUID()}`, backend = this.deps.backend;
    const input = await importedInput(options.messages.filter(message => message.role !== "system"), toolCallNames(options.messages), ref => this.imageResolver(ref, "content"));
    const channel = new EventChannel(signal);
    let off: (() => void) | undefined;
    try {
      await backend.createSession(owner, backendId, cwd, { ...turnOptions(options), approvalPolicy: "never", sandbox: "read-only" });
      off = backend.subscribe(owner, backendId, event => channel.push(event));
      let turn: TurnSnapshot;
      try {
        turn = await backend.startTurn(owner, backendId, input === "" ? " " : input, turnOptions(options));
      } catch (error) {
        throw providerError(error);
      }
      let output = "", completedText: string | undefined, error: string | undefined, status: TurnSnapshot["state"] | undefined;
      if (turn.state === "unknown") throw new LlmError("Codex execution state unknown; do not redispatch", "EXECUTION_UNKNOWN");
      if (TERMINAL_STATES.has(turn.state)) {
        ({ output, error } = await replayTurn(backend, owner, backendId, turn.turnId));
        completedText = output;
        status = turn.state;
      } else {
        for await (const { event, sequence } of channel) {
          if (signal?.aborted) break;
          if (event.type === "session.uncertain") throw new LlmError(event.error, "EXECUTION_UNKNOWN");
          if (event.type === "turn.output" && event.turnId === turn.turnId) {
            if (typeof event.item === "string") output += event.item;
            else if (isAgentMessage(event.item)) completedText = event.item.text;
          } else if (event.type === "turn.state" && event.turn.turnId === turn.turnId && TERMINAL_STATES.has(event.turn.state)) {
            status = event.turn.state;
            error = event.error;
            if (event.finalOutput !== undefined) completedText = event.finalOutput;
            break;
          }
        }
      }
      const result = completedText ?? output;
      if (signal?.aborted) {
        await cancelTurn(backend, owner, backendId, turn.turnId, this.deps.logger);
        yield { type: "finish", reason: { kind: "aborted", failure: { message: "Codex auxiliary call aborted", code: "ABORTED" } } };
        return;
      }
      if (status !== "completed" || result.trim() === "") {
        yield { type: "finish", reason: { kind: "error", failure: { message: error ?? "Codex auxiliary call failed", code: "AUX_FAILED" } } };
        return;
      }
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "block-end", index: 0, block: { type: "text", text: result } };
      const usage = await this.readUsage(owner, backendId, turn.turnId, options.model);
      if (usage !== undefined) yield { type: "usage", usage };
      yield { type: "finish", reason: { kind: "stop" } };
    } finally {
      off?.();
      channel.close();
      await this.closeAuxiliary(owner, backendId);
    }
  }

  /**
   * Hand one native approval to the plugin's own pane, or fail closed.
   *
   * Codex owns its approval configuration: the plugin never asks DSH's approval
   * service, whose per-Session policy would decide for Codex. A request that
   * reaches this client is one Codex could not settle itself, so with an
   * interactive channel mounted it simply stays pending until the pane answers
   * on the plugin's own approval channel. A composition with no client cannot
   * obtain a real decision, so it fails closed instead of fabricating consent —
   * the request and its recorded decline stay visible in the provider store.
   * @param owner - the provider's own owner identity.
   * @param request - the native request the App Server addressed to this client.
   */
  private async bridgeApproval(owner: string, request: ApprovalRequest): Promise<void> {
    if (this.deps.approvals?.interactive === true) return;
    this.deps.logger.warn("No Codex approval channel is mounted in this composition; the native approval was declined fail-closed");
    await this.decide(owner, request.requestId, "decline").catch(() => {});
  }

  private async decide(owner: string, requestId: string, decision: ApprovalDecision): Promise<void> {
    await this.deps.backend.decideApproval(owner, requestId, decision);
  }

  /**
   * Codex `request_user_input` maps onto DSH structured questions. Without an
   * agent or the seam (or when the question is aborted) the turn receives an
   * empty answer set, matching the upstream error path, never fabricated input.
   */
  private async bridgeUserInput(owner: string, sessionId: string, request: UserInputRequest, signal?: AbortSignal): Promise<void> {
    const agent = this.deps.agents.get(sessionId), questions = this.deps.questions;
    let answers: UserInputAnswer = null;
    if (agent !== undefined && questions !== undefined) {
      const controller = new AbortController();
      const onAbort = (): void => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const outcome = await questions.ask({ agent, questions: request.questions.map(providerQuestion), signal: controller.signal });
        answers = userInputAnswers(outcome.answers);
      } catch (error) {
        this.deps.logger.warn(`Codex user-input bridge failed: ${String(error)}`);
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    }
    try {
      await this.deps.backend.answerUserInput(owner, request.requestId, answers);
    } catch (error) {
      this.deps.logger.warn(`Codex user-input response failed: ${String(error)}`);
    }
  }

  private async readUsage(owner: string, backendId: string, turnId: string, model: string): Promise<TokenUsage | undefined> {
    const reports = await this.deps.backend.readReports(owner, backendId).catch(() => [] as readonly Report[]);
    const usage = reports.find(report => report.turnId === turnId)?.usage ?? null;
    const contextWindow = usage?.modelContextWindow;
    if (typeof contextWindow === "number" && Number.isSafeInteger(contextWindow) && contextWindow > 0) this.contextWindows.set(model, contextWindow);
    return usageChunk(usage);
  }

  private sessionCwd(sessionId: string): string | undefined {
    const cwd = this.deps.sessions.get(sessionId)?.header?.cwd;
    return typeof cwd === "string" && isAbsolute(cwd) ? cwd : undefined;
  }

  private async closeAuxiliary(owner: string, backendId: string): Promise<void> {
    try {
      await this.deps.backend.closeSession(owner, backendId);
    } catch (error) {
      this.deps.logger.warn(`Codex auxiliary Session cleanup requires confirmed execution ownership: ${String(error)}`);
    }
  }
}

interface SequencedEvent { event: BackendEvent; sequence?: number }

class EventChannel implements AsyncIterable<SequencedEvent> {
  private readonly queue: SequencedEvent[] = [];
  private wake: (() => void) | undefined;
  private closed = false;
  private readonly onAbort = (): void => { this.wake?.(); this.wake = undefined; };

  constructor(private readonly signal?: AbortSignal) {
    signal?.addEventListener("abort", this.onAbort);
  }

  push(event: BackendEvent, sequence?: number): void {
    if (this.closed) return;
    this.queue.push({ event, sequence });
    this.wake?.();
    this.wake = undefined;
  }

  close(): void {
    this.closed = true;
    this.signal?.removeEventListener("abort", this.onAbort);
    this.wake?.();
    this.wake = undefined;
  }

  async next(): Promise<IteratorResult<SequencedEvent>> {
    while (this.queue.length === 0) {
      if (this.closed || this.signal?.aborted) return { done: true, value: undefined };
      await new Promise<void>(resolve => { this.wake = resolve; });
    }
    return { done: false, value: this.queue.shift()! };
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<SequencedEvent> {
    return this;
  }
}

function* finishChunks(started: boolean, text: string, reason: FinishReason): Generator<StreamChunk> {
  if (started || text.trim() !== "") {
    if (!started) yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "block-end", index: 0, block: { type: "text", text } };
  }
  yield { type: "finish", reason };
}

async function cancelTurn(backend: CodexBackend, owner: string, backendId: string, turnId: string, logger: { warn(message: string): void }): Promise<void> {
  for (const request of await backend.pendingApprovals(owner, backendId).catch(() => [])) {
    await backend.decideApproval(owner, request.requestId, "cancel").catch(() => {});
  }
  await backend.interruptTurn(owner, turnId).catch(error => { logger.warn(`Codex turn interrupt failed after abort: ${String(error)}`); });
}

async function replayTurn(backend: CodexBackend, owner: string, backendId: string, turnId: string): Promise<TurnOutcome> {
  const events = await backend.readEvents(owner, backendId);
  let output = "", error: string | undefined, status: TurnSnapshot["state"] = "completed";
  for (const { event } of events) {
    if (event.type === "turn.output" && event.turnId === turnId) {
      if (typeof event.item === "string") output += event.item;
      else if (isAgentMessage(event.item)) output = event.item.text;
    } else if (event.type === "turn.state" && event.turn.turnId === turnId && TERMINAL_STATES.has(event.turn.state)) {
      status = event.turn.state;
      error = event.error;
      if (event.finalOutput !== undefined) output = event.finalOutput;
    }
  }
  return { status, output, ...(error === undefined ? {} : { error }) };
}

async function planInput(
  messages: readonly Message[],
  threadId: string | undefined,
  cursor: string | undefined,
  image: ImageResolver,
): Promise<{ input: string | TurnInput[]; key: string }> {
  const lastUser = [...messages].reverse().find(message => message.role === "user" && message.source.kind !== "tool");
  if (lastUser === undefined) throw new LlmError("Codex provider received no user input", "INVALID_REQUEST");
  const key = String(lastUser.id);
  let start = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== "assistant" || message.source.kind !== "model" || message.source.provider !== CODEX_PROVIDER) continue;
    if (threadId !== undefined && replayThread(message.source.replayState) === threadId) { start = index; break; }
  }
  if (start === -1 && cursor !== undefined) {
    const index = messages.findIndex(message => String(message.id) === cursor);
    if (index !== -1) start = index === messages.length - 1 ? index - 1 : index;
  }
  const segment = messages.slice(start + 1).filter(isCodexVisible);
  const current = segment[segment.length - 1];
  if (current === undefined) throw new LlmError("Codex provider found no new input for this turn", "INVALID_REQUEST");
  const names = toolCallNames(messages);
  const isUserInput = current.role === "user" && current.source.kind !== "tool";
  if (!isUserInput) return { input: await importedInput(segment, names, ref => image(ref, "history")), key };
  const history = segment.slice(0, -1);
  const currentParts = await renderBlocks(current.content, names, ref => image(ref, "content"));
  if (history.length === 0) return { input: represent(currentParts), key };
  const imported = await importedInput(history, names, ref => image(ref, "history"));
  if (imported === "") return { input: represent(currentParts), key };
  const parts: TurnInput[] = typeof imported === "string" ? [{ type: "text", text: imported }] : [...imported];
  const currentText = textOf(currentParts);
  if (currentText !== "" || currentParts.length === 0) parts.push({ type: "text", text: currentText });
  for (const part of currentParts) if (part.type !== "text") parts.push(part);
  return { input: parts, key };
}

/**
 * Render one DSH history segment as a single deterministic text import, or as
 * interleaved text/image inputs when the segment carries durable images.
 */
async function importedInput(
  messages: readonly Message[],
  names: Map<string, string>,
  image: (ref: ProviderImageRef) => Promise<TurnInput>,
): Promise<string | TurnInput[]> {
  const entries: { label: string; parts: TurnInput[] }[] = [];
  for (const message of messages) {
    if (isInjectedContext(message)) continue;
    const parts = await renderBlocks(message.content, names, image);
    const hasImage = parts.some(part => part.type !== "text");
    if (parts.length === 0 || (!hasImage && textOf(parts).trim() === "")) continue;
    entries.push({ label: messageLabel(message, names), parts });
  }
  if (entries.length === 0) return "";
  const header = "[DSH history import — reconstructed from the DSH Session log for continuity]";
  if (!entries.some(entry => entry.parts.some(part => part.type !== "text"))) {
    const lines = [header];
    for (const entry of entries) lines.push(`${entry.label}: ${textOf(entry.parts)}`);
    return lines.join("\n");
  }
  const parts: TurnInput[] = [];
  let buffer = [header];
  for (const entry of entries) {
    const body = textOf(entry.parts);
    if (body.trim() !== "") buffer.push(`${entry.label}: ${body}`);
    const images = entry.parts.filter(part => part.type !== "text");
    if (images.length > 0) {
      parts.push({ type: "text", text: buffer.join("\n") });
      parts.push(...images);
      buffer = [];
    }
  }
  if (buffer.length > 0) parts.push({ type: "text", text: buffer.join("\n") });
  return parts;
}

/**
 * Refuse a successor's first input that replays the source thread.
 *
 * The resumed thread already carries the original context, so the continuation
 * prompt is the only new user input. A DSH history import here would duplicate
 * work the thread performed and re-present executed tool calls as instructions.
 * @param input - the planned first input of a handed-over successor.
 */
function assertFreshSuccessorInput(input: string | readonly TurnInput[]): void {
  const text = typeof input === "string"
    ? input
    : input.filter(part => part.type === "text").map(part => (part as { text: string }).text).join("\n");
  if (text.includes(HISTORY_IMPORT_MARKER)) {
    throw new LlmError("A successor must continue the handed-over Codex thread instead of replaying its history", "EXECUTION_MISMATCH");
  }
}

/** Collapse rendered parts into the legacy string form unless the turn carries images. */
function represent(parts: readonly TurnInput[]): string | TurnInput[] {  if (!parts.some(part => part.type !== "text")) return textOf(parts);
  const values: TurnInput[] = [];
  for (const part of parts) if (part.type !== "text" || part.text !== "") values.push(part);
  return values;
}

function textOf(parts: readonly TurnInput[]): string {
  const values: string[] = [];
  for (const part of parts) if (part.type === "text") values.push(part.text);
  return values.join("\n");
}

function messageLabel(message: Message, names: Map<string, string>): string {
  if (message.source.kind !== "tool") return message.source.kind === "plugin" ? "context" : message.role;
  const name = names.get(String(message.source.callId));
  return `tool${name === undefined ? "" : `(${name})`}`;
}

async function renderBlocks(
  blocks: readonly ContentBlock[],
  names: Map<string, string>,
  image: (ref: ProviderImageRef) => Promise<TurnInput>,
): Promise<TurnInput[]> {
  const parts: TurnInput[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "text": if (block.text !== "") parts.push({ type: "text", text: block.text }); break;
      case "reasoning": break;
      case "image": parts.push(await image(block.attachment)); break;
      case "file": parts.push({ type: "text", text: `[file: ${block.attachment.name} (${block.attachment.bytes} bytes)]` }); break;
      case "tool-call": parts.push({ type: "text", text: `[tool call ${block.name} ${block.arguments}]` }); break;
      case "tool-result": {
        const nested = await renderBlocks(block.content, names, image);
        parts.push({ type: "text", text: `[tool result${block.isError ? " error" : ""}] ${textOf(nested)}` });
        parts.push(...nested.filter(part => part.type !== "text"));
        break;
      }
      default: parts.push({ type: "text", text: `[unsupported block: ${(block as { type: string }).type}]` });
    }
  }
  return parts;
}

function toolCallNames(messages: readonly Message[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    for (const block of message.content) if (block.type === "tool-call") names.set(String(block.id), block.name);
  }
  return names;
}

function replayThread(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const response = (value as { response?: unknown }).response;
  if (typeof response !== "object" || response === null) return undefined;
  const threadId = (response as { threadId?: unknown }).threadId;
  return typeof threadId === "string" ? threadId : undefined;
}

function replayState(turn: TurnSnapshot, key: string): ReplayEnvelope {
  return { response: { threadId: turn.threadId, turnId: turn.turnId, input: key } };
}

/**
 * Read the effective execution inputs a Session recorded at creation.
 *
 * Only the two enforced fields cross; a record with neither is an ordinary,
 * unscoped Codex Session rather than an empty execution.
 * @param record - the provider's recorded Session, when one exists.
 * @returns the recorded inputs, or undefined when the record declares none.
 */
function recordedExecution(record: SessionSnapshot | undefined): ProviderExecutionInputs | undefined {
  const options = record?.options;
  if (options?.developerInstructions === undefined && options?.boundary === undefined) return undefined;
  return {
    ...(options.developerInstructions === undefined ? {} : { developerInstructions: options.developerInstructions }),
    ...(options.boundary === undefined ? {} : { boundary: options.boundary }),
  };
}

function usageContextWindow(usage: unknown): number | undefined {
  if (typeof usage !== "object" || usage === null) return undefined;
  const value = (usage as { modelContextWindow?: unknown }).modelContextWindow;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function usageChunk(usage: Usage | null): TokenUsage | undefined {
  if (usage === null) return undefined;
  const last = usage.last;
  const cached = last.cachedInputTokens ?? 0;
  const input = last.inputTokens === null ? null : Math.max(0, last.inputTokens - cached);
  if (input === null && last.outputTokens === null) return undefined;
  const output = last.outputTokens ?? 0;
  return {
    inputTokens: input ?? 0,
    outputTokens: output,
    ...(last.totalTokens === null ? {} : { totalTokens: last.totalTokens }),
    ...(cached === 0 ? {} : { cacheReadTokens: cached }),
    ...(last.cacheWriteInputTokens === null || last.cacheWriteInputTokens === 0 ? {} : { cacheWriteTokens: last.cacheWriteInputTokens }),
    ...(last.reasoningOutputTokens === null || last.reasoningOutputTokens === 0 ? {} : { reasoningTokens: last.reasoningOutputTokens }),
  };
}

function isAgentMessage(value: unknown): value is { type: "agentMessage"; text: string } {
  if (typeof value !== "object" || value === null) return false;
  const item = value as { type?: unknown; text?: unknown };
  return item.type === "agentMessage" && typeof item.text === "string";
}

function turnOptions(options: GenerateOptions): { model: string; reasoningEffort?: string } {
  return {
    model: options.model,
    ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: String(options.reasoningEffort) }),
  };
}

function providerQuestion(question: UserInputQuestion): ProviderQuestion {
  return {
    id: question.id,
    question: question.question,
    ...(question.header === "" ? {} : { header: question.header }),
    ...(question.options === undefined ? {} : {
      options: question.options.map(option => ({
        label: option.label,
        ...(option.description === "" ? {} : { description: option.description }),
      })),
    }),
  };
}

function userInputAnswers(answers: readonly ProviderQuestionAnswer[]): UserInputAnswer {
  const mapped: Record<string, { answers: string[] }> = {};
  for (const answer of answers) {
    const values = [...answer.selected];
    if (answer.custom !== undefined && answer.custom !== "") values.push(answer.custom);
    mapped[answer.id] = { answers: values };
  }
  return mapped;
}

function approvalReason(request: ApprovalRequest): string | undefined {
  const params = typeof request.params === "object" && request.params !== null ? request.params as Record<string, unknown> : {};
  if (typeof params.reason === "string" && params.reason.trim() !== "") return params.reason;
  if (typeof params.command === "string" && params.command.trim() !== "") return params.command;
  if (typeof params.grantRoot === "string" && params.grantRoot.trim() !== "") return `write access under ${params.grantRoot}`;
  return undefined;
}

export function backendSessionId(sessionId: string): string {
  return `codex:${sessionId}`;
}

function providerError(error: unknown): Error {
  if (error instanceof LlmError) return error;
  return new LlmError(error instanceof Error ? error.message : String(error), "CODEX_ERROR");
}
