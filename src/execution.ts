/** Read-only native execution facts for Host consumers; no worker management or profile policy. */
export interface NativeExecution {
  nativeSessionId: string;
  threadId?: string;
  turnId?: string;
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

export interface NativeExecutionReader {
  /** Trusted Host access by exact native Session id; performs no resume or model request. */
  read(nativeSessionId: string): Promise<NativeExecution | undefined>;
  /**
   * Sourced, already-executed history lines from the recorded native transcript,
   * for continuing an assignment under another provider adapter. Absent when
   * this build cannot project them; performs no resume or model request.
   */
  facts?(nativeSessionId: string): Promise<readonly string[]>;
}

declare module "@deepseek-ai/cordis" {
  interface Context { codexExecution: NativeExecutionReader }
}
