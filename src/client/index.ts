import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-locale/client";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import type {} from "@deepseek-ai/dsh-client-ui-slots";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-ui-chat/client";
import { executionDefinition, executionEndDefinition, ExecutionNode } from "./ExecutionNode.js";
import { SETTINGS_NAMESPACE, type Settings } from "../settings.js";
import { en, zh } from "./locales.js";
import { SidebarSetting, type SidebarSettingInjected } from "./SidebarSetting.js";
import { savePosition } from "./settings.js";
import { openPosition } from "./settings.js";
import type {} from "@deepseek-ai/dsh-client-ui-subagent/client";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar-right/client";
import { ChildConversation, type ChildConversationInjected } from "./ChildConversation.js";

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap { "dsh-codex-app-provider": keyof typeof zh }
}
/** A child conversation address as the DSH client names it. */
type ChildAddress = Parameters<ChildConversationInjected["retainView"]>[0];
/** The core's `subagent/open` request shape; absent from stock client types. */
interface SubagentOpenRequest { originSessionId?: string; address: ChildAddress }
export const inject = ["slots", "locale", "settingsScope"];
export function apply(ctx: Context): void {
  ctx.inject(["uiConversation"], scope => {
    scope.uiConversation.events.register(executionDefinition);
    scope.uiConversation.events.register(executionEndDefinition);
    scope.slots.inject("conversation.chat.node", () => scope.slots.register({
      name: "conversation.chat.node", key: "codex-execution", locale: SETTINGS_NAMESPACE,
    }, ExecutionNode));
  });
  ctx.effect(() => ctx.locale.register(SETTINGS_NAMESPACE, { zh, en }), "Codex settings locales");
  const scope = ctx.settingsScope.bind<Settings>({ namespace: SETTINGS_NAMESPACE });
  ctx.inject(["sessions", "sidebarRight", "sidebarRightTabs"], sidebar => {
    sidebar.slots.inject("main.conversation", () => sidebar.slots.inject("sidebar.right.pane.tab", function* () {
      const leases = new Map<AbortSignal, { key: string; release: () => void }>();
      const retainView: ChildConversationInjected["retainView"] = (address, signal) => {
        if (signal.aborted) throw new Error("Child view has closed");
        const key = JSON.stringify(address), previous = leases.get(signal);
        if (previous?.key === key) return;
        // Stock client core has no `retainSubagent`; the pane then renders
        // read-only instead of throwing out of the render. The degraded panel is
        // the accepted prototype outcome, not a defect.
        const retain = (sidebar.sessions as { retainSubagent?: (value: ChildAddress) => () => void }).retainSubagent;
        const releaseNative = typeof retain === "function" ? retain.call(sidebar.sessions, address) : () => {};
        previous?.release();
        const release = () => {
          signal.removeEventListener("abort", release);
          if (leases.get(signal)?.release === release) leases.delete(signal);
          releaseNative();
        };
        leases.set(signal, { key, release });
        signal.addEventListener("abort", release, { once: true });
      };
      yield () => { for (const lease of [...leases.values()]) lease.release(); };
      yield sidebar.sidebarRightTabs.register({ id: "codex-child", kind: "codex-child", patterns: ["dsh-resource://codex-child/**"], title: () => "Codex" });
      yield sidebar.slots.register({
        name: "sidebar.right.pane.tab", key: "codex-child", locale: SETTINGS_NAMESPACE,
        children: { "codex.child.conversation": { kind: "single", scope: "session", mount: "main.conversation" } },
        inject: (): ChildConversationInjected => ({ retainView, openMain: address => sidebar.sessions.openSubagent(address) }),
      }, ChildConversation);
      // Stock client core declares no `subagent/open` event, so this
      // interception is inert there and a native directory item still switches
      // the main area; the registration is kept for cores that do emit it.
      const onSidebarEvent = sidebar.on as unknown as (
        event: "subagent/open",
        listener: (request: SubagentOpenRequest) => boolean | undefined,
      ) => () => void;
      yield onSidebarEvent("subagent/open", request => {
        if (openPosition(scope.getSnapshot()) !== "sidebar" || request.originSessionId === undefined
          || sidebar.sessions.list.getSnapshot().current !== request.originSessionId) return;
        const address = request.address;
        sidebar.sidebarRight.openResource(`dsh-resource://codex-child/${encodeURIComponent(address.parentSessionId)}/${encodeURIComponent(address.childSessionId)}/${address.mode}`, { kind: "codex-child", params: address });
        return true;
      });
    }));
  });
  ctx.slots.inject("settings.general.item", () => ctx.slots.register({
    name: "settings.general.item", id: "codex-subagent-open-position", order: 30, locale: SETTINGS_NAMESPACE,
    inject: (): SidebarSettingInjected => ({ hooks: { settings: scope }, savePosition: value => savePosition(scope, value) }),
  }, SidebarSetting));
}
