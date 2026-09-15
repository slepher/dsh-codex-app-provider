import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-locale/client";
import type {} from "@deepseek-ai/dsh-client-ui-slots";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
// These two carry the slot-name and standard-props merges the header action and
// the main-conversation pane register against; they are not renderer-specific.
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-ui-chat/client";
import type {} from "@deepseek-ai/dsh-client-ui-subagent/client";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar-right/client";
import type {} from "@deepseek-ai/dsh-api-session-controller/client";
import type { SubagentAddress, SubagentPromptRequestId } from "@deepseek-ai/dsh-subagent/client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import { SessionEventStream } from "@deepseek-ai/dsh-api-session-controller/client";
import { LOCALE_NAMESPACE, en, zh } from "./locales.js";
import { ChildConversation, type ChildConversationInjected } from "./ChildConversation.js";
import { ChildAction, type ChildActionInjected } from "./ChildAction.js";
import { createChildViews } from "./child-view.js";
import { createCodexApprovalRpc } from "./approval-rpc.js";
import type { ConnectionHandle } from "@deepseek-ai/dsh-client-connection/client";
import { installClientStyles } from "./styles.js";

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap { "dsh-codex-app-provider": keyof typeof zh }
}

/** Branded identities are compile-time only; the plugin owns no runtime brand constructors. */
const asSessionId = (value: string): SessionId => value as unknown as SessionId;

/**
 * The client Session services the pane needs.
 *
 * The controller face carries child-address helpers the injected `SessionStore`
 * typing does not declare, so they are read structurally instead of assumed.
 */
interface ChildSessionFace {
  subagentAddress(sessionId: string): SubagentAddress | undefined;
  openSubagent(address: SubagentAddress): void;
  binding(id: SessionId): {
    session: {
      getSnapshot(): { running?: boolean; subagent?: { parentAvailable?: boolean } | null };
      subscribe(listener: () => void): () => void;
    };
  } | undefined;
}

/** The tab kind this plugin registers for one child conversation. */
const CHILD_TAB_KIND = "codex-child";

/** Unwrap a client remote result, or raise its transport-level failure. */
function remoteValue<T>(result: unknown): T {
  const value = result as { ok?: unknown; value?: unknown; error?: unknown };
  if (value !== null && typeof value === "object" && value.ok === true) return value.value as T;
  const failure = value?.error;
  throw new Error(typeof failure === "string" ? failure : failure instanceof Error ? failure.message : "The subagent request failed");
}

export const inject = ["slots", "locale"];
export function apply(ctx: Context): void {
  installClientStyles();
  ctx.effect(() => ctx.locale.register(LOCALE_NAMESPACE, { zh, en }), "Codex locales");
  // `remote.session` is the stream carrier the pane's own event stream reads, and
  // it is a service of its own: declaring the `remote` head does not grant it.
  ctx.inject(["sessions", "sidebarRight", "sidebarRightTabs", "remote", "remote.session", "remote.subagents", "connection"], sidebar => {
    // The plugin's own entry is additive. The lineage slot is a single seat
    // whose official occupant is the whole subagent catalog, so taking it would
    // delete official parent/child navigation rather than extend it. It is
    // registered from this scope because resolving a child address and opening
    // it need the Session services, which a conversation-scoped inject face
    // does not carry.
    sidebar.slots.inject("conversation.session.header.actions", () => sidebar.slots.register({
      name: "conversation.session.header.actions", id: "codex-child-open", order: 20, locale: LOCALE_NAMESPACE,
      inject: (): ChildActionInjected => ({
        // `subagentAddress` is the shell's documented feature-plugin accessor: it
        // returns the durable direct-parent address the Session controller
        // retained, including one restored from a persisted child selection. The
        // controller's catalog-navigation helper is not part of the client
        // service, so asking for it here would throw inside the header slot.
        addressOf: sessionId => (sidebar.sessions as unknown as ChildSessionFace).subagentAddress(asSessionId(sessionId)),
        openSidebar: address => openChildTab(sidebar.sidebarRight, address),
      }),
    }, ChildAction));
    // Codex approvals are answered on the plugin's own authenticated channel,
    // never through DSH's approval policy.
    const approvals = createCodexApprovalRpc(sidebar.connection as unknown as ConnectionHandle);
    const views = createChildViews({
      create: (address, options) => new SessionEventStream(sidebar.remote, { kind: "subagent",
        parentSessionId: asSessionId(address.parentSessionId), childSessionId: asSessionId(address.childSessionId), mode: address.mode }, options),
      prompt: async (address, text, delivery) => {
        remoteValue(await sidebar.remote.subagents.prompt({
          requestId: crypto.randomUUID() as unknown as SubagentPromptRequestId,
          parentSessionId: asSessionId(address.parentSessionId), childSessionId: asSessionId(address.childSessionId),
          mode: "continuable", delivery, content: [{ type: "text", text }],
        }));
      },
      stop: async address => {
        remoteValue(await sidebar.remote.subagents.interruptByParent(
          asSessionId(address.childSessionId), asSessionId(address.parentSessionId), "continuable"));
      },
    });
    sidebar.slots.inject("main.conversation", () => sidebar.slots.inject("sidebar.right.pane.tab", function* () {
      yield sidebar.sidebarRightTabs.register({
        id: CHILD_TAB_KIND, kind: CHILD_TAB_KIND, patterns: [`dsh-resource://${CHILD_TAB_KIND}/**`],
        title: address => (address as unknown as SubagentAddress | undefined)?.childSessionId ?? "Codex",
      });
      yield sidebar.slots.register({
        name: "sidebar.right.pane.tab", key: CHILD_TAB_KIND, locale: LOCALE_NAMESPACE,
        inject: (): ChildConversationInjected => ({
          openMain: address => (sidebar.sessions as unknown as ChildSessionFace).openSubagent(address),
          attach: (address, listener) => views.attach(address, listener),
          approvals,
          // The child's own native Session state carries the official
          // availability facts this pane mirrors in its composer policy.
          nativeState: (address, listener) => {
            const face = (sidebar.sessions as unknown as ChildSessionFace).binding(asSessionId(address.childSessionId))?.session;
            if (face === undefined) { listener({}); return () => {}; }
            const report = (): void => {
              const state = face.getSnapshot();
              listener({ ...(state.subagent?.parentAvailable === undefined ? {} : { parentAvailable: state.subagent.parentAvailable }),
                ...(state.running === undefined ? {} : { running: state.running }) });
            };
            report();
            return face.subscribe(report);
          },
        }),
      }, ChildConversation);
    }));
  });
}

/**
 * Open one child conversation as a right-pane resource.
 *
 * The address is the tab's own parameter, so the pane can address a
 * non-current child without changing the main area's selection.
 * @param sidebarRight - the sidebar controller.
 * @param address - the direct child conversation to open.
 */
function openChildTab(sidebarRight: { openResource(address: string, options: { kind: string; params: SubagentAddress }): void },
  address: SubagentAddress): void {
  sidebarRight.openResource(
    `dsh-resource://${CHILD_TAB_KIND}/${encodeURIComponent(address.parentSessionId)}/${encodeURIComponent(address.childSessionId)}/${address.mode}`,
    { kind: CHILD_TAB_KIND, params: address },
  );
}
