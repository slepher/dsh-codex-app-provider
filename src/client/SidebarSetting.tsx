import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SettingsScope } from "@deepseek-ai/dsh-client-ui-settings/client";
import type { InjectFace, PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type { Settings, SubagentOpenPosition } from "../settings.js";
import { canSave } from "./settings.js";
import { CheckIcon, ChevronDownIcon } from "./icons.js";
import { installClientStyles } from "./styles.js";

export interface SidebarSettingInjected {
  hooks: { settings: Pick<SettingsScope<Settings>, "getSnapshot" | "subscribe"> };
  savePosition(value: SubagentOpenPosition): Promise<void>;
}
type Props = PropsRuntime<"settings.general.item"> & PropsLocale<"dsh-codex-app-provider"> & InjectFace<SidebarSettingInjected>;

const POSITIONS: readonly SubagentOpenPosition[] = ["sidebar", "main"];

/** Native-style General settings row: label column plus the selector pill and its menu. */
export function SidebarSetting({ useSettings, savePosition, t }: Props) {
  const snapshot = useSettings(value => value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);
  const writable = canSave(snapshot);
  const position = snapshot.value?.subagentOpenPosition ?? "";
  const label = (value: SubagentOpenPosition) => value === "main" ? t("main") : t("sidebar");
  installClientStyles();

  const choose = useCallback((value: SubagentOpenPosition) => {
    setOpen(false);
    trigger.current?.focus();
    setSaving(true); setError("");
    void savePosition(value).catch(reason => { setError(String(reason)); }).finally(() => { setSaving(false); });
  }, [savePosition]);

  const openMenu = () => {
    const rect = trigger.current?.getBoundingClientRect();
    if (rect === undefined) return;
    setAnchor({ top: rect.bottom + 4, right: Math.max(0, window.innerWidth - rect.right) });
    setActive(Math.max(0, POSITIONS.indexOf(position as SubagentOpenPosition)));
    setOpen(true);
  };

  // Menu dismissal and keyboard navigation, the same behavior the native menu owns.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (list.current?.contains(target) === true || trigger.current?.contains(target) === true) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setOpen(false); trigger.current?.focus(); return; }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setActive(current => (current + (event.key === "ArrowDown" ? 1 : POSITIONS.length - 1)) % POSITIONS.length);
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        choose(POSITIONS[active]);
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, active, choose]);

  return <div className="codex-setting-row">
    <div className="codex-setting-text">
      <div className="codex-setting-title">{t("title")}</div>
      <div className="codex-setting-desc">{error === "" ? t("description") : <span className="codex-setting-error">{error}</span>}</div>
    </div>
    {!writable && <div className="codex-setting-desc" role="status">{t(snapshot.status === "loading" ? "loading" : "unavailable")}</div>}
    <button type="button" ref={trigger} className="codex-setting-selector" disabled={!writable || saving}
      aria-haspopup="menu" aria-expanded={open} aria-label={t("title")} aria-busy={saving}
      onClick={() => { if (open) setOpen(false); else openMenu(); }}>
      <span>{snapshot.value === undefined ? t("loading") : label(position as SubagentOpenPosition)}</span>
      <ChevronDownIcon className="codex-setting-chevron" />
    </button>
    {open && anchor !== null && createPortal(
      <div ref={list} className="codex-setting-menu" role="menu" tabIndex={-1}
        style={{ top: anchor.top, right: anchor.right }}>
        {POSITIONS.map((value, index) => <button key={value} type="button" role="menuitemradio"
          aria-checked={value === position} className="codex-setting-option"
          data-active={String(index === active)} data-selected={String(value === position)}
          onPointerEnter={() => { setActive(index); }}
          onClick={() => { choose(value); }}>
          <span className="codex-setting-option-label">{label(value)}</span>
          {value === position && <CheckIcon className="codex-setting-check" />}
        </button>)}
      </div>, document.body)}
  </div>;
}
