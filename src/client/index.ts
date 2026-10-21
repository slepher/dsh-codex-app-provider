/**
 * The browser half of the Codex app provider.
 *
 * The plugin is a Host plugin: it has no page of its own. This half contributes
 * three surfaces for the same Host configuration form — the bundle's own
 * configuration section and the row's Configure page in the Plugin manager, and
 * a Settings page of its own (the most discoverable one) — so a deployment can
 * edit `command`, `allowMainSession` and `toolBridge` from the UI instead of
 * hand-editing the profile patch. Copy is localized in English and Chinese.
 * Nothing here runs a Codex process or reads a Session.
 * @module dsh-codex-app-provider/client
 */

import type { Context } from "@deepseek-ai/cordis";
// Type-only: the renderer declares the `ctx.slots` registry this half registers into.
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-slots";
// Type-only: the locale service and its namespace map.
import type {} from "@deepseek-ai/dsh-client-locale/client";
// Type-only: the settings form contract and the `ctx.configForms` service merge.
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import type { ConfigForm } from "@deepseek-ai/dsh-client-ui-settings/client";
// Type-only: the plugin manager declares the slots and the props they receive.
import type {} from "@deepseek-ai/dsh-client-ui-plugin-manager/client";
import { withForm, withFormAsPage, type ProviderConfigFields } from "./ProviderConfigForm.js";
import { en, zh } from "./locales.js";

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {
    "dsh-codex-app-provider": keyof typeof zh;
  }
}

/** Services this half reads: slot registration, copy and the Host config form. */
export const inject = ["slots", "configForms", "locale"];

/** The locale namespace and package name; the bundle page keys itself by the name. */
const NAMESPACE = "dsh-codex-app-provider";
/** The Loader entry id its `cordis.patch.yml` declares. */
const ROW_ID = "dsh-codex-app-provider";
/** The Settings page id; unique among settings sections. */
const SECTION_ID = "codex-app-provider";

/** Register the copy, the bundle section, the row page and a Settings page. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NAMESPACE, { zh, en }), "dsh-codex-app-provider: locales");
  const t = ctx.locale.bind(NAMESPACE);
  ctx.inject(["configForms", "slots"], scope => {
    // The settings service keys a form by the profile entry id, which is the row
    // id this package's patch declares.
    const form = scope.configForms.get<ProviderConfigFields>(ROW_ID);
    const bound = withForm(form as ConfigForm<ProviderConfigFields>);
    const asPage = withFormAsPage(form as ConfigForm<ProviderConfigFields>);
    scope.slots.inject("plugins.bundle.config", () => scope.slots.register({
      name: "plugins.bundle.config",
      key: NAMESPACE,
      locale: NAMESPACE,
    }, bound as never));
    scope.slots.inject("plugins.row.config", () => scope.slots.register({
      name: "plugins.row.config",
      key: `${NAMESPACE}#${ROW_ID}`,
      locale: NAMESPACE,
    }, bound as never));
    // Ordered after the routine deployment pages; this one edits a model route.
    scope.slots.inject("settings.section", () => scope.slots.register({
      name: "settings.section",
      id: SECTION_ID,
      order: 60,
      label: () => t("nav"),
      locale: NAMESPACE,
    }, asPage as never));
  });
}
