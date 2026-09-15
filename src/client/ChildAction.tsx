import type { InjectFace, PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type { SubagentAddress } from "@deepseek-ai/dsh-subagent/client";

/** Where the plugin's own child entry opens, and how it resolves an address. */
export interface ChildActionInjected {
  /** The direct-child address of one Session, when that Session is a direct child. */
  addressOf(sessionId: string): SubagentAddress | undefined;
  /** Open the plugin's child pane for one address. */
  openSidebar(address: SubagentAddress): void;
}

type Props = PropsRuntime<"conversation.session.header.actions"> & PropsLocale<"dsh-codex-app-provider"> &
  InjectFace<ChildActionInjected>;

/** Open the current child conversation in the plugin's sidebar pane. */
export function ChildAction({ sessionId, addressOf, openSidebar, t }: Props) {
  const address = addressOf(String(sessionId));
  if (address === undefined) return null;
  return <button type="button" className="codex-child-open" title={`${t("childOpen")} → ${t("childPositionSidebar")}`}
    onClick={() => openSidebar(address)}>
    {t("childOpen")}
  </button>;
}
