import type { Conversation, ConversationItem } from "./browser-types.js";

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function object(value: unknown): Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, any> : {};
}

/** Projects only public Codex items; raw reasoning content and unknown internal items stay private. */
export function conversation(threadValue: unknown): Conversation {
  const thread = object(threadValue);
  const turns = Array.isArray(thread.turns) ? thread.turns.map(value => {
    const turn = object(value);
    return {
      id: String(turn.id ?? ""),
      status: typeof turn.status === "string" ? turn.status : undefined,
      startedAt: nonNegativeNumber(turn.startedAt),
      completedAt: nonNegativeNumber(turn.completedAt),
      durationMs: nonNegativeNumber(turn.durationMs),
      error: typeof object(turn.error).message === "string" ? object(turn.error).message : undefined,
    };
  }) : [];
  const items = (Array.isArray(thread.turns) ? thread.turns : []).flatMap(turnValue => {
    const turn = object(turnValue);
    return (Array.isArray(turn.items) ? turn.items : []).flatMap(itemValue => projectItem(String(turn.id ?? ""), itemValue));
  });
  return { source: "thread", turns, items };
}

function projectItem(turnId: string, itemValue: unknown): ConversationItem[] {
  const item = object(itemValue);
  const id = typeof item.id === "string" ? item.id : "";
  const kind = typeof item.type === "string" ? item.type : undefined;
  const base = {
    id, turnId, kind,
    status: typeof item.status === "string" ? item.status : undefined,
    phase: typeof item.phase === "string" ? item.phase : undefined,
    durationMs: nonNegativeNumber(item.durationMs),
  };
  if (kind === "userMessage") {
    const content = Array.isArray(item.content) ? item.content.map(object) : [];
    return [{ ...base, role: "user", text: content.map(value => typeof value.text === "string" ? value.text : "").filter(Boolean).join("\n"),
      images: content.filter(value => value.type === "image" && typeof value.url === "string" || value.type === "localImage" && typeof value.path === "string").map(value => value.url ?? value.path),
      files: content.filter(value => value.type === "mention" && typeof value.path === "string" && value.path.startsWith("/")).map(value => ({ name: String(value.name ?? ""), path: value.path })),
    }];
  }
  if (kind === "agentMessage" || kind === "plan") return [{ ...base, role: "assistant", phase: kind === "plan" ? "commentary" : base.phase, text: typeof item.text === "string" ? item.text : "" }];
  if (kind === "reasoning") {
    const summary = Array.isArray(item.summary) ? item.summary.filter((value): value is string => typeof value === "string") : [];
    return Array.isArray(item.summary) ? [{ ...base, role: "assistant", summary, text: summary.join("\n\n") }] : [];
  }
  if (kind === "commandExecution") return [{ ...base, role: "tool", text: [item.command, item.aggregatedOutput].filter(Boolean).join("\n"), title: item.command, output: item.aggregatedOutput ?? "", cwd: item.cwd, exitCode: typeof item.exitCode === "number" ? item.exitCode : undefined }];
  if (kind === "fileChange") return [{ ...base, role: "tool", text: JSON.stringify(item.changes), title: "文件修改", changes: (Array.isArray(item.changes) ? item.changes : []).map(value => { const change = object(value); return { path: String(change.path ?? ""), diff: typeof change.diff === "string" ? change.diff : "", kind: typeof change.kind === "string" ? change.kind : typeof object(change.kind).type === "string" ? object(change.kind).type : undefined }; }) }];
  if (kind === "mcpToolCall" || kind === "dynamicToolCall") { const result = item.result ?? item.contentItems ?? item.error ?? ""; return [{ ...base, role: "tool", title: [item.server ?? item.namespace, item.tool].filter(Boolean).join(" / "), text: JSON.stringify(result), output: JSON.stringify(result, null, 2), arguments: item.arguments }]; }
  if (kind === "functionCallOutput") { const output = typeof item.output === "string" ? item.output : JSON.stringify(item.output); return [{ ...base, role: "tool", title: item.name, text: output, output: typeof item.output === "string" ? item.output : JSON.stringify(item.output, null, 2) }]; }
  if (kind === "webSearch") return [{ ...base, role: "tool", title: "网页搜索", text: typeof item.query === "string" ? item.query : "", output: JSON.stringify(item.action ?? "", null, 2) }];
  if (kind === "contextCompaction") return [{ ...base, role: "tool", title: "上下文已压缩", text: "" }];
  return [];
}
