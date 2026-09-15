/**
 * Client CSS owned by this plugin.
 *
 * The same-package client half is bundled by esbuild without a CSS pipeline, so
 * the styles are injected once at first render instead of shipping a separate
 * stylesheet the deployment loader would never fetch.
 */
const PLUGIN_CSS_ID = "dsh-codex-app-provider";

const CSS = `
.codex-child {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  gap: 8px;
  padding: 8px;
}
.codex-child-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.codex-child-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-primary);
}
.codex-child-action {
  flex: none;
  height: 28px;
  padding: 0 10px;
  border: none;
  border-radius: 14px;
  background: var(--dsw-alias-bg-module-platform);
  font: inherit;
  font-size: 12px;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
}
.codex-child-action:disabled {
  opacity: 0.5;
  cursor: default;
}
.codex-child-open {
  border: none;
  background: none;
  padding: 0 6px;
  font: inherit;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
.codex-child-open:hover {
  color: var(--dsw-alias-label-primary);
}
.codex-child-error {
  font-size: 12px;
  color: var(--dsw-alias-label-error);
}
.codex-child-approval {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
}
.codex-child-questions {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.codex-child-question {
  display: flex;
  flex-direction: column;
  gap: 6px;
  border-radius: 10px;
  padding: 8px;
  background: var(--dsw-alias-bg-module-platform);
}
.codex-child-question-text {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-primary);
}
.codex-child-log {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.codex-child-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  border-radius: 10px;
  padding: 6px 8px;
  background: var(--dsw-alias-bg-module-platform);
}
.codex-child-row > header {
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
}
.codex-child-row > pre {
  margin: 0;
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--dsw-alias-label-primary);
}
.codex-child-composer {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.codex-child-input {
  width: 100%;
  resize: vertical;
  border-radius: 10px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  background: transparent;
  padding: 6px 8px;
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-primary);
}
.codex-child-actions {
  display: flex;
  gap: 6px;
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
