import type { InjectFace, PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type { SubagentAddress } from "@deepseek-ai/dsh-subagent/client";

/** Where the plugin's own child entry opens, and how it resolves an address. */
export interface ChildActionInjected {
  /** The direct-child address of one Session, when that Session is a direct child. */
  addressOf(sessionId: string): SubagentAddress | undefined;
  /** Whether this deployment opens child conversations in the right sidebar. */
  position(): "sidebar" | "main";
  /** Open the plugin's child pane for one address; `false` keeps the main-area entry. */
  openSidebar(address: SubagentAddress): boolean;
  /** Open one child conversation in the main area. */
  openMain(address: SubagentAddress): void;
}

type Props = PropsRuntime<"conversation.session.header.actions"> & PropsLocale<"dsh-codex-app-provider"> &
  InjectFace<ChildActionInjected>;

/**
 * Open the current child conversation in the plugin's pane.
 *
 * This is an additive header action rather than the lineage seat. The lineage
 * slot is a single occupant whose official renderer is the whole subagent
 * catalog — child switcher, states, usage — so shadowing it would delete
 * official parent/child navigation. An additive action keeps that navigation and
 * still gives the plugin its own entry, which opens the child where the
 * deployment says (the pane, or the main area through the core).
 */
export function ChildAction({ sessionId, addressOf, position, openSidebar, openMain, t }: Props) {
  const address = addressOf(String(sessionId));
  if (address === undefined) return null;
  // The entry's destination is otherwise invisible: the official catalog sits
  // right beside it and opens the child as the selected Session instead.
  const where = position() === "sidebar" ? t("childPositionSidebar") : t("openMain");
  return <button type="button" className="codex-child-open" title={`${t("childOpen")} → ${where}`}
    onClick={() => {
      if (position() === "sidebar" && openSidebar(address)) return;
      openMain(address);
    }}>
    {t("childOpen")}
  </button>;
}
