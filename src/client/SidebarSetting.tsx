import { useState } from "react";
import type { SettingsScope } from "@deepseek-ai/dsh-client-ui-settings/client";
import type { InjectFace, PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type { Settings, SubagentOpenPosition } from "../settings.js";
import { canSave } from "./settings.js";

export interface SidebarSettingInjected {
  hooks: { settings: Pick<SettingsScope<Settings>, "getSnapshot" | "subscribe"> };
  savePosition(value: SubagentOpenPosition): Promise<void>;
}
type Props = PropsRuntime<"settings.general.item"> & PropsLocale<"dsh-codex-app-provider"> & InjectFace<SidebarSettingInjected>;

export function SidebarSetting({ useSettings, savePosition, t }: Props) {
  const snapshot = useSettings(value => value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  return <div>
    <label>
      {t("title")}
      <select value={snapshot.value?.subagentOpenPosition ?? ""} disabled={!canSave(snapshot) || saving}
        onChange={event => {
          const value = event.target.value;
          if (value !== "sidebar" && value !== "main") return;
          setSaving(true); setError("");
          void savePosition(value).catch(reason => { setError(String(reason)); }).finally(() => { setSaving(false); });
        }}>
        {snapshot.value === undefined && <option value="">{t("loading")}</option>}
        <option value="sidebar">{t("sidebar")}</option>
        <option value="main">{t("main")}</option>
      </select>
    </label>
    {saving && <div role="status">{t("saving")}</div>}
    {!canSave(snapshot) && <div role="status">{t(snapshot.status === "loading" ? "loading" : "unavailable")}</div>}
    {error && <div role="alert">{error}</div>}
  </div>;
}
