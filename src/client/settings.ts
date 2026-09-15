import type { SettingsScope, SettingsScopeSnapshot } from "@deepseek-ai/dsh-client-ui-settings/client";
import type { Settings, SubagentOpenPosition } from "../settings.js";

export function canSave(snapshot: SettingsScopeSnapshot<Settings>): boolean {
  return snapshot.status === "ready" && snapshot.mode === "host" && snapshot.writable;
}

/**
 * Where the plugin's own child entry opens.
 *
 * A stored preference wins whenever the client can read it. When it cannot — the
 * document is process-local, or the scope has not settled yet — the entry opens
 * the plugin's own pane, which is the schema default. Falling back to the main
 * area would make the plugin's entry a second copy of the official subagent
 * catalog, which already opens children there.
 */
export function openPosition(snapshot: SettingsScopeSnapshot<Settings>): SubagentOpenPosition {
  return snapshot.value?.subagentOpenPosition ?? "sidebar";
}

export async function savePosition(scope: SettingsScope<Settings>, value: SubagentOpenPosition): Promise<void> {
  if (!canSave(scope.getSnapshot())) throw new Error("Settings cannot be saved");
  await scope.set("subagentOpenPosition", value);
}
