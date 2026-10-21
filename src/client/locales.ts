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
  commandLabel: "Codex 可执行文件（command，留空自动探测）",
  commandHint: "留空即自动探测：在当前系统 PATH 中查找可用的 Codex；Windows 上 npm 的 .cmd shim 会解析到它随包自带的原生 codex.exe（隐藏窗口、启动更快），没有原生二进制时才退回 Node 运行 JS 入口。只有探测失败、或需要覆盖已安装版本时才填写。",
  commandPlaceholder: "自动探测",
  checkTitle: "Codex 可用性",
  checkRun: "主动检测",
  checkRunning: "正在检测…",
  checkNever: "尚未检测。首次打开会自动检测一次，之后使用缓存结果。",
  checkSource: "来源",
  checkProgram: "可执行文件",
  checkVersion: "版本",
  checkModels: "可用模型",
  checkAt: "检测时间",
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
  commandLabel: "Codex executable (command, blank auto-detects)",
  commandHint: "Leave it blank to detect: the plugin searches this system's PATH for a usable Codex, and on Windows resolves an npm .cmd shim to the native codex.exe its package ships (hidden window, faster start); only without a native binary does it fall back to running the JavaScript entry with Node. Set it only when detection fails or you need to override the installed version.",
  commandPlaceholder: "auto-detect",
  checkTitle: "Codex availability",
  checkRun: "Check now",
  checkRunning: "Checking…",
  checkNever: "Not checked yet. Opening this page checks once; later opens reuse the cached answer.",
  checkSource: "Source",
  checkProgram: "Executable",
  checkVersion: "Version",
  checkModels: "Available models",
  checkAt: "Checked at",
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
