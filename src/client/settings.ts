import type { SettingsScope, SettingsScopeSnapshot } from "@deepseek-ai/dsh-client-ui-settings/client";
import type { Settings, SubagentOpenPosition } from "../settings.js";

export function canSave(snapshot: SettingsScopeSnapshot<Settings>): boolean {
  return snapshot.status === "ready" && snapshot.mode === "host" && snapshot.writable;
}

export function openPosition(snapshot: SettingsScopeSnapshot<Settings>): SubagentOpenPosition {
  return snapshot.status === "ready" && snapshot.mode === "host" ? snapshot.value?.subagentOpenPosition ?? "main" : "main";
}

export async function savePosition(scope: SettingsScope<Settings>, value: SubagentOpenPosition): Promise<void> {
  if (!canSave(scope.getSnapshot())) throw new Error("Settings cannot be saved");
  await scope.set("subagentOpenPosition", value);
}
