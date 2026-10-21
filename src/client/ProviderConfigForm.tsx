/**
 * The configuration page for the Codex app provider.
 *
 * The page edits the Loader entry's own fields, so the values it writes are the
 * ones the Host plugin starts with: the Codex executable, whether top-level
 * Sessions may select the route, and the native tool bridge. Only a save writes;
 * leaving the page drops the staged edits. One component serves both surfaces the
 * Plugin manager offers — the bundle's configuration section, which passes no
 * form and reads the Host form directly, and the row page, which passes one.
 * @module dsh-codex-app-provider/client/ProviderConfigForm
 */

import { useSyncExternalStore, useState, type CSSProperties, type ReactNode } from "react";

import type { ConfigForm, ConfigFormSnapshot } from "@deepseek-ai/dsh-client-ui-settings/client";
import type { PluginConfigViewProps } from "@deepseek-ai/dsh-client-ui-plugin-manager/client";

/** The provider's editable entry fields, as the Host resolves them. */
export interface ProviderConfigFields {
  command?: string;
  allowMainSession?: boolean;
  toolBridge?: { enabled?: boolean; allow?: readonly string[] };
}

/** What the form renders from: accepted values plus the one write operation. */
interface FormLike {
  state: ConfigFormSnapshot<ProviderConfigFields>;
  mutate: ConfigForm<ProviderConfigFields>["mutate"];
}

/** One field edit in the Host's path-mutation vocabulary. */
type FieldOp =
  | { op: "set"; path: string[]; value: unknown }
  | { op: "unset"; path: string[] };

const label: CSSProperties = {
  display: "block", color: "var(--dsw-alias-label-primary)", fontSize: 13, fontWeight: 500, marginBottom: 4,
};
const hint: CSSProperties = {
  display: "block", color: "var(--dsw-alias-label-tertiary)", fontSize: 12, lineHeight: "18px", marginTop: 4,
};
const field: CSSProperties = { marginBottom: 18 };
const input: CSSProperties = {
  boxSizing: "border-box", width: "100%", height: 34, borderRadius: 8,
  border: "0.5px solid var(--dsw-alias-border-l3)", background: "var(--dsw-alias-bg-layer-3)",
  color: "var(--dsw-alias-label-primary)", padding: "0 10px", fontSize: 13, outline: "none",
};
const toggleRow: CSSProperties = { display: "flex", alignItems: "center", gap: 8 };
const saveRow: CSSProperties = { display: "flex", alignItems: "center", gap: 12, marginTop: 4 };
const saveButton: CSSProperties = {
  height: 32, padding: "0 14px", borderRadius: 8, cursor: "pointer", fontSize: 13,
  border: "0.5px solid transparent", background: "var(--dsw-alias-state-business-primary)",
  color: "var(--dsw-alias-label-primary-foreground)",
};

/**
 * Bind the Host's configuration form to a slot component.
 *
 * The bundle configuration slot passes no form, so the component subscribes to
 * the settings form itself; a row page that does pass one keeps that form.
 * @param form - the Host form for this entry.
 * @returns the slot component.
 */
export function withForm(form: ConfigForm<ProviderConfigFields>): (props: PluginConfigViewProps) => ReactNode {
  return function ProviderConfigBound(props: PluginConfigViewProps): ReactNode {
    const snapshot = useSyncExternalStore(
      listener => form.subscribe(listener),
      () => form.getSnapshot(),
    );
    const bound: FormLike = { state: snapshot, mutate: form.mutate.bind(form) };
    return <ProviderConfigForm view={props.view} form={props.form === undefined ? bound : { state: props.form.state as FormLike["state"], mutate: props.form.mutate as FormLike["mutate"] }} />;
  };
}

/**
 * Bind the Host's configuration form to the Settings page surface.
 *
 * A settings page receives the section owner props rather than a form, so this
 * wrapper ignores them and renders the same page body.
 * @param form - the Host form for this entry.
 * @returns the settings-section component.
 */
export function withFormAsPage(form: ConfigForm<ProviderConfigFields>): () => ReactNode {
  const Bound = withForm(form);
  return function ProviderConfigSettingsPage(): ReactNode {
    return <Bound view="page" />;
  };
}

/**
 * The entry component: a one-liner in the summary view, the form in the page view.
 * @param props - the view the page asks for and its Host form.
 */
export function ProviderConfigForm(props: { view?: "summary" | "page"; form?: FormLike }): ReactNode {
  if (props.view === "summary") return "Codex executable, main-session gate and native tool bridge.";
  return <ProviderConfigPage form={props.form} />;
}

/**
 * The editable page body.
 * @param props - the Host form for this entry.
 */
function ProviderConfigPage({ form }: { form?: FormLike }): ReactNode {
  if (form === undefined) {
    return <p style={hint}>The Host has not exposed this plugin's configuration form in this composition.</p>;
  }
  if (form.state.status === "loading") return <p style={hint}>Loading configuration…</p>;
  if (form.state.status === "unavailable") {
    return <p style={hint}>The Host does not expose this plugin's configuration to the browser.</p>;
  }
  const value = (form.state.value ?? {}) as ProviderConfigFields;
  const initialAllow = (value.toolBridge?.allow ?? []).join(", ");
  return <ProviderConfigFieldsForm key={`${form.state.revision ?? "none"}:${initialAllow}`} form={form} value={value} initialAllow={initialAllow} />;
}

/** The staged editor; remounted when the accepted revision or tool list changes. */
function ProviderConfigFieldsForm({ form, value, initialAllow }: {
  form: FormLike;
  value: ProviderConfigFields;
  initialAllow: string;
}): ReactNode {
  const [command, setCommand] = useState(value.command ?? "");
  const [allowMainSession, setAllowMainSession] = useState(value.allowMainSession === true);
  const [bridgeEnabled, setBridgeEnabled] = useState(value.toolBridge?.enabled === true);
  const [allowText, setAllowText] = useState(initialAllow);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const writable = form.state.writable;
  const disabled = !writable || saving;

  /** Stage every changed field as one atomic mutation. */
  const save = async (): Promise<void> => {
    const ops: FieldOp[] = [];
    const initialCommand = value.command ?? "";
    if (command !== initialCommand) {
      ops.push(command.trim() === ""
        ? { op: "unset", path: ["command"] }
        : { op: "set", path: ["command"], value: command.trim() });
    }
    if (allowMainSession !== (value.allowMainSession === true)) {
      ops.push({ op: "set", path: ["allowMainSession"], value: allowMainSession });
    }
    if (bridgeEnabled !== (value.toolBridge?.enabled === true)) {
      ops.push({ op: "set", path: ["toolBridge", "enabled"], value: bridgeEnabled });
    }
    if (allowText.trim() !== initialAllow.trim()) {
      ops.push({ op: "set", path: ["toolBridge", "allow"], value: allowText.split(/[\s,]+/).filter(name => name !== "") });
    }
    if (ops.length === 0) {
      setStatus("No changes to save.");
      return;
    }
    setSaving(true);
    try {
      const accepted = await form.mutate(ops, form.state.revision);
      setStatus(accepted ? "Saved. A running deployment applies it immediately or on the next runtime." : "The Host refused this write.");
    } catch (error) {
      setStatus(`Save failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div style={field}>
        <label style={label} htmlFor="dsh-codex-app-command">Codex executable (command)</label>
        <input
          id="dsh-codex-app-command" style={input} value={command} disabled={disabled}
          placeholder="codex" onChange={event => setCommand(event.target.value)}
        />
        <span style={hint}>
          Run as <code>&lt;command&gt; app-server --stdio</code>. On Windows the npm shim cannot be spawned directly;
          point this at the native <code>codex.exe</code>. A new runtime reads it immediately.
        </span>
      </div>

      <div style={field}>
        <div style={toggleRow}>
          <input
            id="dsh-codex-app-main-session" type="checkbox" checked={allowMainSession} disabled={disabled}
            onChange={event => setAllowMainSession(event.target.checked)}
          />
          <label htmlFor="dsh-codex-app-main-session" style={{ ...label, marginBottom: 0 }}>
            Allow main Sessions (allowMainSession)
          </label>
        </div>
        <span style={hint}>
          Off by default: only workflow child Sessions use the route. On, <code>codex-app</code> also appears in the
          main-Session model menu. Turning it off retires a saved selection onto another route.
        </span>
      </div>

      <div style={field}>
        <div style={toggleRow}>
          <input
            id="dsh-codex-app-bridge" type="checkbox" checked={bridgeEnabled} disabled={disabled}
            onChange={event => setBridgeEnabled(event.target.checked)}
          />
          <label htmlFor="dsh-codex-app-bridge" style={{ ...label, marginBottom: 0 }}>
            Native DSH tool bridge (toolBridge.enabled)
          </label>
        </div>
        <span style={hint}>
          Exposes allow-listed DSH tools to Codex as native dynamic tools. A change reaches only new Sessions: the
          declaration is frozen on a thread at creation.
        </span>
      </div>

      <div style={field}>
        <label style={label} htmlFor="dsh-codex-app-allow">Bridged tools (toolBridge.allow)</label>
        <input
          id="dsh-codex-app-allow" style={input} value={allowText} disabled={disabled}
          placeholder="cordis_inspect_list, cordis_inspect_query, plugin_manager, plugin_market, skill, read"
          onChange={event => setAllowText(event.target.value)}
        />
        <span style={hint}>
          Exposure ceiling, comma or space separated. The shipped set is still the intersection with the tools the main
          request presents and the scoped registry; this list grants no permission by itself.
        </span>
      </div>

      <div style={saveRow}>
        <button type="button" style={{ ...saveButton, opacity: disabled ? 0.6 : 1, cursor: disabled ? "default" : "pointer" }}
          disabled={disabled} onClick={() => { void save(); }}>
          {saving ? "Saving…" : "Save"}
        </button>
        {writable ? null : <span style={{ ...hint, marginTop: 0 }}>This profile's configuration document is read-only.</span>}
        {status === null ? null : <span style={{ ...hint, marginTop: 0 }}>{status}</span>}
      </div>
    </div>
  );
}
