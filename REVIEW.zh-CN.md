# dsh-codex-app-provider 代码评审：重复实现、复杂度与不恰当实现

评审时间：2026-10-04。对象：`dsh-codex-app-provider` 0.1.1（HEAD `bef8e4c`）。
问题：这些功能点有重复实现吗？有不必要的复杂度吗？有不恰当的实现吗？

---

## 0. 结论速览

| # | 结论 | 级别 | 一句话 |
|---|---|---|---|
| D1 | `codex_workers` 与 DSH 核心 `ctx.subagents` 的可续子代理**重复实现**了同一件事 | 高 | 核心已有稳定的可续子会话、收件箱 FIFO、`sendMessage`、`interrupt`、冷恢复、目录投影 |
| B1 | 对 `profileContext` 的结构断言在 0.2.0-rc.2 上不成立 → 状态目录/默认 cwd 静默退化 | 高 | 本机 live 契约只有 4 个成员，没有 `name`/`home`/`cwd`；多 profile 会撞同一把锁 |
| B3 | 每个 token delta 触发**两次同步全量落盘** | 高 | `item/agentMessage/delta` → 两次 `publish` → 两次 `store.put`（`writeFileSync`+`rename`） |
| B2 | 静默丢弃 `GenerateOptions` 的 `temperature`/`maxTokens`/`stop` 等字段 | 高 | 违反官方 cookbook 的 `UNSUPPORTED_OPTION` 义务；用户设置静默失效 |
| B4 | 解析 Codex rollout JSONL 取用量，同步整读 | 中 | 依赖 Codex 私有文件格式，且在 create/resume 热路径上 `readFileSync` |
| B5 | 事实行里的 `full output at codex thread=… item=…` 是悬空引用 | 中 | 原始通知被丢弃，`ctx.spillStore` 未使用，引用无法解析 |
| B6 | 直接用 `node:fs` / `node:child_process` / `setTimeout` | 中 | 绕过核心的 `ctx.fs`（含 `fs/write-intent`、`fs/observed`、sandboxPolicy）/`ctx.subprocess`/`ctx.timer` |
| B11 | 事实幂等依赖可选方法 `session.snapshotEvents`，缺失时是**fail-open** | 中 | 缺该方法会把全部历史事实重复追加，而不是拒绝导入 |
| D2/D4/D5 | 同一概念在两处声明且已经漂移 | 中 | `codex:` 前缀映射三份；action 清单与字段表两份（`skills` 已漂移）；交接请求类型两份（`approvalsReviewer` 已漂移） |
| C1 | 两个巨型文件各承担 5–6 类职责 | 中 | 官方 cookbook 明确要求 wire 类型/序列化/解析/chunk 转换/adapter 分层 |
| C3 | 每次辅助调用、每次目录刷新各起一个 `codex app-server` 进程 | 中 | 标题/压缩/目录读取都另起进程 |
| C4 | 自建锁 + `/proc` 解析 + 手写校验器（505 行 store） | 中 | 平台已有 `ctx.storageDomain`（zod + 版本 + 原子 + 串行写链）与 `$DSH_HOME/storages` 约定 |
| D9 | 状态持久化整体重复核心 storage domain 的能力 | 中 | 见 C4 |
| C5–C7/B7–B10 | 常驻迁移代码、死代码、双签名 API、过时注释、硬编码核心 kind、MAC 锁退化、Codex 未文档化字段依赖 | 低 | 见下文逐条 |

我没有发现"同一功能在同一层被写了两遍"的低级复制；问题集中在**与平台既有能力重叠**，以及**契约假设未经核实**这两类。

---

## 1. 评审依据（先声明可信度）

| 依据 | 内容 |
|---|---|
| 运行中的 DSH（本机 GUI 会话） | `$DSH_HOME/dsh-runtimes/dsh-primary-runtime/runtime.json` → **desktop 0.2.0-rc.2**，darwin x64，Node 24.21.0 |
| 插件声明的兼容性 | `package.json` → `dsh.compatibility.dshReleases = { "0.1.7-rc.2": "compatible", "0.2.0-rc.2": "compatible" }` —— **0.2.0-rc.2 正是本机运行的版本** |
| 运行时契约（live，只读） | `cordis_inspect_list` / `cordis_inspect_query`：Host `Service`（`llm`、`sessions`、`userQuestions`、`subagents`、`profileContext`、`storageDomain`、`fs`、`subprocess`、`tools`、`systemPrompt`、`timer`、`spillStore` 等）与 Host `Event` 目录 |
| 官方文档 | [Adding an LLM adapter](https://deepseek-harness.github.io/deepseek-harness/en/reference/cookbook/adding-an-llm-adapter.md)、[Storage](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/storage.md)、[Session persistence](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/persistence.md)、[Subagents](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/subagent.md) |
| 版本注意 | 官方站点自述"Current official website; not pinned to your installed DSH version"。因此**契约判断以本机 live 查询为准**，文档用于最佳实践与命名。 |

---

## 2. 重复实现

### D1（高）`codex_workers` 与核心 `ctx.subagents` 重复

核心 `ctx.subagents` 已经提供"持久、可续、可发消息、可中断的子代理"这一整块能力：

| 插件功能点 | 核心既有能力（live 契约 + [Subagents 文档](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/subagent.md)） |
|---|---|
| `create`（`worker-actions.ts:92`） | `subagents.startContinuable()`：预留稳定 child id、持久化 `subagent/descriptor`、建立父子 ownership、提交首条 prompt |
| `append` / `steer`（`worker-actions.ts:106`、`113`） | `subagents.sendMessage(sender, targetId, content, options)`——文档措辞是 "the **sole** model-authored message operation" |
| `interrupt`（`worker-actions.ts:117`） | `subagents.interrupt(targetSessionId, authority)` |
| `list` / `get`（`worker-actions.ts:90`、`105`） | `subagents.listChildren()` / `listDescendants()` + `subagentCatalog` 投影 |
| `resume`（`worker-actions.ts:121`） | 可续子代理的 Activation 冷恢复由 continuation manager 拥有 |
| `reports` / `ack` / `accept`（`worker-actions.ts:91`、`127`、`130`） | `subagent/end` 事件 + 子会话自己的日志；**验收（acceptance）本就是 `dsh-workflow-kit` 的业务** |
| `report.ready` 通知与投递（`worker-delivery.ts`） | 子代理结束事件 + 父 Agent 收件箱（`agent/inbox/*`、`agent.followup`） |
| worker 记录与所有权（`store.ts` 的 `worker` 块、`backend.ts:1395` 的 `validateCaller`） | 核心的 live ownership graph + `agents.isOwnedBy()` |

此外官方 Subagents 文档列出的 Service Provider 里还有 `dsh-subagent-codex`（"用 Codex 作为子代理后端"）。**注意层次**：本条比较的对象是 `ctx.subagents` 这个 Service Definition，而非某个 provider 包；该包在本环境**未核实**（npm 元数据获取失败）。逐功能点判定、以及"哪些结论依赖哪个 provider"见 [附录 A](#附录-ad1-的替代性判定可由-ctxsubagents-替代且功能不变是否成立)。

**影响**：同一个部署里存在两套互不可见的委派系统（README 也承认 workflow child 与 `codex_workers` 互不可见），两套子会话生命周期、两套结果投递语义、两套幂等键。模型看到的工具语义也冲突：核心要求"发消息只有一个入口"，而本插件另开了一个。

**建议（按插件身份修正过）**：本插件的身份是**模型 provider**——`codex` 路由的 LLM adapter + 原生执行底座 + 三个 Host 服务；`codex_workers` 只是其中一个"委派"组件，也正是与核心重复的那一块。因此正确的收敛**不是**"把本插件改写成 `SubagentProvider`"（那会与它自己的 adapter 重复：走 `codex` 路由的 DSH 子会话本来就由本插件承载，本仓库 driver 已验证），而是把职责分开：

- **保留（provider 侧，`ctx.subagents` 无法替代）**：adapter 与模型目录、原生 thread/turn 状态机、审批与提问桥、执行事实写入会话日志、原生压缩、用量与配置对账、以及 `ctx.codexExecution` / `ctx.codexHandoff` / `ctx.codexToolGate` 三个 Host 服务。
- **移除/降级（委派侧，与核心重复）**：`codex_workers` 的委派语义（create/append/steer/interrupt/accept/ack/close）、`store` 的 worker 记录、`worker-delivery.ts`、`worker-control.ts`；交给 `ctx.subagents`（`spawn` provider + `codex` 路由）与 `dsh-workflow-kit`。逐轮 report/usage 仍可从 provider 自己的记录读（`ctx.codexExecution`），不需要 worker 注册表。
- **例外**：仅当产品明确要"Codex 原生子代理"——子代理不进入 DSH agent loop、使用 Codex 自己的提示与工具、以原生线程为载体——才保留第二套委派模型；那时应在文档中显式声明这是产品取舍，并把与核心重叠的语义（验收/ack、通用列举、第二套投递）压到最小。

### D2（低）`codex:` 前缀映射写了三遍

- `provider.ts:1324` `backendSessionId(s) = "codex:" + s`
- `handoff.ts:71` `nativeSessionId(s) = "codex:" + s`（**同一函数**）
- `handoff.ts:74` 反向 `dshSessionId`；`backend.ts:36` 同时导入两个方向

`provider.backendSessionId` 与 `handoff.nativeSessionId` 应合并为一处，否则改前缀语义必然漏改。

### D3（中）审批/提问转发重复三份

`streamMain`（`provider.ts:612`–`615`）、`streamAuxiliary`（`provider.ts:706`–`709`）、`watchWorkerRequests`（`provider.ts:825`–`829`）各写一遍同样的 `approval.requested → bridgeApproval` / `userInput.requested → bridgeUserInput` 分派。抽一个 `forwardNativeRequests(subscription)` 即可；三份分派也是漏改风险点（例如新增一类原生请求）。

### D4（中）action 清单与字段表两份，且已漂移

- `index.ts:242` `WORKER_ACTIONS` + `index.ts:199`–`209` 的工具 schema
- `worker-actions.ts:15` `WorkerActionName` + `worker-actions.ts:33` `ACTION_FIELDS`

漂移证据：`ACTION_FIELDS` 允许 `append`/`steer` 携带 `skills`（`worker-actions.ts:38`–`39`），但工具 schema 没有该字段——能力存在却无法经模型到达。应当由一处生成另一处（单一事实来源）。

### D5（中）交接类型两份，且已漂移

`handoff.ts:20` `CodexThreadHandoffRequest` 与 `browser-types.ts:119` `ThreadHandoffRequest` 字段几乎相同，但**前者缺 `approvalsReviewer`**。结果是内部路径能设、Host 服务面不能设，且类型不会报错。建议：对外类型 `Pick`/映射自内部类型，或让内部类型引用对外类型。

### D6（低）快照/报告投影两份

`SessionSnapshot`+`Report`（`browser-types.ts:28`、`208`）与 `NativeExecution`+`NativeExecutionReport`（`execution.ts:2`、`22`）是同一份数据的两种形状，转换写在 `provider.ts:417`–`430`（其中 `usage` 还从嵌套结构拍平）。作为跨边界 DTO 可以接受，但应显式声明"这是有意的发布契约"，并加一个字段对齐测试，否则每次加字段都要手动同步三处。

### D7（低–中）身份校验两层

`identity.ts:45` 手动比对 `ctx.agents.get(id)` / `ctx.sessions.get(id)` / `agent.session`，`backend.ts:1395` 又独立实现 `validateCaller`+`canAccess`。核心已建模这件事：`agents.isOwnedBy(id, owner)`、`agents.currentInitiator()`/`requireInitiator()`（live 契约）。防御性冗余本身不算错，但：
- 8 处 `revalidate()` 调用点（`worker-actions.ts:93`–`132`）+ `index.ts:216`/`219` 的 `control.ensure`，同一动作最多校验 4–6 次身份；
- 两层机制不同（一层看注册表，一层看 caller 结构），语义不完全等价。

建议：保留一层权威（推荐 core 的 `agents` 谓词），另一层收敛为一次包装调用。

### D8（低）`worker-control` 与 `worker-delivery` 两套 per-parent 注册

`worker-control.ts:48` 的 `watched: Map<sessionId, ...>` 与 `worker-delivery.ts:47` 的 `parents: Map<Agent, off>` + `sent: WeakMap<Agent, Set>`，各自订阅 `agent/disposed`、`session/disposed` 并做同类清理。若 D1 落地，这两块一并消失；若保留，应合并为一个 per-parent 注册表。

---

## 3. 不必要的复杂度

### C1（中）两个巨型文件承担过多职责

`provider.ts` 1331 行、`backend.ts` 1465 行。前者同时是：LlmAdapter、请求计划器（`planInput`）、历史渲染器（`importedInput`）、事实导入器、审批/提问桥、原生压缩编排。后者同时是：RPC 生命周期、线程状态机、worker CRUD、审批账本、报告存储、交接状态机、用量解析、gate 证据。

官方 cookbook 的明确要求："Keep wire types, request serialization, transport parsing, chunk translation, and the adapter class as separate responsibilities"。至少 `planInput`/`importedInput`/`nativeHistoryCursor`（`provider.ts:978`–`1138`）可以独立成 `history.ts`，`rolloutUsage`/`normalizeUsage`（`backend.ts:1347`–`1393`）独立成 `usage.ts`。

### C2（中）provider store 是 native 生命周期的第二份真相

DSH 的会话日志已是对话的真相源（[persistence.md](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/persistence.md)：`session/event` → 写句柄 → `flush` 屏障），而 Codex 的 thread/turn 是执行真相源；插件又维护第三份 `StoredSession`（含 `facts`、`reports`、`pending`、`applied`、`approvals`、`lastOutput`…），并在每个事件上重写它（见 B3）。其中 `approvals` 落盘后在 `recover()` 里一律被清空（`store.ts:350`、`355`），`lastOutput`/`lastUnphasedOutput` 是进程内瞬间值——这些字段的持久化没有读者。

### C3（中）进程模型偏重

- `readWithTemporaryServer`（`backend.ts:1128`）为 `modelSettings` 和交接前的 `thread/read` 各起一个 `codex app-server` 进程；目录缓存只有 30s（`provider.ts:57`），意味着长期运行时会反复拉起进程。
- `streamAuxiliary`（`provider.ts:668`）为每次标题/摘要请求创建 `codex-aux:<uuid>` 一次性会话 → 又一个进程（`backend.ts:244` → `attach` → `factory`）。

如果 Codex 的 `app-server` 支持在同一进程内开多个 ephemeral thread（`thread/start` 已有此形状），应复用主 runtime，而不是按调用起进程。

### C4（中）自建持久化与锁

`store.ts`（505 行）自己实现：目录权限、原子写、单所有者锁、`/proc/<pid>/stat` 与 `boot_id` 身份、陈旧锁回收、legacy 镜像迁移、以及一整套手写记录校验器（`parseRecord`/`validReport`/`validGate`/`validPending`…）。

平台提供的能力（[Storage](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/storage.md)）：`ctx.storageDomain.open(spec)`，域即 `{name, version, layout, compatibleVersions, invalidRecords, global, tables}`，用 **zod** 校验记录、由后端保证"每次单调用原子且落盘后 resolve"、写入经同一 per-domain 写链、`: `domain/changed` 事件、`backup-and-skip` 处理坏记录。本机磁盘布局也印证了这套约定：`$DSH_HOME/storages/workspace.json`、`$DSH_HOME/storages/session_projcache/sessions`。

也就是说：zod schema 可以替代全部手写校验器，版本/兼容/坏记录策略由域声明取代，原子性由后端取代。真正需要自研的只剩**跨进程单所有者排除**（`StorageBackend` 明确说"a unit does not serialize concurrent writes"）；而这一条也可以退化为"域 + 启动期 advisory lock"，或直接依赖域名的 `already-open`（进程内）+ 文档约定（跨进程）。

### C5（低）一次性迁移代码常驻

`store.ts:337`–`356` 的 `LegacyMirror`（旧 `events` 镜像 → `facts`）是历史版本的一次性迁移，却仍在每次加载时执行。若目标部署没有旧状态目录，应删除；若有，应做成显式的一次性 upgrade 路径（读旧写新后删除旧字段）而不是永久兼容层。

### C6（低）死代码与冗余

- `execution-events.ts:183` 的 `current` 变量只用于 `current === undefined && completed.size === 0`，而该条件等价于 `completed.size === 0`——纯冗余。
- `provider.ts:367` `noteFactChannel()` + `retiredFactChannelNoted`：一次性日志。
- `index.ts:124`–`134` 的 `unregister?.()`/`unfilter?.()`/`untool?.()`：`llm.registerAdapter` 的返回句柄文档写明 "Disposed with the fiber"，fiber 释放已覆盖；这些手写 disposer 是同类机制的第二次实现（保留 `provider.close()`/`backend.close()`/`toolGate.close()` 这类有真实进程语义的即可）。
- `provider.ts:257`–`275` `contextWindowFor` 会遍历该 owner 的全部会话记录来"学习"contextWindow，属于启发式，成本随会话数增长。

### C7（低）双签名方法可读性差

`steerTurn` / `interruptTurn` / `decideApproval` 用 `owner: string | Caller` + 位置参数互换（`backend.ts:645`–`653`、`668`–`672`、`702`–`712`）在同一签名里装两种语义。最佳实践是拆成 `…ForOwner()` / `…ForCaller()`，或接受一个显式的 `{owner}`/`{caller}` 判别对象——现在任何调用点读起来都需要回溯类型。

---

## 4. 不恰当的实现

### B1（已更正为"低"）`profileContext` 字段未经类型校验——本评审上一版的结论是错的

**更正声明**：上一版断言"live `profileContext` 没有 `name`/`home`/`cwd`，状态会落到 `state/default/` 并使两个 profile 撞同一把锁"。**该结论不成立**，实测反证如下。

插件在本机加载后，实际状态目录是：

```
/Users/slepher/.dsh/state/desktop/codex/{sessions,owner.lock}
```

也就是说 `profileContext.name === "desktop"` 在运行时**确实存在**。我是从 `cordis_inspect` 的 Service 投影（只列出 4 个带文档的成员）推断"字段不存在"，把**投影**当成了**实现**；`state/default/...` 从未出现，多 profile 撞锁的场景也没有发生。

因此本条降级为**低（健壮性，不是缺陷）**：

- 真正的问题是那处 `as { name?: string; home?: string; cwd?: string }` 是**未校验的结构化断言**：字段存在但不是非空字符串、或 `home` 不是绝对路径时，会静默退化到 `default` / `process.cwd()`。
- **已实施（P0）**：`launchedProfile` 逐字段校验（非空字符串，`home`/`cwd` 还要求绝对路径），并为 profile 名增加 `DSH_PROFILE` 环境兜底；默认布局不变，现有部署不受影响。

保留的观察（与正确性无关）：`<DSH_HOME>/state/<profile>/codex` 是插件自选布局，与平台自身的 `$DSH_HOME/storages/` 约定不同；`defaultProviderCwd` 仍以 `process.cwd()` 兜底（没有更权威的来源）。

### B2（高）静默丢弃 `GenerateOptions` 字段

live 契约：

```ts
interface GenerateOptions {
  provider; model; reasoningEffort?; messages; system?; tools?; toolHistory?;
  temperature?; maxTokens?; stop?; signal?; sessionId?; purpose?;
}
```

插件实际只读 `provider`/`model`/`reasoningEffort`/`messages`/`sessionId`/`purpose`/`signal`（`provider.ts:277`–`303`、`1281`）。`system`、`tools`、`toolHistory`、`temperature`、`maxTokens`、`stop` 全部丢弃。

官方 cookbook 的协议义务原文："A `GenerateOptions` field your provider cannot honor (e.g. a `stop` list on a provider without stop sequences): throw `LlmError(..., 'UNSUPPORTED_OPTION')` rather than silently dropping it."

- `system`/`tools`/`toolHistory` 丢弃是**有理由的**（Codex 自带 system prompt 与工具面，`context.ts` 也正为此过滤），但应写成显式能力声明并记录，而不是"没读"。
- `temperature`/`maxTokens`/`stop` 是**用户在 DSH 设置里能配的调用控制项**（`LlmCallConfig` 就有这三个字段），丢弃意味着设置静默无效——这正是文档要禁止的"accepted-then-ignored"。
- 另外 `LlmAdapter.imageRequestPricing(provider, model)` 未实现（基类返回 `undefined`），而插件会发送图片：图片请求的 token 计量因此缺失。若 Codex 不提供该信息，也应显式返回 `undefined` 并注释，而不是遗漏。

**建议**：在 `stream()` 入口对不支持的显式字段抛 `UNSUPPORTED_OPTION`；对有意忽略的 `system`/`tools`/`toolHistory` 用一处集中的 `assertSupportedOptions()` + 注释说明 Codex 自己拥有这些。

### B3（高）每个 token delta 两次同步全量落盘

路径：
- `backend.ts:913`–`916`：`item/agentMessage/delta` 命中 `startsWith("item/")` → `publish(thread.notification)` → `commitEvents` → `store.put`
- `backend.ts:926`–`927`：同一方法又命中 `item/agentMessage/delta` 分支 → `publish(turn.output)` → 再次 `store.put`
- `store.put` → `write(record)` → `persist()`：`writeFileSync(temp)` + `renameSync`（`store.ts:154`–`176`），**同步** I/O

即：模型每吐一个 delta，就有两次"序列化整条记录 + 写临时文件 + rename"。而这两次写入**没有带来任何新状态**——`record` 里没有 per-delta 字段（`lastOutput` 只在 `item/completed` 更新，`backend.ts:928`–`934`）。这是纯浪费，且随会话记录（`facts`/`reports`）增长而线性变慢，还会阻塞事件循环。

**建议**：
1. 瞬态事件不要持久化：`turn.output`/`thread.notification` 不调用 `store.put`；只在状态迁移点（turn 开始/结束、审批出现/裁决、设置更新、报告落盘）写。
2. 真要持久化高频状态，用 `ctx.storageDomain` 的 `per-record` 布局或 `sqlite` 后端（[Storage](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/storage.md)：写链串行 + 后端原子 + `domain/changed`），由平台接管批处理，而不是每个 delta 一次 `rename`。
3. 若必须自管文件，至少做写合并（microtask/`ctx.timer.debounce` 批处理）。

### B4（中）解析 Codex rollout JSONL 取用量

`rolloutUsage`（`backend.ts:1347`–`1362`）用 `readFileSync` 一次性读入 `result.thread.path` 指向的整个 rollout 文件，逐行解析 `session_meta`/`event_msg.token_count`，并在 `createSession`（`backend.ts:201`）、`createWorker`（`252`）、`resumeSession`（`329`）三处调用。

问题：
- 这是 Codex 的**私有落盘格式**（`payload`/`info`/`model_context_window`），没有任何 DSH 契约背书；Codex 改格式即静默降级为"无 usage"。
- 同步整读一个可能很大的 JSONL，在冷恢复热路径上阻塞。
- DSH 已提供用量通道：`thread/tokenUsage/updated` 通知（`backend.ts:935` 已经处理）与 `Report.usage`。冷恢复缺的是"上次已知用量"，这属于**自己的记录**，应持久化自己的 last-known usage（或读 `ctx.fs`），而不是去读别人的文件。

**建议**：删除 rollout 解析；把 `thread/tokenUsage/updated` 的最近值持久化（storage domain 的 global slot 即可），冷恢复从自己的记录恢复。

### B5（中）悬空的 "full output at …" 引用

`execution-events.ts:118`–`123` 把超过 600 字符的输出截断，并附 `… [truncated; full output at codex thread=<t> turn=<turn> item=<item> (nativeSessionId, threadId, turnId, itemId)]`。

但 `backend.ts:1094`–`1100`（`projectFacts`）在投影后把 `runtime.facts = []` 清空，磁盘记录也明确"the raw notifications are not kept"（`store.ts:72`）。因此**没有任何读者能按该引用取回全文**：它指向的是插件自己丢弃的缓冲。

平台为此提供了 `ctx.spillStore.saveText`（live 契约 `spillStore.saveText(input): Promise<SpillRef>`；文档目录亦有 [Spill storage](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/spill.md)）。Codex 的 rollout 文件里可能仍有全文，但引用没有给出路径。

**建议**：二选一——(a) 用 `ctx.spillStore` 存全文并把 `SpillRef` 写进事实行；(b) 若确认全文在 Codex rollout 中可寻，写出**该文件的绝对路径**（并说明它属于 Codex，可能在会话结束后被清理）。现在的写法是第三种：指向不存在的东西。

### B6（中）绕过核心的 fs / subprocess / timer 治理

- 状态读写：`store.ts` 全量 `node:fs`；`backend.ts:1351` `readFileSync`。
- 进程：`rpc.ts:50` `spawn("codex", ["app-server","--stdio"])`。
- 计时：`rpc.ts:111` 请求超时、`rpc.ts:135`/`136` SIGTERM/SIGKILL 延迟、`tool-gate.ts:369` socket 超时。

平台对应能力（live 契约）：`ctx.fs`（`writeText(…, expected?: FsWriteIntent, sandboxPolicy?)`、`editText`、`readText`、`streamText`，并有 `fs/write-intent`、`fs/edit-intent`、`fs/observed` 事件）、`ctx.subprocess`（`resolveExecutable`、`terminalEnvironment`、`spawn(spec)`）、`ctx.timer`（`timeout`/`interval`/`debounce`，随插件释放）。

这些服务是**可选能力**，所以直接调用 Node 不是"错误"，但在一个把 fs 与进程治理做成一等公民的平台里：
- 直接写盘不会产生 `fs/observed` 观测、不接受 `expected` 版本保护、不可被沙箱策略约束；
- 直接 `spawn` 不做可执行文件解析（`resolveExecutable` 会处理 PATH/打包运行时差异），也拿不到 `terminalEnvironment`；
- 裸 `setTimeout` 不会随插件卸载被清理（`AppServer` 的超时表在 `disconnect` 时才清；插件卸载路径依赖 `close()` 被调用）。

**建议**：状态写入与 rollout 读取改走 `ctx.fs`；Codex 进程改走 `ctx.subprocess.spawn`（至少用 `resolveExecutable` 解析命令）；定时器改走 `ctx.timer`。

### B7（中）过时的模块注释，误导维护者

`execution-events.ts:22`–`33` 的文档写着：

> "Execution facts live only in the provider's own store: stock DSH core neither persists nor reads an unknown `codex/execution` session event, so **nothing is appended to the session log**."

而 `facts.ts` 与 `provider.ts:384`–`408` 正是把事实以 `user/message` 追加进会话日志（这也确实是正确做法，与 `Session.append("user/message", data, {surfaceOp:"append"})` 的 live 签名一致）。注释描述的是被废弃的旧方案。

**建议**：改写为"事实经会话日志承载，provider store 保存原始投影"。

### B8（低–中）硬编码核心私有的 message source kind

`context.ts:7`–`11` 硬编码 `runtime-context`、`agent-instructions`、`skill-catalog`、`compact-checkpoint`、`compact-basic` 以及 form `instructions`/`catalog`/`snapshot`。这些是核心生产者的内部拼写，代码注释自己也记录了它们已经改过一次名（`plugin:'compact'` → `compact-checkpoint`），并为此保留兼容分支。

provider 侧过滤确实无法完全避免认识这些 kind，但：
- 平台提供 `systemPrompt.context(...)` / `suppressRuntimeContext()`（live 契约）等注册面，说明这些上下文是**被注册进来的**；理想做法是让"非 DSH 路由"不注册这些输入，或至少由核心提供一个"这是注入上下文"的谓词。
- 在核心没有谓词之前，应该把这份 kind 清单集中到**一个导出的常量 + 契约测试**，并配一条"未知 kind 视为保留"的规则（现在未知 kind 会被当作可见内容送给 Codex，属于 fail-open）。

### B9（低）关于 Codex 钩子的未文档化字段

`tool-gate.ts:395`–`410` 依赖 `hooks/list` 条目里的 `enabled`、`errors`、`trustStatus`、`eventName`/`hookEventName`，`pretool-client.ts:33` 输出 `hookSpecificOutput.permissionDecision`。这些是 **Codex 侧契约**，DSH 文档不背书，本仓库里唯一的验证是 `integration-gate.test.mjs`（默认 `skip`，需 `DSH_GATE_LIVE=1`）。也就是说，这条链在 CI 里是"未验证"状态。另外 `receive()` 允许 `tool_name` 为空字符串（`tool-gate.ts:312`）并把空名交给 handler，虽然 fail-closed 由 handler 决定，但空工具名通常是协议异常，建议直接 deny。

### B10（低）锁身份在 macOS 退化，README 未说明

`processStartTime`/`bootIdentity` 读 `/proc`（`store.ts:306`、`320`），在本机（darwin）恒为 undefined → `classifyOwner` 退化为"pid 存活即 live"。崩溃后残留锁仍能回收，但**pid 复用**场景无法识别。README 只声明了 hook IPC 的 Unix 限制，未提锁身份的平台差异。

### B11（中）事实导入的幂等是 fail-open

`provider.ts:384`–`403`：

```ts
const imported = new Set(importedFactIds(session.snapshotEvents?.() as … | undefined));
for (const fact of pending) { if (imported.has(fact.id)) continue; session.append("user/message", factMessage(fact), { surfaceOp: "append" }); }
```

`ProviderSessionFace.snapshotEvents` 被声明为可选（`provider.ts:65`）。若某版本/某 composition 没有这个方法，`importedFactIds(undefined)` 返回**空集**，于是每次都把 store 里的全部事实重新追加一遍——重复记录、重复计费上下文，而不是拒绝或跳过。

在 0.2.0-rc.2 上 `Session.snapshotEvents(fromSeq, toSeqExclusive)` 确实存在（live 契约），所以这不是当前活 bug；但"可选依赖缺失 → 重复导入"是错误的方向。正确做法：拿不到当前日志就**不导入**并告警一次（fail-closed），或改走核心读面 `ctx.sessionQuery.readSession(id)` / `ctx.sessionPersistence.open(id,'read')`。

---

## 5. 做得对、不建议改的部分（避免过度收敛）

- **协议义务**：`block-end` → `usage` → `finish` 的顺序正确，`finish` 之后不再产出（`provider.ts:661`–`665`）；错误走"throw `LlmError`"与"`finish {kind:'error'|'aborted'}`"两条 sanctioned 路径。
- **`replayState`**：投影为 `{response:{threadId,turnId,input}}` 并在重建历史时校验 threadId（`provider.ts:1222`–`1232`、`992`），符合 cookbook 的"最小无损 JSON 投影 + 重建时校验"。
- **会话日志写入**：`session.append("user/message", msg, { surfaceOp: "append" })` 与 live `Session.append` 签名完全一致；`MessageSourceMap` 用声明合并扩展来源 kind，是核心认可的扩展方式。
- **过滤位置**：在 `agent/pre-step` 瀑布上做，使被裁掉的消息既不进 Codex 也不落会话表面——这是正确接缝（`agent/pre-step` 的 live 签名与用法一致）。
- **seam 形状**：`ctx.approval.request` 与 `ctx.userQuestions.ask` 的调用形状与 live 契约**核对通过**——`AskUserQuestionRequest{questions,agent?,signal?}` → `AskUserQuestionAnswer{answers:[{id,selected,custom?}]}` 与插件本地结构类型一致；`ask` 要求 agent 是"live runtime root"，插件传的正是父/本会话 live Agent，方向正确。
- **网关职责**：provider 不解释 `role`、不评估策略、只搬 binding（`tool-gate.ts:266`–`284`），DSH 原生入口留给 `tools/pre-execute` 与 workflow——这是正确的分层。
- **fail-closed**：审批、提问、钩子、图片、锁、gate binding 全部选择拒绝而非猜测，方向正确。
- **交接去授权**：`handoffThread` 的"先写源标记、再 detach、再写后继，重复 requestId 幂等"（`backend.ts:475`–`555`）语义严谨，`assertThreadOwnership` 覆盖全部线程操作路径。
- **三处幂等**：`idempotencyKey`（重试同一轮）、`codex-executed:*` 消息 id（重放/冷恢复）、投递 claim key（重复事件）——分别对应三个真实重放面，不是重复造轮子。

---

## 6. 建议的收敛路线

**P0（正确性，先做）— 2026-10-04 已执行并验证**

1. **B1 → 已更正并降级**（见 §4 B1）：原结论错误；实际实施的是字段校验 + `DSH_PROFILE` 兜底，默认布局不变。
2. ✅ **B3**：`commitEvents` 不再落盘（`backend.ts`）；持久化移到三个状态迁移点——settled 的 `item/completed`、终态 `finish`、`session.uncertain`。
3. ✅ **B2**：`temperature`/`maxTokens`/`stop` 现在抛 `UNSUPPORTED_OPTION`（`assertSupportedOptions`，在 `stream()` 入口）；`imageRequestPricing` 显式声明本路由无图片定价。
4. ✅ **B11**：读不到会话日志（`snapshotEvents` 缺失）时**拒绝导入并告警一次**，不再把日志当成空的而全量重放。
5. ✅ 平台红：`test/store.test.mjs` 的 `/proc` 锁身份用例在非 Linux 上跳过（原为 macOS 上的既存失败）。

**验证结果**：`npm run build` 通过；`node --test --test-isolation=none test/*.test.mjs` → **149 tests / 146 pass / 0 fail / 3 skipped**（改动前基线 146 / 143 / 1 / 2）。新增 3 个回归用例分别锁定 B3、B2、B11，均已确认执行并通过。

**未做的部分**：LEAN-PLAN 里 P0 还列了"用 `ctx.subprocess`/`ctx.fs`/`ctx.timer` 替换自建设施"——**本次未动**。它改变 `AppServer` 的构造与测试接缝（测试直接 `new AppServer(...)`、后端工厂签名 `(options?) => BackendTransport`），属于需要单独一轮的 P0b/P1，风险与本次四项不同。

**P1（架构收敛）**
5. D1：`codex_workers` 改为 `SubagentProvider`（或复用 `dsh-subagent-codex`），删除 worker store/投递/控制三件套。
6. B4/B6：删 rollout 解析；状态与读取改走 `ctx.fs`，进程改走 `ctx.subprocess`，计时改 `ctx.timer`。
7. C4/D9：`store.ts` 迁移到 `ctx.storageDomain`（zod 声明取代手写校验器），只保留跨进程排除。
8. C1：按 cookbook 分层拆 `provider.ts`/`backend.ts`。

**P2（一致性）**
9. D2/D4/D5：id 映射、action 表、交接类型各自单一事实来源并加对齐测试。
10. D3/D7/D8：抽公共分派器与身份包装，去掉逐点重复。
11. B5/B7/B8/C5/C6：悬空引用、过时注释、kind 清单集中化、一次性迁移、死代码。

---

## 7. 未验证 / 不可核验

1. **Codex 侧契约**（`app-server` 方法名与参数、`hooks/list` 的 `trustStatus`/`enabled`/`errors`、PreToolUse 的 `permissionDecision` 形状）没有任何 DSH 文档背书；本仓库唯一的验证是默认跳过的 live 测试。本评审不判断它们对错，只指出"未受保护"。
2. **性能结论**（B3 的每 delta 两次写、C3 的进程开销、B4 的整读）来自静态代码阅读，**未实测**。
3. **官方文档与运行版本可能不一致**：站点自述未锁定版本；本评审的契约判断以本机 live 查询（0.2.0-rc.2）为准，文档仅用于最佳实践。
4. `ctx.provide(...)`（`index.ts:148`）的语义（是否 fiber 作用域、是否与 `ctx.set` 等价）本次未核实；C6 中"手写 disposer 冗余"的结论只对 `llm.registerAdapter`（文档明写 "Disposed with the fiber"）成立。
5. `tool-gate` 的 socket 协议与 `pretool-client` 的 3s 超时/100KB 上限是自洽的，但未与 Codex 的 hook 超时语义对照验证。
6. 本评审未运行任何构建或测试；所有"应当"结论都基于上述 live 契约与官方文档。

---

## 8. 本次使用的官方页面与运行时契约

**官方文档**（站点自述未锁定版本）：[Adding an LLM adapter](https://deepseek-harness.github.io/deepseek-harness/en/reference/cookbook/adding-an-llm-adapter.md) · [Storage](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/storage.md) · [Session persistence](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/persistence.md) · [Subagents](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/subagent.md)

**运行时契约**（`cordis_inspect`，本机 0.2.0-rc.2）：Host Service `llm`（`registerAdapter`、`GenerateOptions`、`LlmAdapter`、`LlmCallConfig`）、`sessions`（`Session.append/snapshotEvents/deriveMessages`、`SessionEventMap`、`SurfaceOp`）、`userQuestions`（`ask`/`askTimed`/`answer`、`AskUserQuestion*`）、`subagents`（`startContinuable`/`sendMessage`/`interrupt`/`listChildren`/`listDescendants`）、`profileContext`、`storageDomain`/`storage`、`fs`、`subprocess`、`tools`、`systemPrompt`、`timer`、`spillStore`、`spillStore.saveText`；Host Event 目录（`agent/pre-step`、`agent/status`、`agent/created`、`agent/disposed`、`session/disposed`、`session/event`、`session/flush`、`tools/pre-execute`、`approval/request`、`user-questions/request`、`subagent/start|end`、`fs/write-intent`、`domain/changed` 等）。

**本机事实**：`runtime.json` → desktop 0.2.0-rc.2；`$DSH_HOME` = `/Users/slepher/.dsh`，其下为 `dsh-runtimes/ profiles/ sessions/ storages/`，**无 `state/` 目录**；profile 为 `desktop`。

---

## 附录 A：D1 的替代性判定——"可由 ctx.subagents 替代且功能不变"是否成立

结论：**不能声称"功能不变"**。准确表述是"执行与生命周期这一层可由 `ctx.subagents` 承载；逐轮结构化报告、验收/ack、按 turn 寻址三项没有对应物；且子任务载体从原生线程变为 DSH 子会话"。

### A.1 先澄清比较对象（三层，不可混说）

| 层 | 是什么 | 本次比较的角色 |
|---|---|---|
| Service Definition | `ctx.subagents`（包 `dsh-subagent`）：provider 注册表 + continuation manager + 可续子会话生命周期 + catalog + 控制工具的消费面 | **这才是比较对象** |
| Service Provider（多名并存，注册式） | `spawn-in-process`、`fork-in-process`、`acp`、`codex`、`claude-code`、`dsh-sdk`；可续路径下 provider 只实现 `prepareContinuable?()` | 只在"用哪种 transport"这一维度参与 |
| Consumers（模型面工具） | `subagent` / `subagent_fork`（一次性）与 `send_message` / `interrupt_agent` / `list_agents`（可续控制） | 决定工具面是否等价 |

`dsh-subagent-codex` 属于第二层的一个 provider 包，**不是**本次比较对象。官方 [Subagents](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/subagent.md) 文档把它列为 sibling provider；**本环境未能核实该包**：`dsh_plugins_fetch` 对 `@deepseek-ai/dsh-subagent-codex` 与 `@deepseek-ai/dsh-subagent` 均返回 `fetch failed`（检索错误，非 404），因此既不能断言其存在，也不能断言其可用性。

### A.2 逐功能点判定

| `codex_workers` | `ctx.subagents`（Service Definition）对应 | 判定 |
|---|---|---|
| `create`（`workerId?`/`name`/`cwd`/`model`/`effort`） | `startContinuable({provider, label, childId?, request, signal})`；`request.agentOptions = {provider?, model?, reasoningEffort?, maxTokens?}` | **等价**（`childId?` 支持指定 id；无 `cwd` 字段，cwd 来自父会话 header 或 `execution` 扩展） |
| `append`（idle 新 turn） | `sendMessage`：idle → 起一轮 | **等价** |
| `steer`（turn 内注入） | `sendMessage`：running → "admit at the nearest step boundary" | **等价**，但不接受 `turnId` |
| `resume` | 冷恢复由 manager 拥有（fold descriptor → `ctx.agents.resume()`，**不经过 provider**） | **等价且更完整** |
| `interrupt(workerId, turnId)` | `interrupt(childSessionId, authority)`：fire-and-return；未 claim 的队列保留；absent = no-op | **近似**：子会话级而非 turn 级；已结束目标是静默 no-op |
| `list` / `get` | `listChildren` / `listDescendants` / `subagentCatalog`（`activity: 'running' \| 'inactive'`） | **近似**：结构更全（父/深度/诊断），模型面状态更粗 |
| `reports`（每 turn 结构化成品 + usage） | Activation settle 时**无条件**投递一条 `subagent-settled` notice（带最终 assistant 文本，或 "It left no closing message."） | **有缺口**：每个 epoch 一次而非每 turn 一次；无可续路径的结果包装（文档："No continuable path creates a Task or an intermediate result-bearing wrapper"） |
| 报告唤醒父 Agent（followup / pre-step，claim 一次） | 同一条 settle notice "reaches a resident parent through the same waking Agent delivery" | **等价**，且替代后 `worker-delivery.ts` 的整套"认领一次"机制不再需要 |
| `ack` / `accept(acceptance)` | 无 | **缺失**（属 `dsh-workflow-kit` 的业务） |
| 未知态 fail-closed（"unknown; do not redispatch"） | 持久化在冷恢复时修复中断轮（synthetic `turn/end{interrupted}`） | **语义不同**（核心"修复并继续" vs 插件"拒绝直到确认"） |
| worker 原生审批/提问桥到父答案者 | 子 Agent 即 live runtime root，直接走 `ctx.approval` / `ctx.userQuestions` | **等价且更简单** |

### A.3 结论依赖哪个 provider（上一条回答里被我混说的地方）

- 上表除最后两行外，**全部来自 Service Definition**，与 provider 选择无关，因此"执行与生命周期可由 `ctx.subagents` 承载"成立。
- "用本插件既有读面 `ctx.codexExecution.read(childId)` 重建逐轮 report/usage"**只对一种组合成立**：`provider: "spawn"` + 子代理 `agentOptions.provider = "codex"`。此时子代理是 DSH 子会话、其模型调用走本插件的 codex adapter，provider 记录按子会话 id 存在。本仓库 driver 正是该组合：`test/native-child-driver.mjs:51`–`56`（`startContinuable({provider:"spawn", …, agentOptions:{provider:"codex", model, reasoningEffort, execution}})`），并用 `ctx.codexExecution.read(childId)` 断言。
- 若改用任何**外部 Codex provider**（如文档中的 `dsh-subagent-codex`），子代理的 Codex 执行不经过本插件 adapter，`ctx.codexExecution` 下没有该子会话记录，上述重建路径失效。

### A.4 目标 profile 的工具面限制（未在正文说明）

`codex_workers` 的替代还包括"模型面工具等价"。本机 live `listTools` 显示：`send_message`、`list_agents`、`interrupt_agent` 三个名字的 description **都是 Agent Teams 语义**（"Send one durable message to another Team member" / "List the Lead and every durable teammate" / "Interrupt one teammate's current turn while preserving its pending inbox. Team Lead only."）。也就是说，本 profile 里 `dsh-tool-subagent-control` 的三个可续控制入口被 Agent Teams 占了名字。**服务在、控件不在**，因此"工具面替代"必须按目标 composition 重新确认，不能默认可用。

### A.5 若坚持字面"功能不变"

需要在 `ctx.subagents` 之上补三块薄层：每轮报告（可从子会话日志或 spawn+codex 组合下的 `ctx.codexExecution` 派生）、验收/ack（交给 workflow 或删除这两个 action）、turn 寻址（改为子会话当前轮）。补完之后，其实等价于"在 seam 之上重写一个 `codex_workers`"，因此更可取的结论是：让 `SubagentProvider` 承担 transport，delegation 语义交给核心与 workflow，不再保留第二套并行委派系统。

### A.6 未核实项（本附录特有）

1. `dsh-subagent-codex` 的存在与契约：npm 元数据获取失败，未核实。
2. `spawn` provider 在目标部署的可用性：本仓库 driver 依赖它，但那是测试 profile 的 composition。
3. 各判定为静态（契约 + 文档 + driver 代码）结论，**未运行任何测试**。

---

## 附录 B：P0b 执行后的更正（2026-10-04）

正文 §3 B6 与 §4 B4/B6 中关于"改用内置 API"的三条判断，执行 P0b 时用行为探针复核，结果如下；
详细证据见 [LEAN-PLAN §8](LEAN-PLAN.zh-CN.md)。

| 原判断 | 复核结果 |
|---|---|
| B6：进程改走 `ctx.subprocess` | **成立且已实施**（本 profile 实测 `LocalSubprocessRuntime`；`codex_workers` 全链路 live 通过） |
| B6：计时改走 `ctx.timer` | **部分成立**：`rpc.ts` 的三处计时器已改；`tool-gate.ts:369` 是 `net.Socket#setTimeout`，**不是**裸计时器，不改 |
| B6：状态写入改走 `ctx.fs` | **不成立**：`ctx.fs` 在 `workspace-write` 下拒绝写 `$DSH_HOME/state/**`（实测 `FS_SANDBOX_DENIED`），且没有锁/目录原语。`store.ts` 保留 `node:fs`，收敛目标是 `ctx.storageDomain`（P2） |
| B4：删除 rollout 解析，持久化自己的 last-known usage | **已实施**；usage 的唯一来源是 `thread/tokenUsage/updated`，并新增冷恢复回归用例 |

另外：正文 §1 的"live 契约"清单来自 `cordis_inspect` 的 Service 投影，本次改为在插件 `apply()` 内
`ctx.get(name)` 实测——投影证明"契约存在"，不证明"这个 composition 里装的是它"。
