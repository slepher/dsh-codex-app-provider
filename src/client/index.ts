/**
 * The browser half of the Codex app provider.
 *
 * The plugin is a Host plugin: it has no page of its own. This half exists for
 * the configurations the plugin manager shows — the bundle's own configuration
 * section and the row's Configure page — so a deployment can edit `command`,
 * `allowMainSession` and `toolBridge` from the Plugins page instead of
 * hand-editing the profile patch. Both surfaces edit the same Loader entry
 * config through the Host settings form; nothing here runs a Codex process or
 * reads a Session.
 * @module dsh-codex-app-provider/client
 */

import type { Context } from "@deepseek-ai/cordis";
// Type-only: the renderer declares the `ctx.slots` registry this half registers into.
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-slots";
// Type-only: the settings form contract and the `ctx.configForms` service merge.
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import type { ConfigForm } from "@deepseek-ai/dsh-client-ui-settings/client";
// Type-only: the plugin manager declares the slots and the props they receive.
import type {} from "@deepseek-ai/dsh-client-ui-plugin-manager/client";
import { withForm, type ProviderConfigFields } from "./ProviderConfigForm.js";

/** Services this half reads: slot registration and the Host configuration form. */
export const inject = ["slots", "configForms"];

/** This package, which is also the bundle's key in the Plugin manager. */
const PACKAGE = "dsh-codex-app-provider";
/** The Loader entry id its `cordis.patch.yml` declares. */
const ROW_ID = "dsh-codex-app-provider";

/** Register the bundle configuration section and the row Configure page. */
export function apply(ctx: Context): void {
  ctx.inject(["configForms", "slots"], scope => {
    // The settings service keys a form by the profile entry id, which is the row
    // id this package's patch declares.
    const form = scope.configForms.get<ProviderConfigFields>(ROW_ID);
    const bound = withForm(form as ConfigForm<ProviderConfigFields>);
    scope.slots.inject("plugins.bundle.config", () => scope.slots.register({
      name: "plugins.bundle.config",
      key: PACKAGE,
    }, bound as never));
    scope.slots.inject("plugins.row.config", () => scope.slots.register({
      name: "plugins.row.config",
      key: `${PACKAGE}#${ROW_ID}`,
    }, bound as never));
  });
}
