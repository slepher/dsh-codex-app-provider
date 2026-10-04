import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import type {
  ApprovalDecision,
  ApprovalRequest,
  BackendEvent,
  Caller,
  CodexBackend,
  CreateSessionOptions,
  ExecutionFactLine,
  CreateWorkerInput,
  PendingConfig,
  Report,
  ReportAcceptance,
  SequencedBackendEvent,
  SessionSnapshot,
  StartTurnOptions,
  SubscribeOptions,
  TurnInput,
  ThreadHandoffRequest,
  ThreadHandoffResult,
  ThreadOwnership,
  TurnOptions,
  TurnSnapshot,
  Usage,
  UsageValues,
  UserInputAnswer,
  UserInputQuestion,
  UserInputRequest,
  WorkerProjection,
  WorkerManagementEvent,
} from "./browser-types.js";
import { dshSessionId, nativeSessionId } from "./handoff.js";
import { feedsExecutionFacts, projectExecutionFacts, reduceExecutionEvents } from "./execution-events.js";
import { modelSettings } from "./models.js";
import { AppServer, RpcError, type RpcMessage, UncertainError } from "./rpc.js";
import { SessionStore, type StoredSession } from "./store.js";
import type { CodexGateBridge, GateRecordFacts, HookRunEvidence } from "./tool-gate.js";

/** Hook runs kept per live runtime as deployment evidence. */
const HOOK_RUN_LIMIT = 50;

export interface BackendTransport extends EventEmitter {
  connect(): Promise<void>;
  request<T = unknown>(method: string, params: unknown): Promise<T>;
  respond(id: number | string, result: unknown): void;
  reject(id: number | string, message: string): void;
  close(): Promise<void>;
}

interface Runtime {
  uncertain?: boolean;
  rpc: BackendTransport;
  requests: Map<string, number | string>;
  inputs: Map<string, { rpcId: number | string; request: UserInputRequest; record: StoredSession }>;
  /** Live status of every native command item this thread has reported. */
  commands: Map<string, string>;
  /** Events of the turn in flight that an execution fact can be projected from. */
  facts: SequencedBackendEvent[];
  /** Hook runs Codex reported for this runtime, oldest first. */
  hooks: HookRunEvidence[];
}

interface ThreadResult {
  cwd?: string;
  thread?: { id?: string; cwd?: string; path?: string; name?: string | null; preview?: string; updatedAt?: number; status?: { type?: string }; turns?: { id?: string; status?: string }[] };
  model?: string;
  reasoningEffort?: string;
  approvalPolicy?: string;
  sandbox?: {
    type?: string;
    writableRoots?: string[];
    excludeSlashTmp?: boolean;
    excludeTmpdirEnvVar?: boolean;
    networkAccess?: boolean;
  };
}

interface TurnResult {
  turn?: { id?: string; status?: string; error?: unknown };
}

export class CodexSessionBackend implements CodexBackend {
  private readonly store: SessionStore;
  private readonly live = new Map<string, Runtime>();
  private readonly releasing = new Set<Promise<void>>();
  /** Monotonic sequence for the live subscriber stream; only subscribers read it. */
  private sequence = 0;
  private readonly listeners = new Map<string, Set<(event: BackendEvent, sequence: number) => void>>();
  private readonly interactive = new Map<string, Set<(event: BackendEvent, sequence: number) => void>>();
  private readonly workerListeners = new Map<string, Set<(event: WorkerManagementEvent) => void>>();
  private closed = false;
  /** The workflow gate registry, once the Host capability is installed. */
  private gate?: CodexGateBridge;

  constructor(
    stateDir: string,
    private readonly factory: (options?: { env?: NodeJS.ProcessEnv }) => BackendTransport = () => new AppServer(),
  ) {
    this.store = new SessionStore(stateDir);
  }

  /**
   * Attach the workflow gate registry.
   *
   * The registry reads a Session's recorded binding back through this backend,
   * so a repeated `bind` can only restate what the record already carries.
   * @param gate - the installed Host gate capability.
   */
  attachGate(gate: CodexGateBridge): void {
    this.gate = gate;
    gate.useRecordReader(sessionId => this.gateFacts(sessionId));
  }

  /**
   * The hook runs Codex reported for one Session's current runtime.
   *
   * A gate refusal shows up here as a started hook run; a tool call Codex never
   * attempted shows up as nothing at all. The two must never be confused when a
   * live experiment is judged.
   * @param session - DSH Session identity.
   * @returns the recorded runs, oldest first.
   */
  readHookRuns(session: string): readonly HookRunEvidence[] {
    return structuredClone(this.live.get(nativeSessionId(session))?.hooks ?? []);
  }

  /** Record one HookRunSummary notification against its runtime. */
  private recordHookRun(record: StoredSession, runtime: Runtime, method: string, params: unknown): void {
    runtime.hooks.push({ method, params: structuredClone(params), at: Date.now() });
    if (runtime.hooks.length > HOOK_RUN_LIMIT) runtime.hooks.splice(0, runtime.hooks.length - HOOK_RUN_LIMIT);
    this.publish(record, { type: "thread.notification", method, params });
  }

  /** Retire the runtime key of one Session whose live runtime is being dropped. */
  private releaseGateRuntime(sessionId: string): void {
    this.gate?.releaseRuntime(dshSessionId(sessionId));
  }

  /**
   * The provider record facts a gate validation reads.
   * @param session - DSH Session identity.
   * @returns the recorded binding, execution cwd and thread usability, or undefined without a record.
   */
  gateFacts(session: string): GateRecordFacts | undefined {
    const record = this.store.lookup(nativeSessionId(session));
    if (record === undefined) return undefined;
    const gate = record.options?.gate;
    return {
      ...(gate === undefined ? {} : { gate: structuredClone(gate) }),
      cwd: record.executionCwd ?? record.cwd,
      ...(record.turnId === undefined ? {} : { turnId: record.turnId }),
      closed: record.released === true || record.handedOff !== undefined,
    };
  }


  async createSession(
    ownerId: string,
    sessionId: string,
    cwd: string,
    options: CreateSessionOptions = {},
  ): Promise<SessionSnapshot> {
    if (!ownerId || !sessionId || !isAbsolute(cwd)) throw new Error("Owner, Session ID, and absolute cwd are required");
    const boundary = normalizedBoundary(options.boundary);
    // The gate a Host bound before this Session's first start is persisted with
    // the record, so a resume, a restart or a cold recovery of the same Session
    // keeps exactly the authority its first request carried.
    const gate = options.gate ?? this.gate?.bindingFor(dshSessionId(sessionId));
    const normalizedOptions = { ...options, ...(gate === undefined ? {} : { gate }), ...(boundary === undefined ? {} : { boundary }) };
    const existing = this.store.get(ownerId, sessionId);
    if (existing !== undefined) return snapshot(existing);
    const record: StoredSession = {
      ownerId,
      sessionId,
      cwd,
      executionCwd: boundary?.cwd ?? cwd,
      state: "unknown",
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      approvals: [],
      options: normalizedOptions,
      facts: [],
      reports: [],
    };
    this.store.put(record);
    const runtime = this.attach(record);
    try {
      await runtime.rpc.connect();
      // A gated Session is refused before its thread exists when Codex would
      // silently skip the hook: present-but-untrusted is not a gate.
      if (gate !== undefined) await this.gate!.preflight((method, params) => runtime.rpc.request(method, params), record.executionCwd ?? cwd);
      const result = await runtime.rpc.request<ThreadResult>("thread/start", threadParams(record));
      if (typeof result.thread?.id !== "string") throw new Error("Missing thread identity");
      record.threadId = result.thread.id;
      reconcileBoundary(record, result);
      checkExecutionModel(record, result);
      if (typeof result.thread.path === "string") record.usage = rolloutUsage(result.thread.path, result.thread.id) ?? record.usage;
      record.model = result.model;
      record.reasoningEffort = result.reasoningEffort;
      record.state = "idle";
      this.store.put(record);
      return snapshot(record);
    } catch (error) {
      record.state = "unknown";
      this.store.put(record);
      throw new Error(`Session creation is uncertain; inspect before retrying: ${String(error)}`);
    }
  }

  async createWorker(caller: Caller, input: CreateWorkerInput): Promise<WorkerProjection> {
    validateCaller(caller);
    const sessionId = input.id ?? randomUUID();
    if (!sessionId || !input.name.trim() || !availableDirectory(input.cwd)) {
      throw new Error("Parent, name and an existing absolute cwd are required");
    }
    if (this.store.has(sessionId)) throw new Error("Invalid or occupied worker identity");
    const { id: _, name: __, cwd: ___, ...options } = input;
    const boundary = normalizedBoundary(options.boundary);
    const normalizedOptions = { ...options, ...(boundary === undefined ? {} : { boundary }) };
    const record: StoredSession = {
      ownerId: ownerIdentity(caller),
      sessionId,
      cwd: input.cwd,
      executionCwd: boundary?.cwd ?? input.cwd,
      state: "unknown",
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      approvals: [],
      options: normalizedOptions,
      facts: [],
      reports: [],
      worker: {
        parentSessionId: ownerIdentity(caller),
        owner: "agent",
        name: input.name,
        detached: false,
      },
    };
    this.store.put(record);
    const runtime = this.attach(record);
    try {
      await runtime.rpc.connect();
      const result = await runtime.rpc.request<ThreadResult>("thread/start", threadParams(record));
      if (typeof result.thread?.id !== "string") throw new Error("Missing thread identity");
      record.threadId = result.thread.id;
      reconcileBoundary(record, result);
      checkExecutionModel(record, result);
      if (typeof result.thread.path === "string") record.usage = rolloutUsage(result.thread.path, result.thread.id) ?? record.usage;
      record.model = result.model;
      record.reasoningEffort = result.reasoningEffort;
      record.state = "idle";
      this.store.put(record);
      this.notifyWorker(record, "created");
      return workerProjection(record);
    } catch (error) {
      record.state = "unknown";
      this.store.put(record);
      if (error instanceof UncertainError) this.notifyWorker(record, "uncertain");
      throw new Error(`Worker ${sessionId} creation failed; inspect it before retrying: ${String(error)}`);
    }
  }

  async listWorkers(caller: Caller): Promise<readonly WorkerProjection[]> {
    validateCaller(caller);
    return this.store.listWorkers(ownerIdentity(caller))
      .filter(record => canAccess(caller, record))
      .map(workerProjection);
  }

  async getWorker(caller: Caller, workerId: string): Promise<WorkerProjection> {
    return workerProjection(this.boundRequired(caller, workerId));
  }

  async pendingReports(caller: Caller): Promise<readonly Report[]> {
    validateCaller(caller);
    return structuredClone(this.store.listWorkers(ownerIdentity(caller))
      .filter(record => record.worker?.owner === "agent")
      .flatMap(record => record.reports.filter(report => report.acceptance === "pending" && report.acknowledgedAt === undefined)));
  }

  async listSessions(ownerId: string): Promise<readonly SessionSnapshot[]> {
    return this.store.list(ownerId).filter(record => !record.released).map(snapshot);
  }

  async readSession(owner: string | Caller, sessionId: string): Promise<SessionSnapshot | undefined> {
    const record = typeof owner === "string" ? this.store.get(owner, sessionId) : this.boundRequired(owner, sessionId);
    return record === undefined ? undefined : snapshot(record);
  }

  async resumeSession(owner: string | Caller, sessionId: string): Promise<SessionSnapshot> {
    const record = this.required(owner, sessionId);
    this.assertThreadOwnership(record, "resume its thread");
    const ownerId = ownerIdentity(owner);
    const prior = this.live.get(sessionId);
    if (prior !== undefined) {
      // A runtime this process still holds is authoritative: an uncertain one has
      // to be resolved rather than replaced, and a healthy one is already resumed.
      if (prior.uncertain) throw new UncertainError("Execution state unknown; resolve it before resuming");
      if (record.state !== "unknown") return snapshot(record);
    }
    // A record left behind by a process that no longer owns the state directory is
    // resumed directly. What a previous process wrote about its own execution is
    // not evidence that it still runs; the resumed thread's reported status is,
    // and the resume refuses a thread that is still active.
    if (record.threadId === undefined) throw new Error("No thread identity to resume");
    if (prior !== undefined) {
      await prior.rpc.close();
      this.live.delete(sessionId);
    }
    const runtime = this.attach(record);
    try {
      await runtime.rpc.connect();
      if (record.options?.gate !== undefined) await this.gate?.preflight((method, params) => runtime.rpc.request(method, params), record.executionCwd ?? record.cwd);
      const result = await runtime.rpc.request<ThreadResult>("thread/resume", {
        ...threadParams(record),
        threadId: record.threadId,
      });
      if (result.thread?.id !== record.threadId) throw new Error("Recovered thread identity mismatch");
      reconcilePending(record, result);
      reconcileBoundary(record, result);
      checkExecutionModel(record, result);
      if (result.thread.status?.type === "active" || result.thread.turns?.some(turn => turn.status === "inProgress")) {
        throw new Error("Thread appears active; refusing to claim it");
      }
      if (typeof result.thread.path === "string") record.usage = rolloutUsage(result.thread.path, record.threadId) ?? record.usage;
      record.state = "idle";
      if (record.worker !== undefined) record.worker.savedState = undefined;
      record.released = false;
      record.approvals = [];
      this.store.put(record);
      return snapshot(record);
    } catch (error) {
      record.state = "unknown";
      this.store.put(record);
      if (record.worker !== undefined) this.notifyWorker(record, "uncertain");
      this.releaseGateRuntime(sessionId);
      this.live.delete(sessionId);
      await runtime.rpc.close().catch(() => {});
      throw error;
    }
  }

  async configureSession(owner: string | Caller, sessionId: string, options: TurnOptions): Promise<SessionSnapshot> {
    const record = this.required(owner, sessionId);
    this.assertThreadOwnership(record, "configure its thread");
    if (typeof owner !== "string") throw new Error("Workers keep their creation configuration");
    const ownerId = ownerIdentity(owner);
    if ("model" in options) record.model = options.model;
    if ("reasoningEffort" in options) record.reasoningEffort = options.reasoningEffort;
    record.options = { ...record.options, model: record.model, reasoningEffort: record.reasoningEffort };
    this.store.put(record);
    return snapshot(record);
  }

  async closeSession(owner: string | Caller, sessionId: string, confirmedStopped = false): Promise<void> {
    const record = this.required(owner, sessionId);
    if (record.worker !== undefined && confirmedStopped) throw new Error("Workers must be confirmed idle before closing");
    const ownerId = ownerIdentity(owner);
    if (record.worker !== undefined) {
      const idle = record.state === "idle" || record.state === "saved" && record.worker.savedState === "idle";
      if (!idle || record.approvals.length) throw new Error("Only idle workers can be closed");
      if (record.reports.some(report => report.acceptance === "pending" && report.acknowledgedAt === undefined)) {
        throw new Error("Process pending reports with accept or ack before closing");
      }
      if (hasActiveCommand(this.live.get(sessionId))) throw new Error("Tracked task command still running; verify its completion before closing");
      record.state = "starting";
      this.store.put(record);
      try {
        await this.live.get(sessionId)?.rpc.close();
        this.releaseGateRuntime(sessionId);
        this.live.delete(sessionId);
        record.state = "saved";
        record.worker.savedState = "idle";
        record.worker.detached = true;
        this.store.put(record);
        this.notifyWorker(record, "closed", record.worker.parentSessionId, true);
        this.dropSubscribers(sessionId);
        return;
      } catch (error) {
        record.state = "unknown";
        this.store.put(record);
        this.notifyWorker(record, "uncertain");
        throw error;
      }
    }
    // A Session this process still holds is not uncertain, so it must be idle to
    // close. Once no runtime is here, the caller may confirm the prior process
    // stopped: an `unknown` record left by a dead process is otherwise unreachable.
    const live = this.live.get(sessionId);
    const confirmed = confirmedStopped && live === undefined && (record.state === "unknown" || record.state === "saved");
    if (record.state !== "idle" && !confirmed) throw new Error("Only an idle Session can close; confirm a stopped one explicitly");
    if (live !== undefined) { await live.rpc.close(); this.releaseGateRuntime(sessionId); this.live.delete(sessionId); }
    record.released = true;
    this.store.put(record);
  }

  /**
   * Release the record that backed one DSH Session the Host has disposed.
   *
   * The Host owns a Session's lifecycle and publishes the disposal as a fact;
   * the Codex record that backed it is this plugin's to clean up. Releasing
   * closes any runtime this process still holds and marks the record released,
   * whatever its state was: nothing can resume a Session that no longer exists,
   * so leaving an `unknown` record behind would only strand the thread.
   * @param backendId - provider-side Session identity.
   */
  releaseDisposed(backendId: string): Promise<void> {
    const record = this.store.lookup(backendId);
    if (record === undefined || record.released) return Promise.resolve();
    const runtime = this.live.get(backendId);
    const closing = runtime === undefined ? undefined : this.trackClose(runtime.rpc.close());
    this.releaseGateRuntime(backendId);
    if (runtime !== undefined) this.live.delete(backendId);
    this.dropSubscribers(backendId);
    if (record.worker !== undefined) record.worker.detached = true;
    record.released = true;
    this.store.put(record);
    return closing ?? Promise.resolve();
  }

  /**
   * Track a close the caller may not await.
   *
   * Releasing removes the runtime from the live map, so teardown would otherwise
   * stop waiting for a process that is still shutting down.
   * @param closing - the close to await.
   * @returns the same close, once it settles.
   */
  private trackClose(closing: Promise<void>): Promise<void> {
    const tracked = closing.catch(() => undefined).then(() => { this.releasing.delete(tracked); });
    this.releasing.add(tracked);
    return tracked;
  }

  async occupiedThreads(): Promise<readonly string[]> {
    return this.store.occupiedThreads();
  }

  /**
   * Read one native Session's thread ownership for Host reconciliation.
   * @param ownerId - the provider's own owner identity.
   * @param sessionId - native Session to inspect.
   * @returns the recorded binding, or `undefined` when no record exists.
   */
  async threadOwnership(ownerId: string, sessionId: string): Promise<ThreadOwnership | undefined> {
    const record = this.store.get(ownerId, sessionId);
    if (record === undefined) return undefined;
    return { sessionId, ...(record.threadId === undefined ? {} : { threadId: record.threadId }),
      ...(record.handedOff === undefined ? {} : { handedOffTo: record.handedOff.toSessionId }),
      ...(record.handoffFrom === undefined ? {} : { handoffFrom: record.handoffFrom.fromSessionId }) };
  }

  /**
   * Hand one Codex thread from a stopped source record to a reserved successor.
   *
   * The source keeps its history, reports and usage but is de-authorized for
   * start, resume, configure, compact, steer, interrupt and restart, so
   * no path can take the thread back; its live App Server runtime is closed by
   * the handover. The successor record carries the original thread identity, the
   * target model/effort and the full execution inputs its first request will
   * send, and is persisted before the successor's first model call. A repeated
   * request with the same identity reuses its recorded handover, and a handover
   * whose target write was lost is completed rather than re-decided.
   * @param ownerId - the provider's own owner identity.
   * @param request - source, reserved successor, target configuration and request identity.
   * @returns the successor's recorded thread binding.
   * @throws when the source is still executing or its ownership is unknown, its
   *   thread is active or changed, the request conflicts with a recorded
   *   handover, or the successor identity is taken.
   */
  async handoffThread(ownerId: string, request: ThreadHandoffRequest): Promise<ThreadHandoffResult> {
    const fields = [request?.requestId, request?.fromSessionId, request?.toSessionId, request?.model];
    if (fields.some(value => typeof value !== "string" || value.length === 0)) {
      throw new Error("Handoff request requires requestId, source, successor and target model");
    }
    if (request.fromSessionId === request.toSessionId) throw new Error("A handoff successor must differ from its source");
    const from = this.required(ownerId, request.fromSessionId);
    if (from.threadId === undefined) throw new Error("Source Session has no Codex thread to hand over");
    const recorded = from.handedOff;
    if (recorded !== undefined
      && (recorded.requestId !== request.requestId || recorded.toSessionId !== request.toSessionId)) {
      throw new Error("Thread handoff was already recorded with different inputs");
    }
    if (recorded === undefined) {
      const live = this.live.get(request.fromSessionId);
      // The source must be confirmed stopped, not merely released: an in-flight
      // or unknown execution still owns the thread. An idle record may keep its
      // live App Server runtime; this handover closes it below.
      if (live?.uncertain === true) {
        throw new Error("Source execution ownership is unknown; resolve it before handing over its thread");
      }
      if (!["idle", "saved"].includes(from.state)) {
        throw new Error(`Source Session is ${from.state}; stop it before handing over its thread`);
      }
      const result = await this.readWithTemporaryServer(rpc => rpc.request<ThreadResult>("thread/read", { threadId: from.threadId, includeTurns: false }));
      const thread = result.thread;
      if (thread?.id !== from.threadId) throw new Error("Native thread identity changed; handoff refused");
      if (thread.status?.type === "active") throw new Error("Native thread is still active; handoff refused");
      if (typeof thread.cwd !== "string" || thread.cwd !== (from.executionCwd ?? from.cwd)) throw new Error("Native thread workspace changed; handoff refused");
    }
    const existing = this.store.get(ownerId, request.toSessionId);
    if (existing !== undefined && existing.handoffFrom?.requestId !== request.requestId) {
      throw new Error("Handoff successor identity is already in use");
    }
    if (existing === undefined) {
      const boundary = normalizedBoundary(request.boundary);
      const executionCwd = from.executionCwd ?? from.cwd;
      // The successor continues the very same native thread, so its execution
      // location cannot move. A source that declared a task constraint must
      // hand one on: dropping it would silently widen a read-only contract.
      if (boundary !== undefined && boundary.cwd !== executionCwd) {
        throw new Error("A handoff successor must continue the thread in the same execution cwd");
      }
      if (from.options?.boundary !== undefined && boundary === undefined) {
        throw new Error("A handoff successor of a bounded execution must declare the task boundary it continues under");
      }
      const options: CreateSessionOptions = { model: request.model,
        ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
        ...(request.developerInstructions === undefined ? {} : { developerInstructions: request.developerInstructions }),
        ...(request.approvalPolicy === undefined ? {} : { approvalPolicy: request.approvalPolicy }),
        ...(request.approvalsReviewer === undefined ? {} : { approvalsReviewer: request.approvalsReviewer }),
        ...(request.sandbox === undefined ? {} : { sandbox: request.sandbox }),
        // A continuation keeps the same task scope: the successor carries the
        // source's binding verbatim, so handing over a thread never drops the
        // gate the assignment ran under.
        ...(from.options?.gate === undefined ? {} : { gate: structuredClone(from.options.gate) }),
        ...(boundary === undefined ? {} : { boundary }) };
      // The source marker is written first: it is the de-authorization
      // boundary, so a crash before the successor exists can only be retried
      // with the same request identity, never reclaimed by the source.
      if (recorded === undefined) {
        from.handedOff = { toSessionId: request.toSessionId, requestId: request.requestId, at: Date.now() };
        this.store.put(from);
      }
      // No path can operate the thread after the marker, so the source's live
      // runtime is detached before the successor exists. A crash here leaves a
      // revoked source whose handover is completed by a repeated request.
      await this.detach(request.fromSessionId);
      const target: StoredSession = { ownerId, sessionId: request.toSessionId, threadId: from.threadId, cwd: from.cwd,
        executionCwd, state: "idle",
        model: request.model, ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
        approvals: [], options, facts: [], reports: [],
        handoffFrom: { fromSessionId: request.fromSessionId, requestId: request.requestId, at: Date.now() } };
      this.store.put(target);
      return { toSessionId: target.sessionId, threadId: from.threadId, state: target.state };
    }
    // The successor already exists: an earlier attempt wrote the source marker
    // and this repeated request only needs the source runtime gone.
    await this.detach(request.fromSessionId);
    return { toSessionId: existing.sessionId, threadId: existing.threadId ?? from.threadId, state: existing.state };
  }

  /** Close one record's live App Server runtime without touching its thread. */
  private async detach(sessionId: string): Promise<void> {
    const live = this.live.get(sessionId);
    this.releaseGateRuntime(sessionId);
    if (live === undefined) return;
    this.live.delete(sessionId);
    await live.rpc.close().catch(() => {});
  }

  async startTurn(owner: string | Caller, sessionId: string, input: string | readonly TurnInput[], options: StartTurnOptions = {}): Promise<TurnSnapshot> {
    const record = this.required(owner, sessionId);
    this.assertThreadOwnership(record, "start a turn on its thread");
    const ownerId = ownerIdentity(owner);
    const items = turnInput(input);
    if (options.idempotencyKey !== undefined && record.lastStartKey === options.idempotencyKey && record.turnId !== undefined) {
      return turnSnapshot(record, record.lastTurnState ?? record.state);
    }
    if (record.state !== "idle") throw new Error(`Cannot start a turn while Session is ${record.state}; do not redispatch`);
    // A turn may request a model/effort other than the last confirmed one. The
    // request is recorded as a pending target; `record.model` keeps the
    // confirmed value until the App Server reports the settings it applied.
    const target = pendingTarget(record, options);
    if (target === undefined) delete record.pending;
    else record.pending = target;
    const runtime = await this.runtime(record, owner);
    record.state = "running";
    record.turnId = undefined;
    record.lastStartKey = options.idempotencyKey;
    record.lastTurnState = "running";
    record.lastOutput = undefined;
    record.lastUnphasedOutput = undefined;
    record.operation = "turn";
    this.store.put(record);
    try {
      const result = await runtime.rpc.request<TurnResult>("turn/start", {
        threadId: record.threadId,
        input: items,
        model: options.model ?? record.model,
        effort: options.reasoningEffort ?? record.reasoningEffort,
      });
      if (typeof result.turn?.id !== "string") throw new Error("Missing turn identity");
      if (record.turnId !== undefined && record.turnId !== result.turn.id) throw new Error("Turn identity mismatch");
      record.turnId = result.turn.id;
      const responseState = statusState(result.turn.status);
      if (responseState !== undefined && responseState !== "running") {
        this.finish(record, result.turn);
        return turnSnapshot(record, record.lastTurnState ?? responseState);
      }
      if (record.state === "running" || responseState !== "running") {
        record.lastTurnState = responseState ?? record.lastTurnState;
        if (record.lastTurnState !== "running") record.state = "idle";
      }
      this.store.put(record);
      return turnSnapshot(record, record.lastTurnState);
    } catch (error) {
      record.state = error instanceof RpcError ? "idle" : "unknown";
      record.lastTurnState = record.state;
      // An explicit rejection never applied the target: keep the confirmed
      // configuration. An unknown outcome keeps the target pending for the
      // resume path to reconcile against native facts.
      if (error instanceof RpcError) delete record.pending;
      this.store.put(record);
      throw error;
    }
  }

  async compactSession(owner: string | Caller, sessionId: string): Promise<void> {
    const record = this.required(owner, sessionId);
    this.assertThreadOwnership(record, "compact its thread");
    if (record.state !== "idle") throw new Error("Wait for the current turn before compacting");
    if (typeof owner !== "string") throw new Error("Worker compaction is not supported");
    const ownerId = ownerIdentity(owner);
    const runtime = await this.runtime(record, owner);
    record.state = "running";
    record.turnId = undefined;
    record.operation = "compact";
    record.lastOutput = undefined;
    record.lastUnphasedOutput = undefined;
    this.store.put(record);
    try {
      await runtime.rpc.request("thread/compact/start", { threadId: record.threadId });
    } catch (error) {
      record.state = error instanceof RpcError ? "idle" : "unknown";
      this.store.put(record);
      throw error;
    }
  }

  async steerTurn(
    owner: string | Caller,
    workerOrTurnId: string,
    turnOrInput: string | readonly TurnInput[],
    contextualInput?: string | readonly TurnInput[],
  ): Promise<void> {
    const turnId = typeof owner === "string" ? workerOrTurnId : turnOrInput as string;
    const input = typeof owner === "string" ? turnOrInput as string | readonly TurnInput[] : contextualInput!;
    const record = typeof owner === "string" ? this.byTurn(owner, turnId) : this.required(owner, workerOrTurnId);
    this.assertThreadOwnership(record, "steer its thread");
    if (record.turnId !== turnId) throw new Error("Turn not found");
    const ownerId = ownerIdentity(owner);
    const items = turnInput(input);
    if (record.state !== "running") throw new Error("Steer precondition failed");
    const runtime = this.live.get(record.sessionId);
    if (runtime === undefined) throw new Error("Turn runtime unavailable");
    await runtime.rpc.request("turn/steer", {
      threadId: record.threadId,
      expectedTurnId: turnId,
      input: items,
    });
  }

  async interruptTurn(owner: string | Caller, workerOrTurnId: string, contextualTurnId?: string): Promise<void> {
    const turnId = typeof owner === "string" ? workerOrTurnId : contextualTurnId!;
    const record = typeof owner === "string" ? this.byTurn(owner, turnId) : this.required(owner, workerOrTurnId);
    this.assertThreadOwnership(record, "interrupt its thread");
    if (record.turnId !== turnId) throw new Error("Turn not found");
    const ownerId = ownerIdentity(owner);
    if (record.state !== "running" && record.state !== "interrupt-requested") throw new Error("Interrupt precondition failed");
    const runtime = this.live.get(record.sessionId);
    if (runtime === undefined) throw new Error("Turn runtime unavailable");
    await runtime.rpc.request("turn/interrupt", { threadId: record.threadId, turnId });
    if (record.state === "running") record.state = "interrupt-requested";
    this.store.put(record);
  }

  async pendingApprovals(owner: string | Caller, sessionId: string): Promise<readonly ApprovalRequest[]> {
    return structuredClone(this.required(owner, sessionId).approvals);
  }

  async pendingUserInputs(owner: string | Caller, sessionId: string): Promise<readonly UserInputRequest[]> {
    const record = this.required(owner, sessionId);
    return structuredClone([...this.live.get(record.sessionId)?.inputs.values() ?? []].map(pending => pending.request));
  }

  async answerUserInput(ownerId: string, requestId: string, answers: UserInputAnswer): Promise<void> {
    for (const runtime of this.live.values()) {
      const pending = runtime.inputs.get(requestId);
      if (pending === undefined || pending.record.ownerId !== ownerId) continue;
      runtime.inputs.delete(requestId);
      runtime.rpc.respond(pending.rpcId, { answers: answers ?? {} });
      return;
    }
    throw new Error("User input is no longer pending");
  }

  async decideApproval(
    owner: string | Caller,
    workerOrRequestId: string,
    requestOrDecision: string,
    contextualDecision?: ApprovalDecision,
  ): Promise<void> {
    const requestId = typeof owner === "string" ? workerOrRequestId : requestOrDecision;
    const decision = (typeof owner === "string" ? requestOrDecision : contextualDecision) as ApprovalDecision;
    const record = typeof owner === "string"
      ? this.store.list(owner).find(item => item.approvals.some(request => request.requestId === requestId))
      : this.required(owner, workerOrRequestId);
    if (record !== undefined && !record.approvals.some(request => request.requestId === requestId)) throw new Error("Approval no longer pending");
    if (record === undefined) throw new Error("Approval no longer pending");
    const request = record.approvals.find(item => item.requestId === requestId)!;
    const runtime = this.live.get(record.sessionId);
    const rpcId = runtime?.requests.get(requestId);
    const allowed = typeof owner === "string" ? ["accept", "decline", "cancel"] : ["accept", "decline"];
    if (!allowed.includes(decision)) throw new Error("Invalid approval decision");
    if (runtime === undefined || rpcId === undefined
      || request.sessionId !== record.sessionId || request.threadId !== record.threadId || request.turnId !== record.turnId
      || !["running", "waiting-approval", "interrupt-requested"].includes(record.state)) {
      throw new Error("Approval no longer pending");
    }
    // `required` already resolved the record through this caller's ownership,
    // so a contextual decision only has to be one of the allowed verdicts: the
    // parent Agent answers for its own worker; no other caller can reach it.
    const ownerId = ownerIdentity(owner);
    runtime.rpc.respond(rpcId, approvalResponse(request, decision));
    runtime.requests.delete(requestId);
    record.approvals = record.approvals.filter(request => request.requestId !== requestId);
    if (record.state === "waiting-approval" && record.approvals.length === 0) record.state = "running";
    this.store.put(record);
  }

  async readFacts(owner: string | Caller, sessionId: string): Promise<readonly ExecutionFactLine[]> {
    return structuredClone(this.required(owner, sessionId).facts);
  }

  async readReports(owner: string | Caller, sessionId: string): Promise<readonly Report[]> {
    return structuredClone(this.required(owner, sessionId).reports);
  }

  async acknowledgeReport(owner: string | Caller, sessionId: string, turnId: string): Promise<Report> {
    const record = this.required(owner, sessionId);
    const ownerId = ownerIdentity(owner);
    const report = record.reports.find(item => item.turnId === turnId);
    if (report === undefined) throw new Error("Unknown report");
    if (report.acknowledgedAt === undefined) {
      report.acknowledgedAt = Date.now();
      this.store.put(record);
    }
    return structuredClone(report);
  }

  async acceptReport(owner: string | Caller, sessionId: string, turnId: string, acceptance: ReportAcceptance): Promise<Report> {
    const record = this.required(owner, sessionId);
    const ownerId = ownerIdentity(owner);
    const report = record.reports.find(item => item.turnId === turnId);
    if (report === undefined || !["pending", "accepted", "changes-requested"].includes(acceptance)) {
      throw new Error("Unknown report or acceptance");
    }
    if (acceptance === "accepted" && (report.protocolError !== undefined || !report.result.trim())) {
      throw new Error("Cannot accept a report without a deliverable result");
    }
    report.acceptance = acceptance;
    if (acceptance !== "pending") report.acknowledgedAt ??= Date.now();
    this.store.put(record);
    return structuredClone(report);
  }

  subscribe(owner: string | Caller, sessionId: string, listener: (event: BackendEvent, sequence: number) => void, options: SubscribeOptions = {}): () => void {
    this.required(owner, sessionId);
    const listeners = this.listeners.get(sessionId) ?? new Set();
    listeners.add(listener);
    this.listeners.set(sessionId, listeners);
    if (options.interactive === true) {
      const answering = this.interactive.get(sessionId) ?? new Set();
      answering.add(listener);
      this.interactive.set(sessionId, answering);
    }
    return () => {
      listeners.delete(listener);
      this.interactive.get(sessionId)?.delete(listener);
    };
  }

  subscribeWorkers(caller: Caller, listener: (event: WorkerManagementEvent) => void): () => void {
    validateCaller(caller);
    const listeners = this.workerListeners.get(ownerIdentity(caller)) ?? new Set();
    listeners.add(listener);
    this.workerListeners.set(ownerIdentity(caller), listeners);
    return () => { listeners.delete(listener); };
  }

  async modelSettings(cwd: string) {
    return this.readWithTemporaryServer(rpc => modelSettings((method, params) => rpc.request(method, params), cwd));
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.live.values()].map(runtime => runtime.rpc.close()));
    for (const sessionId of [...this.live.keys()]) this.releaseGateRuntime(sessionId);
    this.live.clear();
    // A released Session left the live map, but its process still has to exit
    // before teardown reports the backend closed.
    await Promise.allSettled([...this.releasing]);
    this.store.close();
  }

  private required(owner: string | Caller, sessionId: string): StoredSession {
    const record = typeof owner === "string" ? this.store.get(owner, sessionId) : this.boundRequired(owner, sessionId);
    if (record === undefined) throw new Error("Session not found");
    return record;
  }

  private boundRequired(caller: Caller, sessionId: string): StoredSession {
    validateCaller(caller);
    const record = this.store.bound(sessionId);
    if (record === undefined || !canAccess(caller, record)) throw new Error("Worker not found in this parent session");
    return record;
  }

  private byTurn(ownerId: string, turnId: string): StoredSession {
    const record = this.store.list(ownerId).find(item => item.turnId === turnId);
    if (record === undefined) throw new Error("Turn not found");
    return record;
  }

  /**
   * Refuse every path that operates the native thread once a record handed it
   * to a successor.
   *
   * The source keeps its history, reports and usage, but it is no longer the
   * thread's owner: start, resume, configure, compact, steer, interrupt
   * and restart all fail here, including cold recovery, so nothing can take the
   * thread back from the successor.
   * @param record - the record about to operate its thread.
   * @param action - the refused operation, named in the error.
   */
  private assertThreadOwnership(record: StoredSession, action: string): void {
    if (record.handedOff === undefined) return;
    throw new Error(`This Session handed its Codex thread to ${record.handedOff.toSessionId}; it can no longer ${action}`);
  }

  private async runtime(record: StoredSession, owner: string | Caller = record.ownerId): Promise<Runtime> {
    const existing = this.live.get(record.sessionId);
    if (existing?.uncertain) throw new UncertainError("Execution state unknown; do not redispatch");
    if (existing !== undefined) return existing;
    await this.resumeSession(owner, record.sessionId);
    const runtime = this.live.get(record.sessionId);
    if (runtime === undefined) throw new Error("Session runtime unavailable");
    return runtime;
  }

  private attach(record: StoredSession): Runtime {
    if (this.closed) throw new Error("Codex backend is closed");
    // A new runtime replaces whatever ran before it for this Session, so the
    // previous runtime key is retired before a new one is minted: an old key can
    // never address the new process.
    const session = dshSessionId(record.sessionId);
    this.gate?.releaseRuntime(session);
    const env = this.gate?.envFor(session);
    const runtime: Runtime = { rpc: this.factory(env === undefined ? undefined : { env }), requests: new Map(), inputs: new Map(), commands: new Map(), facts: [], hooks: [] };
    this.live.set(record.sessionId, runtime);
    runtime.rpc.on("notification", (message: RpcMessage) => {
      if (!runtime.uncertain && this.live.get(record.sessionId) === runtime && !this.closed) this.notification(record, message, runtime);
    });
    runtime.rpc.on("request", (message: RpcMessage) => {
      if (runtime.uncertain || this.live.get(record.sessionId) !== runtime || this.closed) {
        if (message.id !== undefined) runtime.rpc.reject(message.id, "Execution ownership unknown");
        return;
      }
      this.serverRequest(record, runtime, message);
    });
    const uncertain = (error: Error): void => {
      if (runtime.uncertain || this.closed || this.live.get(record.sessionId) !== runtime) return;
      runtime.uncertain = true;
      record.state = "unknown";
      record.lastTurnState = "unknown";
      record.approvals = [];
      runtime.requests.clear();
      runtime.inputs.clear();
      this.store.put(record);
      this.publish(record, { type: "session.uncertain", error: `Execution state unknown: ${String(error)}` });
      this.projectFacts(record);
      if (record.worker !== undefined) this.notifyWorker(record, "uncertain");
    };
    runtime.rpc.on("uncertain", uncertain);
    return runtime;
  }

  private notification(record: StoredSession, message: RpcMessage, runtime: Runtime): void {
    const params = objectValue(message.params);
    // A hook run is evidence about the gate itself, not about a thread turn, so
    // it is recorded before the thread filter. It is what tells a refusal apart
    // from a tool call Codex never attempted.
    if (message.method === "hook/started" || message.method === "hook/completed") {
      this.recordHookRun(record, runtime, message.method, params);
      return;
    }
    if (params.threadId !== record.threadId) return;
    if (message.method === "turn/completed") {
      const turn = objectValue(params.turn);
      const event: BackendEvent = { type: "thread.notification", method: message.method, params };
      if (terminalState(turn.status) === undefined) this.publish(record, event);
      else this.finish(record, turn, event);
      return;
    }
    if (message.method === "turn/started") {
      const turnId = objectValue(params.turn).id;
      if (typeof turnId !== "string" || this.finished(record, turnId) || record.turnId !== undefined && record.turnId !== turnId) return;
    }
    if (message.method !== undefined && (message.method.startsWith("item/") || message.method.startsWith("turn/"))) {
      trackCommand(runtime, message.method, params);
      this.publish(record, { type: "thread.notification", method: message.method, params });
    }
    if (message.method === "turn/started") {
      const turn = objectValue(params.turn);
      if (typeof turn.id === "string" && !this.finished(record, turn.id) && (record.turnId === undefined || record.turnId === turn.id)) {
        record.turnId = turn.id;
        record.state = "running";
        record.lastTurnState = "running";
        this.store.put(record);
        this.publish(record, { type: "turn.started", turn: turnSnapshot(record, "running") });
      }
    } else if (message.method === "item/agentMessage/delta" && typeof params.delta === "string" && params.turnId === record.turnId && record.turnId !== undefined) {
      this.publish(record, { type: "turn.output", turnId: record.turnId, item: params.delta });
    } else if (message.method === "item/completed" && params.turnId === record.turnId && record.turnId !== undefined) {
      const item = objectValue(params.item);
      if (item.type === "agentMessage" && typeof item.text === "string") {
        if (item.phase === "final_answer") record.lastOutput = item.text;
        else if (item.phase == null) record.lastUnphasedOutput = item.text;
        this.store.put(record);
      }
      this.publish(record, { type: "turn.output", turnId: record.turnId, item: params.item });
    } else if (message.method === "thread/tokenUsage/updated") {
      record.usage = params.tokenUsage;
      this.store.put(record);
      this.publish(record, { type: "usage.updated", sessionId: record.sessionId, usage: params.tokenUsage });
    } else if (message.method === "thread/settings/updated") {
      // The App Server reports the settings a thread actually runs. This is the
      // native confirmation that promotes a pending target to the confirmed
      // configuration; the initial creation snapshot in `options` is untouched.
      const applied = objectValue(params.threadSettings);
      if (typeof applied.model === "string" && applied.model.length > 0) record.model = applied.model;
      if (typeof applied.effort === "string" && applied.effort.length > 0) record.reasoningEffort = applied.effort;
      delete record.pending;
      this.store.put(record);
      this.publish(record, { type: "thread.notification", method: message.method, params });
    }
  }

  private finish(record: StoredSession, turn: Record<string, unknown>, rawEvent?: BackendEvent): void {
    const terminal = terminalState(turn.status);
    if (typeof turn.id !== "string" || terminal === undefined || this.finished(record, turn.id)) return;
    if (record.turnId !== undefined && record.turnId !== turn.id) return;
    const operation = record.operation;
    const output = record.lastOutput?.trim() ? record.lastOutput : record.lastUnphasedOutput;
    const error = typeof turn.error === "object" && turn.error !== null
      ? String((turn.error as { message?: unknown }).message ?? JSON.stringify(turn.error))
      : undefined;
    record.turnId = turn.id;
    record.lastTurnState = terminal;
    record.state = "idle";
    record.operation = undefined;
    record.approvals = [];
    this.live.get(record.sessionId)?.requests.clear();
    this.live.get(record.sessionId)?.inputs.clear();
    let reportReady: BackendEvent | undefined;
    if (operation !== "compact") {
      const deliverable = typeof output === "string" && output.trim().length > 0;
      const report: Report = {
        workerId: record.sessionId,
        threadId: record.threadId!,
        turnId: turn.id,
        status: terminal,
        result: deliverable ? output : "",
        ...(!deliverable && terminal === "completed" ? { protocolError: "Result missing: completed turn has no deliverable final_answer; ask the same worker to supply its result without repeating the task" } : {}),
        ...(error === undefined ? {} : { error }),
        usage: normalizeUsage(record.usage),
        createdAt: Date.now(),
        acceptance: "pending",
      };
      record.reports.push(report);
      if (record.worker?.owner === "agent" && !record.worker.detached) {
        reportReady = { type: "report.ready", workerId: record.sessionId, turnId: turn.id, parentSessionId: record.worker.parentSessionId };
      }
    }
    // The terminal transition is durable state: the turn identity, the state,
    // the report and the cleared approval ledger must survive a restart.
    this.store.put(record);
    const event: BackendEvent = {
      type: "turn.state",
      turn: turnSnapshot(record, terminal),
      ...(operation === undefined ? {} : { operation }),
      ...(output === undefined ? {} : { finalOutput: output }),
      ...(error === undefined ? {} : { error }),
    };
    this.commitEvents(record, [rawEvent, event, reportReady].filter((item): item is BackendEvent => item !== undefined));
    this.projectFacts(record);
    if (reportReady !== undefined) this.notifyWorker(record, "report");
  }

  private finished(record: StoredSession, turnId: string): boolean {
    return record.turnId === turnId && terminalState(record.lastTurnState) !== undefined;
  }

  private serverRequest(record: StoredSession, runtime: Runtime, message: RpcMessage): void {
    const params = objectValue(message.params);
    if (message.id === undefined || record.threadId === undefined || params.threadId !== record.threadId) {
      if (message.id !== undefined) runtime.rpc.reject(message.id, "Unknown Session thread");
      return;
    }
    const method = message.method ?? "";
    if (method === "item/tool/requestUserInput") {
      this.userInputRequest(record, runtime, message.id, params);
      return;
    }
    if (method === "mcpServer/elicitation/request") {
      // DSH has no structured elicitation seam; rejecting the request maps to
      // an MCP decline upstream. This is fail-closed and never fabricates input.
      runtime.rpc.respond(message.id, { action: "decline", content: null, _meta: null });
      return;
    }
    if (![
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/permissions/requestApproval",
    ].includes(method)) {
      runtime.rpc.reject(message.id, "Unsupported server request");
      return;
    }
    // A declared task boundary is not an approval policy: it constrains where
    // the thread may write, not whether Codex may ask. A request that reaches
    // this client is one Codex decided it cannot settle itself, so it is
    // recorded and surfaced instead of being declined on the plugin's behalf.
    if (this.live.get(record.sessionId) !== runtime
      || record.turnId === undefined
      || !["running", "waiting-approval", "interrupt-requested"].includes(record.state)
      || params.turnId !== undefined && params.turnId !== record.turnId) {
      runtime.rpc.reject(message.id, "No active turn");
      return;
    }
    const request: ApprovalRequest = {
      sessionId: record.sessionId,
      threadId: record.threadId,
      turnId: record.turnId,
      requestId: randomUUID(),
      method,
      params,
    };
    runtime.requests.set(request.requestId, message.id);
    record.approvals.push(request);
    if (record.state === "running") record.state = "waiting-approval";
    this.store.put(record);
    this.publish(record, { type: "approval.requested", request });
  }

  private userInputRequest(record: StoredSession, runtime: Runtime, id: number | string, params: Record<string, unknown>): void {
    const threadId = record.threadId, turnId = record.turnId;
    if (threadId === undefined || turnId === undefined
      || this.live.get(record.sessionId) !== runtime
      || !["running", "waiting-approval", "interrupt-requested"].includes(record.state)
      || params.turnId !== undefined && params.turnId !== turnId) {
      runtime.rpc.respond(id, { answers: {} });
      return;
    }
    const questions = userInputQuestions(params.questions);
    if (questions.length === 0 || (this.interactive.get(record.sessionId)?.size ?? 0) === 0) {
      // Without an interactive subscriber, answer empty rather than blocking
      // the native turn forever; upstream maps client errors the same way.
      runtime.rpc.respond(id, { answers: {} });
      return;
    }
    const request: UserInputRequest = {
      sessionId: record.sessionId,
      threadId,
      turnId,
      requestId: randomUUID(),
      questions,
      isBlocking: params.isBlocking !== false,
    };
    runtime.inputs.set(request.requestId, { rpcId: id, request, record });
    this.publish(record, { type: "userInput.requested", request });
  }

  private publish(record: StoredSession, event: BackendEvent): void {
    this.commitEvents(record, [event]);
  }

  /**
   * Fold the turn's retained events into durable fact lines.
   *
   * The reduction resolves every item the turn left unfinished, so once the lines
   * exist the notifications that carried them are no longer needed.
   * @param record - the record whose turn just reached a terminal state.
   */
  private projectFacts(record: StoredSession): void {
    const runtime = this.live.get(record.sessionId);
    if (runtime === undefined || runtime.facts.length === 0) return;
    record.facts.push(...projectExecutionFacts(reduceExecutionEvents(runtime.facts)));
    runtime.facts = [];
    this.store.put(record);
  }

  private commitEvents(record: StoredSession, events: BackendEvent[]): void {
    const runtime = this.live.get(record.sessionId);
    const committed = events.map(event => ({ sequence: ++this.sequence, event: structuredClone(event) }));
    // Only the events a fact can be projected from are retained; the stream that
    // carries model text and status notices is published, not stored.
    // Persistence belongs to state transitions, not to the notification feed:
    // a streaming item delta carries no durable record change, and rewriting
    // the whole record per delta is pure I/O. Callers that mutate the record
    // persist it themselves.
    for (const item of committed) if (runtime !== undefined && feedsExecutionFacts(item.event)) runtime.facts.push(item);
    for (const { event, sequence } of committed) {
      for (const listener of this.listeners.get(record.sessionId) ?? []) listener(structuredClone(event), sequence);
    }
  }

  private notifyWorker(record: StoredSession, change: WorkerManagementEvent["change"], parentSessionId = record.worker?.parentSessionId, invalidated = false): void {
    if (record.worker === undefined || parentSessionId === undefined) return;
    const event: WorkerManagementEvent = { type: "worker.changed", parentSessionId, workerId: record.sessionId, change, ...(invalidated ? { invalidated: true } : {}) };
    for (const listener of this.workerListeners.get(parentSessionId) ?? []) {
      try { listener(structuredClone(event)); } catch {}
    }
  }


  private dropSubscribers(sessionId: string): void {
    this.listeners.delete(sessionId);
    this.interactive.delete(sessionId);
  }

  private async readWithTemporaryServer<T>(read: (rpc: BackendTransport) => Promise<T>): Promise<T> {
    if (this.closed) throw new Error("Codex backend is closed");
    const rpc = this.factory();
    await rpc.connect();
    try {
      return await read(rpc);
    } finally {
      await rpc.close();
    }
  }
}

function turnInput(input: string | readonly TurnInput[]): Record<string, unknown>[] {
  const values = typeof input === "string" ? [{ type: "text" as const, text: input }] : [...input];
  if (!values.length) throw new Error("Input must not be empty");
  return values.map(value => {
    if (value.type === "text") {
      if (!value.text.trim()) throw new Error("Input must not be empty");
      return { type: "text", text: value.text, text_elements: [] };
    }
    if (value.type === "image") {
      if (!value.url.trim()) throw new Error("Image URL must not be empty");
      return { type: "image", url: value.url };
    }
    if (value.type === "localImage") {
      if (!isAbsolute(value.path)) throw new Error("Local image path must be absolute");
      return { type: "localImage", path: value.path };
    }
    if (!value.name || !isAbsolute(value.path)) throw new Error("Skill name and absolute path are required");
    return { type: "skill", name: value.name, path: value.path };
  });
}

function snapshot(record: StoredSession): SessionSnapshot {
  const { sessionId, threadId, turnId, cwd, model, reasoningEffort, pending, usage, state, options, reports } = record;
  return { sessionId, threadId, turnId, cwd, executionCwd: record.executionCwd ?? options?.boundary?.cwd ?? cwd,
    model, reasoningEffort, ...(pending === undefined ? {} : { pending: structuredClone(pending) }),
    ...(record.applied === undefined ? {} : { applied: structuredClone(record.applied) }),
    usage, state, options: structuredClone(options), reports: structuredClone(reports) };
}

function turnSnapshot(record: StoredSession, state: TurnSnapshot["state"]): TurnSnapshot {
  if (record.threadId === undefined || record.turnId === undefined) throw new UncertainError("Turn identity unavailable");
  return { sessionId: record.sessionId, threadId: record.threadId, turnId: record.turnId, state };
}

function statusState(status: unknown): TurnSnapshot["state"] | undefined {
  if (status === "inProgress") return "running";
  return terminalState(status);
}

function terminalState(status: unknown): Report["status"] | undefined {
  return status === "completed" || status === "failed" || status === "interrupted" ? status : undefined;
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function approvalResponse(request: ApprovalRequest, decision: ApprovalDecision): Record<string, unknown> {
  if (request.method !== "item/permissions/requestApproval") return { decision };
  if (decision !== "accept") return { permissions: {}, scope: "turn" };
  const permissions = objectValue(objectValue(request.params).permissions);
  return { permissions, scope: "turn" };
}

function userInputQuestions(value: unknown): UserInputQuestion[] {
  if (!Array.isArray(value)) return [];
  const questions: UserInputQuestion[] = [];
  for (const raw of value) {
    const question = objectValue(raw);
    if (typeof question.id !== "string" || typeof question.question !== "string") continue;
    const options = Array.isArray(question.options) ? question.options.flatMap(item => {
      const option = objectValue(item);
      return typeof option.label === "string"
        ? [{ label: option.label, description: typeof option.description === "string" ? option.description : "" }]
        : [];
    }) : [];
    questions.push({
      id: question.id,
      header: typeof question.header === "string" ? question.header : "",
      question: question.question,
      isOther: question.isOther === true,
      isSecret: question.isSecret === true,
      ...(options.length === 0 ? {} : { options }),
    });
  }
  return questions;
}

/**
 * Validate one explicitly declared task boundary.
 *
 * The boundary names the Codex execution location and the exact writable roots
 * the task declares. It is forwarded verbatim: the plugin neither rewrites its
 * cwd to the Session workspace nor widens its writable roots. A boundary that
 * does not name absolute directories fails closed.
 * @param boundary - the declared boundary, when the caller declared one.
 * @returns the normalized declared boundary, or undefined for an unscoped Session.
 */
function normalizedBoundary(boundary: CreateSessionOptions["boundary"]) {
  if (boundary === undefined) return undefined;
  if (!isAbsolute(boundary.cwd) || !boundary.writableRoots.every(isAbsolute)) {
    throw new Error("Boundary cwd and writable roots must be absolute");
  }
  return {
    cwd: resolve(boundary.cwd),
    writableRoots: [...new Set(boundary.writableRoots.map(path => resolve(path)))],
    network: boundary.network,
  } as const;
}

/**
 * Build the native thread request for one record.
 *
 * Only what the record actually declares is sent. `approvalPolicy`,
 * `approvalsReviewer` and `sandbox` travel when the caller declared them, and
 * Codex resolves everything else from its own configuration layers and cwd:
 * permissions are Codex's own subject, so the plugin injects no permission
 * profile and couples no feature flag to a task boundary. A declared boundary
 * contributes only the directory the task runs in.
 * @param record - the record whose thread is being started or resumed.
 * @returns the `thread/start` / `thread/resume` parameters.
 */
function threadParams(record: StoredSession): Record<string, unknown> {
  const options = record.options ?? {};
  const boundary = options.boundary;
  return {
    // The native thread runs where the task runs, which is the Session workspace
    // only when the Session declares no task boundary.
    cwd: boundary?.cwd ?? record.cwd,
    model: record.model,
    ...(options.developerInstructions === undefined ? {} : { developerInstructions: options.developerInstructions }),
    ...(options.approvalPolicy === undefined ? {} : { approvalPolicy: options.approvalPolicy }),
    ...(options.approvalsReviewer === undefined ? {} : { approvalsReviewer: options.approvalsReviewer }),
    ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
    config: {
      ...(record.reasoningEffort === undefined ? {} : { model_reasoning_effort: record.reasoningEffort }),
    },
    ephemeral: false,
  };
}

/**
 * Record the native configuration a thread request actually applied, and hold a
 * declared task boundary to the directory it named.
 *
 * Recording happens for every request, so `applied` is native fact rather than
 * an echo of the request — including the sandbox Codex chose, which the plugin
 * reports but never dictates. An unscoped Session has nothing to hold to.
 * @param record - the record being reconciled.
 * @param result - the App Server's thread result.
 * @throws when a declared boundary was not applied as declared.
 */
function reconcileBoundary(record: StoredSession, result: ThreadResult): void {
  const applied: NonNullable<StoredSession["applied"]> = {
    ...(result.cwd === undefined ? {} : { cwd: result.cwd }),
    ...(result.approvalPolicy === undefined ? {} : { approvalPolicy: result.approvalPolicy }),
    ...(result.sandbox === undefined ? {} : {
      sandbox: {
        ...(result.sandbox.type === undefined ? {} : { type: result.sandbox.type }),
        ...(result.sandbox.writableRoots === undefined ? {} : { writableRoots: [...result.sandbox.writableRoots] }),
        ...(result.sandbox.excludeSlashTmp === undefined ? {} : { excludeSlashTmp: result.sandbox.excludeSlashTmp }),
        ...(result.sandbox.excludeTmpdirEnvVar === undefined ? {} : { excludeTmpdirEnvVar: result.sandbox.excludeTmpdirEnvVar }),
        ...(result.sandbox.networkAccess === undefined ? {} : { networkAccess: result.sandbox.networkAccess }),
      },
    }),
  };
  record.applied = applied;
  // Native facts are the authority for the thread's working location: a
  // recorded execution cwd that disagrees with the resumed thread is repaired
  // here rather than trusted, and a declared boundary is then verified below.
  record.executionCwd = result.cwd ?? record.executionCwd ?? record.cwd;
  const boundary = record.options?.boundary;
  if (boundary === undefined) return;
  // Sandbox and approvals are Codex's own decision, so the native sandbox is
  // recorded above as a fact and never compared against the declaration. What
  // the plugin does hold is where the task runs: a declared boundary names a
  // location — a lane worktree, for instance — and a thread that reports a
  // different directory is refused rather than quietly redirected.
  if (result.cwd !== undefined && result.cwd !== boundary.cwd) {
    throw new Error(`App Server ran the declared task in another directory: ${JSON.stringify({ declared: boundary.cwd, cwd: result.cwd })}`);
  }
}

function checkExecutionModel(record: StoredSession, result: ThreadResult): void {
  if (record.options?.developerInstructions === undefined && record.options?.boundary === undefined) return;
  if (record.model !== undefined && result.model !== record.model
    || record.reasoningEffort !== undefined && result.reasoningEffort !== record.reasoningEffort) {
    throw new Error("App Server did not apply the requested execution model/effort");
  }
}

/**
 * The authorized target a turn requested, when it differs from the confirmed
 * configuration. `undefined` means the request keeps the confirmed values.
 */
function pendingTarget(record: StoredSession, options: TurnOptions): PendingConfig | undefined {
  const model = options.model !== undefined && options.model !== record.model ? options.model : undefined;
  const reasoningEffort = options.reasoningEffort !== undefined && options.reasoningEffort !== record.reasoningEffort
    ? options.reasoningEffort
    : undefined;
  if (model === undefined && reasoningEffort === undefined) return undefined;
  return { ...(model === undefined ? {} : { model }), ...(reasoningEffort === undefined ? {} : { reasoningEffort }) };
}

/**
 * Promote or discard a pending target from native facts after a resume or
 * rebuild. Native reports what the thread runs, so a target that was still
 * pending when the process stopped is confirmed by the resumed thread rather
 * than reverted to the configuration it was switched away from.
 */
function reconcilePending(record: StoredSession, result: ThreadResult): void {
  if (record.pending === undefined) return;
  if (typeof result.model === "string" && result.model.length > 0) record.model = result.model;
  if (typeof result.reasoningEffort === "string" && result.reasoningEffort.length > 0) record.reasoningEffort = result.reasoningEffort;
  delete record.pending;
}

function rolloutUsage(path: string, threadId: string): unknown | undefined {
  if (!isAbsolute(path)) return undefined;
  let matches = false, usage: unknown;
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      let row: any;
      try { row = JSON.parse(line); } catch { continue; }
      if (row?.type === "session_meta") matches = row.payload?.id === threadId;
      if (!matches || row?.type !== "event_msg" || row.payload?.type !== "token_count") continue;
      const info = row.payload.info;
      if (!info) continue;
      usage = { total: tokenValues(info.total_token_usage), last: tokenValues(info.last_token_usage), modelContextWindow: count(info.model_context_window) };
    }
  } catch { return undefined; }
  return matches ? usage : undefined;
}

function tokenValues(value: any): UsageValues {
  return {
    totalTokens: count(value?.totalTokens ?? value?.total_tokens),
    inputTokens: count(value?.inputTokens ?? value?.input_tokens),
    cachedInputTokens: count(value?.cachedInputTokens ?? value?.cached_input_tokens),
    cacheWriteInputTokens: count(value?.cacheWriteInputTokens ?? value?.cache_write_input_tokens),
    outputTokens: count(value?.outputTokens ?? value?.output_tokens),
    reasoningOutputTokens: count(value?.reasoningOutputTokens ?? value?.reasoning_output_tokens),
  };
}

function count(value: unknown): number | null { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null; }

function normalizeUsage(value: unknown): Usage | null {
  if (typeof value !== "object" || value === null) return null;
  const usage = value as Record<string, any>;
  const total = tokenValues(usage.total);
  const last = tokenValues(usage.last);
  const modelContextWindow = count(usage.modelContextWindow);
  const currentContextTokens = count(usage.currentContextTokens ?? usage.last?.totalTokens);
  return {
    total,
    last,
    modelContextWindow,
    currentContextTokens,
    remainingContextRatio: currentContextTokens !== null && modelContextWindow !== null && modelContextWindow > 0
      ? Math.max(0, 1 - currentContextTokens / modelContextWindow)
      : null,
  };
}

function validateCaller(caller: Caller): void {
  const parent = caller?.parentAgent;
  if (typeof caller?.nativeSessionId !== "string" || !caller.nativeSessionId
    || caller.source !== "agent" || typeof parent?.id !== "string" || !parent.id
    || parent.nativeSessionId !== caller.nativeSessionId) throw new Error("Invalid contextual caller");
}

function canAccess(caller: Caller, record: StoredSession): boolean {
  const worker = record.worker;
  return worker?.owner === "agent" && !worker.detached && worker.parentSessionId === caller.nativeSessionId;
}

function ownerIdentity(owner: string | Caller): string {
  return typeof owner === "string" ? owner : owner.nativeSessionId;
}

function availableDirectory(path: unknown): path is string {
  if (typeof path !== "string" || !isAbsolute(path)) return false;
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function workerProjection(record: StoredSession): WorkerProjection {
  const worker = record.worker!;
  return structuredClone({
    id: record.sessionId,
    parentSessionId: worker.parentSessionId,
    owner: "agent",
    name: worker.name,
    detached: worker.detached,
    cwd: record.cwd,
    model: record.model,
    effort: record.reasoningEffort,
    threadId: record.threadId,
    turnId: record.turnId,
    state: record.state,
    savedState: worker.savedState,
    reports: record.reports,
    approvals: record.approvals,
    usage: record.usage,
  });
}

/**
 * Record one command item's live status.
 *
 * Only `commandExecution` items are tracked: they are the ones that can outlive
 * the turn that asked for them, and a closed Session must not abandon one.
 * @param runtime - the runtime that owns the thread the notification arrived on.
 * @param method - the native notification method.
 * @param params - the notification parameters.
 */
function trackCommand(runtime: Runtime, method: string, params: Record<string, unknown>): void {
  if (method !== "item/started" && method !== "item/completed") return;
  const item = objectValue(params.item);
  if (item.type !== "commandExecution" || typeof item.id !== "string") return;
  runtime.commands.set(item.id, typeof item.status === "string" ? item.status : method === "item/started" ? "inProgress" : "completed");
}

/**
 * Whether the runtime still has a command item open.
 *
 * A runtime that is gone cannot be asked. Its record's own state already decides:
 * only an idle or confirmed-stopped Session is closable, and a resume is refused
 * while the thread reports a turn in progress, so an accepted runtime has no open
 * command to lose.
 * @param runtime - the runtime holding the Session, when this process holds one.
 * @returns whether any tracked command item is still running.
 */
function hasActiveCommand(runtime: Runtime | undefined): boolean {
  return [...(runtime?.commands.values() ?? [])].some(status => status === "inProgress");
}
