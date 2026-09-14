import { useCallback, useEffect, useRef, useState } from "react";
import type { InjectFace, PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar-right/client";
import type { SubagentAddress } from "@deepseek-ai/dsh-subagent/client";
import type { ChildJournalSnapshot } from "./child-view.js";

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
export function ChildConversation({ useTabInfo, openMain, attach, t }: Props) {
  const { tab } = useTabInfo();
  const address = tab.navigation.params as SubagentAddress | undefined;
  const valid = address !== undefined && typeof address.parentSessionId === "string" && typeof address.childSessionId === "string"
    && (address.mode === "continuable" || address.mode === "one-shot");
  const key = valid ? `${address.parentSessionId}:${address.childSessionId}:${address.mode}` : "";
  const [snapshot, setSnapshot] = useState<ChildJournalSnapshot>(EMPTY);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
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
    {pendingApprovals > 0 && <div className="codex-child-approval" role="status">{t("childApprovalWaiting")}</div>}
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
