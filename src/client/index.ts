/**
 * The browser half of the Codex app provider.
 *
 * The plugin is a Host plugin: it has no page of its own. This half exists for
 * the one surface the plugin manager shows — the row configuration page — so a
 * deployment can edit `command`, `allowMainSession` and `toolBridge` from the
 * Plugins page instead of hand-editing the profile patch. It edits the Loader
 * entry config through the row's own form; nothing here runs a Codex process or
 * reads a Session.
 * @module dsh-codex-app-provider/client
 */

import type { Context } from "@deepseek-ai/cordis";
// Type-only: the renderer declares the `ctx.slots` registry this half registers into.
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-slots";
// Type-only: the plugin manager declares the `plugins.row.config` slot and the
// props a row-configuration entry receives.
import type {} from "@deepseek-ai/dsh-client-ui-plugin-manager/client";
import { ProviderConfigForm } from "./ProviderConfigForm.js";

/** The page this half renders inside the Plugins section. */
export const inject = ["slots"];

/**
 * The Loader row this bundle inserts, as `<package name>#<row id>`.
 *
 * Both halves of the key come from this package: the bundle's name and the id
 * its `cordis.patch.yml` declares.
 */
const ROW_CONFIG_KEY = "dsh-codex-app-provider#dsh-codex-app-provider";

/** Register the row configuration page; the Plugin manager renders it on demand. */
export function apply(ctx: Context): void {
  ctx.slots.inject("plugins.row.config", () => ctx.slots.register({
    name: "plugins.row.config",
    key: ROW_CONFIG_KEY,
  }, ProviderConfigForm as never));
}
