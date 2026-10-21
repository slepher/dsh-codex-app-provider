# 两个插件升级到 DSH 0.2.1-rc.2 的检查与规划

日期：2026-10-21。状态：实现与本地构建/回归已完成；现有 DSH 的文件夹安装及运行验收待完成。

范围：`dsh-codex-app-provider` 与相邻 `dsh-workflow-kit`。只支持目标 DSH 版本，不保留旧版宿主 API 分支、旧版测试矩阵或版本探测回退。

## 1. 版本结论与依据

| 项目 | 当前状态 | 升级目标 |
|---|---|---|
| provider | 插件版本 `0.1.1`；DSH devDependencies 均为 `0.1.7-rc.2` | 所有 DSH 开发依赖统一 `0.2.1-rc.2` |
| workflow | 插件版本 `0.1.1`；DSH devDependencies 与运行时 `dsh-tools` 为 `0.1.7-rc.2` | 所有 DSH 依赖统一 `0.2.1-rc.2` |
| 支持声明 | 两者 `dsh.compatibility.dshReleases` 均列出 `0.1.7-rc.2`、`0.2.0-rc.2` | 只记录实际完成 live 验证的版本 |
| 宿主安装门禁 | 两者没有 `engines.dsh`，DSH peers 都为可选 `*` | 两者显式设置 `engines.dsh: ">=0.2.1-rc.1 <0.2.2-0"` |
| 插件间依赖 | workflow 将 provider 声明为可选 peer `0.1.1`，本地另行复制 provider 类型 | 协调升级版本及对应 peer；构建顺序仍是 provider → workflow |

官方最新发布是 [v0.2.1-rc.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.2)，2026-10-17 发布，仍为 prerelease。检查时本地 DSH HEAD 与该 tag 同为 `687f282e86`。插件检查基线分别为 provider `e3cc6bb`、workflow `d5608fb`。

`dsh.compatibility.dshReleases` 是插件自己的验证记录，不是新版宿主强制执行的版本范围。可选 `*` peer 能通过安装门禁，也不代表运行 API 兼容。当前应表述为：**旧版本有支持声明；最新版本尚未完成兼容验收，且 workflow 存在确定的 API 断点。** 本轮未重跑旧版本验证，不将声明当作重新测得的结果。

检查同时覆盖两段差异：

- [编译基线 0.1.7-rc.2 → 最新版](https://github.com/deepseek-ai/deepseek-harness/compare/dsh-v0.1.7-rc.2...dsh-v0.2.1-rc.2)：覆盖真实依赖跨度。
- [已声明支持的 0.2.0-rc.2 → 最新版](https://github.com/deepseek-ai/deepseek-harness/compare/dsh-v0.2.0-rc.2...dsh-v0.2.1-rc.2)：重点核对新增升级事项。

并阅读了 [0.2.1-rc.1 汇总 release note](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.1)、rc.2 release note，以及本地 `deepseek-harness/docs/upgrade-guide/` 中相关指南。rc.1 汇总了从 0.2.0-rc.2 起的主要变化；rc.2 主要新增 DeepSeek 模型和 Search/Fetch 支持，但不能因此跳过 rc.1 累积的破坏性变化。

## 2. 必须处理的变更

### P0：workflow 子代理创建迁移到 activation

**确定断点。** `../dsh-workflow-kit/src/workers.ts` 的首次派发调用 `ctx.subagents.startContinuable()`；最新版已删除它，改为 `startActivation()`。上游见 [subagent activation 升级指南](../deepseek-harness/docs/upgrade-guide/v0.2.1-alpha.1/subagent-activations/guide.zh.md)，以及 `packages/subagent/subagent/src/index.ts`、`types.ts` 的实际 diff。

实施要求：

1. 改用 `startActivation({ provider: 'spawn', childId, label, request, signal, delivery })`；保留预留 child ID 与首次接受的 `messageId`，保持现有派发幂等逻辑。
2. 当前 `delegate` 文档承诺子任务结束后通知父会话，默认选择 `delivery: 'parent'`。逐条检查 workflow 内部咨询、审核与 handoff 是否已有自己的反馈投递，避免重复通知；只有调用方真正消费结果且不需父级通知的路径才选择 `caller`。
3. 接受完成后，启动调用的 signal 不再控制整个子任务。保留 activation 回执，明确 `result` 拒绝的处理和 `dispose()` 的资源清理责任；正常父工具返回不能误停后台 worker。`interrupt()` 是暂停当前执行，不能用它替代完整释放。
4. `result` 已结算不等于业务验收成功；结合 `stopReason`、现有报告状态和验收账本判断。清理失败单独报告，不能覆盖已捕获的结果。
5. `queueHostSubagentPrompt`、`steerHostSubagentPrompt` 在最新 `./internal` 中仍存在，签名也能承载当前 Host 消息；继续使用，不为本次升级自建消息层。它们不是模型直接发信的 `sendMessage()`，不机械替换。
6. 更新 `test/native-fixture.mjs`、`native-workers.test.mjs` 及 provider 仓库中调用旧 API 的集成驱动、`scripts/clean-rc1-live.mjs`。禁止保留 `startContinuable ?? startActivation` 一类回退。

补充验证：最新版冷恢复从 descriptor 重建的 AgentOptions 仅显式恢复 provider/model/effort，并不保证恢复插件自定义 `execution.boundary`。首次创建仍通过 spread 保留该字段，但“首次成功”不能证明“重启后安全续跑”。必须验证当前记录与恢复策略；若边界无法重新确认，应明确拒绝续跑或创建受约束的后继 child，不能无约束降级。此项是现有集成对最新版恢复行为的风险检查，不断言它由本次上游版本首次引入。

### P0：工作目录与权限根目录分离

最新版引入 `ctx.workingDirectory.get(session)`；`Session.header.cwd` 仍表示原始项目。见 [工作目录升级指南](../deepseek-harness/docs/upgrade-guide/v0.2.1-alpha.1/working-directory/guide.zh.md)。

当前受影响位置：

| 位置 | 当前行为 | 目标行为 |
|---|---|---|
| workflow `workers.ts: parentCwd()` | 从父会话 header 取默认派发目录 | 默认派发目录取父会话当前执行目录 |
| workflow `workers.ts: dispatch()` | lane 边界只传给自定义 `agentOptions.execution` | 同时显式传 `request.cwd = record.boundary.cwd`，使 DSH 工具与 Codex 在同一目录执行 |
| workflow `host.ts: nativeGate()` | 用 header.cwd 解析相对路径 | 使用调用会话的当前执行目录，继续按已授权 binding 校验写路径 |
| provider `provider.ts: sessionCwd()/streamMain()` | 用 header.cwd 创建与校验线程 | 分开读取项目标识与当前目录；普通会话首次启动使用当前目录，受管 child 使用固定 boundary |
| provider `index.ts: liveSessionCwd()`、handoff | 使用 header 作为工作区一致性依据 | 审核其语义后保留项目检查，另校验实际执行目录；不能全局替换所有 header.cwd |

为两插件增加直接消费的 `dsh-working-directory` 类型/peer/dev 声明与必要注入。换目录不会增加授权 writableRoots。已有 Codex thread 的目录是固定执行输入：DSH 目录改变时，在发出原生请求前明确拒绝并提示新建 child/会话，或走现有显式 handoff 流程，不能把旧线程当成已切换目录。

验收要同时覆盖：父目录变更、显式 lane、相对路径 gate、跨目录 handoff、目录变化未扩大写权限，以及原生 DSH provider 与 Codex provider 的行为一致性。

### P0：workflow RPC 适配调用方身份

上游 Connection 新增不同权限的 Peer，`ConnectionRpcHandler` 提供第四个参数 `peer`。`requestRejection()` 只表示请求通过认证与 Host/Origin 检查，不表示 owner 授权。

当前 `../dsh-workflow-kit/src/profile-rpc.ts` 直接注册 webServer prefix，调用 `requestRejection()` 后便根据传入 sessionId 读配置、改配置选择和策略。旧实现没有消费调用方身份，不能沿用“已认证就有全部权限”的假设。源码依据：上游 `packages/client/connection/src/rpc.ts`、`rpc-host.ts` 的 diff；后者已有 `peer.principal.kind !== 'owner'` 的拒绝范式。

优先迁移到 `connection.rpc.handle('/workflow', handler)`，在 handler 中显式限制 owner，复用 Connection 的传输、认证和取消处理，保留 payload 校验与串行写入。如果真实组合测试证明该注册入口仍存在生命周期问题，则通过 `connection.admit(req)` 取得 Peer 并实施同样授权，不保留单纯 `requestRejection()` 的授权判断。

迁移后删除被宿主接管的重复 envelope/body/close-signal 实现。保留或明确配置必要的请求大小限制。覆盖 owner 成功、非 owner 拒绝、未认证拒绝、非法 sessionId/字段拒绝和中止请求；UI 能读取并保存才算通过。

### P1：明确版本门禁与依赖闭包

上游 [engines.dsh 指南](../deepseek-harness/docs/upgrade-guide/v0.2.1-alpha.3/plugin-engines-dsh/guide.zh.md) 明确：存在 `engines.dsh` 时单独按它判断；拒绝记录字段由 `peers` 改为 `requirements`。

实施要求：

- 两插件的 `engines.dsh` 设为 `>=0.2.1-rc.1 <0.2.2-0`，以 rc.1 为最低版本，排除 alpha 与 0.2.2；开发依赖固定 rc.2，实测记录单独维护。
- DSH 开发依赖及 lockfile 统一到该版；workflow 的运行时 `dsh-tools` 同步升级，不能留下旧代传递依赖。
- 宿主共享包继续通过 peer 表达共享实例，不为门禁额外复制一套服务。已有可选性依据真实注入关系决定，不将 optional peer 当成缺失服务仍可工作的承诺。
- Cordis、Schemastery 单独版本管理，不机械设成 DSH 版本。目标 DSH 源码使用 Cordis `4.0.5`，需核对最终锁定与模块身份，避免两个 Cordis 实例导致 Context augmentation 不合并。
- `scripts/compat-surface-probe.mjs` 读取 `issue.requirements`；更新两仓 README、workflow `test/exports.test.mjs` 中“一份构建支持所有 generation”的断言/解释。
- 两插件协调发布建议升到 `0.2.0`，workflow 的 provider peer 同步为 `0.2.0`。实施开始前核对已发布版本占用情况；这里的版本号是建议，不是已发布事实。

`dsh.compatibility.dshReleases` 在最终验收完成后才切到单一最新版；升级进行中的分支不能把计划支持伪装成验证通过。

### P1：请求准入刷新与模型元数据

1. **上下文刷新。** provider `src/context.ts` 在 `agent/pre-step` 过滤 `runtime-context`，文档声称被过滤内容不会进入 Session。最新版 `packages/core/agent-loop/src/agent.ts` 在 `prepareRequest()` 后再次 `refreshContext()`，并在没有已接纳 context 时追加它，因此该日志保证已不成立。

   provider `history.ts` 还有一次 `isCodexVisible()` 过滤，不能仅凭 loop 再注入就断言这些文本已经发给 Codex。实施时分别检查实际原生请求与 DSH 日志：保留 provider 发送前的过滤；在宿主支持的组装接缝中处理需要排除的内容，或收窄日志承诺。不能依赖 pre-step 只运行/求值一次，也不为清理日志重写宿主 loop。测试保留真实用户输入、用户主动调用的技能、压缩 checkpoint 与执行事实的正确语义。

2. **推理强度顺序。** `src/provider.ts` 的 `resolveModel()` 直接透传 Codex `supportedReasoningEfforts` 顺序。新 [标题适配器指南](../deepseek-harness/docs/upgrade-guide/v0.2.1-alpha.1/session-title-adapters/guide.zh.md) 要求从低到高；统一在模型目录出口排序，并保持 configured/defaultEffort 独立。覆盖乱序目录与默认值，避免标题调用误选过高强度。

3. **辅助调用。** 当前已有 `registerAdapter()` 和 `purpose` 的标题/压缩路径，不需要重建适配器。验证新版 `prepareCall()`、标题、手动压缩及工作流角色选模，避免辅助调用意外复用或修改主任务线程。与既有主会话开关规划合并时，明确其对子代理与辅助调用的行为。

### P1：以现有宿主的文件夹安装作为验收入口

按用户后续明确要求，复用现有 DSH `0.2.1-rc.1`，不把重新安装完整 CLI、隔离 profile 或下载 Office 可选运行库列为本次升级的必要步骤。

- `scripts/verify-dsh-compat.mjs` 仅执行本地文件夹预检：检查两个插件的版本门禁、同代依赖声明、构建入口、Client 产物和中英文本地化资源。它不安装软件、不修改用户 profile，且明确提示预检不能代替 live 验收。
- 在 DSH 插件页先添加 provider 文件夹，再添加 workflow 文件夹；按实际安装返回的激活状态、诊断及下一步提示处理。
- 在同一现有 profile 验证设置读写、子代理首次派发、完成通知、续跑、引导、停止与卸载；补充目录、gate 和 handoff 核心路径。
- `compat-surface-probe.mjs` 保留为针对目标版的辅助检查，使用 `requirements`、当前事件格式，并删除旧代 SKIP 分支。它不是文件夹安装的替代品。
- `dsh.compatibility.dshReleases` 在 live 验收完成前保持空，不提前记录 `compatible`。单测独立约束 `engines.dsh` 范围和同代开发依赖，允许尚无 live 测量记录。
- 版本门禁遇到旧宿主时明确拒绝；不添加豁免或旧 API 回退。

## 3. 已核对但不应扩大实施范围的内容

| 上游变化 | 对本项目的判断 |
|---|---|
| 子代理 persona/toolFilter 改为 preset | 当前创建请求没有传这两个字段，无需机械新增 preset；验证继承的组合及 workflow 工具隔离即可 |
| 官方 Codex bundle 提供全局工具 | 它是外部一次性 provider，本项目依赖可续子会话、线程移交与自定义 gate，不能直接替换；测试共存即可 |
| tools `both` 模式删除 | 当前插件源码未使用 `presentAs('both')`，所查 profile 未依赖旧模式；验证 native/PTC，不新增兼容分支 |
| JSONL 持久化改函数插件 | 生产源码使用 sessionPersistence 服务，不直接构造 JSONL 类；检查测试/驱动组合，不迁移插件自己的存储引擎 |
| Session v4 与 reader 变化 | 继续通过宿主 Session API 记录事实，不自行迁移或修改 DSH 历史会话文件；更新探针样本 |
| `stats` slot 拆为 `activity`/`usage` | workflow 注册的是 `conversation.input.left` 和 `settings.section`，没有覆盖旧 stats 行；按最新类型与 UI 运行结果调整 |
| DeepSeek 模型与 Search/Fetch API | workflow 从模型目录动态读取模型；不硬编码新版 DeepSeek 模型，不在本轮新增搜索功能 |
| 实验性 Session 插件状态、worktrees 等 | 不为升级改写现有账本、lane 管理或持久化实现 |
| React 与 Node | 所查最新 UI 包仍用 React 18；Node 最低要求未要求另升。不夹带 React 大版本或运行时迁移 |

## 4. 实施顺序与交付切片

| 顺序 | 修改范围 | 退出条件 |
|---|---|---|
| 1. 依赖基线与门禁 | 两个 package.json/lock、probe 字段与依赖断言 | 最新依赖闭包唯一，旧宿主被明确拒绝；列出真实类型错误，不提前宣称 compatible |
| 2. provider 当前接口 | `provider.ts`、`index.ts`、`context.ts`、模型目录及对应测试 | 当前目录与固定线程边界正确，发送过滤正确，标题/压缩/审批/提问路径通过 |
| 3. workflow 生命周期 | `workers.ts`、`types.ts`、`host.ts`、fixture/驱动 | activation、通知、续跑、取消、清理、lane 与冷恢复行为通过 |
| 4. workflow Connection 与 Client | `profile-rpc.ts`、Client RPC/设置页、相关测试 | owner 授权、完整 RPC 往返、配置保存、中文/英文 UI 和插件启停正常 |
| 5. 文件夹验收 | 本地预检、现有 DSH 的插件页、README 和兼容记录 | 两个目录激活及关键运行路径通过后记录唯一支持版本；打包发布另行进行 |

第 2、3 步共享的工作目录语义先确定，不能一个插件切到“当前目录”、另一个仍按 header 解释。可按切片审查，但两个插件作为同一升级集合验收和发布，不发布只升级依赖的中间状态。

已有 [PROVIDER-PLAN.zh-CN.md](PROVIDER-PLAN.zh-CN.md) 规划 `codex` → `codex-app`、主会话默认开关与精简。本轮应先建立新版 DSH 基线，再执行其重命名/开关，或放在同一升级集合中分开提交。该旧规划引用的 `0.2.1-rc.1` 宿主与 `startContinuable` 路径由本文更新；不为这次版本升级额外引入 spill/storage 重构。

## 5. 验收清单

### 自动检查

- provider：`npm ci`、`npm run typecheck`、`npm run build`、`npm test`。
- workflow：先构建 provider，执行 `npm run prepare:local`（含 staged provider types），再 `npm run typecheck`、`npm run build`、`npm test`。
- 运行 `node scripts/verify-dsh-compat.mjs`，然后在现有 DSH 的插件页依次添加两个已构建目录。`pack:check` 属于后续发布验证，本次不以重新安装宿主作为前提。
- 在现有新版宿主验证服务注册、activation 与 RPC；本地假 App Server 集成覆盖线程移交与请求行为，不使用已删除的旧方法。

### 行为检查

- 普通 Codex 会话、角色模型/effort、父目录继承、显式 lane、写路径 gate 和 handoff。
- 首次委派、接受后父工具结束、自动完成通知、续跑、引导、停止、父级卸载和子级释放；没有重复派发或通知。
- Codex↔其他 provider 的历史事实交接无重复、无漏交；接收未知状态时不自动重派。
- 新建与恢复会话、宿主重启后的受管 child 处理，确认执行边界不丢失。
- owner 设置读写成功；非 owner/无认证无法读写 workflow 私有配置；非法/过大 payload 受控拒绝。
- 审批、结构化提问、图片、标题与压缩；需要原生 Codex 凭据的 live 检查另行明确报告实际执行结果。
- Web 设置页 profile/策略/模型列表可读写，热启停后样式和注册释放正确；必要时覆盖反向代理路径前缀。

完成定义：两个源码目录在现有 DSH `0.2.1-rc.1` 中安装、激活并通过上述关键运行路径；本地类型、构建与相关回归通过；安装范围为 `>=0.2.1-rc.1 <0.2.2-0`，实测声明仅记录已验证版本；无旧 DSH API 回退。目录预检或启动页面单独都不算完成。

## 6. 初始规划阶段的检查证据与限制

- 已通过：两个原工作目录各自的 `npm run typecheck`（现有旧依赖，未更改 lockfile）。
- 已完成：读取官方 releases；本地对照上述 tag 的真实源码 diff，核对 activation、工作目录、Connection、请求准入、LLM 元数据与版本门禁。
- 本轮仅形成规划，未修改插件实现或正式依赖，未将最新版本标记为 compatible，未发布包。
- 已完成最新发布依赖的隔离编译：复制两个插件的源码与 tsconfig 到 `/tmp/dsh-upgrade-audit-20261021`，安装依赖时统一 DSH 版本；lock 中 67 个 DSH 包均为 `0.2.1-rc.2`，Cordis 为 `4.0.5`。未改原项目 node_modules 或 lockfile。

| 隔离检查 | 命令（在对应临时插件目录） | 结果 |
|---|---|---|
| provider 编译与声明生成 | `node ../node_modules/typescript/bin/tsc -p tsconfig.json --pretty false` | 通过 |
| workflow Host 类型检查 | `node ../node_modules/typescript/bin/tsc -p tsconfig.json --noEmit --pretty false` | 失败，只有下列一个错误 |
| workflow Client 类型检查 | `node ../node_modules/typescript/bin/tsc -p tsconfig.client.json --noEmit --pretty false` | 通过 |

```text
src/workers.ts(782,48): error TS2339: Property 'startContinuable' does not exist on type 'SubagentRuntime'.
```

workflow 检查消费的是同一临时依赖树内、本轮生成的 provider 声明。原始日志为临时目录下 `provider-typecheck.log`、`workflow-host-typecheck.log`、`workflow-client-typecheck.log` 与 `install.log`。依赖安装使用 `--ignore-scripts`；这些结果仅证明已发布类型接口的编译表现，不证明原生依赖启动、真实 Codex 请求、前端渲染或新版行为正确。本轮没有运行最新宿主启动、打包与 live 验收。


## 7. 实施记录与当前待办

本节记录实施结果，取代初始规划中“未修改实现”的阶段性说明。

已实施：

- 两插件版本升为 `0.2.0`，DSH 依赖与锁文件统一 `0.2.1-rc.2`，Cordis 为 `4.0.5`；声明 `engines.dsh: ">=0.2.1-rc.1 <0.2.2-0"`，不适配 alpha 或更早宿主。
- workflow 使用 `startActivation`、显式父级通知与 `request.cwd`；关闭及插件卸载通过宿主释放受管子级，结果拒绝有明确记录。
- 默认派发和原生 gate 使用当前目录。provider 分开记录项目目录和原生执行目录，并在已有 thread 的执行位置变化时拒绝继续。
- workflow 配置改由 Connection 注册，显式要求 owner，保留串行写入、取消校验与 8 MiB payload 上限；删除重复 HTTP carrier 实现。
- provider 排序推理强度、保持独立默认值，修正 pre-step 过滤对准入后动态上下文的日志承诺。
- 更新 fixture、原生驱动、README 和本地目录预检；删除仅服务于旧 rc1 profile 的脚本。

本地证据：两仓 `npm ci --ignore-scripts --offline`、typecheck、build 均已通过；目录预检通过。provider 当前目录、推理强度、Host 注册及假 App Server 线程移交的 62 项核心回归通过；workflow 的 owner/RPC、生命周期与目录 gate 核心回归通过。完整结果：provider `npm test` 为 145 通过、0 失败、3 跳过；workflow `npm test` 为 136 通过、7 失败、5 跳过，其中 7 项均已在未修改的 Git HEAD 副本复现。workflow 当前 21 项核心回归全部通过。

现有 macOS 限制已对照未修改的 Git HEAD 副本复现：6 项 Linux 开发脚本用例和 1 项 `/var`/`/private/var` 路径断言失败；本轮不修改这些无关行为。watcher 的并行负载超时单独重跑通过。

曾尝试额外的隔离 CLI 安装，触发可选 LibreOffice 运行库下载。已按用户要求停止这条验收路线。辅助检查中版本门禁、元信息和事件恢复通过，但隔离 Web 的 `/workflow` 路由仍返回 405，不能据此记录兼容成功。后续以现有 DSH 的文件夹安装及其实际诊断为准，不以更换测试方式隐去该未决结果。

当前阻塞：唯一提供 Creator 管理工具的 DSH 桌面会话处于 idle。`plugin_manager` 返回 `approval.request() outside an open turn`，无法进行工具安装。源码 skill 要求此时改用 DSH 插件 UI；已请求用户在该页面依次添加两个本地目录。安装后仍需检查激活、设置和子代理运行，`dshReleases` 暂不标记 compatible。未修改用户 profile、未授予版本豁免、未发布包。

本地日志保存在 `evidence/dsh-upgrade-0.2.1-rc.2/`（忽略目录）。额外创建的三个隔离宿主目录已删除；后续默认验收不安装宿主。

### rc.1 最低版本调整

用户在 DSH Desktop 0.2.1-rc.1 添加 provider 文件夹时被原来的精确 rc.2 门禁拒绝。现按用户要求，两个插件均改为 `>=0.2.1-rc.1 <0.2.2-0`；开发依赖仍固定 rc.2。直接复用现有宿主验证文件夹安装，不安装隔离宿主，不增加 alpha 适配。

本轮验证：两个项目 typecheck、build 均通过；依赖与导出相关测试共 10 项通过；`node scripts/verify-dsh-compat.mjs 0.2.1-rc.1` 通过，使用真实 DSH 版本判定器验证范围边界。当前 MCP 仅返回无 Creator 工具的 idle 会话，实际文件夹安装仍待 Creator 会话可用或用户从插件页重试；尚未标记 live compatible。
