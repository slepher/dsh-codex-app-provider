# dsh-codex-app-provider 下一轮规划：`codex-app` 重命名、主会话开关与代码精简

> **状态**：规划，未实施。
> **日期**：2026-10-21。
> **校核基线**：本仓库 `bfa53ec`（2026-10-04 18:35 +0800，工作树 clean）；`src/` 20 个文件 / 5,505 行。
> **来源**：2026-10-21 的规划稿。本文是它在仓库内的落档，并补上了对照基线的校核结论与关键实现依据。
> **关联**：`LEAN-PLAN.zh-CN.md`（内置能力收敛）、`REVIEW.zh-CN.md`（重复实现评审）、`FUNCTION-MAP.zh-CN.md`（模块索引，已过期）。跨仓库部分落在相邻的 `../dsh-workflow-kit`。

---

## 0. 结论速览

| # | 工作项 | 一句话 | 主要影响 |
|---|---|---|---|
| 1 | Provider 重命名 | Provider ID `codex` → `codex-app`，显示名 `Codex` → `codex app`，常量 `CODEX_PROVIDER` → `CODEX_APP_PROVIDER` | 本仓库源码/测试/README，`dsh-workflow-kit` 的常量、角色默认值与 `profiles/gpt-workflow.json` |
| 2 | 主会话开关 | 新增 `allowMainSession`（默认 `false`）；关闭时把 `codex-app` 从主会话模型菜单与主会话请求路径上摘掉，同时保留 workflow 子代理能力 | 本仓库 `provider.ts`/`index.ts`，`dsh-workflow-kit` 设置页的模型目录接缝 |
| 3 | 死代码与去重 | 删除零调用的 backend/store 方法、旧记录镜像兼容与重复的会话前缀/Handoff 类型定义 | 本仓库 `backend.ts`、`store.ts`、`records.ts`、`handoff.ts`、`browser-types.ts` 及对应测试 |
| 4 | 内置能力替代 | 已接入的保留；`ctx.spillStore`、`ctx.sessionQuery` 是可选增强；`ctx.storageDomain` 迁移成本高，暂缓 | 本仓库 `process.ts`、`execution-events.ts`、`provider.ts`、`store.ts`/`records.ts` |

落地顺序建议按 1 → 2 → 3：先完成纯改名（不夹带行为变化），再加门禁，最后删代码；每一步独立可回滚。

---

## 1. 背景与定位收敛

结合代码核对与 DSH 宿主 `0.2.1-rc.1` 的扫描结果，本插件的边界应收敛为：

- **核心价值**：为 `dsh-workflow-kit` 提供**可续接（continuable）、支持线程切换（handoff）、带工作目录/工具门禁（PreToolUse Gate）**的 Codex `app-server` 子代理运行时。`dsh-workflow-kit` 通过 `ctx.subagents.startContinuable` 创建子会话（`../dsh-workflow-kit/src/workers.ts:782`），并把角色的 `provider`/`model`/`execution.boundary` 放进 `agentOptions`（同文件 `:777-783`），最终由本插件在 LLM 路由层承载。
- **保留主会话能力，但默认关闭**：Codex 仍可作为顶层主会话（Main Agent）使用，但由配置开关 `allowMainSession` 控制，默认 `false`。这样默认部署里 Codex 只在 workflow 子代理路径上运行，避免主会话输入框、`/model`、标题生成与原生 `/compact` 意外拉起外部进程。
- **Provider 重命名**：Provider ID 从 `"codex"` 改为 `"codex-app"`，UI 显示名 `"codex app"`，与宿主内置/官方名称彻底分开。

> 注：本插件并不通过 `ctx.subagents` 注册自己的 subagent provider（`src/` 中没有相关注册）；`dsh-workflow-kit` 的 `startContinuable` 用的是宿主 `spawn` provider，角色的 `provider` 字段最终作为 LLM 路由传入。因此下方的命名冲突重点是 **LLM 路由与持久化配置字符串**，不是 subagent provider 注册表。

---

## 2. Provider 重命名

### 2.1 为什么改成 `codex-app`

宿主 `0.2.1-rc.1` 里已经有两个容易混淆的官方名称：

1. `@deepseek-ai/dsh-llm-pi-ai` 内置 ChatGPT OAuth 路由，Provider ID 为 `"openai-codex"`（显示名 `"OpenAI Codex (legacy)"`，认证标签 `"OpenAI (ChatGPT Plus/Pro)"`）。
2. `@deepseek-ai/dsh-subagent-codex`（官方按需安装 bundle）在 `ctx.subagents` 注册的 provider 名称为 `"codex"`，定位是 *one-shot Codex subagent*。

本插件当前注册的 LLM 路由也叫 `"codex"`（`src/browser-types.ts:9`），`dsh-workflow-kit` 的角色默认值（`../dsh-workflow-kit/src/roles.ts:14,17,25-30`）与随包 profile（`profiles/gpt-workflow.json`）同样写 `"provider": "codex"`。三者同时启用时，用户在配置、模型选择器、日志与文档里看到的是同一个字符串，指向三种不同实现。

改为 `codex-app`（显示名 `codex app`）后，LLM 路由、模型选择器分组与持久化配置都只指向本插件；与 `openai-codex`、官方 `codex` subagent 名称完全正交，可以同时安装使用。

官方文档明确指出 Provider ID 是持久标识：请求、已保存的会话、模型默认值和凭据引用都用它，改名等于新增一个 provider（[Configure models](https://deepseek-harness.github.io/deepseek-harness/en/guide/providers.md)）。本插件尚未正式发布，因此不做旧名称兼容层；代价见 §2.4。

### 2.2 修改清单

行号为基线 `bfa53ec` 的位置，仅用于定位。

| 仓库 / 文件 | 现状 | 改为 |
|---|---|---|
| `src/browser-types.ts:9` | `export const CODEX_PROVIDER = "codex"` | `export const CODEX_APP_PROVIDER = "codex-app"` |
| `src/provider.ts:36,58` | 导入并复导出 `CODEX_PROVIDER` | 同步改名为 `CODEX_APP_PROVIDER` |
| `src/provider.ts:189-191` | `providerInfo()` 返回 `{ id: provider, name: "Codex" }` | `name: "codex app"` |
| `src/context.ts:82` | `selectedProvider(ctx, agent) !== "codex"` | 使用 `CODEX_APP_PROVIDER`，消灭硬编码字面量 |
| `src/index.ts:10,199` | 导入常量并 `ctx.llm.registerAdapter([CODEX_PROVIDER], provider)` | 改用 `CODEX_APP_PROVIDER` |
| `test/*.test.mjs`（14 个文件，44 处 `"codex"` 字面量） | 关键断言：`test/provider.test.mjs:159,1270`、`test/host.test.mjs:19-29`、`test/context.test.mjs:33,42`、`test/integration-handoff.test.mjs:22`；驱动脚本 `test/compact-driver.mjs:59`、`test/workflow-child-driver.mjs:44`、`test/workflow-handoff-driver.mjs:174` | 只替换"Provider 路由"语义的那些；`test/host.test.mjs:76-79` 断言的是状态目录 `.../codex/owner.lock`，属于 §2.3 的不改项 |
| `README.md:115,133`、`README.zh-CN.md` 对应段落 | "The plugin registers the provider id `codex`"、"child that runs on the `codex` route" | 改成 `codex-app` / `codex app` |
| `locale/en.json`、`locale/zh.json` | 标题已是 "Codex app provider" / "Codex 原生提供方"；描述仍提到已删除的 `codex_workers` | 随本轮一并改描述（措辞清理，不涉及命名） |
| `../dsh-workflow-kit/src/constants.ts:7` | `export const CODEX_PROVIDER = "codex"` | `export const CODEX_APP_PROVIDER = "codex-app"` |
| `../dsh-workflow-kit/src/workers.ts:28` | `const NATIVE_EXECUTION_PROVIDER = "codex"` | 引用 `CODEX_APP_PROVIDER` |
| `../dsh-workflow-kit/src/workflow.ts:12,292,1027` | 导入/比较 `CODEX_PROVIDER` | 同步改名 |
| `../dsh-workflow-kit/src/roles.ts:4,14,17,25-30` | 全部角色默认 `provider: CODEX_PROVIDER` | 同步改名 |
| `../dsh-workflow-kit/profiles/gpt-workflow.json` | 每个角色的 `"provider": "codex"` | `"codex-app"` |
| `../dsh-workflow-kit` 的测试/脚本/README/docs | 多处 `"codex"` 字面量（`test/` 10+ 文件） | 逐处判断：Provider 路由才改；CLI 命令、状态目录、文件名不改 |

### 2.3 保持不变的 `codex` 字面量

改名只针对 **Provider 路由身份**。以下字符串语义不同，不能一起替换：

| 位置 | 值 | 原因 |
|---|---|---|
| `src/index.ts:40`、`src/rpc.ts:105` | `command` 默认 `"codex"` | Codex CLI 可执行文件名，不是 Provider ID |
| `src/index.ts:94` | 状态目录段 `codex`（`join(home, "state", name, "codex")`） | 已落盘的目录布局；改了会读不到旧记录 |
| `src/handoff.ts:71`、`src/provider.ts:1083-1085` | 原生会话前缀 `codex:` | 持久化的线程身份（`threadId` 映射/交接记录依赖它）；与 Provider ID 解耦，保持稳定 |
| `src/provider.ts:62-64` | `CODEX_OWNER_ID = "dsh-codex-provider"`、`AUXILIARY_PREFIX = "codex-aux:"` | 记录持久化的 owner 身份与临时会话前缀，不是路由名 |
| `src/index.ts:200-204` | Host 服务名 `codexExecution`、`codexHandoff`、`codexToolGate` | 本插件对 DSH 暴露的 Host 能力名；`dsh-workflow-kit` 已按此消费，不在本轮更名 |
| `package.json` / 模块名 | `dsh-codex-app-provider` | 包名已经是 app 命名 |

### 2.4 影响与迁移

- 按规划稿口径，插件尚未对外发布（仓库版本 `0.1.1`），因此**不做旧名兼容层**；若实际已有外部安装，应先确认发布记录再决定。但以下本地持久数据会因改名失效：已保存会话的 `model/selection` 与 `request/header` 中的 `provider: "codex"`、全局默认模型、`dsh-workflow-kit` 设置里用户覆盖过的角色 `provider: "codex"`。
- 宿主对"默认模型指向已删除 provider"的处理是：模型选择器显示 **Select model** 并阻止输入，直到重新选择（官方 [Configure models](https://deepseek-harness.github.io/deepseek-harness/en/guide/providers.md)）。
- 本轮**不写迁移器**：开发环境清掉旧 profile/默认模型即可；`profiles/gpt-workflow.json` 的随包默认值直接改，用户覆盖需要重新选择。若要求平滑迁移，应单独立项（一次性改写 settings/会话日志，风险明显高于收益）。

---

## 3. 主会话配置开关 `allowMainSession`

### 3.1 配置项定义

基线 `src/index.ts:21-43` 的 `Config` 实际只有四个字段：`stateDir`、`command`、`requestTimeoutMs`、`providerCwd`。规划稿中出现的 `args`/`env`/`cwd`/`defaultModel`/`defaultApprovalPolicy`/`defaultSandboxMode` **在当前代码里不存在**，不要借本轮新增。

新增：

```ts
export interface Config {
  stateDir?: string
  command?: string
  requestTimeoutMs?: number
  providerCwd?: string
  /** 是否允许顶层主会话（Main Agent）直接使用 codex-app provider，默认 false */
  allowMainSession?: boolean
}

// Config schema
allowMainSession: z.boolean().default(false),
```

- 建议作为**普通配置项**：改动触发插件重载，回退逻辑在 `apply` 期间执行一次；不引入 `volatile` 热更新（本插件当前没有 volatile 字段，宿主对普通配置的 remount 语义已经足够）。
- 若后续要求不重载即可切换，需要把门禁改成读 `ctx.llm`/配置的实时值，并把回退做成可重复执行的幂等操作；这是独立的复杂度，不在本轮默认范围内。

### 3.2 主会话判定依据（本仓库实际可用）

`ProviderSessionFace` 只有 `append`、`snapshotEvents`、`header.cwd`（`src/provider.ts:68-72`），**没有** `origin`/`parentSession` 字段；工具门禁绑定也不对 provider 暴露。规划稿列出的 `session.header.origin === "subagent"` / `toolGate.isBound` 等判据在当前接缝上拿不到，不要作为实现基础。

实际可用的判据：

- **受管子代理**：`requestedExecution(options, this.deps.agents.get(sessionId)) !== undefined`（`src/provider.ts:523-553`）。它同时接受请求自带的 `execution` 与 live Agent 的创建快照，正是 `dsh-workflow-kit` 注入边界的那条路径；普通主会话两者都为空。
- **辅助调用**：`options.purpose !== undefined`（`src/provider.ts:314-319`）。
- **原生 `/compact`**：`purpose === "compaction"`，在 `streamInternal` 里先于辅助路径分发；`compactNativeThread(sessionId)` 只拿到会话 id，实现时需要用 `ctx.agents.get(sessionId)` 的创建快照或 backend 记录里的 execution 基线判断是否受管子代理。

### 3.3 行为矩阵

| 接口 / 路径 | `allowMainSession: false`（默认） | `allowMainSession: true` | 实现要点 |
|---|---|---|---|
| `listModels()`（`provider.ts:205-213`） | **返回 `[]`** | 返回完整 `codex app` 模型目录 | 宿主 `modelCatalog` 会过滤空分组：已在本机安装的 `@deepseek-ai/dsh-api-session-controller` 里核实（`lib/types/catalog.js:53`、`lib/index.js:541`）。同一条目录也用于 `routableProviders` 与 `modelAvailable` 校验，所以主会话模型选择会一起失效——这正是 §3.4 回退的原因 |
| `resolveModel()`（`provider.ts:215-239`） | **保持可用** | 保持可用 | 已核实 `LlmAdapter.prepareCall` 走 `resolveModel` 而不是 `listModels`（本机安装的 `@deepseek-ai/dsh-llm/lib/index.js:1734-1738`）。子代理派发仍能解析 `codex-app/*` |
| Workflow 设置页模型列表 | **需要新增接缝**才可见 | 同左 | 现状：`dsh-workflow-kit` 设置页与主会话 composer 读的是同一个 `ctx.remote.session.modelCatalog()`（`../dsh-workflow-kit/src/client/model-catalog.ts:35`）。`listModels()` 返回 `[]` 后两组 UI 都会消失，**不会自动保留 workflow 侧入口**。需由本插件通过 `ctx.codexExecution` 暴露只读目录查询，再由 workflow-kit 自己的 `/workflow` RPC 合并进设置页（见 §3.5） |
| 子代理 / Workflow `stream()`（`provider.ts:294-321`） | **正常放行** | 正常放行 | 用 §3.2 的受管判据；不放行则 workflow 整体不可用 |
| 顶层主会话 `stream()` | **抛 `LlmError` 拒绝** | 正常放行 | 建议稳定的错误码（如 `MAIN_SESSION_DISABLED`）；拒绝必须发生在任何 backend 调用/进程拉起之前 |
| `streamAuxiliary()`（`provider.ts:704-777`） | **直接返回，不拉起进程** | 正常执行 | 默认关闭时不再产生 `codex-aux:<uuid>` 临时进程；标题/摘要退化由宿主自身兜底 |
| `compactNativeThread()`（`provider.ts:327-357`，经 `streamInternal` 的 `purpose === "compaction"` 进入） | **仅允许受管子代理，拒绝主会话** | 正常执行 | 关闭时主会话的 `/compact` 不再压缩原生线程 |

### 3.4 关闭时全局默认模型与已打开主会话的回退

用户先开启 `allowMainSession: true` 并选了 `codex-app`，再关掉开关时，若 `ctx.agentDefaultModel` 或某个已打开主会话仍停在 `codex-app`，前端会退化成 **Select model** 且输入被阻塞。需要在开关关闭时主动回退：

1. **选候选模型**：`ctx.llm.listProviders()`（本机 `@deepseek-ai/dsh-llm/lib/index.js:272`）排除 `codex-app`，按 `deepseek-account` → `deepseek-official` → 首个有其他可用模型的 provider 取第一个。对每个候选调用 `ctx.llm.listModels(provider)`，逐 provider `catch`（目录实现失败会让宿主 `modelCatalog` 记 `failures`，回退不能因此中断）。不要拿 `codex-app` 的 `listModels` 结果做候选来源。
2. **重置全局默认**：`ctx.agentDefaultModel.currentSelection()` 若 `provider === "codex-app"`，调用 `ctx.agentDefaultModel.saveSelection(fallback)`（接口见本机 `@deepseek-ai/dsh-agent-default-model` 的 README/类型；无配置编辑器时 `saveSelection` 是 no-op，需要按失败降级为只记日志）。
3. **重置已打开的主会话**：`ctx.sessions.list()`（本机 `@deepseek-ai/dsh-session` 类型 `SessionStore.list`）遍历会话；用 `ctx.sessionProjections.stateOf(session, "modelSelection")` 读投影（本机 `@deepseek-ai/dsh-session-projection` 类型；状态形如 `{ lastUsed, pending }`），若 `pending ?? lastUsed` 指向 `codex-app`，向该会话追加 `session.append("model/selection", fallback)`。这与宿主 `selectModel` 的写法一致（本机 `@deepseek-ai/dsh-api-session-controller/lib/index.js:320`），前端模型选择器会随事件刷新。
4. **只处理普通主会话**：受管子代理没有模型选择器，保持 `codex-app` 执行；判定时排除带 execution 的会话。
5. **只有在插件仍然加载时才能回退**：如果用户直接卸载整个插件，宿主自身的 "Select model" 兜底会接管（官方 [Configure models](https://deepseek-harness.github.io/deepseek-harness/en/guide/providers.md)），无需本插件处理。

`ctx.sessionProjections` 是可选的（依赖插件是否挂载）；`ctx.get` 拿不到时跳过第 3 步并记一次 warning，不能因此阻断插件启动。

### 3.5 Workflow 设置页模型目录接缝（设计缺口）

这是本规划里**唯一需要新增跨包接缝**的地方，不能靠现有 API 直接满足：

- 现状只有一个目录来源：宿主 `session.modelCatalog` remote，它按 `ctx.llm.listProviders()` + 各 adapter 的 `listModels()` 组装，并过滤空组。`dsh-workflow-kit` 的设置页直接消费它。
- `allowMainSession: false` 时 `listModels()` 必须返回 `[]`，所以 workflow 设置页会一并失去 `codex app` 组。
- 建议方案：本插件给 `ctx.codexExecution` 增加一个只读目录方法（例如 `catalog(): Promise<{ provider, name, models }>`，内部读 `CodexProviderAdapter.catalog()` 的私有结果或新增同名公开方法）；`dsh-workflow-kit` 在 host 侧把它合并进自己的 `/workflow` RPC（`src/profile-rpc.ts` 已有该通道，`src/client/model-catalog.ts` 加合并逻辑），仅在设置页使用，不影响主会话 composer。
- 这需要同时修改两个仓库并补测试；若暂时不做，则必须接受"关闭主会话后 workflow 角色无法在设置页改选 codex-app 模型"，只能编辑 profile 文件——这是不可接受的产品缺口，建议纳入 Step 2 的完成定义。

---

## 4. 代码精简审计

目标是在保留主会话支持能力（受 `allowMainSession` 控制）的前提下做**无损精简**。规划稿给出约 120–150 行死代码 + 150–200 行去重空间；对照基线后，数量级成立。

### 4.1 零调用的残留死代码

| 符号 | 位置 | 证据 | 估计行数 |
|---|---|---|---|
| `runtime.commands` + `trackCommand()` | `src/backend.ts:67`（Map 字段）、`:728`（唯一调用点）、`:1034-1039`（函数体及注释） | `src/` 内没有任何读取 `runtime.commands` 的地方；状态写进去就再没被消费 | ~15–20 |
| `CodexSessionBackend.configureSession()` | `src/backend.ts:264-272` | `src/` 零调用（`provider.ts` 直接走 `createSession`/`resumeSession`/`startTurn`）；仅 `test/thread-handoff.test.mjs:161` 直接调用 | ~9 |
| `CodexSessionBackend.steerTurn()` | `src/backend.ts:527-540` | `src/` 零调用；workflow-kit 的 steer 走宿主 `steerHostSubagentPrompt`（`../dsh-workflow-kit/src/workers.ts:798`） | ~14 |
| `CodexSessionBackend.occupiedThreads()` + `SessionStore.occupiedThreads()` | `src/backend.ts:324-326`、`src/store.ts:80-82` | `src/` 零调用（内部冲突检查直接调私有 `assertThreadAvailable`）；仅测试使用 | ~6 |
| `CodexSessionBackend.pendingUserInputs()` | `src/backend.ts:558-561` | `src/` 零调用；仅测试使用 | ~4 |
| 旧记录镜像 `LegacyMirror` / `recover()` 的 `events` 分支 | `src/records.ts:74-79`（接口）、`:91-110`（`recover`）、`:113` 起的 `parseRecord` 兼容分支 | 每次读盘仍兼容早期 `events` 字段并投影为 `facts`；若不要求兼容旧磁盘文件，可整段移除 | ~40–50 |
| **规划稿之外新发现**：`SessionStore.has()`、`SessionStore.findByThread()` | `src/store.ts:72-74`、`:76-78` | `src/` 与 `test/` 均无调用方 | ~7 |

删除时一并清掉 `src/browser-types.ts:288,290,296,301` 的接口声明与测试里对应的 fixture 用法。`CodexBackend` 是内部类型（包入口没有导出它），删方法不构成对外 API 破坏。

### 4.2 去重与进程开销

1. **会话前缀映射重复**：`src/provider.ts:1083-1085` 的 `backendSessionId()` 与 `src/handoff.ts:71` 的 `nativeSessionId()` 实现相同（都是 `codex:${sessionId}`），但分别被 provider 与 backend 使用。合并成一个（建议留在 `handoff.ts`，`provider.ts` 从那里导入并保留一个再导出以少改调用点），同时保持 `codex:` 前缀本身不变（§2.3）。
2. **Handoff 请求类型重复**：`src/handoff.ts:20-39` 的 `CodexThreadHandoffRequest` 与 `src/browser-types.ts:119-138` 的 `ThreadHandoffRequest` 字段几乎相同，但已经漂移：后者有 `approvalsReviewer`，前者没有（`REVIEW.zh-CN.md` D5）。两者还分别处于 DSH Session id 与原生 Session id 两个命名空间，**不要直接 alias**；正确顺序是先确定哪一层负责 id 翻译，再合并类型并把漂移字段补齐。
3. **临时 `app-server` 进程复用**：`src/backend.ts:937-946` 的 `readWithTemporaryServer()` 在 `handoffThread()`（`:384`，`thread/read`）与 `modelSettings()`（`:618`，`model/list`，被 `provider.ts` 的 `catalog()` 以 30 秒 TTL 缓存，`CATALOG_TTL_MS` 见 `provider.ts:65`）时各拉起一个全新进程，只做一次 RPC 就销毁。若当前已有活跃 runtime，可直接复用其连接读取；空闲/无 runtime 时再退回临时进程。风险是同一连接上的并发请求时序与 app-server 的并发语义，需先验证再落地（见 §8）。

### 4.3 本轮不动的部分

- `process.ts` 的 `nodeSpawner()`/`nodeTimer()` 后备：生产已注入 `ctx.subprocess`/`ctx.timer`（`index.ts` 按能力判空接入），`process.ts` 共 126 行，其中后备实现约 85 行。只有在单测统一注入 mock `subprocess`/`timer` 后才能删，否则会打穿一批无 `ctx` 的测试 fixture。
- `store.ts`/`records.ts` 迁 `ctx.storageDomain`：现有约 39 处测试直接 `new CodexSessionBackend()`，替换需先加 store 端口并改造 fixture；`LEAN-PLAN.zh-CN.md` §11.4 已记录该前置条件（`zod` 依赖声明、离线环境不可完成）。本轮不做。
- `ctx.spillStore` / `ctx.sessionQuery` 升级是"增强"而非"精简"，见 §5。

---

## 5. 内置插件与宿主服务替代评估

| 本插件模块 | 对应 DSH 内置插件 / 服务 | 能否替代？ | 结论与原因 |
|---|---|---|---|
| 可续接 Codex 子代理执行（`backend.ts` + `provider.ts`） | `@deepseek-ai/dsh-subagent-codex`（官方按需安装 bundle） | ❌ 暂不可替代 | 官方定位是 *one-shot Codex subagent*（`NOT_CONTINUABLE`），不支持 `startContinuable`、`threadHandoff` 与 `execution.boundary` 注入 |
| ChatGPT OAuth 模型路由 | `@deepseek-ai/dsh-llm-pi-ai`（内置 `openai-codex`） | ⚠️ 定位不同，互不冲突 | 内置路由走 `chatgpt.com/backend-api`，在 DSH 自己的 AgentLoop 里执行工具；本插件运行外部 `codex app-server` 的原生沙箱与 `threadId` 持久化。改名后可同时开启 |
| PreToolUse 工具门禁桥接（`tool-gate.ts` + `pretool-client.ts`） | `@deepseek-ai/dsh-hooks-codex`（官方 bundle） | ❌ 方向相反，不可替代 | 后者把磁盘上的 Codex `hooks.json` 挂到 **DSH 内部**工具拦截点执行；前者是为**外部** `codex app-server` 生成临时 `hooks.json`，通过 Unix Socket 把 `PreToolUse` 回调发回 `dsh-workflow-kit` 的 gate handler |
| 子进程与定时器（`process.ts`） | `ctx.subprocess` / `ctx.timer` | ✅ 已接入，可删后备 | 生产已使用；仅 `nodeSpawner`/`nodeTimer` 后备（约 85 行）待测试改造后删除 |
| 审批与用户提问（`provider.ts:796-880`） | `ctx.approval` / `ctx.userQuestions` | ✅ 已完全使用内置服务 | 已直接桥接，无额外改动 |
| 超长工具输出截断（`execution-events.ts:122`） | `ctx.spillStore`（`LocalSpillStore`） | ✅ 可用内置增强 | 当前截断后只留一句 `[truncated; full output at ...]` 的悬空引用，宿主无法展开；改用 `ctx.spillStore.saveText()` 与宿主大输出落盘对齐 |
| 会话事件与 `threadId` 回查（`provider.ts:372-506`） | `ctx.sessionQuery` / `ctx.sessionPersistence` | ✅ 可用内置增强 | 目前依赖可选的 `session.snapshotEvents()` 并在 `store.ts` 维护 `threadId` 映射；接 `ctx.sessionQuery` 可减少对私有状态文件的依赖，但需要先补可选依赖降级 |
| 本地 JSON 状态存储与校验（`store.ts` + `records.ts`，共 505 行） | `ctx.storageDomain`（`DomainFacility`） | ⚠️ 可替代，但成本高 | `records.ts` 手写校验器与 `store.ts` 原子写可用 per-record + Zod 替代，仅保留跨进程 `owner.lock`；39 处直连测试构造是主要改造成本，暂缓 |

> 关于官方 bundle（`dsh-subagent-codex`、`dsh-hooks-codex`、`dsh-llm-pi-ai`）的注册名与定位沿用规划稿对宿主 `app.asar` 的扫描结论；本机未安装这些可选 bundle，无法在仓库内复核。涉及本仓库与宿主已安装包的事实已按基线核实。

---

## 6. 推荐落地步骤与验证

### Step 1：Provider 重命名（纯改名，不夹带行为变化）

1. 本仓库：改 `CODEX_APP_PROVIDER`/`providerInfo`/`context.ts:82`/`index.ts`，同步测试、README 与 locale 描述；`npm run typecheck && npm test && npm run build`。
2. `dsh-workflow-kit`：改 `constants.ts`、`workers.ts`、`workflow.ts`、`roles.ts`、`profiles/gpt-workflow.json` 与相关测试/文档；在该仓库先跑本仓库的 `npm run build`，再 `npm run prepare:local`（staging 脚本会把构建产物放进 `node_modules`，类型增强才能解析到新版声明），最后 `npm run typecheck && npm test && npm run build`。
3. 手工确认：模型选择器里出现 `codex app` 组；workflow 子代理按 `codex-app` 路由启动；旧 profile 用户覆盖值失效属预期（§2.4）。

### Step 2：`allowMainSession` 开关与回退

1. 新增配置字段与 §3.2 的受管判据，按 §3.3 矩阵逐项落门禁（`listModels`、`streamInternal`、`streamAuxiliary`、`compactNativeThread`）。
2. 实现 §3.4 的默认/当前模型回退，逐项容忍可选服务缺失。
3. 实现 §3.5 的 workflow 设置页目录接缝（跨仓库）。
4. 验证：默认关闭时主会话菜单无 `codex app`、主会话请求被拒、无 `codex-aux:` 进程、workflow 设置页仍可配置角色、子代理可运行；开启后主会话完整可用（含标题生成与 `/compact`）；关闭切换后默认模型与已打开会话回退。

### Step 3：死代码与去重

1. 删除 §4.1 列表与对应接口/测试；合并 §4.2 的类型与前缀映射。
2. 临时进程复用单独提交，先做验证性测试（有活跃 runtime / 无 runtime 两条路径）。
3. 每步跑 `npm run typecheck && npm test && npm run build`；live 测试按 `LEAN-PLAN.zh-CN.md` §11.4 的已知阻塞（本机 registry TLS）决定是否执行。

两个仓库是独立 git 仓库，重命名需要跨仓库协调提交；`dsh-workflow-kit` 对 provider 的 `dsh-codex-app-provider: 0.1.1` peer 依赖只在运行时解析，本地用 staging 副本验证，不需要为改名单独升版本号。

---

## 7. 对规划稿的校核记录

| 规划稿断言 | 基线 `bfa53ec` 事实 | 处理 |
|---|---|---|
| `Config` 包含 `args`/`env`/`cwd`/`defaultModel`/`defaultApprovalPolicy`/`defaultSandboxMode` | 实际只有 `stateDir`/`command`/`requestTimeoutMs`/`providerCwd`（`index.ts:21-43`） | 以实际代码为准，只新增 `allowMainSession` |
| 行为矩阵是"当前拦截行为" | `streamInternal` 当前直接走 `streamMain`，没有主会话门禁；`listModels()` 无条件返回目录；`providerInfo` 名称是 `"Codex"` | 矩阵按**目标态**理解，全部是待实现 |
| 宿主 `buildModelCatalog` 过滤空分组 | 已在本机安装的 `@deepseek-ai/dsh-api-session-controller` 核实：`lib/types/catalog.js:53`、`lib/index.js:541` 过滤 `models.length === 0`，并影响 `routableProviders`/`modelAvailable` | 成立，且有额外后果：workflow 设置页同样失去入口（§3.3/§3.5） |
| `prepareCall` 走 `resolveModel`，子代理不受 `listModels` 影响 | 本机 `@deepseek-ai/dsh-llm/lib/index.js:1734-1738` 已核实 | 成立 |
| Workflow 设置页由 `codexExecution`/`codexHandoff` 提供目录 | 当前这两个服务没有目录查询方法（`index.ts:200-204` 只有 `read`/`facts`/`handoff`/`read`） | 是新接缝，不是现有能力；见 §3.5 |
| 行号引用：`context.ts:82`、`provider.ts:189-191/205-213/294-321/327/704`、`backend.ts:67/264/324/527/558/728/937/1034`、`handoff.ts:71`、`store.ts:80` | 与基线一致或仅在 ±2 行内 | 按基线行号落档 |
| 行号引用：`ThreadHandoffRequest` 在 `browser-types.ts:67-84`、`LegacyMirror` 在 `records.ts:165-182`、`occupiedThreads` 在 `store.ts:74-83`、截断在 `execution-events.ts:118` | 实际分别是 `119-138`、`74-110`、`80-82`、`122` | 已按基线更正 |
| `process.ts` 后备约 70 行 | 文件共 126 行，后备实现约 85 行 | 按基线更正 |
| 20 个文件 / 5,505 行；死代码约 120–150 行 | 数量吻合；另发现 `SessionStore.has()`/`findByThread()` 零调用 | 已补入 §4.1 |
| 在 `ctx.subagents` 命名空间上与官方 `codex` 正交 | 本插件不注册 subagent provider；冲突面主要是 LLM 路由与持久化配置字符串 | 已在 §1/§2.1 说明 |
| 插件未发布，无需旧名兼容 | 仓库版本为 `0.1.1`；是否对外发布无仓库内证据，按规划稿口径处理 | 采纳；影响与前提见 §2.4 |

---

## 8. 未决问题与风险

1. **Workflow 设置页目录接缝（最高优先级）**：不实现它，`allowMainSession: false` 会让 workflow 角色无法在 UI 里选择 `codex-app` 模型。方案见 §3.5，需要跨仓库测试；备选是让 `listModels()` 在设置页上下文仍返回目录，但当前 `listModels()` 没有调用者上下文，做不到。
2. **`listModels()` 返回 `[]` 的宿主副作用**：除了隐藏分组，还会让 `modelAvailable` 判定该路由不可用；主会话回退必须覆盖"默认模型 + 已打开会话"两条路径，否则 UI 仍可能停在 Select model。
3. **回退所需的可选服务**：`ctx.agentDefaultModel`、`ctx.sessionProjections`、`ctx.sessions` 在不同组合里可能缺失；实现必须 `ctx.get` 判空、跳过并告警，不能阻断插件加载。默认模型保存无配置编辑器时是 no-op，也要按失败处理。
4. **重命名对本地持久数据的影响**：会话日志中的 `model/selection`/`request/header`、全局默认模型、用户覆盖的 workflow 角色 provider 都会失效。本轮选择不迁移；若要求平滑升级，需要单独设计迁移器。
5. **临时 `app-server` 复用的并发语义**：同一连接上并发 `thread/read`/`model/list` 与正在进行的 turn 是否安全，需要先做验证性测试；不能假设 app-server 支持请求并发。
6. **测试改造面**：本仓库 14 个测试文件、44 处 `"codex"` 字面量，外加 `dsh-workflow-kit` 的 10+ 文件；其中状态目录、CLI 命令、文件名等字面量不能误改。建议用"先改常量与断言，再跑全量测试"的顺序。
7. **`allowMainSession` 的切换语义**：普通配置项意味着插件重载；若宿主在重载期间保留旧会话，回退逻辑需幂等（重复执行不应反复追加 `model/selection`）。
8. **`resolveModel` 保持开放的代价**：`listModels()` 隐藏后，宿主仍可解析该模型；必须靠 `stream()` 门禁兜底，任何绕过 `stream()` 的路径（例如未来的直连调用）都会失去保护，需在实现时集中到唯一入口。

## 9. 实施记录（2026-10-21）

**Step 1（已完成）**：provider 提交 `e75fd68`，workflow 提交 `54ae4d1`。Provider ID、adapter 注册与显示名改为 `codex-app` / `codex app`；CLI 可执行名、状态目录段、`codex:` 原生前缀、owner id、Host 服务名保持不变；README 与 locale 同步。两仓失败集合与各自基线一致。

**Step 2（已完成）**：provider 提交 `63f5a4d`，workflow 提交 `2a1f834`。`allowMainSession` 默认 `false`：`listModels()` 返回空、主会话 `stream()` 以 `MAIN_SESSION_DISABLED` 拒绝、标题/摘要调用直接返回不拉起进程、主会话 `/compact` 拒绝，受管子代理（携带原生执行输入）正常放行；关闭路由时把全局默认模型与已打开主会话的选择迁移到其它可用路由（可选服务缺失只告警）。`ctx.codexExecution.catalog()` 暴露路由自有目录，workflow 新增 `/workflow catalog` 端点并在设置页合并，解决 §3.5 的跨包缺口。新增 7 项测试。

**Step 3（已完成，本次提交）**：删除 `runtime.commands`/`trackCommand()`、`configureSession()`、`steerTurn()`、`occupiedThreads()`（含 store 方法与 `claimsThread`/`occupied` 级联）、`pendingUserInputs()`、`SessionStore.has()`/`findByThread()`；`codex:` 前缀映射合并为 `handoff.ts` 的一份实现。保留 LegacyMirror 旧记录兼容（`store.test.mjs` 直接覆盖）与两份 Handoff 请求类型（DSH id 与原生 id 两个命名空间，且 `approvalsReviewer` 已漂移）。净 −77 行（src −72，test −5）。

**验收**：两仓 `typecheck`/`build` 通过；provider 162 项（140+ 新测试通过）、workflow 148 项，失败集合与各自基线完全一致（provider 15、workflow 62，均为 Windows 平台性），零新增失败。

**补充（2026-10-21 晚）：配置入口与 live 字段。** DSH 插件页不会从 Loader Config schema 自动生成配置表单：行配置必须由插件自己的浏览器半注册 `plugins.row.config`（键 `<包名>#<row id>`），且 settings 服务只收录含 `.volatile()` 字段的 entry（`volatileForm` 为空即跳过）。因此本轮把 `command`、`allowMainSession`、`toolBridge` 四个字段改为 volatile，并新增浏览器半（`src/client/`、`lib/client.js`、`dsh.client` 清单）注册行配置页；宿主在每次判定时读取当前值（`command` 在创建新运行时读取），主会话关闭时通过 `loader/volatile-update` 重新执行选择回退。`stateDir`/`providerCwd`/`requestTimeoutMs` 保持部署输入、需要重载。provider 测试增至 169 项（新增 client bundle 2 项），仍零新增失败。

**补充（2026-10-22）：`command` 改为自动探测，并修正 Windows 启动行为。** 新增 `src/command.ts` 的 `resolveCodexCommand()`：显式配置优先；否则在本机 `PATH` 上查找 `codex`/`codex.exe`；Windows 上若只找到 npm 的 `.cmd`/`.bat` shim，先找该包自带的原生 `codex.exe`（`codex-win32-<arch>/vendor/<triple>/bin/codex.exe`），没有再读取 shim 启动行、用当前 Node 运行其 `codex.js`。都找不到时回退裸 `codex` 并在启动时告警。解析结果按 `platform + PATH + configured` 缓存，重复创建运行时不再扫盘。原生路径由 DSH 的 subprocess 服务以隐藏窗口启动（其 README 明确 Windows 非终端子进程隐藏窗口），因此消除了此前经 `node + codex.js` 中转导致的“每次弹 codex cmd 窗口 + 启动变慢”；`nodeSpawner` 后备同样加了 `windowsHide`。本机实测解析为原生 `...\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe`（source=native）。

**补充（2026-10-22）：主动检测与缓存。** 新增 `src/check.ts` 的 `createAvailabilityProbe()`：解析可执行文件、运行 `--version`、经 provider 自己的传输读取 App Server `model/list`，结果缓存；`force=true` 才重新检测。`src/check-rpc.ts` 在 `/codex-app` 上提供 owner-only 的 `check` 动作（复用 Connection 信封，64 KiB 上限），设置页首次打开读缓存（Host 没有缓存时才会真的跑一次），并提供 **主动检测** 按钮强制刷新。新增 8 项解析/缓存与 4 项检测测试；provider 全量 182 项、零新增失败（新增 `@deepseek-ai/dsh-client-connection` 客户端依赖，版本与其它 DSH 包同为 0.2.1-rc.2）。

**仍未覆盖**：真实 DSH 文件夹安装与 live 验收，`dsh.compatibility.dshReleases` 未标记 compatible（阻塞见 `DSH-UPGRADE-PLAN.zh-CN.md` §7）；重命名未写迁移器；Handoff 类型的 `approvalsReviewer` 漂移未修。
