import { useState } from "react";
import type { SettingsScope } from "@deepseek-ai/dsh-client-ui-settings/client";
import type { InjectFace, PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type { Settings, SubagentOpenPosition } from "../settings.js";
import { canSave } from "./settings.js";
import { ChevronDownIcon } from "./icons.js";
import { installClientStyles } from "./styles.js";

export interface SidebarSettingInjected {
  hooks: { settings: Pick<SettingsScope<Settings>, "getSnapshot" | "subscribe"> };
  savePosition(value: SubagentOpenPosition): Promise<void>;
}
type Props = PropsRuntime<"settings.general.item"> & PropsLocale<"dsh-codex-app-provider"> & InjectFace<SidebarSettingInjected>;

/** Native-style General settings row: label column plus the selector pill. */
export function SidebarSetting({ useSettings, savePosition, t }: Props) {
  const snapshot = useSettings(value => value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  installClientStyles();
  const position = snapshot.value?.subagentOpenPosition ?? "";
  return <div className="codex-setting-row">
    <div className="codex-setting-text">
      <div className="codex-setting-title">{t("title")}</div>
      <div className="codex-setting-desc">{error === "" ? t("description") : <span className="codex-setting-error">{error}</span>}</div>
    </div>
    {!canSave(snapshot) && <div className="codex-setting-desc" role="status">{t(snapshot.status === "loading" ? "loading" : "unavailable")}</div>}
    <label className="codex-setting-selector" data-disabled={String(!canSave(snapshot) || saving)}>
      <span aria-hidden="true">{snapshot.value === undefined ? t("loading") : position === "main" ? t("main") : t("sidebar")}</span>
      <ChevronDownIcon className="codex-setting-chevron" />
      <select className="codex-setting-control" value={position} disabled={!canSave(snapshot) || saving}
        aria-label={t("title")} aria-busy={saving}
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
  </div>;
}
