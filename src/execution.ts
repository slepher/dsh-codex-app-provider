/** Read-only native execution facts for Host consumers; no delegation or profile policy. */
export interface NativeExecution {
  nativeSessionId: string;
  threadId?: string;
  turnId?: string;
  /**
   * The directory this thread actually runs in. A Session that declares a task
   * boundary (a lane) runs there, so a consumer reconciles this value against
   * the assignment's own workspace rather than against the host workspace that
   * owns the DSH Session.
   */
  cwd: string;
  /** Last natively confirmed model/effort; the creation snapshot is not projected. */
  model?: string;
  reasoningEffort?: string;
  /** Authorized target configuration a running turn has not confirmed yet. */
  pending?: { model?: string; reasoningEffort?: string };
  state: "starting" | "idle" | "running" | "interrupt-requested" | "waiting-approval" | "completed" | "failed" | "interrupted" | "unknown" | "saved";
  reports: readonly NativeExecutionReport[];
}

export interface NativeExecutionReport {
  threadId: string;
  turnId: string;
  status: "completed" | "failed" | "interrupted";
  result: string;
  error?: string;
  protocolError?: string;
  /** Token usage that native accounting attributed to this turn, when reported. */
  usage?: NativeExecutionUsage;
  createdAt: number;
}

/**
 * One turn's token accounting as the native protocol reports it. A value is
 * `null` when the App Server did not report that field, which a consumer must
 * keep distinct from a reported zero.
 */
export interface NativeExecutionUsage {
  totalTokens: number | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
}

/**
 * One model this route's own catalog advertises, in the shape the workflow
 * settings page renders. Host consumers read it to keep offering the route when
 * the main-Session model menu hides it (`allowMainSession: false`).
 */
export interface NativeCatalogModel {
  id: string;
  name: string;
  efforts: readonly { id: string; name: string }[];
  defaultEffort?: string;
}

/** One provider group this route advertises for Host consumers. */
export interface NativeCatalogGroup {
  provider: string;
  name: string;
  models: readonly NativeCatalogModel[];
}

export interface NativeExecutionReader {
  /** Trusted Host access by exact native Session id; performs no resume or model request. */
  read(nativeSessionId: string): Promise<NativeExecution | undefined>;
  /**
   * Sourced, already-executed history lines from the recorded native transcript,
   * for continuing an assignment under another provider adapter. Absent when
   * this build cannot project them; performs no resume or model request.
   */
  facts?(nativeSessionId: string): Promise<readonly string[]>;
  /**
   * This route's own model catalog, independent of whether the main-Session
   * menu offers it. Absent when this build cannot project it; performs no
   * resume and no model request.
   */
  catalog?(): Promise<NativeCatalogGroup | undefined>;
}

declare module "@deepseek-ai/cordis" {
  interface Context { codexExecution: NativeExecutionReader }
}
