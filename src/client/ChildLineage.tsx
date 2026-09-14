import type { InjectFace, PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type { SubagentAddress } from "@deepseek-ai/dsh-subagent/client";

/** The lineage facts the plugin needs beyond the owner props. */
export interface ChildLineageInjected {
  /** The direct-child address of one lineage session, when it is a direct child. */
  addressOf(sessionId: string): SubagentAddress | undefined;
  /** Whether this deployment routes child conversations to the right sidebar. */
  position(): "sidebar" | "main";
  /** Open the plugin's child pane for one address; `false` keeps the main-area entry. */
  openSidebar(address: SubagentAddress): boolean;
}

type Props = PropsRuntime<"conversation.session.header.lineage"> & PropsLocale<"dsh-codex-app-provider"> &
  InjectFace<ChildLineageInjected>;

/**
 * The Codex child entry in the conversation breadcrumb.
 *
 * It keeps the real parent/child address, and it decides where the child opens:
 * the plugin's right pane when that is the configured position, otherwise the
 * core's main-area navigation through `openTitle`. An ancestor crumb that is not
 * a direct child renders exactly as the core would, so replacing the official
 * occupant never changes a non-child breadcrumb.
 */
export function ChildLineage({ lineageSessionId, displayTitle, openTitle, addressOf, position, openSidebar, t }: Props) {
  const address = addressOf(lineageSessionId);
  const open = (): void => {
    if (address !== undefined && position() === "sidebar" && openSidebar(address)) return;
    openTitle?.();
  };
  if (address === undefined) return <>{displayTitle}</>;
  return <button type="button" className="codex-child-lineage" title={t("childOpen")} onClick={open}>
    {displayTitle}
  </button>;
}
