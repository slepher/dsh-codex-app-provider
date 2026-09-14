import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-locale/client";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import type {} from "@deepseek-ai/dsh-client-ui-slots";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-ui-chat/client";
import type {} from "@deepseek-ai/dsh-client-ui-subagent/client";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar-right/client";
import type {} from "@deepseek-ai/dsh-api-session-controller/client";
import type { SubagentAddress, SubagentPromptRequestId } from "@deepseek-ai/dsh-subagent/client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import { SessionEventStream } from "@deepseek-ai/dsh-api-session-controller/client";
import { executionDefinition, executionEndDefinition, ExecutionNode } from "./ExecutionNode.js";
import { SETTINGS_NAMESPACE, type Settings } from "../settings.js";
import { en, zh } from "./locales.js";
import { SidebarSetting, type SidebarSettingInjected } from "./SidebarSetting.js";
import { savePosition } from "./settings.js";
import { openPosition } from "./settings.js";
import { ChildConversation, type ChildConversationInjected } from "./ChildConversation.js";
import { ChildLineage, type ChildLineageInjected } from "./ChildLineage.js";
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

export const inject = ["slots", "locale", "settingsScope"];
export function apply(ctx: Context): void {
  installClientStyles();
  const settings = ctx.settingsScope.bind<Settings>({ namespace: SETTINGS_NAMESPACE });
  ctx.inject(["uiConversation"], scope => {
    scope.uiConversation.events.register(executionDefinition);
    scope.uiConversation.events.register(executionEndDefinition);
    scope.slots.inject("conversation.chat.node", () => scope.slots.register({
      name: "conversation.chat.node", key: "codex-execution", locale: SETTINGS_NAMESPACE,
    }, ExecutionNode));
    // The official lineage occupant opens every child in the main area. This
    // plugin takes that single seat at a lower priority so a Codex child can be
    // routed to its dedicated pane while the main-area entry stays explicit.
    scope.slots.inject("conversation.session.header.lineage", () => scope.slots.register({
      name: "conversation.session.header.lineage", priority: -1, locale: SETTINGS_NAMESPACE,
      inject: (): ChildLineageInjected => ({
        addressOf: sessionId => (scope.sessions as unknown as ChildSessionFace).subagentAddress(asSessionId(sessionId)),
        position: () => openPosition(settings.getSnapshot()),
        openSidebar: address => openPosition(settings.getSnapshot()) === "sidebar" && openChildTab(scope.sidebarRight, address),
      }),
    }, ChildLineage));
  });
  ctx.effect(() => ctx.locale.register(SETTINGS_NAMESPACE, { zh, en }), "Codex settings locales");
  ctx.inject(["sessions", "sidebarRight", "sidebarRightTabs", "remote", "remote.subagents", "connection"], sidebar => {
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
        name: "sidebar.right.pane.tab", key: CHILD_TAB_KIND, locale: SETTINGS_NAMESPACE,
        inject: (): ChildConversationInjected => ({
          openMain: address => (sidebar.sessions as unknown as ChildSessionFace).openSubagent(address),
          attach: (address, listener) => views.attach(address, listener),
          approvals,
        }),
      }, ChildConversation);
    }));
  });
  ctx.slots.inject("settings.general.item", () => ctx.slots.register({
    name: "settings.general.item", id: "codex-subagent-open-position", order: 30, locale: SETTINGS_NAMESPACE,
    inject: (): SidebarSettingInjected => ({ hooks: { settings }, savePosition: value => savePosition(settings, value) }),
  }, SidebarSetting));
}

/**
 * Open one child conversation as a right-pane resource.
 *
 * The address is the tab's own parameter, so the pane can address a
 * non-current child without changing the main area's selection.
 * @param sidebarRight - the sidebar controller.
 * @param address - the direct child conversation to open.
 * @returns whether a resource was opened.
 */
function openChildTab(sidebarRight: { openResource(address: string, options: { kind: string; params: SubagentAddress }): void },
  address: SubagentAddress): boolean {
  sidebarRight.openResource(
    `dsh-resource://${CHILD_TAB_KIND}/${encodeURIComponent(address.parentSessionId)}/${encodeURIComponent(address.childSessionId)}/${address.mode}`,
    { kind: CHILD_TAB_KIND, params: address },
  );
  return true;
}
