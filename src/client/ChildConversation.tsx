import { useCallback, useEffect, useRef, useState } from "react";
import type { InjectFace, PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar-right/client";
import type { SubagentAddress } from "@deepseek-ai/dsh-subagent/client";
import type { ChildJournalSnapshot } from "./child-view.js";
import type { CodexApprovalRpc } from "./approval-rpc.js";
import type { CodexApprovalView, CodexQuestionView } from "../approval-rpc.js";

declare module "@deepseek-ai/dsh-client-ui-sidebar-right/client" {
  interface SidebarRightResourceParamsMap { "codex-child": SubagentAddress }
}

/** The pane operations the plugin injects; the address always comes from the tab. */
export interface ChildConversationInjected {
  openMain(address: SubagentAddress): void;
  attach(address: SubagentAddress, listener: (snapshot: ChildJournalSnapshot) => void): {
    loadMore(): Promise<void>;
    restart(): void;
    send(text: string, delivery: "queue" | "steer"): Promise<void>;
    stop(): Promise<void>;
    setDraft(text: string): string;
    getDraft(): string;
    release(): void;
  };
  /** The plugin's own approval channel for this child's Codex execution. */
  approvals: CodexApprovalRpc;
}

type Props = PropsRuntime<"sidebar.right.pane.tab"> & PropsLocale<"dsh-codex-app-provider"> &
  InjectFace<ChildConversationInjected>;

const EMPTY: ChildJournalSnapshot = { rows: [], running: false, pendingApprovals: 0, hasMore: false, loading: true };

/**
 * One sidebar tab's child conversation.
 *
 * The tab owns an independent event stream for exactly one child address, so
 * several tabs never share a cursor or a subscription, and closing the tab
 * releases only this pane's display state. Input is composed straight onto the
 * child with the delivery the user chose; stopping asks the parent to interrupt
 * that child rather than closing the DSH Session.
 */
export function ChildConversation({ useTabInfo, openMain, attach, approvals: approvalRpc, t }: Props) {
  const { tab } = useTabInfo();
  const address = tab.navigation.params as SubagentAddress | undefined;
  const valid = address !== undefined && typeof address.parentSessionId === "string" && typeof address.childSessionId === "string"
    && (address.mode === "continuable" || address.mode === "one-shot");
  const key = valid ? `${address.parentSessionId}:${address.childSessionId}:${address.mode}` : "";
  const [snapshot, setSnapshot] = useState<ChildJournalSnapshot>(EMPTY);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<readonly CodexApprovalView[]>([]);
  const [questions, setQuestions] = useState<readonly CodexQuestionView[]>([]);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const handle = useRef<ReturnType<ChildConversationInjected["attach"]> | undefined>(undefined);

  useEffect(() => {
    setSnapshot(EMPTY);
    setError("");
    if (!valid || tab.signal.aborted) return undefined;
    const view = attach(address, setSnapshot);
    handle.current = view;
    setDraft(view.getDraft());
    return () => {
      handle.current = undefined;
      // Closing the tab releases display resources only: the child keeps running.
      view.release();
    };
  }, [key, attach, tab.signal, valid]);

  const childSessionId = valid ? address.childSessionId : "";
  const refreshApprovals = useCallback(async (): Promise<void> => {
    if (childSessionId === "" || tab.signal.aborted) return;
    try {
      setPending(await approvalRpc.pending(childSessionId, tab.signal));
      setQuestions(await approvalRpc.questions(childSessionId, tab.signal));
    } catch {
      // A composition without the channel has no pane-answerable interactions;
      // the transcript still renders, so this is not an error state of its own.
      setPending([]);
      setQuestions([]);
    }
  }, [approvalRpc, childSessionId, tab.signal]);

  // Native approvals appear while a turn runs; re-read them when the journal
  // moves so a request that arrives mid-turn is offered without a manual reload.
  useEffect(() => {
    if (!valid || !snapshot.running) return;
    void refreshApprovals();
  }, [valid, snapshot.running, snapshot.rows.length, refreshApprovals]);

  const act = useCallback(async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  if (!valid) return <div role="alert">{t("childUnavailable")}</div>;
  const { rows, running, pendingApprovals, hasMore, loading } = snapshot;
  return <div className="codex-child">
    <div className="codex-child-head">
      <span className="codex-child-title" title={address.childSessionId}>{address.childSessionId}</span>
      <button type="button" className="codex-child-action" onClick={() => openMain(address)}>{t("openMain")}</button>
      <button type="button" className="codex-child-action" disabled={address.mode !== "continuable" || busy}
        onClick={() => void act(() => handle.current!.stop())}>{t("childStop")}</button>
    </div>
    {(error !== "" || snapshot.error !== undefined) && <div className="codex-child-error" role="alert">{error || snapshot.error}</div>}
    {pending.length > 0 && <section className="codex-child-approvals" aria-label={t("childApprovalWaiting")}>
      {pending.map(request => <div key={request.requestId} className="codex-child-approval" role="status">
        <span className="codex-child-approval-text">{request.reason}</span>
        <button type="button" className="codex-child-action" disabled={busy}
          onClick={() => void act(async () => {
            await approvalRpc.decide(childSessionId, request.requestId, "accept", tab.signal);
            await refreshApprovals();
          })}>{t("childAllow")}</button>
        <button type="button" className="codex-child-action" disabled={busy}
          onClick={() => void act(async () => {
            await approvalRpc.decide(childSessionId, request.requestId, "decline", tab.signal);
            await refreshApprovals();
          })}>{t("childDeny")}</button>
      </div>)}
    </section>}
    {questions.map(request => <section key={request.requestId} className="codex-child-questions" aria-label={t("childQuestion")}>
      {request.questions.map(question => <div key={question.id} className="codex-child-question">
        <span className="codex-child-question-text">{question.header === "" ? question.question : `${question.header}: ${question.question}`}</span>
        <div className="codex-child-actions">
          {question.options.map(option => <button key={option.label} type="button" className="codex-child-action" disabled={busy}
            title={option.description}
            onClick={() => void act(async () => {
              await approvalRpc.answer(childSessionId, request.requestId, { [question.id]: [option.label] }, tab.signal);
              await refreshApprovals();
            })}>{option.label}</button>)}
        </div>
        <input className="codex-child-input" aria-label={t("childAnswer")} value={(answers[question.id] ?? []).join(" ")}
          onChange={event => setAnswers(current => ({ ...current, [question.id]: event.target.value === "" ? [] : [event.target.value] }))} />
        <button type="button" className="codex-child-action" disabled={busy || (answers[question.id] ?? []).length === 0}
          onClick={() => void act(async () => {
            await approvalRpc.answer(childSessionId, request.requestId, { [question.id]: answers[question.id] ?? [] }, tab.signal);
            setAnswers(current => ({ ...current, [question.id]: [] }));
            await refreshApprovals();
          })}>{t("childSendAnswer")}</button>
      </div>)}
    </section>)}
    {pending.length === 0 && questions.length === 0 && pendingApprovals > 0 && <div className="codex-child-approval" role="status">{t("childApprovalWaiting")}</div>}
    <div className="codex-child-log" role="log">
      {hasMore && <button type="button" className="codex-child-action" disabled={loading}
        onClick={() => void act(() => handle.current!.loadMore())}>{t("childLoadEarlier")}</button>}
      {loading && rows.length === 0 && <div role="status">{t("childLoading")}</div>}
      {rows.map(row => <article key={row.id} className={`codex-child-row codex-child-${row.role}`}>
        <header>{t(row.role === "notice" ? "childExecuted" : row.role === "user" ? "roleUser" : row.role === "assistant" ? "roleAssistant" : row.role === "tool" ? "roleTool" : "roleApproval")}</header>
        <pre>{row.text}</pre>
      </article>)}
      {!loading && rows.length === 0 && <div role="status">{t("childEmpty")}</div>}
    </div>
    <form className="codex-child-composer" onSubmit={event => {
      event.preventDefault();
      const text = draft;
      if (text.trim() === "") return;
      void act(async () => { await handle.current!.send(text, running ? "steer" : "queue"); setDraft(handle.current!.getDraft()); });
    }}>
      <textarea className="codex-child-input" aria-label={t("childPrompt")} value={draft} rows={2}
        onChange={event => { setDraft(handle.current?.setDraft(event.target.value) ?? event.target.value); }} />
      <div className="codex-child-actions">
        <button type="submit" className="codex-child-action" disabled={busy || draft.trim() === ""}>
          {running ? t("childSteer") : t("childSend")}
        </button>
        <button type="button" className="codex-child-action" disabled={!running || busy}
          onClick={() => { if (draft.trim() === "") return; void act(async () => { await handle.current!.send(draft, "queue"); setDraft(handle.current!.getDraft()); }); }}>
          {t("childQueue")}
        </button>
        <button type="button" className="codex-child-action" onClick={() => handle.current?.restart()}>{t("childReload")}</button>
      </div>
    </form>
  </div>;
}
