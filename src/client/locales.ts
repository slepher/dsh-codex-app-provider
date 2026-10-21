/**
 * Copy for the browser configuration surface, in the two shipped languages.
 *
 * The keys are shared by every surface (bundle section, row page, Settings page)
 * so a label never drifts between them. `en` is also the fallback a direct mount
 * renders when no locale is bound.
 * @module dsh-codex-app-provider/client/locales
 */

export const zh = {
  nav: "Codex 应用",
  summary: "Codex 可执行文件、主会话门禁与原生工具桥。",
  commandLabel: "Codex 可执行文件（command）",
  commandHint: "以 <command> app-server --stdio 运行。Windows 上 npm 的 shim 无法被直接 spawn，请指向原生 codex.exe；新的 App Server 运行时会读取该值。",
  allowMainLabel: "允许主会话使用（allowMainSession）",
  allowMainHint: "默认关闭：只有工作流子会话使用该路由。打开后 codex-app 也会出现在主会话的模型菜单；关闭时会把已保存的选择迁移到其它可用路由。",
  bridgeLabel: "原生 DSH 工具桥（toolBridge.enabled）",
  bridgeHint: "把 allow 内的 DSH 工具作为原生 dynamic tool 暴露给 Codex。变更只对新建会话生效：声明在线程创建时冻结。",
  allowLabel: "桥接工具（toolBridge.allow）",
  allowHint: "暴露上限，逗号或空格分隔。实际集合仍是它与主请求已呈现工具、当前作用域注册表的交集；该列表本身不授予权限。",
  save: "保存",
  saving: "正在保存…",
  noChanges: "没有改动。",
  saved: "已保存。运行中的部署会立即生效，或在下一个运行时生效。",
  refused: "Host 拒绝了这次写入。",
  saveFailed: "保存失败：",
  loading: "正在读取配置…",
  unavailable: "Host 未向浏览器暴露该插件的配置。",
  missing: "当前组合没有提供该插件的配置表单。",
  readonly: "该 profile 的配置文档是只读的。",
};

export type CodexAppCopy = typeof zh;

export const en: CodexAppCopy = {
  nav: "Codex app",
  summary: "Codex executable, main-session gate and native tool bridge.",
  commandLabel: "Codex executable (command)",
  commandHint: "Run as <command> app-server --stdio. On Windows the npm shim cannot be spawned directly; point this at the native codex.exe. A new App Server runtime reads it immediately.",
  allowMainLabel: "Allow main Sessions (allowMainSession)",
  allowMainHint: "Off by default: only workflow child Sessions use the route. On, codex-app also appears in the main-Session model menu. Turning it off retires a saved selection onto another route.",
  bridgeLabel: "Native DSH tool bridge (toolBridge.enabled)",
  bridgeHint: "Exposes allow-listed DSH tools to Codex as native dynamic tools. A change reaches only new Sessions: the declaration is frozen on a thread at creation.",
  allowLabel: "Bridged tools (toolBridge.allow)",
  allowHint: "Exposure ceiling, comma or space separated. The shipped set is still the intersection with the tools the main request presents and the scoped registry; this list grants no permission by itself.",
  save: "Save",
  saving: "Saving…",
  noChanges: "No changes to save.",
  saved: "Saved. A running deployment applies it immediately or on the next runtime.",
  refused: "The Host refused this write.",
  saveFailed: "Save failed: ",
  loading: "Loading configuration…",
  unavailable: "The Host does not expose this plugin's configuration to the browser.",
  missing: "The current composition provides no configuration form for this plugin.",
  readonly: "This profile's configuration document is read-only.",
};
