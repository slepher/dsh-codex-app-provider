/**
 * Client CSS owned by this plugin.
 *
 * The same-package client half is bundled by esbuild without a CSS pipeline, so
 * the styles are injected once at first render instead of shipping a separate
 * stylesheet the deployment loader would never fetch. The row geometry, tokens
 * and selector pill mirror the native settings rows (`settings.general.item`),
 * which own their own padding and separator.
 */
const PLUGIN_CSS_ID = "dsh-codex-app-provider";

const CSS = `
.codex-setting-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 16px 0;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}
.codex-setting-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-right: 48px;
}
.codex-setting-title {
  font-size: 14px;
  font-weight: 400;
  line-height: 22px;
  color: var(--dsw-alias-label-primary);
}
.codex-setting-desc {
  font-size: 12px;
  font-weight: 400;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.codex-setting-error {
  font-size: 12px;
  font-weight: 400;
  line-height: 18px;
  color: var(--dsw-alias-label-error);
}
.codex-setting-selector {
  position: relative;
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 12px;
  height: 36px;
  padding: 0 14px;
  border-radius: 18px;
  background: var(--dsw-alias-bg-module-platform);
  font: inherit;
  font-size: 14px;
  line-height: 22px;
  color: var(--dsw-alias-label-primary);
}
.codex-setting-selector:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.codex-setting-selector:focus-within {
  outline: 2px solid var(--dsw-alias-border-focus, var(--dsw-alias-label-primary));
  outline-offset: 2px;
}
.codex-setting-selector[data-disabled='true'] {
  color: var(--dsw-alias-label-tertiary);
}
/* The native select keeps its keyboard, wheel and assistive behavior; only its
 * own chrome is hidden so the pill above is what the user sees. */
.codex-setting-control {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  border: 0;
  padding: 0;
  opacity: 0;
  appearance: none;
  cursor: pointer;
}
.codex-setting-control:disabled {
  cursor: default;
}
.codex-setting-chevron {
  flex: none;
  color: var(--dsw-alias-label-tertiary);
}
`;

/** Install the plugin stylesheet once per document. */
export function installClientStyles(): void {
  if (typeof document === "undefined") return;
  if (document.querySelector(`style[data-plugin-css="${PLUGIN_CSS_ID}"]`) !== null) return;
  const tag = document.createElement("style");
  tag.setAttribute("data-plugin-css", PLUGIN_CSS_ID);
  tag.textContent = CSS;
  document.head.append(tag);
}
