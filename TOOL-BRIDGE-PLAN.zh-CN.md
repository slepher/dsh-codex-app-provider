# Codex App Provider 原生 DSH 工具桥调研与实施计划

日期：2026-10-21（Asia/Shanghai）。状态：前期调研与方案；尚未实现工具桥。本文只规划在 DSH 内选择本插件的 Codex 路由时，如何调用当前 DSH 会话提供的工具，不涉及把 Codex 桌面应用的工具移入 DSH。

## 1. 目标与结论

让 DSH 创造模式中的 Codex 直接调用 `cordis_inspect_list`、`cordis_inspect_query`、`plugin_manager`、`plugin_market`，并通过 DSH 的 `skill`、`read` 完成技能发现后的加载与资源读取。调用经过当前 Agent 的工具注册、权限和执行管线，不再通过 `dsh-creator-mcp` 的 HTTP/MCP 接口。

协议入口已经存在：Codex App Server 在 `thread/start.dynamicTools` 接收工具声明，在运行中以 `item/tool/call` 请求客户端执行工具。provider 需要补齐声明转换、调用绑定、DSH 执行、结果返回和持久化。无需新增 MCP 服务、端口、token、第二套审批或插件管理业务实现。

**能够达到的是选定 DSH 工具的功能一致，不是所有路径的行为已经一致。** 原生 DSH `plugin_manager` 对列表操作也检查权限；当前 MCP 的列表查询无需单次审批。工具桥应遵守 DSH 原生语义，不能套用 MCP 的例外。首版也不承诺原生工具卡片、全部 DSH 工具、PTC、委派或 Codex 桌面应用能力。

## 2. 调研基线和证据

| 对象 | 本次实际检查的基线 |
|---|---|
| app-provider | 插件 `0.2.1`，Git HEAD `6d1991a96c83d7bb84dba144bdc4665c9d870a7e`；开始调研时工作树干净 |
| DSH 源码 | 相邻 `deepseek-harness` HEAD `687f282e8625c6b8d11ff58211a90524be2e4317` |
| provider 安装的依赖 | `dsh-tools`、`dsh-llm`、`dsh-agent`、`dsh-session` 均为 `0.2.1-rc.2` |
| 本机 Codex | `codex-cli 0.160.0`；通过该二进制导出含 experimental 字段的 JSON Schema |
| 在线协议说明 | [OpenAI App Server 文档](https://learn.chatgpt.com/docs/app-server)，重点为 Dynamic tool calls 和线程恢复；访问日期 2026-10-21 |
| 运行中 DSH | 经现有 MCP 的只读 `cordis_inspect_list` 和 `Service.listService({service:"tools"})`，确认实际公开 `schemas`、`get`、`execute`、`guard`、`executionMode` 等接口；未启动或修改会话 |

本机协议检查命令：

```sh
codex --version
codex app-server generate-json-schema --experimental --out /tmp/dsh-tool-bridge-schema-20261021
```

导出的协议文件 SHA-256 如下，供后续实现核对。本计划不依赖临时目录长期存在；实施时重新导出，提交选定协议字段的测试夹具，不提交整套协议生成物。

| 文件 | SHA-256 |
|---|---|
| `v2/ThreadStartParams.json` | `80a40a7fac15b4bf70efb7f893fb353acc0a0d30c68f54aee4f01923deca85de` |
| `v2/ThreadResumeParams.json` | `cc5bb3b25f82073d24af5b6c09e4804ac307467f8400ba5f263fa86f9f0349e6` |
| `DynamicToolCallParams.json` | `401bba20cfbd95762bef0467d840430c46be53369093ad9f26425ba757e34efc` |
| `DynamicToolCallResponse.json` | `abb082cad67f11fcc98ba75f2eff75d7d1723af0c657655329b83ff160451a02` |

证据等级：已检查源码、类型、运行中服务声明和本机生成协议；尚未验证真实 App Server 接受声明、模型实际选择工具、冷恢复重新调用、桌面显示及真实插件安装。生成 Schema 成功不能替代这些验收。本次只写计划，不运行有副作用的管理操作。

### 2.1 现有 provider 的断点

| 文件 | 已确认现状 | 所需变化 |
|---|---|---|
| [provider.ts](src/provider.ts) | `GenerateOptions.tools`、`toolHistory` 未被消费；主调用运行完整 Codex turn，辅助请求独立处理 | 主请求选择工具并绑定执行宿主；辅助请求不接入工具桥 |
| [context.ts](src/context.ts) | 过滤 DSH 的 system/developer、runtime context、skill catalog 和已导入执行事实 | 保持现有过滤；仅为工具桥引入有日志依据的最小技能发现信息 |
| [wire.ts](src/wire.ts) / [backend.ts](src/backend.ts) | start/resume 参数未携带动态工具；`serverRequest` 只处理提问、elicitation 和审批 | 新线程携带声明；单独处理动态工具请求 |
| [rpc.ts](src/rpc.ts) | 已启用 `capabilities.experimentalApi: true`，已有 server request 和 respond/reject 传输 | 复用传输；无需新增 IPC |
| [records.ts](src/records.ts) / [store.ts](src/store.ts) | 已保存线程归属、原生执行事实及恢复数据 | 扩展桥接声明快照和调用结算记录，明确旧记录语义 |
| [facts.ts](src/facts.ts) / [execution-events.ts](src/execution-events.ts) | Codex 执行事实通过带来源的 `user/message` 写入 DSH；已识别 `dynamicToolCall` | 桥接调用与原生通知按稳定身份关联，避免重复导入 |

### 2.2 DSH 工具能力与边界

- [tools/src/index.ts](../deepseek-harness/packages/core/tools/src/index.ts)：`schemas(agent)`、`get(name, agent)` 使用会话作用域；`execute({callId,name,arguments,agent,signal})` 经过 pre-policy、guard、执行包装、post-policy 和内容最终处理。禁止直接调用工具定义的 `execute`。
- [llm/src/types.ts](../deepseek-harness/packages/llm/llm/src/types.ts)：`GenerateOptions` 含 `tools`、`sessionId`、`signal`，**没有 DSH turn/step 编号**。不能用 Codex `turnId` 填 DSH 的数值 turn/step。
- [agent-loop/tool-calls.ts](../deepseek-harness/packages/core/agent-loop/src/tool-calls.ts)：原生 `tool/call`、`tool/result` 的落盘、结果上下文和终止语义由 loop 负责，`ctx.tools.execute()` 本身不完成这些事。
- [session/repair.ts](../deepseek-harness/packages/core/session/src/repair.ts)：工具恢复从 `assistant/message` 中的 tool-call 建立 pending，再用 `tool/call` 关联执行位置。因此，孤立追加一对原生工具事件不能直接视为完整原生恢复支持。
- [tools/src/index.ts](../deepseek-harness/packages/core/tools/src/index.ts)：`schemas(agent)` 与模型最终工具面不是同一概念；PTC 模式只允许模型直接调用 `run_code`。不能把所有 `schemas(agent)` 无条件导出，也不能伪造 `parent` 绕过 PTC 限制。
- [创造模式 preset](../deepseek-harness/packages/bundle/web-app/presets/cordis.patch.yml)：注册检查工具、技能与文件工具，以及依赖 profileContext 的插件管理/市场工具。实际可用集合仍由当前会话和服务决定。
- [tool-skill](../deepseek-harness/packages/skill/tool-skill/src/index.ts)：`skill` 可返回技能全文和资源定位信息；只接入检查/管理工具并不能替代技能发现与资源读取。桌面内置资源可能位于 `app.asar`，需要 DSH `read`，不能假定 Codex shell 能读取。
- [原生 plugin_manager](../deepseek-harness/packages/boot/plugin-manager/src/tools.ts)：通过 session sandbox policy 与 `approveEscalation` 检查权限，包括列表操作；插件安装、构建脚本、版本豁免的既有检查必须保留。
- [当前 MCP 服务调用](../dsh-creator-mcp/services.mjs) 和 [说明](../dsh-creator-mcp/README.md)：绕过 Agent 工具执行器，直调内部服务，使用独立单次授权与 SQLite 审计。该实现用于对照能力，不搬入工具桥。

### 2.3 本机 App Server 协议实测结果

`0.160.0` 的 `DynamicToolSpec` 是带 `type` 的联合类型；不要照搬旧示例中没有 `type` 的声明：

```json
{
  "type": "function",
  "name": "dsh_cordis_inspect_list",
  "description": "沿用 DSH 工具描述",
  "inputSchema": { "type": "object", "properties": {} },
  "deferLoading": false
}
```

该版本也声明 namespace 工具；首版使用带固定 `dsh_` 前缀的 function，减少映射和 reserved namespace 风险。只接受预先建立的名称映射，不按输入字符串任意剥前缀后执行。

`item/tool/call` 参数为 `threadId`、`turnId`、`callId`、`tool`、`arguments`，以及可空/省略的 `namespace`。`arguments` 已是 JSON 值，不假定它仍是待 `JSON.parse` 的字符串。响应为：

```json
{
  "contentItems": [{ "type": "inputText", "text": "工具最终输出" }],
  "success": true
}
```

本机响应内容还声明 `inputImage` 和 `inputAudio`；首版只承诺所选工具的文本结果。图片、音频和附件引用转换不是首版功能，出现未支持内容必须明确失败，不能悄悄丢弃后返回成功。

**工具注册生命周期限制：** 本机 Schema 只有 `ThreadStartParams` 含 `dynamicTools`，`ThreadResumeParams` 和 `TurnStartParams` 均不含。官方文档说明声明会随线程持久化并在恢复时加载；本机声明不支持从 resume 参数替换它们。因此不能承诺每轮刷新工具或恢复时注入新工具；这些行为还需真实协议测试。

## 3. 首版范围和配置决策

新增 provider 配置 `toolBridge.enabled`（默认 `false`）和 `toolBridge.allow`（启用时默认如下六项）。这是拟议配置，不是目前已支持的参数：

```yaml
toolBridge:
  enabled: true
  allow:
    - cordis_inspect_list
    - cordis_inspect_query
    - plugin_manager
    - plugin_market
    - skill
    - read
```

最终导出集合是：配置 allow、当前主请求 `options.tools` 和 `ctx.tools.schemas(agent)` 的交集，并验证 `ctx.tools.get(name, agent)` 一致。以主请求已呈现的 schema 为传输依据，按作用域复核；无 live Agent、无可信主请求或未完成持久化绑定时拒绝启用。配置 allow 是暴露上限，不授予权限，也不使其他 preset 获得创造模式工具。

插件市场、管理服务未注册时，不导出相应工具，不伪造占位能力。冻结新线程实际导出的集合与 schema 指纹；调用时重新检查当前可见性与声明兼容性。隐藏、删除或改变了已冻结的工具时停止相应调用并提示新建会话；新增工具只在新会话获得，不自动扩大现有线程能力。

首版仅支持 native 工具呈现。PTC 请求不可通过交集为空而静默宣称支持：识别仅呈现 `run_code` 的请求并明确报不支持该桥接配置，不修改 preset 的呈现模式。文件编辑、shell、web、计划、goal、workflow 和 subagent 不纳入默认 allow；现有 Codex 自有工具照常由其运行时处理。

仅覆盖同一个 live Agent 上的六项能力不需要额外业务服务。暂不提供通用 `dsh_call(service,method,args)` 或任意工具名执行入口，不新建全量工具发现服务，不复制 MCP 的授权数据库。

## 4. 调用流程与职责

```text
DSH 主请求：sessionId + tools + signal
  → provider 解析真实 Agent，选择并记录固定工具集合
  → 新 thread/start(dynamicTools)
  → Codex item/tool/call
  → backend 校验 runtime / thread / turn / call 归属
  → provider 工具桥：名称映射、当前作用域复核、串行排队
  → ctx.tools.execute({ agent, callId, name, arguments, signal })
  → 记录最终结果 → RPC respond({ contentItems, success })
  → Codex 继续当前 turn
```

### 4.1 执行绑定与权限

执行 Agent 只能由 provider 当前主请求和 backend 的 session/runtime 绑定确定。模型不能通过工具参数指定 session、role、cwd、权限或 parent token。绑定至少包含 DSH session、原生 thread/turn、runtime generation 和调用身份；RPC request id 仅用于当前连接应答，不能用作跨重启幂等键。

首次调用和真正开始执行前均检查绑定仍有效。所有调用传入实际 `agent`，让 DSH 既有 scoped restriction、guard、审批和插件业务权限生效。原生 Codex 命令/文件审批沿用现有 provider 逻辑；DSH 工具调用遵守 DSH 工具自己的权限。两种审批不能互相授权。

workflow 的 PreToolUse hook 可能看到 `dsh_` 前缀后的名称，DSH guard 看到原始名称；实施前核对并测试两入口的名称解析。已有 role 禁止的操作必须仍被禁止，不能扩大白名单来使验收通过。

首版按同一会话串行执行，防止插件管理和后续检查交错；不同会话分别排队。不做全局锁，也不使用 Agent Loop 的内部调度符号。后续只有实测需要时才接入 `executionMode` 并行分类。

### 4.2 日志与结果

首版沿用本插件现有的带来源 `user/message` 记录方式，不在 provider 流式执行期间伪造原生 `assistant/message` 或孤立的 `tool/call`。记录明确区分“请求已接收”“执行已开始”“成功/失败/取消/结果未知”，不能把请求记录描述为已执行事实。正常结果必须在回给 Codex 前提交，落盘失败则停止继续应答成功。

持久化调用键建议由 `(threadId, turnId, callId)` 构成；同时保存名称、参数摘要/必要参数、声明指纹及最终应答。参数不同的同键请求视为冲突，不重新执行。结果按 `result.content` 返回，`success = !result.isError`；不要绕过 post-policy 或把执行内部的 `value` 当成最终模型输出。保留 DSH `meta` 供后续展示方案使用，但它不自动变成 App Server 内容。

向 Codex 返回的内容需要能从 DSH 日志及其持久引用完整还原。可展示的短摘要与完整结果分开保存；敏感认证字段不进入工具 schema 或普通诊断输出。复用现有内容长度控制和 spill/附件服务前核对它们的公开接口，不仅留下指向临时文件的截断标记。

桥接请求日志、schema 快照和执行事实要有确定身份，重放不重复追加。`dynamicToolCall` 完成通知与桥接结果归并为同一次执行，不再多导入一条相同事实。同一原生线程续跑时，过滤已送达的桥接记录，避免再次作为用户指令送入；切换 provider 或导入新线程时保留可读记录。

原生工具卡片及 loop 级工具事件属于后续独立能力；若未来需要，先增加或确认 DSH 公开的外部工具执行/记录入口，并联合验证历史修复、会话表面和 SDK 投影，不能复制 loop 私有代码。

### 4.3 技能与上下文

保持现有 Codex 上下文过滤，不整体透传 DSH system/developer。工具桥只加入“当前可用 DSH 技能的简短目录、用 `dsh_skill` 加载、用 `dsh_read` 读取返回资源”的必要引导，并先写入支持的 Session 事件。目录来源是当前 Agent 的 DSH 技能目录，不能扫描 Codex 用户目录来冒充 DSH 能力。

`skill` 和 `read` 的工具描述沿用 DSH，必要时只替换桥接引用名。技能正文仍可能引用裸工具名；使用一段统一、已落盘的名称映射说明，避免重写每份 skill。验证目录信息未被 `context.ts` 再次过滤，同时不重复注入现有 Codex skill catalog。实施时测量首轮 prompt token 增量。

通用 `ToolExecutionResult.additionalContexts` 与 `concludesTurn` 不能无声丢弃。六项首版工具及其组合策略需检查这两种效果；若出现，必须走已设计且有日志的处理路径，否则在将相关工具纳入支持范围前解决。不能先执行有副作用的工具，再以“不支持终止效果”当作安全拒绝。其他依赖 loop 后续步骤的工具在首版排除。

## 5. 恢复、取消和热重载

| 情况 | 首版处理原则 |
|---|---|
| 新会话 | 声明快照写入成功后创建带 dynamicTools 的线程；协议不支持时明确失败，不降级为空工具线程 |
| 旧的无桥接线程启用配置 | 提示新建 DSH 会话；不能假设 resume 可以增加工具，也不能悄悄替换原 thread |
| 已带桥接线程冷恢复 | 同一 thread 恢复既有声明，重建可信绑定并核对持久化快照；快照缺失或当前能力不匹配时拒绝工具调用 |
| 关闭工具桥/移除 allow | 旧线程仍可能持有声明；启动下一轮前拦截不再允许的桥接线程，提示新会话，不让陈旧声明取得执行权 |
| 同连接重复请求 | 同调用键共享排队/执行结果，只执行一次；已结算请求返回已记录结果 |
| 中断、断线或进程崩溃 | 取消尚未开始的任务；正在执行的任务传递取消并等待结算。无法确认的管理变更记为 unknown，不自动重试 |
| 执行完成但 RPC 回包失败 | 保存已结算结果，重放只返回结果；不能将传输失败等同于业务失败后再次执行 |
| HMR、Session dispose、插件卸载 | 先禁止新调用，撤销 generation，取消并排空本实例已开始的工作，再关闭运行时；陈旧回包不能写到新 runtime |
| workflow handoff | 首版拒绝携带桥接线程的 handoff，除非已验证后继相同能力、声明快照转移及原 owner 撤权；普通 handoff 回归保持通过 |
| session-title / compaction | 不注册工具桥，不借用主会话 pending call；任何意外工具请求都不执行 |

不能笼统承诺 exactly-once：工具副作用和 provider 记录之间没有跨系统事务。目标是本进程去重、已记录结果可重放、恢复时绝不盲目重试未知操作。重启后 unknown 的 pending 调用必须先检查实际 DSH 管理状态；不得自动续跑原变更。

## 6. 实施拆分

### P0：协议与记录方案验证

1. 固定并记录待支持 Codex 版本，以本机 Schema 建立小型协议夹具；验证 function 声明、空参数、JSON arguments、失败响应及非法 namespace。
2. 使用隔离状态目录完成真实 App Server 的 start → 一个动态工具回调 → resume → 再次回调；证实恢复使用原声明，以及旧线程不能通过当前 resume API 注入工具。模型调用用无副作用测试工具，不调用真实插件安装。
3. 用真实 DSH Host 验证主请求期间 `ctx.tools.execute` 的 scoped policy、审批和取消，并验证带来源记录在会话重开、切换 provider 后可读。
4. 审核六项工具和已启用工具策略的结果效果、技能资源读取、workflow gate 名称及原生工具呈现；明确首版文本结果范围。

退出条件：四项有可重复证据；若当前公开接口无法满足必需语义，更新本计划并明确所需的最小上游能力，不以假接口或私有导入继续实现。

### P1：最小只读闭环

修改 `index.ts` 的配置和依赖装配；新增 `src/tool-bridge.ts` 集中处理工具选择、名称映射、调用绑定、排队和响应转换；修改 `provider.ts`、`backend.ts`、`wire.ts`、`browser-types.ts` 承载声明与回调。`rpc.ts` 只在确有协议缺口时改动。

先开放两项检查工具，使用真实 Agent/Session 绑定和无模型 fake App Server 测试完成闭环。同步落实 `records.ts`、`store.ts` 的记录校验、`facts.ts` / `execution-events.ts` 的关联去重、`history.ts` / `context.ts` 的过滤规则。禁用工具桥时保持当前行为。

### P2：创造模式完整首版

纳入 `plugin_manager`、`plugin_market`、`skill`、`read`，补最小技能发现信息。复用原生审批，不引入 MCP 授权规则。覆盖取消、unknown、回包丢失、冷恢复、工具撤权、HMR 和 handoff 拒绝。桥接存在时所需服务缺失要给出明确诊断。

### P3：发布与验收

更新中英文 README、配置说明及“不再需要 MCP”的适用范围；注明仅 DSH 内 provider 桥接会话适用，外部 Codex 访问 DSH 仍可使用 MCP。记录实际验证过的 DSH/Codex 组合，不能把 Schema 兼容当成运行兼容。若持久化字段或 Host 服务发生破坏性变化，补升级说明和相应读取测试。

本计划首轮不修改相邻仓库。只有 P0 证实公开接口不足才提出 DSH 最小变更；workflow 仅在 gate 名称解析或 handoff 处理确需修改时联动。无需新建 npm 包或引入新的第三方运行时依赖。

## 7. 测试矩阵与验收标准

| 层次 | 必须覆盖的行为 |
|---|---|
| 协议/转换 | 带 type 的声明、schema 保留、稳定名称映射、参数 JSON 类型、success/error、未支持内容显式失败 |
| 可见性/权限 | 非创造模式不泄露 scoped 工具；不同 Agent 隔离；allow 不能授予权限；隐藏/卸载立即禁止；PTC 不能绕过 |
| 归属/去重 | 错 thread/turn/runtime、旧 generation、同键不同参数、重复 RPC、旧 owner 均不能重复或跨会话执行 |
| DSH 管线 | pre/guard/审批/post/final content 全链条；无审批服务拒绝；管理列表遵守原生权限；取消传到工具 |
| 日志/恢复 | 记录先于成功回包；落盘失败停止；重开可读；执行事实不重复；同线程不回灌；换 provider 保留历史；unknown 不自动重试 |
| 生命周期 | 排队前/执行中取消、回包丢失、进程退出、HMR、dispose、插件自卸载/升级导致 provider teardown 的结果未知处理 |
| 上下文 | 技能目录可发现；skill 正文和 asar 资源可读；声明和必要指引可重建；测量新增 token，不重复原有上下文 |
| 兼容回归 | 桥接关闭、原生审批/提问、执行事实、普通 handoff、辅助请求及 workflow gate 的既有测试 |

建议扩展 `test/fake-codex-app-server.mjs` 与现有 provider/backend 测试，新增专门的工具桥测试；真实 Host 测试验证策略和日志，不仅 mock `tools.execute`。实现完成后运行 `npm run typecheck`、`npm run build`、`npm test` 与 `npm run test:integration:handoff`；需要真实 Codex 的测试复用现有隔离运行脚本，不把凭据复制进夹具或报告。

最终手工验收在 DSH 创造模式中选择本插件路由：关闭该测试运行时的 DSH MCP 接入后，完成 Host 检查、Client 检查、技能加载、桌面资源读取、插件列表、一次获批的测试插件变更及一次拒绝操作；重启后再次执行只读检查。插件变更使用专用测试 bundle，检查 `application` 与 live 能力后恢复测试状态；不得拿当前工作流的 provider 自卸载作为首次实机验收。

验收完成应能回答：Codex 实际看到哪些 DSH 工具、每次调用属于哪个会话、审批由谁判定、结果在哪里持久化、断线后是否会重复操作，以及未支持的能力如何明确报告。仅看到模型说“调用成功”或 fake App Server 通过不足以发布。

## 8. 本轮结束时的明确缺口

按用户要求，本轮在完成源码、协议 Schema 和运行中 tools 服务声明调研后结束，不继续开展实现或实机试验。以下均为待完成项，不能视为已验证能力：

- [ ] **P0 / 真实协议闭环：** 尚未运行带动态工具的新线程、真实工具回调和恢复后再次调用；需核对运行时与生成 Schema 的一致性。
- [ ] **P0 / 固定声明恢复：** 尚未验证持久化声明在冷恢复中的实际行为、旧线程启用桥接的拒绝路径以及声明指纹读取；当前方案依据本机参数 Schema 和官方说明。
- [ ] **P0 / 完整执行语义：** 已确认公开 tools 接口，尚未在 provider 主请求内实测 scoped policy、审批、取消、结果附加上下文和终止效果；六项工具的组合策略仍需逐项检查。
- [ ] **P0 / 日志方案：** 首版选择带来源消息，尚未验证 schema 快照、调用状态、完整结果引用、重放去重与 provider 切换；原生工具卡片没有实现，不能承诺与原生 loop 展示一致。
- [ ] **P0 / 技能发现：** 尚未确定最小技能目录注入所需的公开服务与日志字段，未验证过滤规则、技能内工具名映射、asar 资源读取和新增 token 成本。
- [ ] **P1 / 生命周期：** 尚无排队、取消、结果未知、回包丢失、HMR、自卸载和 handoff 的实现及测试；尤其不能承诺副作用 exactly-once。
- [ ] **P1 / workflow 联动：** 尚未验证 PreToolUse 对动态工具的实际名称，以及前缀映射后是否与 DSH guard 一致。
- [ ] **P2 / 桌面验收与兼容矩阵：** 尚未在关闭 DSH MCP 的测试运行时中完成创造模式端到端、Client 连接、真实获批/拒绝管理操作或重启验收；`0.160.0` 仅为已检查协议版本，不是已通过工具桥验收的版本。

下一轮从 §6 的 P0 开始。本文中的配置、模块名和执行流程均为拟议设计，当前 provider 尚不支持直接调用 DSH 工具。

## 9. 实施记录（2026-10-21）

本节记录 P0 证据与首版实现结果，取代“尚未实现工具桥”的阶段性说明。

### P0：协议基线与真机闭环（已完成）

基线改为本机实际安装的 `codex-cli 0.156.1`（调研时记录的是 0.160.0，两者协议形状一致）：

- `codex app-server generate-json-schema --experimental`：`ThreadStartParams` 含 `dynamicTools`，`DynamicToolSpec` 是带 `type: "function"` 的联合；`ThreadResumeParams` 与 `TurnStartParams` 均无该字段；`DynamicToolCallParams = { threadId, turnId, callId, tool, arguments, namespace? }`；响应为 `{ contentItems: [{ type: "inputText", text }], success }`。
- 真机闭环（隔离临时 cwd，真实 App Server）：`thread/start(cwd, model, approvalPolicy=never, sandbox=read-only, dynamicTools=[dsh_probe])` 被接受 → `turn/start` 触发 `item/tool/call`（`dsh_probe`，`arguments={value:7}`，`namespace=null`）→ 客户端 `respond` 后 turn completed；`thread/resume` 之后第二轮再次回调（`{value:8}`）并 completed。证明声明随线程持久化，而 resume 无法注入新声明。
- 实测注意：本机 ChatGPT 账号不支持配置里的 `gpt-6.1-sol`，必须显式选择 `model/list` 返回的模型（如 `gpt-6-astra`）。

### P1/P2：首版实现（已完成核心闭环）

- 配置 `toolBridge.enabled`（默认 false）与 `toolBridge.allow`（默认六项）；暴露集合 = allow ∩ 主请求已呈现工具 ∩ `ctx.tools.schemas(agent)`，以 `dsh_` 前缀声明，并按声明指纹冻结进 Session 记录。
- `thread/start` 携带 `dynamicTools`，`thread/resume` 不携带；已有线程的声明与当前选择不一致时以 `EXECUTION_MISMATCH` 拒绝并要求新建会话。关闭或移除 allow 后旧线程同样被拦截。
- `item/tool/call` 由 backend 校验 thread/turn/活 runtime 后转给 provider；provider 解析 DSH Session 与活 Agent，经 `ctx.tools.execute` 执行，文本结果回包。非文本内容显式失败而不是丢弃后报成功。
- 同一 `(threadId,turnId,callId)` 重放返回已结算结果、不同参数视为冲突；同一 Session 的调用串行。
- fake App Server 可脚本化一次动态工具回调；新增 7 项工具桥测试与 7 项主会话门禁测试，provider 全量 162 项、零新增失败，另有一份 backend+AppServer 的真实进程内闭环测试。

### 仍未完成（相对本文验收，不得当作已验证）

- 真实 DSH 创造模式端到端：关闭该运行时 MCP 后的 Host/Client 连接、技能加载与桌面资源读取；
- 桥接调用尚未写入 DSH Session 的带来源持久记录（当前只有 provider 日志）；§4.2 的“记录先于回包、落盘失败停止、跨重启重放”只做到进程内；
- PTC 呈现尚未显式报不支持（当前仅不暴露 `run_code`）；
- handoff 携带桥接线程的拒绝路径未实现、未验证；
- 冷恢复（新进程）后真实回调未实测；
- workflow gate 对 `dsh_` 前缀名称的解析未实测；
- 原生工具卡片与 SDK 投影未实现。
