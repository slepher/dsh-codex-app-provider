/** Read-only native execution facts for Host consumers; no worker management or profile policy. */
export interface NativeExecution {
  nativeSessionId: string;
  threadId?: string;
  turnId?: string;
  cwd: string;
  model?: string;
  reasoningEffort?: string;
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
  createdAt: number;
}

export interface NativeExecutionReader {
  /** Trusted Host access by exact native Session id; performs no resume or model request. */
  read(nativeSessionId: string): Promise<NativeExecution | undefined>;
}

declare module "@deepseek-ai/cordis" {
  interface Context { codexExecution: NativeExecutionReader }
}
