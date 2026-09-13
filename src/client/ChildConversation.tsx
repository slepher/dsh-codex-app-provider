import { useEffect, useState } from "react";
import type { InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type { SubagentAddress } from "@deepseek-ai/dsh-subagent/client";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar-right/client";

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface SlotMap {
    "codex.child.conversation": { kind: "single"; scope: "session" };
  }
}
declare module "@deepseek-ai/dsh-client-ui-sidebar-right/client" {
  interface SidebarRightResourceParamsMap { "codex-child": SubagentAddress }
}

export interface ChildConversationInjected {
  retainView(address: SubagentAddress, signal: AbortSignal): void;
  openMain(address: SubagentAddress): void;
}
type Props = PropsRuntime<"sidebar.right.pane.tab"> & PropsRenderSlots<"codex.child.conversation"> &
  PropsLocale<"dsh-codex-app-provider"> & InjectFace<ChildConversationInjected>;

export function ChildConversation({ useTabInfo, retainView, openMain, SessionProvider, renderSlot, t }: Props) {
  const { tab } = useTabInfo();
  const address = tab.navigation.params as SubagentAddress | undefined;
  const valid = address !== undefined && typeof address.parentSessionId === "string" && typeof address.childSessionId === "string"
    && (address.mode === "continuable" || address.mode === "one-shot");
  const key = valid ? JSON.stringify(address) : "";
  const [view, setView] = useState({ key: "", error: "" });
  useEffect(() => {
    if (!valid || tab.signal.aborted) return;
    try { retainView(address, tab.signal); setView({ key, error: "" }); }
    catch (error) { setView({ key, error: String(error) }); }
  }, [key, tab.signal, retainView]);
  if (!valid) return <div role="alert">{t("childUnavailable")}</div>;
  if (view.key !== key) return <div role="status">{t("childLoading")}</div>;
  if (view.error) return <div role="alert">{view.error}</div>;
  return <div style={{ height: "100%", minHeight: 0, display: "flex", flexDirection: "column" }}>
    <button type="button" onClick={() => openMain(address)}>{t("openMain")}</button>
    <div style={{ flex: 1, minHeight: 0 }}>
      <SessionProvider sessionId={address.childSessionId} empty={() => <div>{t("childUnavailable")}</div>}>
        {renderSlot("codex.child.conversation", {})}
      </SessionProvider>
    </div>
  </div>;
}
