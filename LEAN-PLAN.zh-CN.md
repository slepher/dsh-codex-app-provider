# 把 dsh-codex-app-provider 收敛为"模型接入项"的精简方案

问题：作为模型接入项是否过于复杂？哪些功能可以交给 DSH 内置 API？
结论：**是的，明显过重**。当前 19 个文件 / 5875 行里，属于"Codex 作为模型路由"本身的约 **1800–2100 行**；其余是自建平台设施（~1000 行）、委派组件（~500 行）、面向 workflow 的 Host 能力（~800 行）和用户可选面（执行事实/原生压缩）。以下是逐项处置。

依据：官方 [Adding an LLM adapter](https://deepseek-harness.github.io/deepseek-harness/en/reference/cookbook/adding-an-llm-adapter.md)、[Storage](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/storage.md)、[Session persistence](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/persistence.md)、[Subagents](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/subagent.md)，以及本机 live 契约（desktop 0.2.0-rc.2）的 `llm` / `subprocess` / `fs` / `timer` / `agents` / `storageDomain` / `sessionQuery` / `sessionPersistence` / `spillStore` / `subagents`。**未运行任何构建或测试；行数为估算。**

---

## 1. 不可替代的复杂度（模型路由的"翻译层"）

这三件事 DSH 没有对应 API，因为 Codex 是一个**自带 agent loop 的外部执行者**，而 DSH 的 adapter 契约假设"模型只返回文本与工具调用、执行由 DSH 完成"：

| 能力 | 为什么必须自带 | 现有实现 |
|---|---|---|
| 原生会话/线程身份与冷恢复 | DSH 不知道 Codex 的 thread/turn；`replayState` 是唯一官方接缝 | `provider.ts` 计划器 + `backend.ts` 线程状态机 |
| 外部执行的语义翻译 | DSH 的会话日志看不到 Codex 执行了什么；Codex 的 item 语义只有本插件认识 | `execution-events.ts` → `facts.ts` |
| 原生请求（审批/提问/权限）映射到 DSH seam | Codex 会向用户提问；不转发就会死锁或伪造同意 | `provider.ts` 的 `bridgeApproval` / `bridgeUserInput`（走 `ctx.approval` / `ctx.userQuestions`，**这两个内置 API 已经在用**） |
| stdio JSON-RPC 的协议编排 | `app-server` 是 stdio 协议；`initialize` 握手、请求关联、超时、uncertain 语义 | `rpc.ts`（**进程管理可交给内置 API**，见 §2） |

所以"复杂"的**根源**是 Codex 的形态，不是实现选择；但把这三件事写清楚，不需要 5900 行。

---

## 2. 可以交给内置 API 的（已核实契约）

| 现有实现 | 内置 API（live 契约） | 处置 |
|---|---|---|
| `store.ts` 505 行：目录权限、原子写、单所有者锁、`/proc` 身份、手写校验器 | **`ctx.storageDomain.open(spec)`**：zod 校验、`version`/`compatibleVersions`、原子写链、`invalidRecords`、`domain/changed`；后端注册为 `json`/`sqlite`；本机已在使用（`$DSH_HOME/storages/workspace.json`、`storages/session_projcache/`） | 记录层迁移到域；只保留"跨进程单所有者排除"这一条（后端契约明确不串行化并发写） |
| `rpc.ts`：`node:child_process.spawn`、1s/3s 杀进程梯度、超时表 | **`ctx.subprocess.spawn(spec)`**：`SubprocessSpawnSpec{argv,cwd,stdio:{stdin:'pipe',stdout:'pipe',stderr:…},graceMs,env,signal}` → `SubprocessHandle{stdin,stdout,stderr,collected,done,terminate(),waitForExit()}`；服务释放时终止其管理的全部进程 | 保留 JSON 帧/请求关联/超时/uncertain；进程与终止梯度交出去（`stderr` 还可用 `collect` 模式自动带 spill） |
| `node:fs` 写记录、读 rollout | **`ctx.fs`**（`readText`/`writeText(expected)`/`editText`/`stat`，并有 `fs/write-intent`、`fs/observed`） | 状态写入与文件读取走 `ctx.fs`（rollout 解析本身建议删掉，见 §4） |
| 裸 `setTimeout` | **`ctx.timer`**（`timeout`/`interval`/`debounce`，随插件释放） | 请求超时、目录 TTL 改用它 |
| `identity.ts` 61 行手工注册表比对 | **`ctx.agents`**（`get`/`isOwnedBy`/`currentInitiator`/`requireInitiator`）+ 工具执行的 `execution.agent` | 随委派组件一起删除；若保留也应收敛成一次包装 |
| `session.snapshotEvents?.()`（可选依赖，缺失即失去幂等） | **`ctx.sessionQuery.readSession(id)`**（live-preferred）或 **`ctx.sessionPersistence.open(id,'read')`** 句柄 | 事实导入的"已导入 id"读取改走这里，去掉 fail-open |
| 600 字截断 + `full output at codex thread=… item=…`（悬空引用） | **`ctx.spillStore.saveText`** | 长输出存 spill，事实行写 `SpillRef` |
| `codex_workers` + worker store/投递/控制（~500 行） | **`ctx.subagents`**（`startContinuable`/`sendMessage`/`interrupt`，spawn provider + `codex` 路由） | 删除，见 REVIEW 附录 A |

> 注意：`ctx.subprocess` / `ctx.fs` / `storageDomain` 都是**可选能力服务**，使用前需 `ctx.get()` 判空或声明依赖；这本身就是"交给内置 API"的代价（也是好处：能力可被替换、可远程）。

---

## 3. 与"模型接入"无关、可整块删除的

| 组件 | 行数 | 为什么可以删 | 删除的代价 |
|---|---|---|---|
| `worker-actions.ts` + `worker-delivery.ts` + `worker-control.ts` + `identity.ts` | 497 | 委派语义已由 `ctx.subagents` 承载 | 失去"不装 workflow 也能开普通 worker"的能力；相关 9+4+1 个测试用例一并删除 |
| `codex_workers` 的 `store` 分支与 `backend` 的 worker CRUD | ~150（散落） | 同上 | 同上 |
| `tool-gate.ts` + `pretool-client.ts` + `codexToolGate` | 591 | 这是 workflow 会话闸门的**传输**，不是模型接入 | workflow 的 role 门禁在 Codex 侧失效（DSH 原生 `tools/pre-execute` 路径不受影响） |
| `handoff.ts` + `codexHandoff` + store 交接字段 | 79 + ~120 | 交接是 workflow 的"后继者"模式需要的能力 | workflow 无法把同一 Codex 线程交给后继子代理 |
| `codexExecution`（`execution.ts`） | 61 + ~30 | 只读执行面；工作流/driver 在读 | 外部消费者失去读面（包括本仓库 driver 的断言） |
| `browser-types.ts` 的类型面 | 355 → ~120 | 随 worker/handoff 一起裁掉 | 无 |
| 原生压缩（`compactNativeThread`） | ~80 | 可选：Codex 自己会管上下文；DSH 压缩只需辅助摘要 | 原生线程上下文持续增长，长会话成本上升 |

**决策点**：`codexExecution` / `codexHandoff` / `codexToolGate` 三者都**不是**模型路由的正确性所需，而是"让别的插件理解/约束 Codex 会话"的接口。删它们会让插件变小，但会连带削弱 `dsh-workflow-kit` 的能力。建议：**保留 `codexExecution`（便宜且是读面），把 `codexHandoff` 与 `codexToolGate` 移到独立的可选插件**（谁需要谁装）。

---

## 4. 一个结构性简化（收益最大）

**线程身份已经在 DSH 会话日志里**：`finish.replayState` 携带 `threadId`，`planInput` 已经在用它做历史边界判定（`provider.ts:992`、`1222`）。也就是说，`store` 里那份 `threadId` 是**副本**——冷恢复所需的身份信息本可以从会话日志推导（cookbook 的意图正是如此："If the provider requires response ids… emit the minimal lossless-JSON projection as finish.replayState"）。

同理，**执行事实不需要先缓冲后投影**：现在 `runtime.facts` 收集整个 turn、在终态 `projectFacts` 时一次性写入；其实可以在每个 item 完成时直接 `session.append('user/message', factMessage, {surfaceOp:'append'})`（幂等键已经是消息 id），于是 provider store 的 `facts` 字段、legacy 镜像迁移、turn 末投影全部消失。

若这两条成立，`store.ts` 剩下的需求只有：`pending`/`applied` 配置对账、`reports`/`usage`、跨进程排除。前两者可以进一个小域（`global` slot 或 per-record），后者在部署层用一条 advisory lock 解决。

**但必须验证**（我未运行测试）：完全无 store 的冷恢复是否可靠，取决于 `replayState` 的跨进程传递语义与"同一 adapter 注册"的判定。建议先用一个测试证明"删掉 store 的 threadId 后仍能 resume"，再动结构。

---

## 5. 目标形态与规模

| 文件 | 现在 | 精简后（估） | 说明 |
|---|---|---|---|
| `provider.ts` | 1331 | ~700 | adapter + stream + 辅助/压缩 + 历史计划 + 审批/提问桥 + 读面 |
| `backend.ts` | 1465 | ~450 | 会话/线程状态机 + 通知路由 + 审批账本 + 用量（去掉 worker/handoff/gate） |
| `store.ts` | 505 | 0–120 | 交给 `ctx.storageDomain`，只留跨进程排除 |
| `rpc.ts` | 157 | ~140 | 协议编排；进程管理交给 `ctx.subprocess` |
| `context.ts` | 87 | ~70 | 保留（kind 清单集中化） |
| `execution-inputs.ts` | 105 | ~80 | 保留（受管子代理的 boundary 语义） |
| `execution-events.ts` + `facts.ts` | 353 | ~230 | 保留执行事实（审计/UI 需要），否则可删 |
| `models.ts` | 28 | 28 | 保留 |
| `index.ts` | 261 | ~80 | 入口只剩 adapter + bridge + filter + 少量服务 |
| 其余（tool-gate/pretool-client/worker-*/identity/handoff/execution/browser-types 大部分） | ~1500 | 0–60 | 删除或移出为可选插件 |
| **合计** | **5875** | **约 1800–2100（-65%）** | 含执行事实；不含则约 1600 |

---

## 6. 建议路径

1. **P0（不改架构，先止损）— 2026-10-04 已执行**：停掉瞬态事件的落盘（B3）；对不支持选项抛 `UNSUPPORTED_OPTION` 并显式声明无图片定价（B2）；事实导入改 fail-closed（B11）；`profileContext` 字段改为校验读取 + `DSH_PROFILE` 兜底。
   **尚未执行**：用 `ctx.subprocess`/`ctx.fs`/`ctx.timer` 替换自建设施——它会改动 `AppServer` 的构造与测试接缝，单列一轮（P0b）。
2. **P1（减面）**：删除 `codex_workers` 全家（委派交给 `ctx.subagents` + workflow）；`codexHandoff`/`codexToolGate` 拆成独立可选插件。
3. **P2（去状态）**：验证 replayState 冷恢复与"item 完成即 append"后，把 `store.ts` 迁到 `ctx.storageDomain`，只保留跨进程排除。

每步都能独立交付，且第 1 步不改变任何对外能力。

---

## 7. 未核实项

1. 完全无 store 的冷恢复（replayState 跨进程语义）：**未验证**，需测试证明。
2. 行数为估算，未实际重构。
3. `ctx.subprocess` 的具体 provider 实现是否已在本 profile 加载：契约已核实，**加载状态未核实**（`subprocess` 是可选能力服务）。
4. 官方文档未锁定版本；契约判断以本机 0.2.0-rc.2 live 查询为准。

---

## 8. 验证补记（2026-10-04，P0b 执行后）

本节修正 §2、§3、§7 中若干**未核实**的判断，并记录 P0b 的实际结论。方法：临时探针写入插件
`apply()`（构建→热重载→读结果→撤销），因此下面每一条都是**行为证据**，不是 `cordis_inspect` 的
Service 投影（B1 的教训）。证据文件：`/tmp/dsh-service-probe.json`、`probe2`、`probe3`（探针数据，
未入库）。

### 8.1 已核实：本 profile 的 live 服务（全部存在）

在插件 `apply()` 内 `ctx.get(name)` 的实测结果（desktop 0.2.0-rc.2，profile `desktop`）：

| 服务 | 实测实现 | 与本文档的关系 |
|---|---|---|
| `subprocess` | `LocalSubprocessRuntime` | §2 的处置**成立**，已采用（8.2） |
| `timer` | `TimerService` | 同上，已采用 |
| `fs` | `SandboxedFileSystem` | §2 的处置**不成立**，见 8.3 |
| `spillStore` | `LocalSpillStore` | B5 的替代面确实在（尚未使用） |
| `storageDomain` | `DomainFacility` | P2 目标面在（尚未使用） |
| `subagents` | `SubagentRuntime` | P1 的替代面在（尚未使用） |
| `sessionQuery` | `SqliteSessionQueryEngine` | B11 的改进面在（当前用 `session.snapshotEvents` 即可） |
| `sessionPersistence`、`storage`、`approval`、`userQuestions`、`attachments`、`tools`、`systemPrompt`、`sessions`、`agents`、`llm`、`profileContext`、`hmr`、`jobs` | 均在 | — |

`ctx.fs` 之所以存在而 `dsh-fs-local` 不在 profile 清单里：本 profile 实际加载的是
`dsh-fs-sandbox`（`fs-sandbox` 这一行），它继承 `LocalFileSystem` 并把 `ctx.fs` 注册为
`sandbox` 实现。**不要**用"清单里没有 `dsh-fs-local`"推断 `ctx.fs` 不存在。

### 8.2 已核实并已实施：`ctx.subprocess` + `ctx.timer`

- `ctx.subprocess.resolveExecutable("codex")` → `/Users/slepher/.local/bin/codex`；`spawn` 返回
  `{stdin: Socket, stdout/stderr, done:{exitCode,signal}, terminate(), waitForExit()}`。
- 显式 `env` 在 credential/`DSH_*` 清洗**之后**合并：探针子进程读到
  `DSH_GATE_PROBE=yes`、`PATH`（678 字节）、`HOME`，说明门禁环境（`DSH_PRETOOL_*`）能到达
  Codex 子进程。这是把 `env` 显式交给服务的前提。
- 实施：`src/process.ts`（`AppServerSpawner`/`AppServerTimer` 两个接缝 + node 兜底实现）；
  `src/rpc.ts` 只保留协议（分帧、关联、超时、uncertain），进程与计时全部来自接缝；
  `src/index.ts` 注入 `ctx.subprocess` / `ctx.timer`。
- **live 证据**：热重载后探针读到 `spawner:true, timer:true, ctor:LocalSubprocessRuntime`；
  `codex_workers create → append → 报告 "T1-OK" → ack → close` 全程通过，平台服务 `live` 计数
  1 → 2 → 1（我们的 App Server 在 close 后被托管范围释放），结束 `codex_workers list` 为 `[]`。
- 兜底：组合里没有这两个能力时，App Server 用 `node:child_process`/`setTimeout` 直接跑
  （与 P0b 前行为一致），并在 `apply()` 里 warn 一次。**这样 0.1.7-rc.2 兼容声明与所有既有
  测试接缝都不受影响**（测试无需注入任何 ctx）。

### 8.3 已核实：`ctx.fs` **不能**承载插件自己的状态目录（§2 该行撤回）

- `ctx.fs.writeText` 需要先 `resolve(path)` 得到 `FsTarget`（直接传字符串是 `TypeError`），
  且 `SandboxedFileSystem.checkedTarget` 在 `workspace-write` 下要求目标**位于可写根之内**。
- 本机 policy：`mode=workspace-write`，可写根 `/Users/slepher/.dsh/profiles/desktop`；而插件
  状态目录是 `/Users/slepher/.dsh/state/desktop/codex` → 实测
  `FsError: cannot write "...": file access denied under workspace-write mode`。
- 另外 `ctx.fs` 的接口只有 `resolve/stat/readText/streamText/writeText/editText/listDir`：**没有**
  `mkdir`/`rename`/`readdir`/独占创建，而 `store.ts` 的单所有者锁（`mkdir` 原子抢占）、
  原子写（temp+rename）、记录目录枚举都依赖这些。
- 结论：`store.ts` 的记录层**保留 `node:fs`**；它真正的收敛目标是 `ctx.storageDomain`（P2），
  而不是 `ctx.fs`。`src/store.ts` 里补一条注释说明这个已验证的原因。

### 8.4 已核实：`tool-gate.ts:369` 不是裸 `setTimeout`

REVIEW B6 列的"裸 `setTimeout`（`tool-gate.ts:369`）→ `ctx.timer`"是误读：该行是
`net.Socket#setTimeout`，是这条一次性连接自己的接收超时（连接关闭即失效），换成 `ctx.timer`
反而会把它与 socket 生命周期解耦。**此项不做**，只改 `rpc.ts` 的三处真实计时器（请求超时、
close 宽限、close 观测），它们现在都来自 `ctx.timer`。

### 8.5 已实施：B4 删除 rollout 读取

- 删掉 `rolloutUsage()` 与 create/resume/createWorker 三处调用；`record.usage` 的唯一来源是
  `thread/tokenUsage/updated`（通知即落盘），冷恢复读自己的记录。插件不再读 Codex 的私有
  JSONL，resume 热路径上也没有同步整读。
- 新增回归用例：`test/backend.test.mjs` "a resumed Session recovers the last usage from the
  provider's own record"（首进程上报 usage → `close()` → 新进程 `readSession` 仍读到该 usage，
  且中断轮仍为 `unknown`）。原来断言 rollout 读取的用例改为只覆盖 skills/compact 语义。
- 代价（已接受）：无法从 Codex 的 rollout 里"捡回"本插件从未收到过的历史用量；正常生命周期里
  该数据本来就是冗余的第二来源。

### 8.6 环境事实的修正

- 本机 `profiles/desktop/cordis.patch.yml` 的 `agent-default-model` 当前是
  `provider: deepseek-account / model: deepseek-flash`（交接文书写的是 `provider: codex`）。
  也就是说热重载不再等同于打断用户主会话；但 `cordis.yml` 里物化的那一行仍是 codex——两个
  文件不一致，改插件前仍应确认。
- 宿主进程的 `process.cwd()` 是 `/Users/slepher/.dsh/profiles/desktop`，`process.execPath` 是
  `/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness`（宿主跑在 Electron 主进程里）。
  因此 `sandboxPolicy` 的默认可写根是 profile 目录，而不是 workspace。
- 读取 app.asar 的正确数据区基址是 `8 + headerSize`（不是 `16 + headerSize`）；asar 目录里的
  `offset` 字段是**字符串**，比较前必须 `Number()`。本次会话早期按 16 字节解析，导致解出的每个
  文件头部少 8 字节。

---

## 9. P1 执行记录（2026-10-04）

**已执行**：删除第二套委派系统。

- 删除 `worker-actions.ts`、`worker-control.ts`、`worker-delivery.ts`、`identity.ts`，以及
  `codex_workers` 工具注册与它的系统提示段落。
- `backend.ts`：删除 `createWorker`/`listWorkers`/`getWorker`/`pendingReports`/`subscribeWorkers`/
  `acknowledgeReport`/`acceptReport`/`notifyWorker`/`validateCaller`/`canAccess`/`workerProjection`，
  以及 close/resume/release/finish 里的 worker 分支；`report.ready` 事件随之消失。
- `store.ts`：删除 worker 记录字段、worker 校验器、`listWorkers`/`bound`/`findBoundByThread`；
  `occupied()` 退化为 `!released`（`handedOff` 仍排除占用）。
- `browser-types.ts`：删除 `Caller`、`CreateWorkerInput`、`WorkerProjection`、`WorkerManagementEvent`、
  `ReportAcceptance` 与 `Report` 的 `workerId`/`acceptance`/`acknowledgedAt`。`ctx.codexExecution` 的读面
  （`NativeExecutionReport`）不含这些字段，因此 workflow kit 侧不受影响。
- **顺带修掉 REVIEW C7**：`steerTurn`/`interruptTurn`/`decideApproval`/`readSession` 等 15 处
  `owner: string | Caller` 双签名与位置参数互换退化为单一 `ownerId: string`（Caller 的产出者已被删除）。
- 测试：删除 `worker-tool.test.mjs`(379)、`ownership.test.mjs`、`delegate-driver.mjs`；改写
  `backend.test.mjs`/`provider.test.mjs`/`store.test.mjs` 中的 worker 用例。套件 150 → **138 项**，
  135 pass / 0 fail / 3 skipped。
- 规模：净删除 1775 行（src 净 -961）。

**未执行（有意保留）**：`codexToolGate`/`codexHandoff` 仍在本插件内。原因是**跨仓库硬依赖**：
`dsh-workflow-kit` 的 `src/host.ts:26` 把 `codexExecution` 与 `codexToolGate` 写进 `inject`，并在缺
`codexToolGate` 时抛错（`workers.ts:388`）。把它们拆成独立插件需要同时改那个仓库并调整部署
composition，属于另一个交付单元；`codex_workers` 的删除不受影响（workflow kit 只在门禁名单
`gate.ts:76` 与一段工具描述里提到该名字，没有调用）。

**验收**：按 REVIEW 附录 A.2 的结论，删除**接受**"逐轮结构化报告 / 验收 / 按 turn 寻址"三项语义差异；
两侧 README 已新增 `Delegation` 一节，用表格逐条列出替代与需接受的差异（附录 A 为完整判定）。

---

## 10. P2 执行记录与 `storageDomain` 评估（2026-10-04）

### 10.1 决策：`codexToolGate` / `codexHandoff` **不拆分**（用户决定）

两者继续留在本插件内，§9 里"待定"的拆分项就此关闭。原因已在 §9 记录：`dsh-workflow-kit`
对它们是硬依赖（`host.ts:26` 的 `inject`、`workers.ts:388` 的缺则抛错），而用户选择不为此改动
另一个仓库/部署。README 的 Host 能力章节仍照实列出这两个服务。

### 10.2 已实施：线程身份以会话日志为权威（P2 第一步）

**测试先行**（`test/provider.test.mjs`："recovers a native thread identity the record lost from the
DSH session log"）：跑完一轮 → 关掉进程 → 从磁盘记录里删掉 `threadId` → 用**新进程**重新加载
同一 `stateDir` → 新开一轮。断言：`thread/resume` 带的是日志里 `finish.replayState` 的线程
id，**没有** `thread/start`，且该身份重新落回记录。

实现（三处）：

| 位置 | 改动 |
|---|---|
| `provider.ts` | 新增 `recoveredThreadId(events)`：从最新一条 `finish.replayState` 取线程身份；`streamMain` 用 `record?.threadId ?? logThreadId` 作为历史边界，并在"记录没有副本、日志有"时用该身份 resume |
| `backend.ts` | `resumeSession(ownerId, sessionId, threadId?)`：`identity = record.threadId ?? threadId`；**只有 App Server 回报的线程 id 与之一致时才写回记录**（不验证不落盘） |
| `browser-types.ts` | `CodexSessionBackend.resumeSession` 声明第三个可选参数 |

**当前语义（有意保留）**：日志可以重建身份，但身份仍会被写回记录 —— 记录是**缓存**而不是
第二份真相：`snapshotEvents` 是可选 seam（B11 的 fail-closed 前提），只依赖日志会让"没有该
seam 的 composition"无法冷恢复。要彻底删掉缓存，前提是把会话日志读面升级为必需依赖
（`ctx.sessionQuery` / `ctx.sessionPersistence`），那是独立一步。

验证：`npm run typecheck`、`npm run build`、`node --test --test-isolation=none test/*.test.mjs`
→ **139 tests / 136 pass / 0 fail / 3 skipped**（新增 1 项），既有 cold-recovery 用例全绿。

### 10.3 `store.ts → ctx.storageDomain` 评估（契约已核实）

契约来自 live 0.2.0-rc.2 的 `@deepseek-ai/dsh-storage-domain`（asar 解包 + 本机布局实测）：

```
defineDomain({ name, version, compatibleVersions?, layout: 'single' | 'per-record',
               invalidRecords?: 'backup-and-skip', tables: { t: domainTable(zodSchema) }, global? })
ctx.storageDomain.open(spec) -> { table(name).get/put/update/delete, close(), domain/changed }
```

已核实的事实：

1. **`layout: 'per-record'` 与插件现状同构**：本机 `$DSH_HOME/storages/session_projcache/sessions/`
   就是 per-record 布局（一记录一文件），而 `workspace.json` 是 `single`。每条记录一次原子写、
   后端保证落盘后才 resolve —— 正是 `store.ts` 手写 temp+rename 想做的事。
2. **坏记录策略不同**：per-record 的契约是"一个坏/过期的记录文件读作不存在"；插件现在是
   `parseRecord` 抛错 → 整个 store 打开失败。迁移即**放宽**（若要保持严格，需要 `invalidRecords:
   'backup-and-skip'` + 自检告警，不能两者兼得）。
3. **位置会变**：域的路由与根由**部署**决定（本机 `storage-json` 的 root = `$DSH_HOME/storages`），
   插件无法为自己的域选路径。迁移意味着记录从 `$DSH_HOME/state/<profile>/codex/sessions/*.json`
   搬到 `$DSH_HOME/storages/<name>/`，**需要一次性迁移**（插件已有 `LegacyMirror` 的先例，可复用
   同样的"读旧写新后删除旧字段"模式）。
4. **跨进程单所有者排除不是域的能力**：`already-open` 只在同一个 facility/进程内生效，后端也
   明确不串行化跨进程并发写。`owner.lock` 必须保留。
5. **校验器可整体替换**：`parseRecord`/`validReport`/`validPending`/`validGate`/`validHandoff`/
   `validUsage` 等约 140 行手写校验器对应一份 zod schema（记录是普通不可变数据，读是内存同步读）。

结论：**可以迁，但不该与本次一起做**。收益是删掉 ~140 行手写校验器 + 原子写，代价是一次
带迁移的状态目录搬家 + 坏记录语义放宽 + 锁逻辑仍要自持；而 §10.2 已经把"记录是缓存"这一
结构性问题解决。建议的下一步（独立交付单元）：先落字段级的 zod schema 与 `defineDomain`
声明 + 一个测试证明"同一批记录在域里 open→put→get 往返等价"，再写一次性迁移与回滚，
最后删 `store.ts` 的手写持久化。


### 10.4 用户裁定（2026-10-04，晚）：记录可弃，不做搬迁

§10.3 里"需要一次性迁移"这一条**作废**：用户明确表示 provider 自己的记录无所谓，不搬迁也可以。
于是 T3-2 的形态变为"直接把持久化层换成域，旧 `sessions/*.json` 原样留下（不自动删）"，代价只剩
下面三条**已实测**的前置条件：

1. `zod@4.6.5` 在 `node_modules/zod` 里存在（传递依赖）但 `package.json` 未声明 → 需先声明；
   本机无网络，改 lockfile 要靠 `npm install --offline` 或换机器。
2. `@deepseek-ai/dsh-storage-domain` **从插件目录 resolve 不到**（只在 DSH asar 载荷里），所以
   `import { defineDomain }` 在当前环境不可用；但 `open(spec)` 只读
   `name/version/layout/tables[t].valueSchema/global/invalidRecords`（无 brand、无注册表），
   可用 `zod` 手搓等价 spec（`domainTable(schema)` 即 `{ valueSchema: schema }`）。
   路线 A（加该包为依赖）需网络；路线 B（只用 zod + 本地结构类型）离线可行。
3. `ctx.storageDomain` 来自 ctx，而 `CodexSessionBackend` 现在不需要 ctx（约 39 处测试直接构造）
   → 需要先加一个可注入的 store 端口，改动量比"删校验器"大。

**结论调整**：在"记录无所谓"的前提下，T3-2 的收益只剩删 ~140 行手写校验器与手写原子写，而
§10.2 已解决结构性问题（身份不再是第二份真相）。若只为推进度，**优先做 C1 分层**（纯搬运、零
宿主耦合）比 T3-2 更划算。T3-2 保留为可选单元。

### 10.5 仍未做（更新）

- T3-2（可选，见 §10.4 的三条前置条件）；T3-3：把日志读面升级为必需 seam 后删掉记录里的身份缓存。
- C1 分层（`provider.ts` 1331 行 / `backend.ts` 1202 行）——**推荐的下一步**。
- T5：`npm run test:live -- --fake`（本机被 npm network 阻塞）；B3 的整轮行为探针。

---

## 11. C1 执行记录（2026-10-04 晚，本轮）

按 §10.5 的推荐先做 C1（纯搬运、零宿主耦合）。四个提交，每步独立、每步全套绿：

| 提交 | 内容 | 规模 |
|---|---|---|
| `c5016b1` | `provider.ts` → `history.ts`：DSH 对话↔原生线程边界 | `provider.ts` 1362 → 1113；`history.ts` 280 |
| `e53cf53` | `provider.ts` + `backend.ts` → `usage.ts`：token 记账两个方向 | `usage.ts` 90；两侧各减 |
| `cca48d7` | `store.ts` → `records.ts`：记录 schema 与单所有者锁分家 | `store.ts` 461 → 277；`records.ts` 228 |
| `86e9ab9` | `backend.ts` → `wire.ts`：App Server 线格式翻译 | `backend.ts` 1202 → 1040；`wire.ts` 214 |

### 11.1 各模块职责（搬运后）

- **`history.ts`**：新输入边界（`planInput`）、历史段渲染（`importedInput`）、
  `recoveredThreadId`、`nativeHistoryCursor`、`toolCallNames`、`HISTORY_IMPORT_MARKER`。
  依赖只有类型 + `context.ts` 的可见性谓词 + `dsh-llm` 词表；不含进程、后端句柄或宿主能力。
- **`usage.ts`**：`tokenValues`/`count`/`normalizeUsage`（wire → 记录）与
  `usageChunk`/`usageContextWindow`（记录 → `TokenUsage`）。两个方向同处一文件。
- **`records.ts`**：`StoredSession` 及两个 handoff 记录、legacy 镜像、`recover`、`parseRecord`、
  全部 `valid*` 校验器。**不打开任何文件、不创建目录**。
- **`wire.ts`**：`turnInput`、`snapshot`/`turnSnapshot`、`statusState`/`terminalState`、
  `objectValue`、`approvalResponse`、`userInputQuestions`、`normalizedBoundary`、`threadParams`、
  `ThreadResult`/`TurnResult`。
- **`store.ts`** 只剩 `SessionStore`（状态目录 + 记录内存表 + 原子写）、`owner.lock` 跨进程单所有者
  逻辑、`processStartTime`；**`backend.ts`** 只剩 transport / runtime / 记录存储 / 事件归约。

### 11.2 两个"单一真相"顺带修掉

1. **`CODEX_PROVIDER` 曾有两份**：`provider.ts` 导出 `"codex"`，而 `history.ts` 需要读同一个标记来
   从日志里认出自己的 turn。现移到 `browser-types.ts`（共享词表），`provider.ts` 原样 re-export，
   公开导出面不变 → 语义常量只有一份。
2. **`StoredSession` 的类型来源**：`store.ts` re-export 记录类型，因此既有 `import { StoredSession }
   from "./store.js"` 的调用方零改动；声明它的是 `records.ts`。

### 11.3 验证方式（比"跑一遍测试"更强）

- 每一步都跑了 §7 第一行：`npm run typecheck` + `npm run build` +
  `node --test --test-isolation=none test/*.test.mjs` → **139 tests / 136 pass / 0 fail / 3 skipped**，
  四步全部与基线逐字相同。
- 纯搬运用**脚本比对**证明，而不是肉眼看 diff：把上一版 `git show HEAD:src/<file>.ts` 与新版逐函数
  抽取函数体/接口体，规范化掉新增的 `export` 后逐行比较。结论：
  - `history.ts` 与 `usage.ts`：搬运函数体全部 `IDENTICAL`（`history.ts` 中 `recoveredThreadId`/
    `planInput`/`nativeHistoryCursor`/`importedInput`/`renderBlocks`/`toolCallNames` 等，`usage.ts` 中
    `tokenValues`/`normalizeUsage`/`usageChunk`/`usageContextWindow`）。
  - `records.ts`：`parseRecord`/`recover`/`claimsThread` 仅差 `export`；其余 `valid*` 逐字相同。
    `store.ts` 保留的 12 个 `SessionStore` 成员（含 `constructor`、`acquireLock`、`persist`）与 7 个锁
    辅助函数全部 `IDENTICAL`。
  - `wire.ts`：10 个函数 + 2 个接口全部 `IDENTICAL`（仅差 `export`）。
- 冷恢复专项：`node --test --test-isolation=none --test-name-pattern="recovers a native thread identity"
  test/provider.test.mjs` → 1 pass（T3 前半的语义没被搬运碰坏）。
- 构建触发的 link 重载已生效：`$DSH_HOME/state/desktop/codex/owner.lock/owner.json` mtime 前进到 16:58:02。
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters` 只剩一处**搬运前就有**的未用形参绑定
  （`provider.ts` `streamAuxiliary` 的 `sequence`），未在本轮顺手改，避免把无关改动混进纯搬运提交。

### 11.4 未做（仍然可选）

- **T3-2**（`store.ts → ctx.storageDomain`）：§10.4 的三条前置条件未变（无网络 → 不能加
  `@deepseek-ai/dsh-storage-domain` 依赖、需手搓 spec、要给 `CodexSessionBackend` 加 store 端口）。
  本轮把记录 schema 独立成 `records.ts` 后，这条路线的第三步（删 ~140 行手写校验器）**比之前更好做**：
  要替换的现在集中在一个文件里，且不再与 `node:fs`、`owner.lock` 混在一起。**A 路线仍需网络**；
  离线只能走 B 路线（只依赖 `zod` 手搓 spec，见 §10.4 第 2 条）。
- **T3-3**：把日志读面升级为必需 seam 后删掉记录里的 `threadId` 缓存。
- **T5**：`npm run test:live -- --fake` 仍走不通。本轮重试一次（2026-10-04 17:02），
  `a141d05` 的 `mkdir evidence/` 修复**已验证有效**：harness 不再 ENOENT，而是稳定产出结构化报告
  `{"status":"FAIL", ..., "error":"npm failed: exit=1 ... see evidence/live-install.log"}`。
  阻塞点是 registry 本身：`ERR_TLS_CERT_ALTNAME_INVALID`（TLS 证书不含 DNS 名），不是插件的错。
  换机器或修复本机 TLS 后可重跑；B3 的整轮行为探针同样走这条路。

