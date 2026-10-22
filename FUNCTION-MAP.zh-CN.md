# dsh-codex-app-provider 代码 → 功能点对照

> **已过期（2026-10-04 晚）**：本文档写于 `bef8e4c`（P1 之前）。P1 已删除 worker 四模块与
> `codex_workers` 工具（§H/§I/§J/§K 及 §2 的 A9/A10/A13、§2 的"持久 worker"整行、§2 的 C/D/B
> 若干行、§4 的 worker 用例都已失效），P2/C1 又把大文件拆开：`provider.ts` → +`history.ts`、
> `backend.ts` → +`wire.ts`、`store.ts` → +`records.ts`，并且新增了 `usage.ts`。
> **当前模块拓扑与职责以 `LEAN-PLAN.zh-CN.md` §11 为准**；本文只当索引，**不要照抄 `文件:行`**。
> §1 与 §D 的模块归属已按 C1 的结果就地更正，其余章节的锚点行号未逐一重算。

对象：`dsh-codex-app-provider` 0.1.1（工作树 HEAD `bef8e4c`，2026-10-03，clean）。
范围：`src/` 全部 19 个 TypeScript 文件；`test/`、`scripts/`、打包与本地化在后续章节。
方法：逐文件阅读源码，把每条可观察行为归到一个功能点，并给出代码锚点 `文件:行`。行号对应当前工作树。

本包只有一个 DSH Host 插件：把本机 Codex CLI 的 `app-server --stdio` 作为 DSH 的 LLM 路由 `codex` 接进来，
同时把 Codex 的审批/提问、执行事实、持久 worker、线程交接和 workflow 工具闸门暴露给 DSH。包内没有浏览器 UI。

---

## 1. 总览：五条功能主线

| 主线 | 一句话 | 主要代码 |
|---|---|---|
| 模型路由 | `codex` provider 的目录、请求转换、流式事件、用量、取消 | `provider.ts`、`models.ts`、`backend.ts`、`wire.ts`、`usage.ts` |
| 原生执行记录 | Codex 自己执行工具，插件把执行事实写回 DSH 会话日志（幂等） | `execution-events.ts`、`facts.ts`、`provider.ts`、`history.ts` |
| ~~持久 worker~~ | **已删除（P1）**：`codex_workers` 工具与整套报告投递 | 无（原 `worker-actions.ts` 等四模块已删） |
| Host 服务 | `ctx.codexExecution` / `ctx.codexHandoff` / `ctx.codexToolGate` | `index.ts`、`execution.ts`、`handoff.ts`、`tool-gate.ts` |
| 传输与持久化 | App Server JSON-RPC over stdio、单所有者状态目录、记录 schema | `rpc.ts`、`store.ts`、`records.ts` |

---

## 2. 功能点索引

### A. 插件装配与生命周期（`src/index.ts`）

| ID | 功能点 | 代码锚点 | 关键约束 |
|---|---|---|---|
| A1 | 配置 schema：`stateDir`/`command`/`requestTimeoutMs`/`providerCwd` | `index.ts:26`、`index.ts:43` | `command` 默认 `codex`；超时 1–2147483647，默认 30000 |
| A2 | 依赖注入声明 | `index.ts:50` | `inject = ["agents","sessions","llm"]`；工具部分另行 `ctx.inject(["tools","systemPrompt"])` |
| A3 | 状态目录默认推导 | `index.ts:74`–`79` | 优先 launcher 的 `profileContext`；否则 `$DSH_HOME`，再 `~/.dsh`；路径 `<home>/state/<profile>/codex`，**绝不**用进程 cwd |
| A4 | 线程默认工作目录推导 | `index.ts:89`–`91` | 用 launcher 捕获的启动目录，避免后续 `process.chdir` 影响 |
| A5 | 单一执行所有者装配 | `index.ts:96`–`116` | 一个 `CodexSessionBackend` + 一个 transport 工厂（按 runtime 注入 gate 环境）；gate 与 backend 互相 attach |
| A6 | LLM 适配器注册 | `index.ts:135`–`147` | 注册 provider id `codex`；审批/提问/附件三个 seam 用 `ctx.get` 可选获取 |
| A7 | Host 服务发布 | `index.ts:148`–`183` | `codexToolGate`、`codexExecution`（`read`/`facts`）、`codexHandoff`（`handoff`/`read`）；`handoff` 会先校验源会话 cwd |
| A8 | 上下文过滤器安装 | `index.ts:184` | `installCodexContextFilter(ctx)` |
| A9 | `codex_workers` 工具注册 | `index.ts:196`–`227` | 11 个 action 的 schema；`presentCall` 把 `list/get/reports` 标为 `read`，其余 `execute` |
| A10 | 工具系统提示段落 | `index.ts:229`–`233` | 挂在 `TOOL_JOBS` 顺序位，说明"worker 无角色概念、报告要独立处理" |
| A11 | 会话销毁联动 | `index.ts:123` | `session/disposed` → `backend.releaseDisposed("codex:<id>")` |
| A12 | 卸载顺序与资源回收 | `index.ts:124`–`134` | 顺序：disposed 钩子 → adapter.close → 工具/过滤/投递/控制注销 → backend.close → gate.close |
| A13 | 工具执行的身份与桥接准备 | `index.ts:211`–`221` | 动作前/后各 `control.ensure(identity)`，保证新建 worker 立刻被观察 |

### B. LLM 适配层（`src/provider.ts`）

| ID | 功能点 | 代码锚点 | 关键约束 |
|---|---|---|---|
| B1 | provider 元信息与模型目录 | `provider.ts:184`–`196` | `providerInfo` 名称 `Codex`；`listModels` 映射 id/name/输入模态 |
| B2 | 模型解析：effort 列表、默认 effort、contextWindow | `provider.ts:198`–`222` | 未知模型也返回可用信息（仅退回 id/name） |
| B3 | 模态裁剪 | `provider.ts:229`–`234` | 没有 attachments seam 时只宣告 `text`；永不宣告 `audio` |
| B4 | 目录缓存（30s）与单飞请求 | `provider.ts:432`–`442` | `CATALOG_TTL_MS = 30_000`；同一时刻只有一个 `config/read`+`model/list` 飞行 |
| B5 | contextWindow 学习 | `provider.ts:257`–`275`、`provider.ts:880`–`886` | 先从配置，再从其他会话 usage 记录；usage 上报时回写 |
| B6 | 主路径流式调用 | `provider.ts:277`–`303`、`provider.ts:529` | 必须有 DSH 会话身份；`purpose` 存在则走压缩/辅助分支 |
| B7 | 工作区一致性校验 | `provider.ts:531`–`540` | 记录的 `cwd` 与当前会话工作区不同即 `WORKSPACE_CHANGED` |
| B8 | 原生执行输入解析与等值校验 | `provider.ts:497`–`527` | 请求优先、活 Agent 快照兜底；两者都有则必须相等；模型/effort 必须与活 Agent 生效配置一致 |
| B9 | 执行输入不可变 | `provider.ts:543`–`550` | `developerInstructions`/`boundary` 变化即 `EXECUTION_MISMATCH`（要求新建 child） |
| B10 | 事实追补导入 | `provider.ts:553` | 每轮开始先补上一进程未导入的事实 |
| B11 | 预备线程绑定（交接后继） | `provider.ts:457`–`480`、`provider.ts:562`–`563` | 只允许 `thread/resume`，缺失/不匹配一律报错，绝不 `thread/start` 新线程 |
| B12 | 后继首轮输入防重放 | `provider.ts:566`、`provider.ts:1148` | 输入含 `[DSH history import` 标记即拒绝 |
| B13 | 输入计划与幂等键 | `provider.ts:978`–`1017` | 幂等键 = 最后一条用户消息 id；边界来自 replayState → 游标 → compaction 检查点回推 |
| B14 | 检查点遮挡下的边界恢复 | `provider.ts:1020`–`1065` | 用 `assistant/message`、`compaction/summary` 的 `shadowedSeqs` 重建可见范围 |
| B15 | 历史导入渲染 | `provider.ts:1104`–`1138` | 带 `[DSH history import — …]` 头；文本与图片按条目交错；纯文本时退化为多行字符串 |
| B16 | 工具消息渲染 | `provider.ts:1190`–`1219` | 工具结果加 `[tool result]`/`[tool result error]` 前缀；tool-call 名字表用于 `tool(name)` 标签 |
| B17 | 内容块渲染 | `provider.ts:1196`–`1212` | `reasoning` 不发送；`file`/`tool-call`/未知块降级为文本占位 |
| B18 | 图片解析 | `provider.ts:237`–`255` | 优先 host path 的 `localImage`，其次 `readImage` 转 data URL；都不可用则抛错而非丢图 |
| B19 | 流式事件映射 | `provider.ts:609`–`665` | 文本 delta、block-start/end、usage、finish；终态轮从落盘报告 replay |
| B20 | 中止路径 | `provider.ts:645`–`649`、`provider.ts:949`–`954` | abort 时取消待批审批并 interrupt 该 turn，产出 `aborted` finish |
| B21 | 失败与空结果映射 | `provider.ts:650`–`660` | 完成但无可见消息 → `EMPTY_RESULT`；failed/interrupted 各自映射 failure code |
| B22 | 不确定态短路 | `provider.ts:603`、`provider.ts:611` | `session.uncertain` / `unknown` → `EXECUTION_UNKNOWN`，禁止重发 |
| B23 | 辅助调用路径（compaction 摘要、一次性请求） | `provider.ts:668`–`741` | 每个辅助调用一个一次性 native 会话（`codex-aux:<uuid>`），finally 关闭；审批/提问同样转发 |
| B24 | 原生线程压缩 | `provider.ts:309`–`339` | `thread/compact/start` 后等 `turn.state(operation=compact)`；未完成 → `COMPACTION_FAILED`；中断则尝试取消 |
| B25 | 执行事实写入 DSH 会话日志 | `provider.ts:384`–`408` | 以 `user/message` + `surfaceOp: "append"` 落盘；按 `importedFactIds` 去重 |
| B26 | 事实导入失败不静默 | `provider.ts:410`–`415`、`provider.ts:367`–`371` | 每会话只告警一次；首次成功导入时提示事实通道已迁移到会话日志 |
| B27 | 审批桥（fail-closed） | `provider.ts:762`–`803` | 无 seam/无 agent/抛错 → `decline`；`allowed-once`→accept，`cancelled`→cancel，其余→decline |
| B28 | 结构化提问桥 | `provider.ts:847`–`878` | 无 seam → 回空答案；收集 `selected + custom`，无任何答案时回 `null` |
| B29 | worker 原生请求观察 | `provider.ts:820`–`831` | 用父会话 caller 订阅，声明 `interactive: true`，审批走父 Agent、决定走 owning caller |
| B30 | 用量投影 | `provider.ts:1258`–`1273` | 输入 token 扣除缓存读；`null` 字段不产出；reasoning/cacheWrite 仅在非零时带 |
| B31 | 只读执行视图 | `provider.ts:417`–`430` | `codexExecution.read` 的数据来源；用 `executionCwd` 而非宿主工作区 |
| B32 | 原生事实文本投影 | `provider.ts:354`–`358` | `codexExecution.facts`：读取 provider store，不触发 resume/模型请求 |
| B33 | 错误归一化 | `provider.ts:1328`–`1331` | 非 `LlmError` 统一包成 `CODEX_ERROR` |
| B34 | 事件通道（异步迭代器） | `provider.ts:904`–`939` | 队列 + abort 唤醒；关闭后不再入队 |
| B35 | 会话↔native id 映射 | `provider.ts:1324`、`handoff.ts:71`–`75` | 双向 `codex:` 前缀 |

### C. 后端状态机（`src/backend.ts`；纯翻译已拆到 `src/wire.ts`）

> C1 之后：C26 的 `normalizedBoundary`、C31 的 `trackCommand` 之外，**线格式翻译全部在 `wire.ts`**
> （`turnInput`=C36、`snapshot`/`turnSnapshot`、`statusState`/`terminalState`、`objectValue`、
> `approvalResponse`、`userInputQuestions`、`threadParams`），`ThreadResult`/`TurnResult` 也随之搬家；
> C29 的手写 rollout 解析已在 T1c 删除，用量唯一来源是 `thread/tokenUsage/updated`（`usage.ts`）。

| ID | 功能点 | 代码锚点 | 关键约束 |
|---|---|---|---|
| C1 | runtime 生命周期与不确定态 | `backend.ts:856`–`890` | 替换 runtime 前先退役 gate key；uncertain 时清空审批/输入并发布 `session.uncertain`，后续 server request 一律 reject |
| C2 | 建会话（`thread/start`） | `backend.ts:161`–`212` | 校验 owner/session/绝对 cwd；gate 在 thread 存在前 preflight；失败落 `unknown` 并提示先检查 |
| ~~C3~~ | ~~建 worker~~ | **已删除（P1）** | `codex_workers` 与 worker 记录字段整块删除 |
| C4 | 恢复会话（`thread/resume`） | `backend.ts:294`–`345` | 活 runtime 权威；`active` 线程拒绝接管；对账 pending/boundary/model；失败清 live 并退役 gate key |
| C5 | 配置会话 | `backend.ts:347`–`357` | ~~worker 拒绝改配置~~（P1 后仅剩普通会话路径） |
| C6 | 关会话 | `backend.ts:359`–`399` | ~~worker 必须 idle、无待批审批、无未确认报告~~（P1 后无 worker 分支）；普通会话需 idle 或显式确认已停 |
| C7 | 宿主销毁释放 | `backend.ts:411`–`423` | 无视状态标记 `released` 并关闭 runtime；被跟踪的 close 会等进程真正退出 |
| C8 | 启动一轮 | `backend.ts:566`–`621` | 幂等键命中直接返回既有快照；非 idle 拒绝；`pending` 记录未确认的模型/effort 目标 |
| C9 | steer | `backend.ts:645`–`666` | 必须匹配当前 turnId 且状态为 running；runtime 不在则拒绝 |
| C10 | interrupt | `backend.ts:668`–`680` | running/interrupt-requested 才可；成功后进入 `interrupt-requested` |
| C11 | 原生压缩 | `backend.ts:623`–`643` | 仅 idle、仅非 worker；`operation = "compact"` |
| C12 | 通知路由 | `backend.ts:892`–`950` | 先记 hook run（不受 thread 过滤）；再按 threadId 过滤 turn/item/usage/settings |
| C13 | 完成结算 | `backend.ts:952`–`998` | 生成 Report（completed 且无交付物 → `protocolError`）；worker 未 detached 时发 `report.ready`；清审批与请求表 |
| C14 | 服务器请求处理 | `backend.ts:1004`–`1053` | 3 类审批请求记录并转 `waiting-approval`；未知方法 reject；`mcpServer/elicitation/request` 固定 decline |
| C15 | 用户提问请求 | `backend.ts:1055`–`1081` | 无 interactive 订阅者或无问题时立即回空答案，避免线程永久阻塞 |
| C16 | 审批决定 | `backend.ts:702`–`734` | 校验 requestId 仍待批、thread/turn/state 一致；上下文调用者只允许 accept/decline |
| C17 | 提问回答 | `backend.ts:691`–`700` | 按 requestId + ownerId 定位；已失效则报错 |
| C18 | 事件提交与序号 | `backend.ts:1102`–`1112` | 每次提交分配单调 sequence；只有 `feedsExecutionFacts` 的事件被保留用于事实投影 |
| C19 | 事实投影 | `backend.ts:1094`–`1100` | 终态后把保留事件归约为事实行并清空缓冲 |
| C20 | worker 管理事件 | `backend.ts:1114`–`1120`、`backend.ts:788`–`794` | `worker.changed`（created/closed/report/uncertain，closed 带 `invalidated`）广播给同父会话订阅者 |
| C21 | 报告读取与确认 | `backend.ts:736`–`770` | `ack` 只写一次时间；`accept` 校验取值与"有交付物才能 accepted" |
| C22 | 待处理报告查询 | `backend.ts:278`–`283` | 只返回 agent 所有、`pending` 且未 ack 的报告 |
| C23 | 线程交接 | `backend.ts:475`–`555` | 源必须确认停止且线程非 active、cwd 未变；先写源 `handedOff` 再 detach 再写后继；重复 requestId 幂等 |
| C24 | 交接去授权 | `backend.ts:841`–`844` | 已交接记录对 start/resume/configure/compact/steer/interrupt 全部拒绝 |
| C25 | 线程所有权读取 | `backend.ts:449`–`455` | 返回 threadId / handedOffTo / handoffFrom，供 Host 对账 |
| C26 | 边界归一化与对账 | `backend.ts:1228`–`1238`、`backend.ts:1282`–`1311` | boundary 必须绝对路径、writableRoots 去重；记录 native 实际应用值；声明 cwd 与实跑 cwd 不同即报错 |
| C27 | 执行模型对账 | `backend.ts:1313`–`1319` | 有执行输入时，native 未应用请求的 model/effort 即报错 |
| C28 | pending 配置对账 | `backend.ts:1325`–`1345` | 原生事实提升或丢弃 pending，不盲目回退旧配置 |
| C29 | rollout 用量解析 | `backend.ts:1347`–`1393` | 解析 thread path 的 JSONL，只接受匹配 threadId 的 `token_count`；归一化 total/last/contextWindow/剩余比例 |
| C30 | caller 校验与所有权 | `backend.ts:1395`–`1409` | caller 必须 source=agent、父 Agent id 与 nativeSessionId 自洽；worker 访问要求 owner=agent、未 detached、父会话匹配 |
| C31 | 命令存活追踪 | `backend.ts:1446`–`1465` | 只跟踪 `commandExecution` 的 started/completed；关会话前若有 inProgress 则拒绝 |
| C32 | hook 运行证据 | `backend.ts:127`–`136`、`backend.ts:897`–`900` | 每 runtime 保留最近 50 条 `hook/started|hook/completed`，区分"被闸门拒绝"与"Codex 未尝试" |
| C33 | 临时服务器读取 | `backend.ts:1128`–`1137`、`backend.ts:796`–`798` | `modelSettings` 与交接前的 `thread/read` 用一次性 App Server，读写完即关 |
| C34 | 关停 | `backend.ts:800`–`809` | 关闭全部 runtime、退役全部 gate key、等待所有跟踪中的 close、关闭 store |
| C35 | 线程占用视图 | `backend.ts:439`–`441` | 由 store 判定仍可操作线程的记录集合 |
| C36 | 输入编码 | `backend.ts:1140`–`1159` | text/image/localImage/skill 各自的必填校验，空输入直接拒绝 |

### D. 状态持久化（锁与文件：`src/store.ts`；记录 schema：`src/records.ts`）

> C1 之后按职责分家：**"这个文件是不是一条记录"在 `records.ts`**（不打开任何文件），
> **"谁独占这个目录、记录怎么落盘"在 `store.ts`**。D6–D11 现在都在 `records.ts`；
> D1–D5 留在 `store.ts`。`store.ts` re-export 记录类型，调用方无需改 import。

| ID | 功能点 | 代码锚点 | 关键约束 |
|---|---|---|---|
| D1 | 单所有者锁 | `store.ts:133`–`158`（`SessionStore.acquireLock`） | 锁目录 `owner.lock`；活 owner 直接拒绝第二个 backend |
| D2 | 锁所有权识别 | `store.ts:180`–`277`（`readLockOwner`/`classifyPid`/`classifyOwner`/`processIdentity`/`processStartTime`） | `owner.json`（pid+start+boot）；回退 `pid` 文件；boot_id 防 pid 复用；不可读 → `unknown` 交由人工 |
| D3 | 陈旧锁回收 | `store.ts:133`–`158` `acquireLock` 内 | 用 `owner.lock.reclaim` 防止两个回收者互相拆锁 |
| D4 | 锁释放 | `store.ts:126`–`131` `close()` | 仅当锁 owner 正是本进程时删除 |
| D5 | 原子写 + 权限 | `store.ts:114`–`124` `persist()` | 临时文件 `{pid}.tmp` → rename；文件 0600；目录 0700 |
| D6 | 启动载入与迁移 | `store.ts:45`–`65` 构造函数 + `records.ts:91` `recover()` | 旧版 `events` 镜像投影为 `facts` 并回写；`running/waiting-approval` → `unknown`（worker → `saved` 已在 P1 删除） |
| D7 | 记录校验 | `records.ts:113` `parseRecord()` | 必填字段、reports、pending、gate、handoff 任一畸形即整条记录失败（worker 校验已删） |
| D8 | 查询面 | `store.ts:68`–`107` `list`/`has`/`lookup`/`get`/`findByThread`/`occupiedThreads` | 按 ownerId 过滤；`get` 做 owner 校验（worker 相关查询已删） |
| D9 | 占用判定 | `records.ts:173` `claimsThread()`/`occupied()` | 未交接且未 released |
| D10 | 报告合法性 | `records.ts:181` `validReports()`/`validReport()` | 每条报告 turnId 唯一（accepted/ack 语义已随 worker 删除） |
| D11 | 用量与时间戳合法性 | `records.ts:206` `validUsage()`/`validUsageValues()`/`validTimestamp()` | 计数为非负安全整数或 null；剩余比例 0..1 |

### E. 执行事件 → 事实（`src/execution-events.ts`、`src/facts.ts`）

| ID | 功能点 | 代码锚点 | 关键约束 |
|---|---|---|---|
| E1 | 事件归约 | `execution-events.ts:34`–`93` | 按 `(thread,turn,item)` 去重与 pending 记账；reasoning 只保留公开 summary；只接受白名单 item 种类 |
| E2 | 未完成项结算 | `execution-events.ts:56`–`72` | 终态 turn 只结算自己的 item（completed→unknown）；uncertain 结算全部为 unknown |
| E3 | 事实渲染 | `execution-events.ts:144`–`169` | command（含 exit/cwd）、fileChange 路径、mcp/dynamic tool、functionCallOutput、webSearch、compaction 标记 |
| E4 | 长输出截断 | `execution-events.ts:14`、`execution-events.ts:118`–`123` | 600 字符上限，并给出可寻址的 item 引用 |
| E5 | 最终事实投影 | `execution-events.ts:181`–`211` | 每个 item 取最后一次 completed/终态；只输出已完成项，行首带 `[source: codex thread=… turn=… item=…]` |
| E6 | 保留判据 | `execution-events.ts:108`–`115` | 只有 item 生命周期、reasoning summary、命令输出、不确定/终态事件进入事实缓冲 |
| E7 | 事实分组为消息 | `facts.ts:82`–`94` | 一个 native item = 一条 DSH 消息（多行合并）；id = `codex-executed:<thread>:<turn>:<item>` |
| E8 | 事实消息构造 | `facts.ts:105`–`116` | `freezeMessage` + `user` 角色 + plugin 来源 + `form: "notice"`；不含可被 DSH dispatcher 执行的 tool-call 身份 |
| E9 | 幂等导入判据 | `facts.ts:58`–`60`、`facts.ts:127`–`135` | 按 id 前缀识别已导入事实 |
| E10 | 来源类型声明 | `facts.ts:27`–`34`、`facts.ts:45` | 消息来源 kind `dsh-codex-app-provider`，与 `FACT_PLUGIN` 同步 |

### F. 上下文过滤（`src/context.ts`）

| ID | 功能点 | 代码锚点 | 关键约束 |
|---|---|---|---|
| F1 | DSH 注入上下文识别 | `context.ts:28`–`46` | system / developer 一律过滤；`runtime-context`/`agent-instructions`/`skill-catalog` 与 `instructions`/`catalog`/`snapshot` form 过滤 |
| F2 | 必须保留的内容 | `context.ts:36`–`43` | 用户显式调用的 skill、压缩检查点（`compact-checkpoint`/`compact-basic`）、worker 报告通知保留；已导入的执行事实**过滤**（避免重复喂回） |
| F3 | 路由判定 | `context.ts:62`–`70` | 先看 `sessionProjections` 的 modelSelection（pending → lastUsed），再退回 agent 配置；未知视为"非 Codex" |
| F4 | pre-step 过滤安装 | `context.ts:79`–`87` | 在 `agent/pre-step` 瀑布里裁剪消息，使被裁内容既不进 Codex 也不落会话表面 |

### G. 执行输入（`src/execution-inputs.ts`）

| ID | 功能点 | 代码锚点 | 关键约束 |
|---|---|---|---|
| G1 | 结构化读取 `execution` | `execution-inputs.ts:58`–`76` | 字段不在 stock 类型里，故结构化读取；存在但畸形 → 抛错（fail-closed） |
| G2 | boundary 快照隔离 | `execution-inputs.ts:36`–`38` | 复制 `writableRoots`，防止调用方后续修改影响已记录约束 |
| G3 | 输入等值比较 | `execution-inputs.ts:79`–`90` | 与属性顺序无关；undefined 语义精确（都无 = 相等） |
| G4 | 执行 cwd 推导 | `execution-inputs.ts:103`–`105` | `boundary.cwd ?? sessionCwd` |

### H. 工具动作面（`src/worker-actions.ts`）

| ID | 功能点 | 代码锚点 | 关键约束 |
|---|---|---|---|
| H1 | 11 个 action 分发 | `worker-actions.ts:79`–`137` | `create/list/get/reports/append/steer/interrupt/resume/ack/accept/close` |
| H2 | 字段白名单 | `worker-actions.ts:33`–`45`、`worker-actions.ts:59`–`67` | 多余字段点名拒绝（旧版 `reports` 静默忽略 `workerId` 的坑） |
| H3 | 状态前置条件 | `worker-actions.ts:107`–`109` | `append` 要求 worker idle，运行中提示改用 `steer` |
| H4 | 变更前身份再校验 | `worker-actions.ts:93`、`109`、`114`、`118`、`122`、`126`、`129`、`132` | 每个写操作调用 `revalidate()` |
| H5 | skill 输入拼接 | `worker-actions.ts:140`–`142` | 有 skills 时以 `[text, ...skills]` 形式传入 |
| H6 | 参数校验 | `worker-actions.ts:144`–`152` | 非空字符串、acceptance 取值枚举 |

### I. 调用者身份（`src/identity.ts`）

| ID | 功能点 | 代码锚点 | 关键约束 |
|---|---|---|---|
| I1 | 捕获活父 Agent 身份 | `identity.ts:29`–`34` | 无 agent 直接拒绝；捕获后立即校验 |
| I2 | 身份再校验 | `identity.ts:45`–`51` | agents/sessions 注册表与 agent.session 三者必须一致，否则"Parent agent identity changed" |
| I3 | 转成后端 caller | `identity.ts:58`–`61` | `{ nativeSessionId, source: "agent", parentAgent }`，即 worker 围栏依据 |

### J. 报告投递（`src/worker-delivery.ts`）

| ID | 功能点 | 代码锚点 | 关键约束 |
|---|---|---|---|
| J1 | 一次性认领 | `worker-delivery.ts:56`–`65`、`worker-delivery.ts:166`–`168` | 每个 Agent 一个 WeakMap 已发送集合，key = `workerId/turnId/status` |
| J2 | 空闲唤醒 | `worker-delivery.ts:69`–`81` | 仅 idle 时 `agent.followup(notice)`；失败则撤回认领 |
| J3 | 忙碌注入 | `worker-delivery.ts:119`–`131` | 在 `agent/pre-step` 且 decision=enter 时把通知并入 messages |
| J4 | 触发时机 | `worker-delivery.ts:112`–`118` | agent/created、agent/status(idle)、worker.changed 订阅、启动时对已有 Agent 各刷一次 |
| J5 | 未知 worker 提示 | `worker-delivery.ts:152`–`164` | `unknown` 或 `saved` 且非 idle → 生成 status `unknown` 的通知，明确"不要派新 worker" |
| J6 | 投递内容形状 | `worker-delivery.ts:177`–`186` | plugin 来源、`form: "notice"`、含"重复通知不代表重复工作"的指令 |
| J7 | 生命周期与单例 | `worker-delivery.ts:43`–`48`、`worker-delivery.ts:101`–`108`、`worker-delivery.ts:150` | 每个 backend 只允许一个投递消费者；close 幂等 |

### K. worker 原生请求控制（`src/worker-control.ts`）

| ID | 功能点 | 代码锚点 | 关键约束 |
|---|---|---|---|
| K1 | 按父会话维护 watch 集合 | `worker-control.ts:46`–`81` | `ensure` 对比现有 worker 列表：新 worker 装 watch，离组 worker 释放 |
| K2 | 异步读写后再校验身份 | `worker-control.ts:59`–`64`、`worker-control.ts:78` | 与变更同样严格 |
| K3 | 销毁清理 | `worker-control.ts:89`–`91` | agent/disposed、session/disposed 丢弃对应 watch |

### L. 工具闸门与 PreToolUse 钩子（`src/tool-gate.ts`、`src/pretool-client.ts`）

| ID | 功能点 | 代码锚点 | 关键约束 |
|---|---|---|---|
| L1 | 单一业务 handler 注册 | `tool-gate.ts:162`–`170` | 同一 hook 名重复注册报错；返回精确 disposer |
| L2 | 会话绑定 | `tool-gate.ts:172`–`188` | 必须已注册 hook；已有记录/已有绑定只能是同一 binding，否则"start a new Session" |
| L3 | 绑定校验 | `tool-gate.ts:441`–`449`、`tool-gate.ts:457`–`477` | role/hook 非空、args 必须是纯 JSON 数据（有限数字、普通对象、无 undefined） |
| L4 | 绑定等价比较 | `tool-gate.ts:452`–`454`、`tool-gate.ts:480`–`487` | 规范化 JSON 后比较，键序无关 |
| L5 | 运行时环境注入 | `tool-gate.ts:215`–`222` | 每个 gated runtime 新随机 key；返回 `DSH_PRETOOL_ENABLED/SOCKET/RUNTIME`，只作用于该 runtime 的 spawn env |
| L6 | key 退役 | `tool-gate.ts:231`–`236` | runtime 替换/释放时删除映射，旧 key 失效 |
| L7 | 启动前钩子预检 | `tool-gate.ts:253`–`263`、`tool-gate.ts:395`–`410` | 调 `hooks/list`，要求条目命令含本包 client、enabled 且无 errors、`trustStatus` 为 managed/trusted、事件为 PreToolUse |
| L8 | 决策函数 | `tool-gate.ts:266`–`284` | 无绑定/无 handler/返回非法/抛错 一律 deny 且带原因；否则原样返回 handler 决定 |
| L9 | hook 请求接收 | `tool-gate.ts:295`–`325` | 身份只来自 runtime key；记录必须存在且未关闭；payload 的 cwd/turn_id 与记录不符即拒；toolArgs 原样传递 |
| L10 | socket 传输 | `tool-gate.ts:343`–`382` | `mkdtemp` 0700 目录 + `chmod 0600` socket；一连接一请求一响应；2s 接收超时；1MB 上限；end/error 均回 deny |
| L11 | 传输关闭 | `tool-gate.ts:328`–`340` | 清空 key、关服务器、递归删除 socket 目录 |
| L12 | hook 命令（客户端） | `pretool-client.ts:81`–`93` | 未 armed（`DSH_PRETOOL_ENABLED!=1`）→ 退出 0 且无输出 |
| L13 | 客户端 fail-closed | `pretool-client.ts:84`–`92`、`pretool-client.ts:95`–`99` | 无传输、非 JSON、非对象、连接失败、超时(3s)、响应超限(100KB)/非法 → 显式 deny |
| L14 | 客户端输出协议 | `pretool-client.ts:31`–`36` | 只打印 `hookSpecificOutput.permissionDecision`（allow/deny + reason）；runtime key 永不外泄 |

### M. RPC 传输（`src/rpc.ts`）

| ID | 功能点 | 代码锚点 | 关键约束 |
|---|---|---|---|
| M1 | 拉起 App Server | `rpc.ts:48`–`56` | `spawn(command ?? codex, ["app-server","--stdio"])`；gated runtime 的 env 与 process.env 合并 |
| M2 | 握手 | `rpc.ts:98`–`102` | `initialize`（clientInfo 版本读自 `package.json`）+ `initialized` 通知 |
| M3 | JSON 行分发 | `rpc.ts:57`–`82` | 有 method → request/notification 事件；有 id → 完成 pending；畸形响应 → `UncertainError` |
| M4 | 逐请求超时 | `rpc.ts:105`–`120` | 默认 30s；超时 → `UncertainError` 并触发 `uncertain` 事件（禁止重发语义） |
| M5 | stderr 诊断 | `rpc.ts:83`–`90` | 保留最后 20 行，用于解释 exit 原因 |
| M6 | 断连处理 | `rpc.ts:91`–`97`、`rpc.ts:147`–`156` | child error/exit/stdin error → 全部 pending 以 `UncertainError` 拒绝 |
| M7 | 优雅关闭 | `rpc.ts:130`–`140` | stdin end → 1s SIGTERM → 3s SIGKILL，最后等 exit |
| M8 | 服务器请求回应 | `rpc.ts:122`–`128` | `respond` 正常结果；`reject` 用 JSON-RPC -32601 |

### N. 模型目录（`src/models.ts`）

| ID | 功能点 | 代码锚点 | 关键约束 |
|---|---|---|---|
| N1 | 读取 Codex 目录 | `models.ts:3`–`27` | `config/read(includeLayers:false)` + 分页 `model/list(limit:100)`；默认模型取配置或 `isDefault`；effort/contextWindow 来自配置；模态只保留 text/image |

### O. 契约与类型（`src/browser-types.ts`、`src/execution.ts`、`src/handoff.ts`）

| ID | 功能点 | 代码锚点 | 关键约束 |
|---|---|---|---|
| O1 | 运行状态机类型 | `browser-types.ts:8`–`20` | `starting/idle/running/interrupt-requested/waiting-approval/completed/failed/interrupted/unknown/saved` |
| O2 | 快照/上报/用量类型 | `browser-types.ts:28`–`240` | `cwd` 与 `executionCwd` 显式分离；`pending`/`applied` 分离"请求"与"原生事实" |
| O3 | 后端接口面 | `browser-types.ts:321`–`355` | provider 与工具共同依赖的 `CodexBackend` 契约（含双签名 steer/interrupt/decideApproval） |
| O4 | 事件类型 | `browser-types.ts:279`–`288` | 9 种 `BackendEvent` |
| O5 | Host 执行读取接口 | `execution.ts:2`–`61` | `read`/`facts` 不触发 resume 与模型请求；含 Cordis 模块声明合并 |
| O6 | Host 交接接口 | `handoff.ts:20`–`79` | 请求/结果/所有权类型 + id 双向映射 + 模块声明 |
| O7 | 订阅语义 | `browser-types.ts:312`–`319` | `interactive: true` 才能回答 `item/tool/requestUserInput` |
| O8 | 命名说明 | `browser-types.ts:1` | 文件名沿用旧"browser 半边"，现为**纯类型模块**（运行时无代码、无 UI） |

---

## 3. 扩展点与外部契约一览

**DSH 事件消费**：`agent/pre-step`（上下文过滤 `context.ts:80`、报告注入 `worker-delivery.ts:119`）、`agent/status`（idle 投递）、`agent/created`、`agent/disposed`、`session/disposed`（`index.ts:123`、`worker-control.ts:90`、`worker-delivery.ts:114`）。

**DSH 服务发布**：`codexToolGate`（`index.ts:148`）、`codexExecution`（`index.ts:149`）、`codexHandoff`（`index.ts:155`）；LLM adapter 注册 `index.ts:147`；工具 `codex_workers` 注册 `index.ts:196`；系统提示段落 `index.ts:229`。

**DSH 服务消费（可选 seam）**：`approval`、`userQuestions`、`attachments`（`index.ts:141`–`143`）、`sessionProjections`（`context.ts:63`）、`profileContext`（`index.ts:59`）。缺失时一律 fail-closed（审批拒绝 / 提问空答 / 图片报错 / 视作非 Codex）。

**Codex App Server 方法**：`initialize`/`initialized`、`config/read`、`model/list`、`hooks/list`、`thread/start`、`thread/resume`、`thread/read`、`thread/compact/start`、`turn/start`、`turn/steer`、`turn/interrupt`；通知 `turn/started`、`turn/completed`、`item/*`、`item/agentMessage/delta`、`item/reasoning/summaryTextDelta`、`item/commandExecution/outputDelta`、`thread/tokenUsage/updated`、`thread/settings/updated`、`hook/started`、`hook/completed`；服务器请求 `item/{commandExecution,fileChange,permissions}/requestApproval`、`item/tool/requestUserInput`、`mcpServer/elicitation/request`。

**环境变量**：`DSH_PRETOOL_ENABLED`、`DSH_PRETOOL_SOCKET`、`DSH_PRETOOL_RUNTIME`（仅注入 gated runtime 子进程）；`DSH_HOME`（默认状态目录推导）。

**磁盘布局**：`<stateDir>/sessions/<encodeURIComponent(sessionId)>.json`（0600，原子 rename）、`<stateDir>/owner.lock/owner.json`（0600）、临时收回目录 `owner.lock.reclaim`、运行时 socket 目录 `$TMPDIR/dsh-pretool-*/gate.sock`（0700/0600，dispose 删除）。

---

## 4. 测试与脚本（功能点的可执行证据）

### 4.1 `test/`（18 个 `.test.mjs`、144 个 `test()` 调用、2 个 fixture、6 个 driver）

静态统计（**未运行**）：144 个 `test()` 字面调用；`rpc-failure.test.mjs` 另用 `for` 循环生成 2 例，故实际用例约 146。测试名本身就是行为断言，下表按"文件 → 它验证的功能点"归纳。

| 文件（行数） | 角色 | 验证的功能点（括号为用例起始行） |
|---|---|---|
| `provider.test.mjs`（1757） | 适配层端到端（最大） | 目录/模型元数据不建线程（154、180）；流式一轮后 resume 同线程（204）；重启后从记录重学 contextWindow（257）；跨 provider 与工具历史只导入一次、无附件 seam 时图片 fail-closed（282）；图片模态与 `localImage`（318、342、373）；fork 会话工具历史导入（388）；导入时过滤注入上下文（426）；并发会话隔离与取消（466）；按会话工作区与显式模型（501）；标题/压缩请求隔离并清理（539）；一次性输入走辅助路径（570）；审批与提问桥（591–720）；child/legacy worker/外部 native 事件隔离（746）；原生压缩 10 例（831–1118）；中止、失败 replay、关闭拒绝后续调用（1154–1218）；真实 DSH `LlmRuntime` 注册与 chunk 归一化（1226、1258）；uncertain RPC 结束流且过期事件不能补完成（1281）；执行输入全链（1338–1464）；冷恢复事实追补（1488）与无活 Agent 基线（1579）；受管 child 不能请求未授权路由（1532）；lane 边界不被放宽（1548）；`readExecution` 报 `executionCwd`（1657）；插件未请求的权限策略被记录为原生事实（1738） |
| `backend.test.mjs`（548） | 后端状态机集成 | 线程绑定与原生重试去重（53）；有边界执行仍上报审批（142）；permissions 轮次授权、非交互 user input 空答、elicitation 拒绝（176）；阻塞提问只答一次（224）；typed skills、rollout usage、compact 视为维护操作（264）；图片 base64/host-path 映射与非法图片在 turn 前拒绝（298）；关闭前置条件（321、342）；销毁释放（353）；死进程遗留记录可直接 resume（380）；不确定 runtime 拒绝 resume（402）；释放可等待（418）；active 线程拒绝接管（443）；有运行中命令拒绝关 worker（465）；重复终态只结算一次（493）；只留事实不留通知（524） |
| `tool-gate.test.mjs`（446） | 闸门桥与 hook 客户端 | 单 handler 与 disposer（72）；绑定暂存/幂等/校验（84、95）；role 不被枚举（109）；绑定或 handler 不可用即 deny（118）；多会话隔离（139、331）；handler 拿到的是脱离副本（154）；记录持久化且只能复述（168、195）；未绑定会话不写 gate（181）；畸形 gate 记录整条失败（206）；真实 hook 命令往返（264）；未 armed 静默、armed 无传输 deny（287）；抛错/未知 hook/陈旧 key 均 deny（304）；payload 不能自选会话、role 或参数（317）；接收方不答则 deny（345）；启动预检只认本 client 的 managed/trusted PreToolUse（361、375）；交接后绑定随后继（393）；hook run 是"被拒 vs 未尝试"的证据（420）；未绑定会话无 gate 环境与预检（432）；已释放会话拒绝请求（439） |
| `worker-tool.test.mjs`（379） | `codex_workers` 工具面 | 工具与提示段落注册（60）；非活父 Agent 不能操作其 worker（103）；`append` → 报告 pending → `accept` → `close` 全流程（127）；后端状态前置条件（165）；未读字段被拒（197）；通知每个父 Agent 只认领一次且不伪造决定（222）；legacy worker 数据不迁移不重新识别（263）；worker 审批到父答案者（335）；worker 提问到父提问面（361） |
| `thread-handoff.test.mjs`（250） | 交接集成 | 后继绑定原线程且源被去授权（119）；源所有线程路径被拒、含冷恢复（154）；后继首轮 resume 原线程并换目标配置（184）；绑定失败/不匹配时报错而非新建线程（212）；后继首轮不重放源历史（234） |
| `store.test.mjs`（222） | 存储与锁 | 所有权持久化与 `running`→`unknown`（10）；合法/非法历史报告记录（69、84）；legacy 未绑定与 worker 记录恢复及统一占用（114、141）；锁按进程身份识别而非复用 pid（155）；死进程锁回收 vs 活 owner 不被抢（179）；通知镜像只在载入时投影一次（197） |
| `config-switch.test.mjs`（220） | 配置切换（pending/confirmed） | 受管 child 同线程切换且 pending 到原生确认（95）；普通主会话后续轮切换不换线程（134）；显式拒绝保持旧配置（161）；确认后的切换在冷恢复后不回落（175）；pending 在 resume 时由原生事实对账（200） |
| `integration-gate.test.mjs`（189） | 真实 Codex 闸门（默认 skip，需 `DSH_GATE_LIVE=1`） | 真实 Codex turn 被 workflow gate 拒绝（83）；不可用部署被判 FAIL 而不是通过（168） |
| `dependencies.test.mjs`（134） | 依赖纪律 | 无家族级依赖快照（74）；同一包不在两个 section（79）；脚本不写死 DSH 版本（88）；开发树只有一代 dsh 包（101）；兼容矩阵只含已实测 release（118） |
| `failures.test.mjs`（114） | 失败与恢复 | 不确定的创建/turn 不重发，错误线程的审批被拒（55） |
| `integration-handoff.test.mjs`（109） | 交接入口（真实线程） | handoff 转发声明的 lane boundary，后继 resume 被交接的线程（46） |
| `ownership.test.mjs`（94） | 所有权围栏 | 隔离各父会话 worker、拒绝 UI caller、保留 legacy user 所有权（43） |
| `host.test.mjs`（80） | Host 装配 | headless 注册一条路由、卸载释放所有权、可重载（11）；销毁释放（34）；省略 `stateDir` 落到 launched profile 状态树（64） |
| `watch.test.mjs`（65） | 发布器行为 | `--no-initial-build` 需要完整基线（39）；只发布完整暂存构建（44）；开发 watch 的源码变更要求重启（52）；构建期 SIGINT 不能发布（61） |
| `execution-events.test.mjs`（68） | 事实归约 | 事实整场只重放一次且 reasoning 不外泄（8）；未完成状态只随绑定的终态 turn 并保留不确定性（27）；投影不带模型撰写文本（42）；长输出截断并指向可寻址 item（62） |
| `context.test.mjs`（51） | 上下文过滤 | 只对 Codex 步骤丢弃注入上下文并保留任务输入（4） |
| `facts.test.mjs`（44） | 事实消息 | 按 item 分组为稳定 id 的一条消息（8）；plugin 来源且无 tool-call 身份（22）；从会话日志读回已导入身份（35） |
| `rpc-failure.test.mjs`（28） | RPC 故障 | `timeout`/`exit` 两例：真实 RPC 故障终止 provider、永不重发（`turn/start` 只发生一次），记录落 `unknown`（11） |

fixture 与 driver：driver 都是 test-only 的 Cordis profile 插件，由 `test-live.mjs`/`live-hermetic.mjs` 注入隔离 profile，跑完把带 `PASS_*` 状态与 observed 证据的 JSON 写到 `DSH_NATIVE_CHILD_RESULT`。

| 文件 | 角色 | 关键点 |
|---|---|---|
| `fake-codex-app-server.mjs`（225） | 脚本化 Codex App Server | 讲同一 stdio JSON-RPC（`initialize`、线程生命周期、`turn/start`、`model/list`、`config/read`）；每轮回脚本化 `turn/started` + 一个 completed `commandExecution` + final `agentMessage` + `turn/completed`；线程元数据持久到 `DSH_FAKE_CODEX_STATE`（使 `thread/read` 临时进程看到同 cwd）；每个入站请求追加 `DSH_FAKE_CODEX_LOG`，客户端对服务器请求的响应也记录；环境开关 `DSH_FAKE_CODEX_FINAL`/`COMMAND_OUTPUT`/`APPROVALS`/`QUESTIONS` |
| `fixtures/uncertain-server.mjs` | 故障注入 App Server | `timeout`（不答）与 `exit`（中途退出）两种模式，供 uncertain 语义测试 |
| `compact-driver.mjs`（118） | live driver：原生压缩 | `inject = agents/compaction/sessionPersistence/codexExecution`；两轮标记文本验证压缩后仍能继续 |
| `delegate-driver.mjs`（103） | live driver：委派 | `inject` 含 `subagents`；一个角色任务交给一个 child，child 保留 handle 供后续跟进 |
| `native-child-driver.mjs`（145） | live driver：原生 child 参数链 | 真实 spawn/descriptor/冷恢复链；`DSH_EXTERNAL_EVENTS_TEST=1` 时走外部事件分支 |
| `workflow-child-driver.mjs`（121） | live driver：workflow child | 真实 spawn/descriptor/冷恢复链的 workflow 形态 |
| `workflow-contract-driver.mjs`（117） | live driver：合同交付 | 在隔离仓库里用真实 native worker 跑安装后的 `codex_workflow` 工具 |
| `workflow-handoff-driver.mjs`（253） | live driver：后继交接 | 真实 bootstrap handoff：`sup` 开场阶段把任务交给 `def` 后继 |

驱动方式见 4.2 的 `test-live.mjs`（driver 被拷成 `native-child-driver.mjs` 后由 `insert` row 注入），以及 `package.json` 的 `test` / `test:integration:handoff` / `test:live*` 脚本。

测试运行契约（静态核实）：

- 全部用顶层 `test(...)`，无 `describe`；实测 144 个顶层 `test()` 调用（`rpc-failure` 再加循环生成的 2 例）。
- **测试断言的是编译产物**：15 个测试文件直接 `import "../lib/*.js"`（backend、execution-events、facts、index、provider、rpc、store、tool-gate、worker-actions、worker-delivery），因此 `npm test` 隐含"先 `npm run build`"，改 `src/` 后不构建就跑测试会测到旧产物。
- 测试替身分三层：进程内 `FakeServer`（EventEmitter，用于 provider/backend/config-switch/thread-handoff）、真实 Cordis Context + 真实插件 over 脚本化 App Server（`host`、`worker-tool`、`integration-handoff`）、真实子进程（`rpc-failure` 的故障 App Server、`tool-gate` 的 `lib/pretool-client.js` 往返、`watch` 的 `scripts/*.mjs`）。
- `integration-gate.test.mjs` 用真实 `codex` CLI 与 `~/.codex/config.toml`，会备份/还原配置并打印前后 sha256（并同时挂 `t.after` 与 `process.once("exit")`）；默认 `skip`，需 `DSH_GATE_LIVE=1`。

### 4.2 `scripts/`（7 个脚本）

以下为静态阅读结论：本次整理**未执行**任何脚本（未跑 `npm test`、`test-live`、`verify-dsh-compat` 或 live/hermetic 运行），脚本行为依据其代码与注释。

| 脚本 | 功能点 | 关键行为与失败语义 |
|---|---|---|
| `clean-rc1-live.mjs`（163 行） | 干净 profile 的真实 child 验收入口 | 要求 `~/.dsh/profiles/clean-rc1/node_modules` 存在否则 `clean-rc1 profile missing`；把真实 `~/.codex`/profile 只读播种进 `.live/clean-rc1-<stamp>/`；内嵌 stock child driver（`inject: agents/subagents/sessionPersistence/codexExecution/llm`），带 `developerInstructions` 标记与 `boundary` lane；断言 child 的 DSH cwd == 父 cwd、`codexExecution.read().cwd` == 父 cwd、最后 report `completed` 且含 `DSH_CLEAN_RC1`；4 级 `--preserve-symlinks`/bundle 数降级阶梯各 300s；状态 `PASS_CLEAN_RC1_CHILD`/`FAIL_ASSERTIONS`/`FAIL_NO_CHILD`，非 PASS 时 exit 1；结束删除播种的 `auth.json` 与 `home/.dsh` 并写 `evidence/clean-rc1/02-live-child-result.json` |
| `live-hermetic.mjs`（113 行） | 零审批 hermetic 真实模型入口 | 把 `HOME`/`CODEX_HOME`/`TMPDIR`/npm cache 全部改指 `.live/<stamp>/`，只读播种 Codex 登录态、`llm-deepseek`、`.credentials.yaml`、`.gitconfig`、`.npmrc`；`--cross` 时按"已播种凭证 → `DEEPSEEK_API_KEY` → 真实 `.credentials.yaml` 正则提取"顺序找 key，找不到仅告警（后继会 `MISSING_CREDENTIAL`）；透传 `--workflow-handoff` 给 `test-live.mjs`；退出时（无论成败）删除所有 `auth.json`/`*.credentials.yaml`，打印 `credentials-removed=` 与证据路径 |
| `test-live.mjs`（191 行） | 隔离安装 + 真实/live 验收主入口 | 11 个 flag（`--fake` 用脚本化 App Server 替换真实 Codex）；证据前缀由 flag 推导；`dshGeneration()` 要求 devDependencies 中 `@deepseek-ai/dsh-*` 是唯一精确三段版本，否则报错；写 UNRUN → `npm install --ignore-scripts` → 动态 import 校验 Host `apply` 是函数 → `--dump-config` →（`--install-only`/`--browser` 到此结束，状态 `PASS_ISOLATED_INSTALLATION`）→ headless 真实跑并校验输出严格等于 `DSH_CODEX_APP_OK`、再扫 `<stateDir>/sessions/*.json` 必须存在 `codex:` 前缀且 `completed` 的记录；终态状态串 8 种（`PASS_BASIC_MAIN_SESSION`、`PASS_NATIVE_COMPACTION`、`PASS_DELEGATE_ROLE_TASK`、`PASS_WORKFLOW_SUCCESSOR_HANDOFF`、`PASS_WORKFLOW_CONTRACT_DELIVERY`、`PASS_WORKFLOW_NATIVE_CHILD_PROFILES`、`PASS_EXTERNAL_EXECUTION_EVENTS`、`PASS_NATIVE_CHILD_PARAMETER_CHAIN`）；始终写 `evidence/<prefix>-result.json` |
| `verify-dsh-compat.mjs`（177 行） | 让 `dsh.compatibility.dshReleases` 成为可验证事实 | 对每个声明 release 建一次性 `DSH_HOME`：写 profile + `cordis.patch.yml`（含 `stateDir`）→ `npm install` 两个 tarball → `--dump-config` 要求两个 row 名都在 → 跑 `compat-surface-probe.mjs` → 起 `dsh web`、60×2s 探活、从 boot log 取 token、对 `/workflow/profiles` 与一个不存在的端点各 POST 一次并要求两者状态码不同（`CHANNEL_NOT_DISTINCT` 即失败）；判词 `OK`/`RED`，逐级 `INSTALL_FAIL`/`COMPOSE_FAIL`/`SURFACE_FAIL`/`BOOT_FAIL` |
| `compat-surface-probe.mjs`（137 行） | 单个已装 release 的兼容面探针（用该 release 自己的依赖运行） | 5 类检查：`evaluatePluginCompatibility` 评审 peer 声明；`readPluginMeta` + **locale 断言**（`en` 为英文锚点、`zh` 非空、任一语言为空即缺陷）；`ToolCallRecovery` 存在性及其"已记录结果不得重复、缺失结果恰好补一次"的实测（缺失则 `SKIP`）；`app-boot` 仍导出 `loadProfileDirectory`/`composeEntries`；`dsh-user-questions` 的 `ask` 是函数（缺失 `SKIP`）、`dsh-tool-ask-user` 的 `Config` 可选 |
| `publish.mjs`（86 行） | 原子化"暂存构建 → 校验 → 替换 `lib/`" | stage `.watch/publish-build`（`node_modules` 用 symlink/junction），在 stage 内 `npm run build`，要求 `lib/index.js`、`lib/backend.js`、`lib/provider.js` 都在；`replaceDirectory` 用 `lib.watch-backup` 实现替换与失败回滚；watch 模式三态 `pending/building/coreChanged`、SIGINT/SIGTERM 停止、构建事件串行化；`--no-initial-build` 要求基线产物存在 |
| `watch.mjs`（4 行） | `publish.mjs` 的 development 薄封装 | `watchPublication(true)`：**首次 `src` 变更即策略性停止发布**（打印 "restart required; publication paused"）；需要持续发布要用 `npm run release:watch` |

本地可复现性缺口（静态阅读得出，未执行验证）：`verify-dsh-compat.mjs` 默认需要 `../dsh-workflow-kit/dsh-workflow-kit-<version>.tgz`，当前 checkout 只有 provider 的 tgz；`test-live.mjs` 无条件读取 `../dsh-workflow-kit/package.json`，且默认 skill 目录 `root/../../codex-workflow/skills/codex-workflow` 在本机不存在（需 `DSH_WORKFLOW_SKILL_DIR`）。

### 4.3 打包与元数据

| 文件 | 功能点 | 关键约束 |
|---|---|---|
| `package.json` | 包身份、构建/测试契约、打包白名单、DSH 插件元数据 | `type: module`；`exports` 只有 `.`、`./package.json`、`./locale/*.json`（**无 `./client`**）；`files` 仅 `lib`+`locale/*.json`+`cordis.patch.yml`+`LICENSE`；`engines.node >= 22.19.0`；5 个 `@deepseek-ai/dsh-*` peer 全为 `*` 且 `optional: true`（兼容性闸门据此不按 pinned generation 判插件）；`devDependencies` 精确 pin `0.1.7-rc.2` 那一代；运行时依赖仅 `@deepseek-ai/schemastery ^3.18.2`；`dsh.bundle.patch` 指向 `cordis.patch.yml`、`dsh.compatibility.dshReleases` 声明 `0.1.7-rc.2`/`0.2.0-rc.2` |
| `cordis.patch.yml` | 装包即注册插件入口 | 只有一条 `insert:` row `{ id: dsh-codex-app-provider, name: dsh-codex-app-provider }`；`id` 是其它 patch 挂 `config`（如 `stateDir`）的锚点 |
| `locale/en.json`、`locale/zh.json` | 插件管理器展示文案 | 只有 `meta.title` / `meta.description` 两个键；被 `compat-surface-probe.mjs` 的 locale 断言实际检查（`zh` 必须非空） |
| `tsconfig.json` | Host 侧构建/类型检查 | `strict`、NodeNext、ES2022，产出 `.js`+`.d.ts`+`.map` 到 `lib/`；`include: ["src/*.ts"]` **不递归子目录**——现布局全是顶层文件，但未来 `src/<dir>/` 会被静默排除 |
| `.gitignore` | 决定入库面 | 忽略 `node_modules/`、`lib/`、`dist/`、`*.tgz`、`evidence/`、`.dsh-state/`、`.watch/`、`.live/`——即构建产物、打包物、全部验证证据都不入库；当前 checkout 中 `evidence/` 不存在 |

### 4.4 测试覆盖到、但实现不在本仓库的功能点

这些是本插件所依赖、并由测试断言其契约的部分，读代码时容易误认为属于本包：

| 外部功能点 | 归属 | 本包只做什么 |
|---|---|---|
| `codex_workflow` 工具、role/profile 目录、验收与集成状态机（`started`/`confirmed`/`activeWorker`/`candidate`/`accepted`/`delivered`/`released`） | `dsh-workflow-kit`（`workflow-contract-driver.mjs`、`workflow-handoff-driver.mjs`、`workflow-child-driver.mjs`、`delegate-driver.mjs` 驱动） | 提供 `ctx.codexExecution`、`ctx.codexHandoff`、`codex_workers` 与 provider/backend；自身不做验收 |
| 子 Agent 的 spawn/descriptor/冷恢复与 `request/header` 形状、`queueHostSubagentPrompt` | DSH 核心 `@deepseek-ai/dsh-subagent` | driver 只观察 `descriptor` 与 `execution` 字段是否存活 |
| `LlmRuntime` 与其 seam：`approval.request`、`userQuestions.ask`、`attachments.imageHostPath`/`readImage`、`GenerateOptions.purpose/signal/execution`、chunk 归一化、`createUserMessage` | `@deepseek-ai/dsh-llm` 等核心包 | 结构化读取 `execution`，把原生请求转发到这些 seam，缺失时 fail-closed |
| Host 服务与生命周期：`agents`、`sessions`、`tools`、`systemPrompt`、`sessionProjections`、`compaction`、`sessionPersistence`、`profileContext`、`session/disposed`、会话日志事件类型 | DSH 核心与 Cordis | 消费它们；`facts.ts` 只声明自己的消息来源 kind |
| 真实 `codex` CLI、`~/.codex/config.toml`、hook 信任模型（`hooks/list`、`trustStatus`、`trusted_hash`） | Codex CLI 本身 | 只做 preflight 校验与 hook 命令实现 |
| `scripts/watch.mjs`/`publish.mjs`、`package.json`、`node_modules` | 本仓库但不在 `src/` 之下 | 分别被 `watch.test.mjs`、`dependencies.test.mjs` 断言 |

---

## 5. 分析与观察

1. **provider 有三条互不相同的调用路径**：主会话（`streamMain`，绑定真实 DSH 会话，落事实、可交接）、原生压缩（`compactNativeThread` + 辅助摘要）、辅助一次性调用（`streamAuxiliary`，`codex-aux:<uuid>` 临时 native 会话，用完即关）。阅读 `streamInternal` 的分支即可区分。
2. **"请求值"与"原生事实"始终分开**：`pending` vs `model`（`backend.ts:1325`）以及 `applied`（`backend.ts:1282`）。插件从不把"我请求了什么"当成"Codex 实际用什么"。
3. **fail-closed 是贯穿性设计**：审批、提问、hook、图片、锁、gate 绑定、记录校验，全部选择拒绝而不是猜测；`provider.ts` 有 27 处带码的 `LlmError` 抛出点、9 个错误码（`ABORTED`、`COMPACTION_FAILED`、`DISPOSED`、`EMPTY_RESULT`、`EXECUTION_MISMATCH`、`EXECUTION_UNKNOWN`、`INVALID_REQUEST`、`NO_WORKSPACE`、`WORKSPACE_CHANGED`），绝大多数是拒绝而非兜底。
4. **幂等性有三处独立实现**：`turn/start` 的 `idempotencyKey`、执行事实的 `codex-executed:*` 消息 id、报告投递的 claim key；分别覆盖"重试同一轮""重放/冷恢复""重复通知"。
5. **`worker-actions.ts` 的 `skills` 字段未在工具 schema 暴露**：`ACTION_FIELDS` 允许 `append`/`steer` 携带 `skills`（`worker-actions.ts:38`–`39`），但 `index.ts:199`–`209` 的 `codex_workers` 参数表没有该字段。经模型工具的路径当前无法使用该能力，属实现与暴露面的差异。
6. **`browser-types.ts` 不含浏览器代码**：它是 backend / provider / 工具共用的类型契约；包内确实没有客户端 UI（与 README 一致）。
7. **平台面**：锁身份依赖 `/proc`（`store.ts:306`、`store.ts:320`），hook IPC 依赖 Unix domain socket（`tool-gate.ts:345`）。两者在 Windows 上不可用；`processStartTime` 已导出，说明它是被测试直接覆盖的接缝。
8. **文档与工作树已漂移**：`EXECUTION.md` 描述的"同包客户端"链路（`scripts/build-client.mjs`、`src/client/`、`lib/client.js`、`dsh.client`、react/react-dom peer、`test/client-bundle.test.mjs`）在当前工作树中**没有对应物**——`scripts/` 无该文件，`src/` 无子目录，`package.json` 无 client 字段/依赖/脚本，`tsconfig.json` 也只收顶层 `src/*.ts`。当前布局与 README 的"本包不提供浏览器 UI"一致。
9. **证据无法在当前磁盘核验**：`evidence/` 被 `.gitignore` 忽略且当前不存在，`EXECUTION.md` 与两个 prompt 引用的全部 `evidence/*.log`、`evidence/probe-405/` 都不在。`EXECUTION.md` 的完成度表是文档自述：E0 基线 / E1 单插件迁移 = PASS，E2 恢复与 child / E3 设置与原生事件 / E4 侧栏 / E5 隔离安装与真实主会话 = PARTIAL，E6 旧消费者退役 = TODO；文首自述"完整目标未完成"。本文件只把它当作声明而非事实。
10. **部分脚本未接入 npm scripts**：`clean-rc1-live.mjs`、`verify-dsh-compat.mjs`、`compat-surface-probe.mjs`、`watch.mjs` 只能 `node scripts/...` 直调；`watch.mjs` 在首次源码变更后会主动暂停发布，持续发布必须用 `npm run release:watch`。
11. **`prompt.md` / `prompt-2026-09-13-previous.md` 是交接文档而非产品文档**，且内部绝对路径是 Linux 路径（`/home/slepher/...`），与当前 macOS 工作区 `/Users/slepher/project/dsh` 不一致；不能按字面复现。

---

## 6. 数据来源与核验方式

- 源码：`src/*.ts`（19 个文件，5875 行）逐文件通读；文中每条锚点都回读原行确认（脚本化解析 + 人工核对），例如 `provider.ts` 的错误码统计为实测（27 处带码抛出、9 个码）。
- 测试与脚本：`test/`（18 个 suite + 2 fixture + 6 driver）与 `scripts/`（7 个文件）静态清点；`package.json`/`cordis.patch.yml`/`locale`/`tsconfig.json`/`.gitignore` 逐一核对。
- 设计说明（仅用于功能命名交叉核对，不作为事实来源）：`README.md`、`README.zh-CN.md`、`EXECUTION.md`（后者为自述性执行日志，其证据目录当前不存在）。
- 版本/状态：`package.json`（0.1.1）、`git log -1`（`bef8e4c`，2026-10-03，工作树 clean）。
- **本次整理未执行任何构建或测试**（未跑 `npm run build`、`npm test`、`test-live`、`verify-dsh-compat`），因此"代码做了什么"是静态结论；"测试是否通过"未核验，需另跑 `npm test` 与相应 live 入口。
- 行号为 2026-10-04 在工作树读取时的值；文件若再改动需重新对齐。
