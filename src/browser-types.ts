export type SessionId = string;
export type ThreadId = string;
export type TurnId = string;
export type Effort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export type RunState =
  | "starting"
  | "idle"
  | "running"
  | "interrupt-requested"
  | "waiting-approval"
  | "completed"
  | "failed"
  | "interrupted"
  | "unknown"
  | "saved";

export type WorkerState = RunState;
export type WorkerOwner = "user" | "agent";

export interface Caller {
  nativeSessionId: string;
  source: "ui" | "agent";
  parentAgent?: { id: string; nativeSessionId: string };
}

export interface SessionSnapshot {
  sessionId: SessionId;
  threadId?: ThreadId;
  turnId?: TurnId;
  /**
   * The DSH Session's host workspace. This identifies the Session, never the
   * native thread's working directory when the Session declares a task
   * boundary: a lane worker's host workspace is the parent repository while its
   * Codex thread runs in the lane.
   */
  cwd: string;
  /** The Codex execution cwd the native thread runs in; equals `cwd` when no task boundary is declared. */
  executionCwd?: string;
  /** Last natively confirmed model/effort; the creation snapshot stays in `options`. */
  model?: string;
  reasoningEffort?: string;
  /** Authorized target configuration a running turn has not confirmed yet. */
  pending?: PendingConfig;
  /**
   * The native configuration the App Server reported it applied. Written only
   * from native facts, so a declared task constraint is verified against what
   * actually ran rather than against what the plugin asked for.
   */
  applied?: AppliedExecution;
  usage?: unknown;
  state: RunState;
  options?: CreateSessionOptions;
  reports: readonly Report[];
}

/** Native settings the App Server reported for one thread. */
export interface AppliedExecution {
  cwd?: string;
  approvalPolicy?: string;
  sandbox?: {
    type?: string;
    writableRoots?: readonly string[];
    excludeSlashTmp?: boolean;
    excludeTmpdirEnvVar?: boolean;
    networkAccess?: boolean;
  };
}

/**
 * A model/effort target requested for a turn but not yet confirmed by the App
 * Server. `model`/`reasoningEffort` keep the last confirmed values while this
 * is set, so an unknown outcome never rewrites the configuration a Session was
 * actually running.
 */
export interface PendingConfig {
  model?: string;
  reasoningEffort?: string;
}

export interface TurnOptions {
  model?: string;
  reasoningEffort?: string;
}

export type ApprovalPolicy = "untrusted" | "on-failure" | "on-request" | "never";
export type ApprovalsReviewer = "user" | "auto_review" | "guardian_subagent";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface ExecutionBoundary {
  cwd: string;
  writableRoots: readonly string[];
  network: "disabled" | "loopback";
}

export interface CreateSessionOptions extends TurnOptions {
  developerInstructions?: string;
  approvalPolicy?: ApprovalPolicy;
  approvalsReviewer?: ApprovalsReviewer;
  sandbox?: SandboxMode;
  boundary?: ExecutionBoundary;
}

/**
 * One controlled native-thread handover requested by the trusted Host.
 *
 * The source record keeps its history but loses the right to operate the
 * thread; the successor record owns it and continues on the target
 * configuration. The provider never creates a replacement thread when the
 * binding fails.
 */
export interface ThreadHandoffRequest {
  /** Host request identity; a repeated request reuses its recorded handover. */
  requestId: string;
  /** Native Session handing the thread over. */
  fromSessionId: string;
  /** Reserved successor native Session that continues it. */
  toSessionId: string;
  /** Target model and effort the successor runs on. */
  model: string;
  reasoningEffort?: string;
  /** Full execution inputs the successor's first request will carry. */
  developerInstructions?: string;
  boundary?: ExecutionBoundary;
  approvalPolicy?: ApprovalPolicy;
  approvalsReviewer?: ApprovalsReviewer;
  sandbox?: SandboxMode;
}

/** The recorded outcome of one thread handover. */
export interface ThreadHandoffResult {
  toSessionId: string;
  threadId: string;
  state: RunState;
}

/** Read-only view of one native Session's thread ownership. */
export interface ThreadOwnership {
  sessionId: string;
  threadId?: string;
  /** Successor that now owns the thread, when this record handed it over. */
  handedOffTo?: string;
  /** Source that handed the thread over, when this record continues one. */
  handoffFrom?: string;
}

export interface CreateWorkerInput extends CreateSessionOptions {
  id?: SessionId;
  name: string;
  cwd: string;
}

export interface StartTurnOptions extends TurnOptions {
  idempotencyKey?: string;
}

export type TurnInput =
  | { type: "text"; text: string }
  | { type: "image"; url: string }
  | { type: "localImage"; path: string }
  | { type: "skill"; name: string; path: string };

export interface ThreadSummary {
  id: ThreadId;
  cwd: string;
  name?: string | null;
  preview?: string;
  updatedAt?: number;
  status?: { type?: string };
}

export interface ThreadPage {
  data: readonly ThreadSummary[];
  nextCursor: string | null;
}

/** A Codex-native skill offered by the composer's `$` catalogue. */
export interface Skill { name: string; path: string; description: string }

export interface ConversationItem {
  /** Public reasoning summary parts; raw reasoning content is never projected. */
  summary?: string[];
  id: string;
  turnId: string;
  role: "user" | "assistant" | "tool";
  text: string;
  kind?: string;
  phase?: string;
  status?: string;
  title?: string;
  output?: string;
  cwd?: string;
  exitCode?: number;
  durationMs?: number;
  arguments?: unknown;
  images?: string[];
  files?: { name: string; path: string }[];
  changes?: { path: string; kind?: string; diff: string }[];
}

export interface ConversationTurn { id: string; status?: string; startedAt?: number; completedAt?: number; durationMs?: number; error?: string }
export interface Conversation { turns?: ConversationTurn[]; items: ConversationItem[]; source: "thread" | "reports" }
export type ConversationStreamEvent = { type: "item"; item: ConversationItem } | { type: "turn"; turn: ConversationTurn };

/** Input modality DSH can route to a Codex model; Codex `audio` is not representable. */
export type InputModality = "text" | "image";

export interface ModelOption {
  model: string;
  displayName: string;
  supportedReasoningEfforts: { reasoningEffort: Effort; description: string }[];
  defaultReasoningEffort: Effort;
  inputModalities?: readonly InputModality[];
}
export interface ModelSettings { models: ModelOption[]; model: string | null; effort: Effort | null; contextWindow?: number }

export interface TurnSnapshot {
  sessionId: SessionId;
  threadId: ThreadId;
  turnId: TurnId;
  state: RunState;
}

export interface UsageValues {
  totalTokens: number | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
}

export interface Usage {
  total: UsageValues;
  last: UsageValues;
  modelContextWindow: number | null;
  currentContextTokens: number | null;
  remainingContextRatio: number | null;
}

export type ReportAcceptance = "pending" | "accepted" | "changes-requested";

export interface Report {
  workerId: SessionId;
  threadId: ThreadId;
  turnId: TurnId;
  status: "completed" | "failed" | "interrupted";
  result: string;
  protocolError?: string;
  error?: string;
  usage: Usage | null;
  turnUsage?: UsageValues;
  createdAt: number;
  acceptance: ReportAcceptance;
  acknowledgedAt?: number;
}

export interface WorkerProjection {
  id: SessionId;
  updatedAt?: number;
  parentSessionId: string;
  owner: WorkerOwner;
  name: string;
  detached: boolean;
  cwd: string;
  model?: string;
  effort?: string;
  threadId?: ThreadId;
  turnId?: TurnId;
  state: WorkerState;
  savedState?: WorkerState;
  reports: readonly Report[];
  approvals: readonly ApprovalRequest[];
  usage?: unknown;
  group: "user" | "active" | "inactive";
}

export interface ApprovalRequest {
  sessionId: SessionId;
  threadId: ThreadId;
  turnId: TurnId;
  requestId: string;
  method: string;
  params: unknown;
}

export type ApprovalDecision = "accept" | "decline" | "cancel";

export interface UserInputQuestionOption {
  label: string;
  description: string;
}

export interface UserInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options?: readonly UserInputQuestionOption[];
}

export interface UserInputRequest {
  sessionId: SessionId;
  threadId: ThreadId;
  turnId: TurnId;
  requestId: string;
  questions: readonly UserInputQuestion[];
  isBlocking: boolean;
}

/** Codex `tool/requestUserInput` answers keyed by question id; `null` means no answer was collected. */
export type UserInputAnswer = Readonly<Record<string, { answers: readonly string[] }>> | null;

export type BackendEvent =
  | { type: "session.uncertain"; error: string }
  | { type: "turn.started"; turn: TurnSnapshot }
  | { type: "turn.output"; turnId: TurnId; item: unknown }
  | { type: "turn.state"; turn: TurnSnapshot; operation?: "turn" | "compact"; finalOutput?: string; error?: string }
  | { type: "approval.requested"; request: ApprovalRequest }
  | { type: "userInput.requested"; request: UserInputRequest }
  | { type: "usage.updated"; sessionId: SessionId; usage: unknown }
  | { type: "report.ready"; workerId: SessionId; turnId: TurnId; parentSessionId: string }
  | { type: "thread.notification"; method: string; params: unknown };

/** One projected execution fact line plus the durable identity a reader resolves it by. */
export interface ExecutionFactLine {
  /** Sourced line, already marked as an executed fact rather than an instruction. */
  text: string;
  threadId: string;
  turnId: string;
  itemId: string;
}

export interface SequencedBackendEvent {
  sequence: number;
  event: BackendEvent;
}

export interface WorkerManagementEvent {
  type: "worker.changed";
  parentSessionId: string;
  workerId: SessionId;
  change: "created" | "binding" | "closed" | "report" | "uncertain";
  invalidated?: true;
}

export type BackendMutationAction =
  | "create"
  | "resume"
  | "configure"
  | "close"
  | "start"
  | "compact"
  | "steer"
  | "interrupt"
  | "decide-approval"
  | "ack-report"
  | "accept-report"
  | "link"
  | "detach";

export interface BackendMutation {
  ownerId: string;
  action: BackendMutationAction;
  sessionId?: SessionId;
  cwd?: string;
  boundary?: ExecutionBoundary;
}

/**
 * `interactive: true` marks a subscriber that can answer server-initiated
 * user-input requests (`item/tool/requestUserInput`); without one the backend
 * answers empty instead of leaving the native turn blocked.
 */
export interface SubscribeOptions {
  interactive?: boolean;
}

export interface CodexBackend {
  createSession(ownerId: string, sessionId: SessionId, cwd: string, options?: CreateSessionOptions): Promise<SessionSnapshot>;
  createWorker(caller: Caller, input: CreateWorkerInput): Promise<WorkerProjection>;
  listWorkers(caller: Caller): Promise<readonly WorkerProjection[]>;
  getWorker(caller: Caller, workerId: SessionId): Promise<WorkerProjection>;
  linkWorker(caller: Caller, workerId: SessionId): Promise<WorkerProjection>;
  detachWorker(caller: Caller, workerId: SessionId): Promise<void>;
  pendingReports(caller: Caller): Promise<readonly Report[]>;
  listSessions(ownerId: string): Promise<readonly SessionSnapshot[]>;
  readSession(owner: string | Caller, sessionId: SessionId): Promise<SessionSnapshot | undefined>;
  resumeSession(owner: string | Caller, sessionId: SessionId): Promise<SessionSnapshot>;
  restartSession(owner: string | Caller, sessionId: SessionId, options?: TurnOptions): Promise<SessionSnapshot>;
  configureSession(owner: string | Caller, sessionId: SessionId, options: TurnOptions): Promise<SessionSnapshot>;
  closeSession(owner: string | Caller, sessionId: SessionId, confirmedStopped?: boolean): Promise<void>;
  searchThreads(ownerId: string, search?: string, cursor?: string): Promise<ThreadPage>;
  importSession(ownerId: string, sessionId: SessionId, threadId: ThreadId): Promise<SessionSnapshot>;
  occupiedThreads(): Promise<readonly ThreadId[]>;
  /** Read-only thread ownership for trusted-Host reconciliation. */
  threadOwnership(ownerId: string, sessionId: SessionId): Promise<ThreadOwnership | undefined>;
  /** Transfer one stopped record's thread to a reserved successor. */
  handoffThread(ownerId: string, request: ThreadHandoffRequest): Promise<ThreadHandoffResult>;
  startTurn(owner: string | Caller, sessionId: SessionId, input: string | readonly TurnInput[], options?: StartTurnOptions): Promise<TurnSnapshot>;
  steerTurn(ownerId: string, turnId: TurnId, input: string | readonly TurnInput[]): Promise<void>;
  steerTurn(caller: Caller, workerId: SessionId, turnId: TurnId, input: string | readonly TurnInput[]): Promise<void>;
  compactSession(owner: string | Caller, sessionId: SessionId): Promise<void>;
  interruptTurn(ownerId: string, turnId: TurnId): Promise<void>;
  interruptTurn(caller: Caller, workerId: SessionId, turnId: TurnId): Promise<void>;
  pendingApprovals(owner: string | Caller, sessionId: SessionId): Promise<readonly ApprovalRequest[]>;
  decideApproval(ownerId: string, requestId: string, decision: ApprovalDecision): Promise<void>;
  decideApproval(caller: Caller, workerId: SessionId, requestId: string, decision: ApprovalDecision): Promise<void>;
  pendingUserInputs(owner: string | Caller, sessionId: SessionId): Promise<readonly UserInputRequest[]>;
  answerUserInput(ownerId: string, requestId: string, answers: UserInputAnswer): Promise<void>;
  history(owner: string | Caller, sessionId: SessionId): Promise<Conversation>;
  readFacts(owner: string | Caller, sessionId: SessionId): Promise<readonly ExecutionFactLine[]>;
  readReports(owner: string | Caller, sessionId: SessionId): Promise<readonly Report[]>;
  acknowledgeReport(owner: string | Caller, sessionId: SessionId, turnId: TurnId): Promise<Report>;
  acceptReport(owner: string | Caller, sessionId: SessionId, turnId: TurnId, acceptance: ReportAcceptance): Promise<Report>;
  subscribe(owner: string | Caller, sessionId: SessionId, listener: (event: BackendEvent, sequence: number) => void, options?: SubscribeOptions): () => void;
  subscribeWorkers(caller: Caller, listener: (event: WorkerManagementEvent) => void): () => void;
  installGuard(guard: (mutation: BackendMutation) => void): () => void;
  listModels(cwd: string): Promise<readonly unknown[]>;
  readConfig(cwd: string): Promise<unknown>;
  listSkills(cwd: string): Promise<readonly unknown[]>;
  modelSettings(cwd: string): Promise<ModelSettings>;
  skills(cwd: string): Promise<readonly Skill[]>;
}
