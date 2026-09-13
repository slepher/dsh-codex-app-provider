import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync, statSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { isAbsolute, resolve } from "node:path";

import type {
  ApprovalDecision,
  ApprovalRequest,
  BackendMutation,
  BackendEvent,
  AccessCaller as Caller,
  MainCaller,
  Caller as NativeCaller,
  CodexBackend,
  Conversation,
  CreateSessionOptions,
  CreateWorkerInput,
  Report,
  ReportAcceptance,
  SequencedBackendEvent,
  SessionSnapshot,
  StartTurnOptions,
  SubscribeOptions,
  ThreadPage,
  TurnInput,
  TurnOptions,
  TurnSnapshot,
  Usage,
  UsageValues,
  UserInputAnswer,
  UserInputQuestion,
  UserInputRequest,
  WorkerProjection,
  WorkerManagementEvent,
  WorkflowProvider,
  WorkflowRegistration,
  WorkflowRole,
} from "./browser-types.js";
import { conversation } from "./conversation.js";
import { modelSettings } from "./models.js";
import { AppServer, RpcError, type RpcMessage, UncertainError } from "./rpc.js";
import { listSkills } from "./skills.js";
import { SessionStore, type StoredSession } from "./store.js";

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

interface WorkflowPermission {
  registration: object;
  caller: NativeCaller;
  workerId: string;
  action: BackendMutation["action"];
}

export class CodexSessionBackend implements CodexBackend {
  private readonly store: SessionStore;
  private readonly live = new Map<string, Runtime>();
  private readonly mainFlights = new Map<string, Promise<WorkerProjection>>();
  private readonly listeners = new Map<string, Set<(event: BackendEvent, sequence: number) => void>>();
  private readonly interactive = new Map<string, Set<(event: BackendEvent, sequence: number) => void>>();
  private readonly workerListeners = new Map<string, Set<(event: WorkerManagementEvent) => void>>();
  private readonly guards = new Set<(mutation: BackendMutation) => void>();
  private readonly workflowPermission = new AsyncLocalStorage<WorkflowPermission>();
  private workflow?: { identity: object; provider: WorkflowProvider };
  private closed = false;

  constructor(
    stateDir: string,
    private readonly factory: () => BackendTransport = () => new AppServer(),
  ) {
    this.store = new SessionStore(stateDir);
  }

  registerWorkflow(provider: WorkflowProvider): WorkflowRegistration {
    if (this.workflow !== undefined) throw new Error("Workflow backend integration is already registered");
    const identity = {}, active = (): boolean => this.workflow?.identity === identity;
    this.workflow = { identity, provider };
    return {
      listRoles: () => { if (!active()) throw new Error("Workflow backend integration is unavailable"); return this.workflowRoles(); },
      resolveRole: name => { if (!active()) throw new Error("Workflow backend integration is unavailable"); return this.resolveWorkflowRole(name); },
      run: async (caller, workerId, action, operation) => {
        validateCaller(caller);
        if (!active()) throw new Error("Workflow backend integration is unavailable");
        return this.workflowPermission.run({ registration: identity, caller: structuredClone(caller), workerId, action }, operation);
      },
      dispose: () => { if (active()) this.workflow = undefined; },
    };
  }

  workflowRoles(): readonly WorkflowRole[] {
    if (this.workflow === undefined) throw new Error("Workflow role provider is unavailable");
    const roles = this.workflow.provider.listRoles();
    for (const role of roles) validateWorkflowRole(role);
    return structuredClone(roles);
  }

  resolveWorkflowRole(name: string): WorkflowRole {
    if (this.workflow === undefined) throw new Error("Workflow role provider is unavailable");
    const role = this.workflow.provider.resolveRole(name);
    validateWorkflowRole(role);
    if (role.name !== name) throw new Error("Workflow role provider returned a different role");
    return structuredClone(role);
  }

  async createSession(
    ownerId: string,
    sessionId: string,
    cwd: string,
    options: CreateSessionOptions = {},
  ): Promise<SessionSnapshot> {
    if (!ownerId || !sessionId || !isAbsolute(cwd)) throw new Error("Owner, Session ID, and absolute cwd are required");
    const boundary = normalizedBoundary(options.boundary, cwd);
    const normalizedOptions = { ...options, ...(boundary === undefined ? {} : { boundary }) };
    this.guard({ ownerId, sessionId, action: "create", cwd, ...(boundary === undefined ? {} : { boundary }) });
    const existing = this.store.get(ownerId, sessionId);
    if (existing !== undefined) return snapshot(existing);
    const record: StoredSession = {
      ownerId,
      sessionId,
      cwd,
      state: "unknown",
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      approvals: [],
      options: normalizedOptions,
      events: [],
      nextEventSequence: 1,
      reports: [],
    };
    this.store.put(record);
    const runtime = this.attach(record);
    try {
      await runtime.rpc.connect();
      const result = await runtime.rpc.request<ThreadResult>("thread/start", threadParams(record));
      if (typeof result.thread?.id !== "string") throw new Error("Missing thread identity");
      record.threadId = result.thread.id;
      checkBoundary(record, result);
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
    if (caller.conversationId !== undefined) throw new Error("Main callers cannot create legacy workers");
    if (input.id?.startsWith("main:")) throw new Error("Reserved main conversation identity");
    return this.createBoundWorker(caller, input);
  }

  async getMainWorker(caller: MainCaller): Promise<WorkerProjection | undefined> {
    privateCaller(caller);
    if (!caller.conversationId) throw new Error("Codex conversation identity is required");
    const record = this.store.bound(`main:${caller.conversationId}`);
    if (record === undefined) return undefined;
    if (!record.worker?.main) throw new Error("Main conversation identity is occupied");
    return this.getWorker(caller, record.sessionId);
  }

  async createMainWorker(caller: MainCaller, input: Omit<CreateWorkerInput, "id" | "role">): Promise<WorkerProjection> {
    privateCaller(caller);
    const key = caller.conversationId;
    let flight = this.mainFlights.get(key);
    if (flight === undefined) {
      flight = (async () => {
        const existing = await this.getMainWorker(caller);
        return existing ?? this.createBoundWorker(caller, { ...input, id: `main:${key}` }, true);
      })().finally(() => this.mainFlights.delete(key));
      this.mainFlights.set(key, flight);
    }
    const worker = await flight;
    if (worker.cwd !== input.cwd) throw new Error("Main conversation belongs to another workspace");
    return worker;
  }

  private async createBoundWorker(caller: Caller, input: CreateWorkerInput, main?: true): Promise<WorkerProjection> {
    validateCaller(caller);
    if (caller.source === "agent") agentCaller(caller);
    else privateCaller(caller);
    const sessionId = input.id ?? randomUUID();
    if (!sessionId || !input.name.trim() || !availableDirectory(input.cwd)) {
      throw new Error("Parent, name and an existing absolute cwd are required");
    }
    if (this.store.has(sessionId)) throw new Error("Invalid or occupied worker identity");
    const managed = this.managedCreation(caller, sessionId);
    const { id: _, name: __, cwd: ___, role, ...requestedOptions } = input;
    const resolvedRole = role === undefined || role === "" ? undefined : this.resolveWorkflowRole(role);
    const options = resolvedRole === undefined ? requestedOptions : {
      ...requestedOptions,
      model: resolvedRole.model,
      reasoningEffort: resolvedRole.reasoningEffort,
      developerInstructions: resolvedRole.developerInstructions,
    };
    const boundary = normalizedBoundary(options.boundary, input.cwd);
    const normalizedOptions = { ...options, ...(boundary === undefined ? {} : { boundary }) };
    this.guard({ ownerId: ownerIdentity(caller), sessionId, action: "create", cwd: input.cwd, ...(boundary === undefined ? {} : { boundary }) });
    const record: StoredSession = {
      ownerId: ownerIdentity(caller),
      sessionId,
      cwd: input.cwd,
      state: "unknown",
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      approvals: [],
      options: normalizedOptions,
      events: [],
      nextEventSequence: 1,
      reports: [],
      worker: {
        parentSessionId: ownerIdentity(caller),
        ...(main ? { main } : {}),
        owner: caller.source === "agent" ? "agent" : "user",
        name: input.name,
        detached: false,
        ...(managed ? { managedBy: "workflow" as const } : {}),
        ...(resolvedRole === undefined ? {} : { role: resolvedRole.name }),
      },
    };
    this.store.put(record);
    const runtime = this.attach(record);
    try {
      await runtime.rpc.connect();
      const result = await runtime.rpc.request<ThreadResult>("thread/start", threadParams(record));
      if (typeof result.thread?.id !== "string") throw new Error("Missing thread identity");
      record.threadId = result.thread.id;
      checkBoundary(record, result);
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

  async listMainConversations(cwd: string): Promise<readonly WorkerProjection[]> {
    return this.store.mainConversations(cwd).map(workerProjection);
  }

  async listWorkers(caller: Caller): Promise<readonly WorkerProjection[]> {
    validateCaller(caller);
    if (caller.source === "agent" || caller.parentAgent !== undefined) agentContextCaller(caller);
    return this.store.listWorkers(ownerIdentity(caller))
      .filter(record => canAccess(caller, record))
      .map(workerProjection);
  }

  async getWorker(caller: Caller, workerId: string): Promise<WorkerProjection> {
    return workerProjection(this.boundRequired(caller, workerId));
  }

  async linkWorker(caller: Caller, workerId: string): Promise<WorkerProjection> {
    agentUiCaller(caller);
    const record = this.store.bound(workerId);
    if (record?.worker === undefined || record.worker.parentSessionId !== ownerIdentity(caller) || record.worker.detached) {
      throw new Error("Worker not found in this parent session");
    }
    this.guard({ ownerId: ownerIdentity(caller), sessionId: workerId, action: "link", cwd: record.cwd });
    if (record.worker.owner !== "user") throw new Error("Only a user conversation can be linked");
    if (record.worker.main) throw new Error("Main conversation binding is fixed");
    this.store.assertWritable(record);
    const now = Date.now();
    for (const report of record.reports) report.acknowledgedAt ??= now;
    record.worker.owner = "agent";
    this.store.put(record);
    this.notifyWorker(record, "binding", record.worker.parentSessionId, true);
    this.dropSubscribers(workerId);
    return workerProjection(record);
  }

  async detachWorker(caller: Caller, workerId: string): Promise<void> {
    privateCaller(caller);
    const record = this.boundRequired(caller, workerId);
    this.guard({ ownerId: ownerIdentity(caller), sessionId: workerId, action: "detach", cwd: record.cwd });
    if (record.worker!.main) throw new Error("Main conversation binding is fixed");
    if (record.worker!.owner !== "user") throw new Error("Only user conversations can be removed from this group");
    this.store.assertWritable(record);
    record.worker!.detached = true;
    this.store.put(record);
    this.notifyWorker(record, "closed", record.worker!.parentSessionId, true);
    this.dropSubscribers(workerId);
  }

  async adoptWorker(caller: Caller, threadId: string): Promise<WorkerProjection> {
    privateCaller(caller);
    if (caller.conversationId !== undefined) throw new Error("Main callers cannot adopt legacy workers");
    if (!threadId) throw new Error("Thread ID is required");
    const matches = this.store.findByThread(threadId);
    if (matches.length > 1) throw new Error("Ambiguous Codex session identity");
    if (matches.length === 1 && matches[0].worker === undefined) {
      throw new Error("Legacy Session requires explicit identity migration before adoption");
    }
    if (matches[0]?.worker?.managedBy === "workflow") throw new Error("Managed workflow workers cannot be adopted");
    if (matches[0]?.worker?.main) throw new Error("Main conversation binding is fixed");
    if (matches[0]?.worker !== undefined) this.store.assertWritable(matches[0]);
    if (this.store.occupiedThreads().includes(threadId)) throw new Error("This Codex session is already occupied");
    const result = await this.readWithTemporaryServer(rpc => rpc.request<ThreadResult>("thread/read", { threadId, includeTurns: false }));
    const thread = result.thread;
    if (thread?.id !== threadId || !availableDirectory(thread.cwd)) throw new Error("Session working directory is unavailable");
    const currentMatches = this.store.findByThread(threadId);
    if (currentMatches.length > 1) throw new Error("Ambiguous Codex session identity");
    if (currentMatches.length !== matches.length || currentMatches[0]?.sessionId !== matches[0]?.sessionId) {
      throw new Error("Worker adoption target changed");
    }
    if (currentMatches[0]?.worker?.managedBy === "workflow") throw new Error("Managed workflow workers cannot be adopted");
    if (thread.status?.type === "active" || this.store.occupiedThreads().includes(threadId)) {
      throw new Error("This Codex session is already occupied");
    }
    if (currentMatches[0]?.worker !== undefined) this.store.assertWritable(currentMatches[0]);
    let record = currentMatches[0];
    const previousParent = record?.worker?.parentSessionId;
    const sessionId = record?.sessionId ?? randomUUID();
    const cwd = record?.cwd ?? thread.cwd;
    this.guard({ ownerId: ownerIdentity(caller), sessionId, action: "adopt", cwd });
    if (record?.worker !== undefined) {
      record = this.store.adopt(record.sessionId, ownerIdentity(caller), threadId);
    } else {
      record = {
        ownerId: ownerIdentity(caller),
        sessionId,
        threadId,
        cwd,
        state: "saved",
        model: result.model,
        reasoningEffort: result.reasoningEffort,
        approvals: [],
        options: { model: result.model, reasoningEffort: result.reasoningEffort },
        events: [],
        nextEventSequence: 1,
        reports: [],
        worker: {
          parentSessionId: ownerIdentity(caller),
          owner: "user",
          name: thread.name || thread.preview?.slice(0, 40) || threadId,
          detached: false,
          savedState: "idle",
        },
      };
      this.store.put(record);
    }
    if (previousParent !== undefined && previousParent !== ownerIdentity(caller)) this.notifyWorker(record, "binding", previousParent, true);
    this.notifyWorker(record, "binding");
    this.dropSubscribers(record.sessionId);
    await this.resumeSession(caller, record.sessionId);
    return workerProjection(record);
  }

  async pendingReports(caller: Caller): Promise<readonly Report[]> {
    agentContextCaller(caller);
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

  async resumeSession(owner: string | Caller, sessionId: string, confirmedStopped = false): Promise<SessionSnapshot> {
    const record = this.required(owner, sessionId);
    this.store.assertWritable(record);
    if (record.worker !== undefined && confirmedStopped && typeof owner !== "string" && owner.source !== "ui") {
      throw new Error("Only UI callers can confirm a stopped worker");
    }
    const ownerId = ownerIdentity(owner);
    const prior = this.live.get(sessionId);
    if (prior !== undefined && !prior.uncertain && record.state !== "unknown") return snapshot(record);
    if ((record.state === "unknown" || record.state === "saved" && record.worker?.savedState !== "idle") && !confirmedStopped) {
      throw new Error("Unknown execution ownership; confirm the prior process stopped before resume");
    }
    if (record.threadId === undefined) throw new Error("No thread identity to resume");
    this.managed(record, owner, "resume");
    this.guard({ ownerId, sessionId, action: "resume", cwd: record.cwd });
    if (prior !== undefined) {
      await prior.rpc.close();
      this.live.delete(sessionId);
    }
    const runtime = this.attach(record);
    try {
      await runtime.rpc.connect();
      const result = await runtime.rpc.request<ThreadResult>("thread/resume", {
        ...threadParams(record),
        threadId: record.threadId,
      });
      if (result.thread?.id !== record.threadId) throw new Error("Recovered thread identity mismatch");
      checkBoundary(record, result);
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
      this.live.delete(sessionId);
      await runtime.rpc.close().catch(() => {});
      throw error;
    }
  }

  /**
   * Drop the current native thread and start a fresh empty one for the same
   * record. The DSH Session log stays the source of truth: the next turn
   * imports the visible history into the new thread. Native checkpoints are
   * disposable, so this is the rebuild path after native compaction.
   */
  async restartSession(owner: string | Caller, sessionId: string, options: TurnOptions = {}): Promise<SessionSnapshot> {
    const record = this.required(owner, sessionId);
    this.store.assertWritable(record);
    if (record.worker?.main) throw new Error("Main conversation binding is fixed");
    if (record.state !== "idle" && record.state !== "saved") throw new Error(`Cannot rebuild a Session while it is ${record.state}`);
    const ownerId = ownerIdentity(owner);
    this.managed(record, owner, "resume");
    this.guard({ ownerId, sessionId, action: "resume", cwd: record.cwd });
    if ("model" in options) record.model = options.model;
    if ("reasoningEffort" in options) record.reasoningEffort = options.reasoningEffort;
    record.options = { ...record.options, model: record.model, reasoningEffort: record.reasoningEffort };
    await this.live.get(sessionId)?.rpc.close().catch(() => {});
    this.live.delete(sessionId);
    record.approvals = [];
    record.turnId = undefined;
    record.operation = undefined;
    record.state = "unknown";
    this.store.put(record);
    const runtime = this.attach(record);
    try {
      await runtime.rpc.connect();
      const result = await runtime.rpc.request<ThreadResult>("thread/start", threadParams(record));
      if (typeof result.thread?.id !== "string") throw new Error("Missing thread identity");
      record.threadId = result.thread.id;
      checkBoundary(record, result);
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
      this.live.delete(sessionId);
      await runtime.rpc.close().catch(() => {});
      throw new Error(`Session rebuild is uncertain; inspect before retrying: ${String(error)}`);
    }
  }

  async configureSession(owner: string | Caller, sessionId: string, options: TurnOptions): Promise<SessionSnapshot> {
    const record = this.required(owner, sessionId);
    this.store.assertWritable(record);
    const managed = this.managed(record, owner, "configure");
    if (typeof owner !== "string" && owner.source !== "ui" && !managed) throw new Error("Only UI callers can configure a worker");
    if (record.worker?.role !== undefined && (
      options.model !== undefined && options.model !== record.options?.model
      || options.reasoningEffort !== undefined && options.reasoningEffort !== record.options?.reasoningEffort
    )) throw new Error("Role execution profile cannot be overridden");
    const ownerId = ownerIdentity(owner);
    this.guard({ ownerId, sessionId, action: "configure", cwd: record.cwd });
    if ("model" in options) record.model = options.model;
    if ("reasoningEffort" in options) record.reasoningEffort = options.reasoningEffort;
    record.options = { ...record.options, model: record.model, reasoningEffort: record.reasoningEffort };
    this.store.put(record);
    return snapshot(record);
  }

  async closeSession(owner: string | Caller, sessionId: string, confirmedStopped = false): Promise<void> {
    const record = this.required(owner, sessionId);
    if (record.worker?.main) throw new Error("Main conversation binding is fixed");
    this.store.assertWritable(record);
    if (record.worker?.owner === "agent" && confirmedStopped && typeof owner !== "string" && owner.source !== "ui") {
      throw new Error("Only UI callers can confirm a stopped worker");
    }
    const ownerId = ownerIdentity(owner);
    if (record.worker !== undefined) {
      if (record.worker.owner === "user") {
        this.guard({ ownerId, sessionId, action: "close", cwd: record.cwd });
        record.worker.detached = true;
        this.store.put(record);
        this.notifyWorker(record, "closed", record.worker.parentSessionId, true);
        this.dropSubscribers(sessionId);
        return;
      }
      const idle = record.state === "idle" || record.state === "saved" && record.worker.savedState === "idle";
      const confirmed = confirmedStopped && (record.state === "saved" || record.state === "unknown");
      if (!idle && !confirmed || record.approvals.length) throw new Error("Only idle workers can be closed");
      if (record.reports.some(report => report.acceptance === "pending" && report.acknowledgedAt === undefined)) {
        throw new Error("Process pending reports with accept or ack before closing");
      }
      if (hasActiveCommand(record)) throw new Error("Tracked task command still running; verify its completion before closing");
      this.managed(record, owner, "close");
      this.guard({ ownerId, sessionId, action: "close", cwd: record.cwd });
      record.state = "starting";
      this.store.put(record);
      try {
        await this.live.get(sessionId)?.rpc.close();
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
    if (record.state !== "idle") throw new Error("Only an idle Session can close");
    this.guard({ ownerId, sessionId, action: "close", cwd: record.cwd });
    await this.live.get(sessionId)?.rpc.close();
    this.live.delete(sessionId);
    record.released = true;
    this.store.put(record);
  }

  async searchThreads(_ownerId: string, search?: string, cursor?: string): Promise<ThreadPage> {
    return this.readWithTemporaryServer(async rpc => {
      const page = await rpc.request<{ data?: ThreadResult["thread"][]; nextCursor?: string | null }>("thread/list", {
        cursor: cursor ?? null,
        limit: 50,
        sortKey: "updated_at",
        useStateDbOnly: true,
        modelProviders: [],
        searchTerm: search?.trim() || null,
      });
      const occupied = new Set(this.store.occupiedThreads());
      return {
        data: (page.data ?? []).filter((thread): thread is NonNullable<ThreadResult["thread"]> & { id: string; cwd: string } =>
          typeof thread?.id === "string" && typeof thread.cwd === "string" && thread.status?.type !== "active" && !occupied.has(thread.id)),
        nextCursor: page.nextCursor ?? null,
      };
    });
  }

  async importSession(ownerId: string, sessionId: string, threadId: string): Promise<SessionSnapshot> {
    if (!ownerId || !sessionId || !threadId) throw new Error("Owner, Session ID, and thread ID are required");
    if (this.store.get(ownerId, sessionId) !== undefined) throw new Error("Session identity already exists");
    const result = await this.readWithTemporaryServer(rpc => rpc.request<ThreadResult>("thread/read", { threadId, includeTurns: false }));
    const thread = result.thread;
    if (thread?.id !== threadId || typeof thread.cwd !== "string" || !isAbsolute(thread.cwd)) throw new Error("Imported thread is invalid");
    if (thread.status?.type === "active" || this.store.occupiedThreads().includes(threadId)) throw new Error("This Codex session is already occupied");
    this.guard({ ownerId, sessionId, action: "create", cwd: thread.cwd });
    const record: StoredSession = {
      ownerId, sessionId, threadId, cwd: thread.cwd, state: "idle",
      model: result.model, reasoningEffort: result.reasoningEffort,
      approvals: [], options: { model: result.model, reasoningEffort: result.reasoningEffort },
      events: [], nextEventSequence: 1,
      reports: [],
    };
    this.store.put(record);
    return snapshot(record);
  }

  async occupiedThreads(): Promise<readonly string[]> {
    return this.store.occupiedThreads();
  }

  async startTurn(owner: string | Caller, sessionId: string, input: string | readonly TurnInput[], options: StartTurnOptions = {}): Promise<TurnSnapshot> {
    const record = this.required(owner, sessionId);
    this.store.assertWritable(record);
    const ownerId = ownerIdentity(owner);
    const items = turnInput(input);
    if (options.idempotencyKey !== undefined && record.lastStartKey === options.idempotencyKey && record.turnId !== undefined) {
      return turnSnapshot(record, record.lastTurnState ?? record.state);
    }
    if (record.state !== "idle") throw new Error(`Cannot start a turn while Session is ${record.state}; do not redispatch`);
    if (record.worker?.role !== undefined && (
      options.model !== undefined && options.model !== record.options?.model
      || options.reasoningEffort !== undefined && options.reasoningEffort !== record.options?.reasoningEffort
    )) throw new Error("Role execution profile cannot be overridden");
    this.managed(record, owner, "start");
    this.guard({ ownerId, sessionId, action: "start", cwd: record.cwd });
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
      this.store.put(record);
      throw error;
    }
  }

  async compactSession(owner: string | Caller, sessionId: string): Promise<void> {
    const record = this.required(owner, sessionId);
    this.store.assertWritable(record);
    if (record.state !== "idle") throw new Error("Wait for the current turn before compacting");
    const managed = this.managed(record, owner, "compact");
    if (typeof owner !== "string" && owner.source !== "ui" && !managed) throw new Error("Only UI callers can compact a worker");
    const ownerId = ownerIdentity(owner);
    this.guard({ ownerId, sessionId, action: "compact", cwd: record.cwd });
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

  async reviewSession(owner: string | Caller, sessionId: string): Promise<TurnSnapshot> {
    const record = this.required(owner, sessionId);
    this.store.assertWritable(record);
    if (record.state !== "idle") throw new Error(`Cannot review while Session is ${record.state}`);
    const managed = this.managed(record, owner, "review");
    if (typeof owner !== "string" && owner.source !== "ui" && !managed) throw new Error("Only UI callers can review a worker");
    const ownerId = ownerIdentity(owner);
    this.guard({ ownerId, sessionId, action: "review", cwd: record.cwd });
    const runtime = await this.runtime(record, owner);
    record.state = "running";
    record.turnId = undefined;
    record.operation = "review";
    record.lastOutput = undefined;
    record.lastUnphasedOutput = undefined;
    this.store.put(record);
    try {
      const result = await runtime.rpc.request<TurnResult>("review/start", {
        threadId: record.threadId,
        target: { type: "uncommittedChanges" },
        delivery: "inline",
      });
      if (typeof result.turn?.id !== "string") throw new Error("Missing turn identity");
      if (record.turnId !== undefined && record.turnId !== result.turn.id) throw new Error("Turn identity mismatch");
      record.turnId = result.turn.id;
      const responseState = statusState(result.turn.status);
      if (responseState !== undefined && responseState !== "running") {
        this.finish(record, result.turn);
        return turnSnapshot(record, record.lastTurnState ?? responseState);
      }
      if (!this.finished(record, result.turn.id)) record.lastTurnState = responseState ?? "running";
      this.store.put(record);
      return turnSnapshot(record, record.lastTurnState ?? "running");
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
    this.store.assertWritable(record);
    if (record.turnId !== turnId) throw new Error("Turn not found");
    const ownerId = ownerIdentity(owner);
    const items = turnInput(input);
    if (record.state !== "running") throw new Error("Steer precondition failed");
    const runtime = this.live.get(record.sessionId);
    if (runtime === undefined) throw new Error("Turn runtime unavailable");
    this.managed(record, owner, "steer");
    this.guard({ ownerId, sessionId: record.sessionId, action: "steer", cwd: record.cwd });
    await runtime.rpc.request("turn/steer", {
      threadId: record.threadId,
      expectedTurnId: turnId,
      input: items,
    });
  }

  async interruptTurn(owner: string | Caller, workerOrTurnId: string, contextualTurnId?: string): Promise<void> {
    const turnId = typeof owner === "string" ? workerOrTurnId : contextualTurnId!;
    const record = typeof owner === "string" ? this.byTurn(owner, turnId) : this.required(owner, workerOrTurnId);
    this.store.assertWritable(record);
    if (record.turnId !== turnId) throw new Error("Turn not found");
    const ownerId = ownerIdentity(owner);
    if (record.state !== "running" && record.state !== "interrupt-requested") throw new Error("Interrupt precondition failed");
    const runtime = this.live.get(record.sessionId);
    if (runtime === undefined) throw new Error("Turn runtime unavailable");
    this.managed(record, owner, "interrupt");
    this.guard({ ownerId, sessionId: record.sessionId, action: "interrupt", cwd: record.cwd });
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
      this.store.assertWritable(pending.record);
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
    this.store.assertWritable(record);
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
    const managed = this.managed(record, owner, "decide-approval");
    if (typeof owner !== "string" && owner.source !== "ui" && !managed) throw new Error("Only UI callers can decide worker approvals");
    const ownerId = ownerIdentity(owner);
    this.guard({ ownerId, sessionId: record.sessionId, action: "decide-approval", cwd: record.cwd });
    runtime.rpc.respond(rpcId, approvalResponse(request, decision));
    runtime.requests.delete(requestId);
    record.approvals = record.approvals.filter(request => request.requestId !== requestId);
    if (record.state === "waiting-approval" && record.approvals.length === 0) record.state = "running";
    this.store.put(record);
  }

  async history(owner: string | Caller, sessionId: string): Promise<Conversation> {
    const record = this.required(owner, sessionId);
    const result = await this.readWithTemporaryServer(rpc => rpc.request<{ thread?: { turns?: unknown[] } }>("thread/read", {
      threadId: record.threadId,
      includeTurns: true,
    }));
    return conversation({ turns: result.thread?.turns ?? [] });
  }

  async readEvents(owner: string | Caller, sessionId: string, afterSequence = 0): Promise<readonly SequencedBackendEvent[]> {
    return structuredClone(this.required(owner, sessionId).events.filter(item => item.sequence > afterSequence));
  }

  async readReports(owner: string | Caller, sessionId: string): Promise<readonly Report[]> {
    return structuredClone(this.required(owner, sessionId).reports);
  }

  async acknowledgeReport(owner: string | Caller, sessionId: string, turnId: string): Promise<Report> {
    const record = this.required(owner, sessionId);
    this.store.assertWritable(record);
    const ownerId = ownerIdentity(owner);
    const report = record.reports.find(item => item.turnId === turnId);
    if (report === undefined) throw new Error("Unknown report");
    this.managed(record, owner, "ack-report");
    this.guard({ ownerId, sessionId, action: "ack-report", cwd: record.cwd });
    if (report.acknowledgedAt === undefined) {
      report.acknowledgedAt = Date.now();
      this.store.put(record);
    }
    return structuredClone(report);
  }

  async acceptReport(owner: string | Caller, sessionId: string, turnId: string, acceptance: ReportAcceptance): Promise<Report> {
    const record = this.required(owner, sessionId);
    this.store.assertWritable(record);
    const ownerId = ownerIdentity(owner);
    const report = record.reports.find(item => item.turnId === turnId);
    if (report === undefined || !["pending", "accepted", "changes-requested"].includes(acceptance)) {
      throw new Error("Unknown report or acceptance");
    }
    if (acceptance === "accepted" && (report.protocolError !== undefined || !report.result.trim())) {
      throw new Error("Cannot accept a report without a deliverable result");
    }
    this.managed(record, owner, "accept-report");
    this.guard({ ownerId, sessionId, action: "accept-report", cwd: record.cwd });
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

  installGuard(guard: (mutation: BackendMutation) => void): () => void {
    this.guards.add(guard);
    return () => { this.guards.delete(guard); };
  }

  async listModels(cwd: string): Promise<readonly unknown[]> {
    return this.readWithTemporaryServer(async rpc => {
      const models: unknown[] = [];
      let cursor: string | null = null;
      do {
        const page: { data?: unknown[]; nextCursor?: string | null } = await rpc.request("model/list", { cursor, limit: 100, cwd });
        models.push(...(page.data ?? []));
        cursor = page.nextCursor ?? null;
      } while (cursor !== null);
      return models;
    });
  }

  async readConfig(cwd: string): Promise<unknown> {
    return this.readWithTemporaryServer(rpc => rpc.request("config/read", { includeLayers: false, cwd }));
  }

  async listSkills(cwd: string): Promise<readonly unknown[]> {
    return this.readWithTemporaryServer(async rpc => {
      const result = await rpc.request<{ data?: unknown[] }>("skills/list", { cwds: [cwd], forceReload: false });
      return result.data ?? [];
    });
  }

  async modelSettings(cwd: string) {
    return this.readWithTemporaryServer(rpc => modelSettings((method, params) => rpc.request(method, params), cwd));
  }

  async skills(cwd: string) {
    return this.readWithTemporaryServer(rpc => listSkills((method, params) => rpc.request(method, params), cwd));
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.live.values()].map(runtime => runtime.rpc.close()));
    this.live.clear();
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
    const runtime: Runtime = { rpc: this.factory(), requests: new Map(), inputs: new Map() };
    this.live.set(record.sessionId, runtime);
    runtime.rpc.on("notification", (message: RpcMessage) => {
      if (!runtime.uncertain && this.live.get(record.sessionId) === runtime && !this.closed) this.notification(record, message);
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
      this.publish(record, { type: "session.uncertain", error: `Execution state unknown: ${String(error)}` });
      if (record.worker !== undefined) this.notifyWorker(record, "uncertain");
    };
    runtime.rpc.on("uncertain", uncertain);
    return runtime;
  }

  private notification(record: StoredSession, message: RpcMessage): void {
    const params = objectValue(message.params);
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
      }
      this.publish(record, { type: "turn.output", turnId: record.turnId, item: params.item });
    } else if (message.method === "thread/tokenUsage/updated") {
      record.usage = params.tokenUsage;
      this.store.put(record);
      this.publish(record, { type: "usage.updated", sessionId: record.sessionId, usage: params.tokenUsage });
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
    const event: BackendEvent = {
      type: "turn.state",
      turn: turnSnapshot(record, terminal),
      ...(operation === undefined ? {} : { operation }),
      ...(output === undefined ? {} : { finalOutput: output }),
      ...(error === undefined ? {} : { error }),
    };
    this.commitEvents(record, [rawEvent, event, reportReady].filter((item): item is BackendEvent => item !== undefined));
    if (reportReady !== undefined) this.notifyWorker(record, "report");
  }

  private finished(record: StoredSession, turnId: string): boolean {
    // ponytail: linear durable-event lookup; add a persisted terminal-turn index only if long-session profiles require it.
    return record.events.some(({ event }) => event.type === "turn.state"
      && event.turn.turnId === turnId
      && terminalState(event.turn.state) !== undefined);
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
    if (record.options?.boundary !== undefined) {
      runtime.rpc.respond(message.id, method === "item/permissions/requestApproval"
        ? { permissions: {}, scope: "turn" }
        : { decision: "decline" });
      return;
    }
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
      || record.options?.boundary !== undefined
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

  private commitEvents(record: StoredSession, events: BackendEvent[]): void {
    const committed = events.map(event => ({ sequence: record.nextEventSequence++, event: structuredClone(event) }));
    record.events.push(...committed);
    this.store.put(record);
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

  private managedCreation(caller: Caller, workerId: string): boolean {
    const permission = this.workflowPermission.getStore();
    if (permission === undefined) return false;
    if (!this.permissionMatches(permission, caller, workerId, "create")) {
      throw new Error("Managed workflow worker: create requires matching codex_workflow permission");
    }
    if (caller.source !== "agent") throw new Error("Managed workflow workers require an Agent caller");
    this.workflow!.provider.authorize(structuredClone(caller), workerId, "create");
    return true;
  }

  private managed(record: StoredSession, owner: string | Caller, action: BackendMutation["action"]): boolean {
    if (record.worker?.managedBy !== "workflow") return false;
    if (typeof owner === "string" || owner.conversationId !== undefined) throw new Error(`Managed workflow worker: ${action} requires codex_workflow`);
    const permission = this.workflowPermission.getStore();
    if (permission === undefined || !this.permissionMatches(permission, owner, record.sessionId, action)) {
      throw new Error(`Managed workflow worker: ${action} requires codex_workflow`);
    }
    this.workflow!.provider.authorize(structuredClone(owner), record.sessionId, action);
    return true;
  }

  private permissionMatches(permission: WorkflowPermission, caller: Caller, workerId: string, action: BackendMutation["action"]): boolean {
    return this.workflow?.identity === permission.registration
      && permission.workerId === workerId
      && permission.action === action
      && sameCaller(permission.caller, caller);
  }

  private guard(mutation: BackendMutation): void {
    for (const guard of this.guards) guard(mutation);
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
  const { sessionId, threadId, turnId, cwd, model, reasoningEffort, usage, state, options, reports } = record;
  return { sessionId, threadId, turnId, cwd, model, reasoningEffort, usage, state, options: structuredClone(options), reports: structuredClone(reports) };
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

function normalizedBoundary(boundary: CreateSessionOptions["boundary"], cwd: string) {
  if (boundary === undefined) return undefined;
  if (boundary.cwd !== cwd || !boundary.writableRoots.every(isAbsolute)) {
    throw new Error("Boundary cwd and writable roots must be absolute and match the Session");
  }
  return {
    cwd,
    writableRoots: [...new Set(boundary.writableRoots.map(path => resolve(path)))],
    network: boundary.network,
  } as const;
}

function threadParams(record: StoredSession): Record<string, unknown> {
  const options = record.options ?? {};
  const boundary = options.boundary;
  return {
    cwd: record.cwd,
    model: record.model,
    ...(options.developerInstructions === undefined ? {} : { developerInstructions: options.developerInstructions }),
    ...(options.approvalPolicy === undefined ? {} : { approvalPolicy: options.approvalPolicy }),
    ...(options.approvalsReviewer === undefined ? {} : { approvalsReviewer: options.approvalsReviewer }),
    ...(boundary === undefined && options.sandbox !== undefined ? { sandbox: options.sandbox } : {}),
    config: {
      ...(record.reasoningEffort === undefined ? {} : { model_reasoning_effort: record.reasoningEffort }),
      ...(boundary === undefined ? {} : {
        "features.multi_agent": false,
        "features.apps": false,
        "features.plugins": false,
        "features.browser_use": false,
        "features.computer_use": false,
        default_permissions: "dsh-task",
        permissions: {
          "dsh-task": {
            filesystem: {
              ":root": "read",
              ...Object.fromEntries(boundary.writableRoots.map(path => [path, "write"])),
            },
            network: {
              enabled: boundary.network === "loopback",
              ...(boundary.network === "loopback"
                ? { allow_local_binding: true, domains: { "127.0.0.1": "allow", localhost: "allow" } }
                : {}),
            },
          },
        },
        ...(boundary.network === "loopback" ? { "features.network_proxy": true } : {}),
      }),
    },
    ...(boundary === undefined ? {} : { approvalPolicy: "never" }),
    ephemeral: false,
  };
}

function checkBoundary(record: StoredSession, result: ThreadResult): void {
  const boundary = record.options?.boundary;
  if (boundary === undefined) return;
  const expected = [...new Set(boundary.writableRoots)].sort();
  // Codex reports additional writable roots; an explicitly writable cwd may be omitted.
  const actual = [...new Set([
    ...(result.sandbox?.writableRoots ?? []),
    ...(result.cwd === boundary.cwd && expected.includes(result.cwd) ? [result.cwd] : []),
  ])].sort();
  if (
    result.cwd !== undefined && result.cwd !== boundary.cwd
    || result.sandbox?.type !== "workspaceWrite"
    || JSON.stringify(actual) !== JSON.stringify(expected)
    || result.sandbox.excludeSlashTmp !== true
    || result.sandbox.excludeTmpdirEnvVar !== true
    || result.sandbox.networkAccess !== (boundary.network === "loopback")
    || result.approvalPolicy !== "never"
  ) throw new Error(`App Server did not apply the requested execution boundary: ${JSON.stringify({ sandbox: result.sandbox, approvalPolicy: result.approvalPolicy })}`);
}

function checkExecutionModel(record: StoredSession, result: ThreadResult): void {
  if (record.worker?.role === undefined && record.options?.developerInstructions === undefined && record.options?.boundary === undefined) return;
  if (record.model !== undefined && result.model !== record.model
    || record.reasoningEffort !== undefined && result.reasoningEffort !== record.reasoningEffort) {
    throw new Error("App Server did not apply the requested execution model/effort (Workflow role profile when present)");
  }
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
  if (caller?.conversationId !== undefined) {
    if (typeof caller.conversationId !== "string" || !caller.conversationId || caller.source !== "ui" || caller.nativeSessionId !== undefined || caller.parentAgent !== undefined) throw new Error("Invalid contextual caller");
    return;
  }
  if (typeof caller?.nativeSessionId !== "string" || ownerIdentity(caller).length === 0 || !["ui", "agent"].includes(caller.source)
    || caller.parentAgent !== undefined && !validAgentContext(caller)) {
    throw new Error("Invalid contextual caller");
  }
}

function validAgentContext(caller: Caller): boolean {
  const parent = caller.parentAgent as unknown;
  return caller.conversationId === undefined && typeof parent === "object" && parent !== null
    && typeof (parent as { id?: unknown }).id === "string"
    && (parent as { id: string }).id.length > 0
    && (parent as { nativeSessionId?: unknown }).nativeSessionId === ownerIdentity(caller);
}

function sameCaller(left: Caller, right: Caller): boolean {
  return left.nativeSessionId === right.nativeSessionId
    && left.source === right.source
    && left.parentAgent?.id === right.parentAgent?.id
    && left.parentAgent?.nativeSessionId === right.parentAgent?.nativeSessionId;
}

function validateWorkflowRole(role: WorkflowRole): void {
  if (typeof role?.name !== "string" || role.name.length === 0
    || typeof role.developerInstructions !== "string" || role.developerInstructions.length === 0
    || typeof role.model !== "string" || role.model.length === 0
    || typeof role.reasoningEffort !== "string" || role.reasoningEffort.length === 0) {
    throw new Error("Invalid Workflow role provider result");
  }
}

function agentCaller(caller: Caller): void {
  validateCaller(caller);
  if (caller.source !== "agent" || !validAgentContext(caller)) throw new Error("Invalid contextual caller");
}

function agentUiCaller(caller: Caller): void {
  validateCaller(caller);
  if (caller.source !== "ui" || !validAgentContext(caller)) throw new Error("Invalid contextual caller");
}

function agentContextCaller(caller: Caller): void {
  validateCaller(caller);
  if (!validAgentContext(caller)) throw new Error("Invalid contextual caller");
}

function privateCaller(caller: Caller): void {
  validateCaller(caller);
  if (caller.source !== "ui") throw new Error("Invalid contextual caller");
}

function canAccess(caller: Caller, record: StoredSession): boolean {
  const worker = record.worker;
  if (worker === undefined || worker.detached || worker.parentSessionId !== ownerIdentity(caller)) return false;
  if (worker.main || caller.conversationId !== undefined) return worker.main === true && caller.conversationId !== undefined && record.sessionId === `main:${caller.conversationId}`;
  if (worker.owner === "user") return caller.source === "ui";
  return validAgentContext(caller);
}

function ownerIdentity(owner: string | Caller): string {
  return typeof owner === "string" ? owner : owner.conversationId === undefined ? owner.nativeSessionId : `codex:${owner.conversationId}`;
}

function availableDirectory(path: unknown): path is string {
  if (typeof path !== "string" || !isAbsolute(path)) return false;
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function workerProjection(record: StoredSession): WorkerProjection {
  const worker = record.worker!;
  const active = ["starting", "running", "interrupt-requested", "unknown"].includes(record.state)
    || record.approvals.length > 0
    || record.reports.some(report => report.acceptance === "pending" && report.acknowledgedAt === undefined);
  return structuredClone({
    id: record.sessionId,
    ...(worker.main ? { main: worker.main, conversationId: record.sessionId.slice(5), updatedAt: record.updatedAt } : {}),
    parentSessionId: worker.parentSessionId,
    owner: worker.owner,
    managedBy: worker.managedBy,
    role: worker.role,
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
    group: worker.owner === "user" ? "user" : active ? "active" : "inactive",
  });
}

function hasActiveCommand(record: StoredSession): boolean {
  const statuses = new Map<string, string>();
  for (const { event } of record.events) {
    if (event.type !== "thread.notification" || !["item/started", "item/completed"].includes(event.method)) continue;
    const item = objectValue(objectValue(event.params).item);
    if (item.type !== "commandExecution" || typeof item.id !== "string") continue;
    statuses.set(item.id, typeof item.status === "string" ? item.status : event.method === "item/started" ? "inProgress" : "completed");
  }
  return [...statuses.values()].some(status => status === "inProgress");
}
