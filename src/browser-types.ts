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
  conversationId?: never;
  nativeSessionId: string;
  source: "ui" | "agent";
  parentAgent?: { id: string; nativeSessionId: string };
}

/** Authenticated access to a standalone Codex main; never an Agent identity. */
export interface MainCaller {
  source: "ui";
  conversationId: string;
  nativeSessionId?: never;
  parentAgent?: never;
}
export type AccessCaller = Caller | MainCaller;

export interface SessionSnapshot {
  sessionId: SessionId;
  threadId?: ThreadId;
  turnId?: TurnId;
  cwd: string;
  /** Last natively confirmed model/effort; the creation snapshot stays in `options`. */
  model?: string;
  reasoningEffort?: string;
  /** Authorized target configuration a running turn has not confirmed yet. */
  pending?: PendingConfig;
  usage?: unknown;
  state: RunState;
  options?: CreateSessionOptions;
  reports: readonly Report[];
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
  role?: string;
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
  main?: true;
  conversationId?: string;
  updatedAt?: number;
  parentSessionId: string;
  owner: WorkerOwner;
  managedBy?: "workflow";
  role?: string;
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
  | { type: "turn.state"; turn: TurnSnapshot; operation?: "turn" | "review" | "compact"; finalOutput?: string; error?: string }
  | { type: "approval.requested"; request: ApprovalRequest }
  | { type: "userInput.requested"; request: UserInputRequest }
  | { type: "usage.updated"; sessionId: SessionId; usage: unknown }
  | { type: "report.ready"; workerId: SessionId; turnId: TurnId; parentSessionId: string }
  | { type: "thread.notification"; method: string; params: unknown };

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
  | "review"
  | "steer"
  | "interrupt"
  | "decide-approval"
  | "ack-report"
  | "accept-report"
  | "link"
  | "detach"
  | "adopt";

export interface WorkflowRole {
  name: string;
  developerInstructions: string;
  model?: string;
  reasoningEffort?: string;
}

export interface WorkflowProvider {
  listRoles(): readonly WorkflowRole[];
  resolveRole(name: string): WorkflowRole;
  authorize(caller: Caller, workerId: SessionId, action: BackendMutationAction): void;
}

export interface WorkflowRegistration {
  listRoles(): readonly WorkflowRole[];
  resolveRole(name: string): WorkflowRole;
  run<T>(caller: Caller, workerId: SessionId, action: BackendMutationAction, operation: () => T | Promise<T>): Promise<T>;
  dispose(): void;
}

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
  registerWorkflow(provider: WorkflowProvider): WorkflowRegistration;
  workflowRoles(): readonly WorkflowRole[];
  resolveWorkflowRole(name: string): WorkflowRole;
  createSession(ownerId: string, sessionId: SessionId, cwd: string, options?: CreateSessionOptions): Promise<SessionSnapshot>;
  createWorker(caller: AccessCaller, input: CreateWorkerInput): Promise<WorkerProjection>;
  createMainWorker(caller: MainCaller, input: Omit<CreateWorkerInput, "id" | "role">): Promise<WorkerProjection>;
  getMainWorker(caller: MainCaller): Promise<WorkerProjection | undefined>;
  listMainConversations(cwd: string): Promise<readonly WorkerProjection[]>;
  listWorkers(caller: AccessCaller): Promise<readonly WorkerProjection[]>;
  getWorker(caller: AccessCaller, workerId: SessionId): Promise<WorkerProjection>;
  linkWorker(caller: AccessCaller, workerId: SessionId): Promise<WorkerProjection>;
  detachWorker(caller: AccessCaller, workerId: SessionId): Promise<void>;
  adoptWorker(caller: AccessCaller, threadId: ThreadId): Promise<WorkerProjection>;
  pendingReports(caller: AccessCaller): Promise<readonly Report[]>;
  listSessions(ownerId: string): Promise<readonly SessionSnapshot[]>;
  readSession(owner: string | AccessCaller, sessionId: SessionId): Promise<SessionSnapshot | undefined>;
  resumeSession(owner: string | AccessCaller, sessionId: SessionId, confirmedStopped?: boolean): Promise<SessionSnapshot>;
  restartSession(owner: string | AccessCaller, sessionId: SessionId, options?: TurnOptions): Promise<SessionSnapshot>;
  configureSession(owner: string | AccessCaller, sessionId: SessionId, options: TurnOptions): Promise<SessionSnapshot>;
  closeSession(owner: string | AccessCaller, sessionId: SessionId, confirmedStopped?: boolean): Promise<void>;
  searchThreads(ownerId: string, search?: string, cursor?: string): Promise<ThreadPage>;
  importSession(ownerId: string, sessionId: SessionId, threadId: ThreadId): Promise<SessionSnapshot>;
  occupiedThreads(): Promise<readonly ThreadId[]>;
  startTurn(owner: string | AccessCaller, sessionId: SessionId, input: string | readonly TurnInput[], options?: StartTurnOptions): Promise<TurnSnapshot>;
  steerTurn(ownerId: string, turnId: TurnId, input: string | readonly TurnInput[]): Promise<void>;
  steerTurn(caller: AccessCaller, workerId: SessionId, turnId: TurnId, input: string | readonly TurnInput[]): Promise<void>;
  compactSession(owner: string | AccessCaller, sessionId: SessionId): Promise<void>;
  reviewSession(owner: string | AccessCaller, sessionId: SessionId): Promise<TurnSnapshot>;
  interruptTurn(ownerId: string, turnId: TurnId): Promise<void>;
  interruptTurn(caller: AccessCaller, workerId: SessionId, turnId: TurnId): Promise<void>;
  pendingApprovals(owner: string | AccessCaller, sessionId: SessionId): Promise<readonly ApprovalRequest[]>;
  decideApproval(ownerId: string, requestId: string, decision: ApprovalDecision): Promise<void>;
  decideApproval(caller: AccessCaller, workerId: SessionId, requestId: string, decision: ApprovalDecision): Promise<void>;
  pendingUserInputs(owner: string | AccessCaller, sessionId: SessionId): Promise<readonly UserInputRequest[]>;
  answerUserInput(ownerId: string, requestId: string, answers: UserInputAnswer): Promise<void>;
  history(owner: string | AccessCaller, sessionId: SessionId): Promise<Conversation>;
  readEvents(owner: string | AccessCaller, sessionId: SessionId, afterSequence?: number): Promise<readonly SequencedBackendEvent[]>;
  readReports(owner: string | AccessCaller, sessionId: SessionId): Promise<readonly Report[]>;
  acknowledgeReport(owner: string | AccessCaller, sessionId: SessionId, turnId: TurnId): Promise<Report>;
  acceptReport(owner: string | AccessCaller, sessionId: SessionId, turnId: TurnId, acceptance: ReportAcceptance): Promise<Report>;
  subscribe(owner: string | AccessCaller, sessionId: SessionId, listener: (event: BackendEvent, sequence: number) => void, options?: SubscribeOptions): () => void;
  subscribeWorkers(caller: AccessCaller, listener: (event: WorkerManagementEvent) => void): () => void;
  installGuard(guard: (mutation: BackendMutation) => void): () => void;
  listModels(cwd: string): Promise<readonly unknown[]>;
  readConfig(cwd: string): Promise<unknown>;
  listSkills(cwd: string): Promise<readonly unknown[]>;
  modelSettings(cwd: string): Promise<ModelSettings>;
  skills(cwd: string): Promise<readonly Skill[]>;
}
