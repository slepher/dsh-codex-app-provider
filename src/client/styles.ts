/**
 * Client CSS owned by this plugin.
 *
 * The same-package client half is bundled by esbuild without a CSS pipeline, so
 * the styles are injected once at first render instead of shipping a separate
 * stylesheet the deployment loader would never fetch. The row geometry, tokens,
 * selector pill and menu card mirror the native settings rows and menu
 * (`settings.general.item`, ui-primitives Menu): the contributor owns its own
 * padding and separator.
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
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 12px;
  height: 36px;
  padding: 0 14px;
  border: none;
  border-radius: 18px;
  background: var(--dsw-alias-bg-module-platform);
  font: inherit;
  font-size: 14px;
  line-height: 22px;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
}
.codex-setting-selector:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
}
.codex-setting-selector:disabled {
  cursor: default;
  color: var(--dsw-alias-label-tertiary);
}
.codex-setting-chevron {
  flex: none;
}
/* Menu card (ui-primitives Menu): r20, 4px inset padding, prominent elevation. */
.codex-setting-menu {
  position: fixed;
  z-index: 1100;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  min-width: 218px;
  max-width: calc(100vw - 24px);
  padding: 4px;
  border: 0;
  border-radius: 20px;
  background: var(--dsw-specific-menu);
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
  box-shadow: var(--dsw-elevation-prominent);
  outline: none;
}
/* Menu cell (ui-primitives Menu .item): min-h 40, r10, 8/10 padding, trailing check. */
.codex-setting-option {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 40px;
  padding: 8px 10px;
  border: none;
  border-radius: 10px;
  background: transparent;
  cursor: pointer;
  font: inherit;
  font-size: 14px;
  line-height: 22px;
  color: var(--dsw-alias-label-primary);
  text-align: left;
}
.codex-setting-option[data-active='true'] {
  background: var(--dsw-alias-interactive-bg-hover);
}
.codex-setting-option-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.codex-setting-check {
  flex: none;
  color: var(--dsw-alias-label-primary);
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
