# dsh-codex-app-provider

[English](README.md) | [中文](README.zh-CN.md)

把 Codex CLI App Server 作为 DSH 原生模型路由运行，并把 Codex 自己的执行记录进 DSH Session 日志。

`dsh-codex-app-provider` 是一个 DSH Host 插件。它注册 `codex` LLM adapter，把 Codex 自己的审批与提问接进 DSH 的交互面，把 Codex 实际执行的内容写入 DSH Session 日志，并发布描述 Codex thread 的 Host 能力。它不含浏览器界面：子会话面板归 `dsh-subagent-ui-sidepanel`，角色/profile 策略归 `dsh-workflow-kit`。

- [提供什么](#提供什么)
- [环境要求](#环境要求)
- [安装](#安装)
- [配置](#配置)
- [把 Codex 作为模型路由使用](#把-codex-作为模型路由使用)
- [委派](#委派)
- [Host 能力](#host-能力)
- [Workflow session gate 与 PreToolUse hook](#workflow-session-gate-与-pretooluse-hook)
- [兼容性](#兼容性)
- [开发](#开发)
- [仓库结构](#仓库结构)
- [已知限制](#已知限制)
- [许可证](#许可证)
- [相关仓库](#相关仓库)

## 提供什么

```
DSH 原生 Session / 原生 child Agent
  → LLM 路由：codex
  → dsh-codex-app-provider（Host 插件）
    → provider adapter（模型、请求、事件、审批、提问）
    → 内部 backend（App Server RPC、thread/turn 状态、存储、恢复）
  → codex app-server --stdio（thread / turn / item）
  → 原生事件映射回 DSH Session
```

| 能力面 | 说明 |
|---|---|
| `codex` LLM adapter | 把安装的 Codex 运行时作为 DSH provider：模型目录、请求转换、流式事件、token 用量、取消。 |
| 上下文过滤器 | 从发给 Codex 的请求里剔除 DSH 注入的上下文（system/developer 消息、runtime context、skill catalog、已导入的执行事实）。 |
| 委派 | 归 DSH 核心：`ctx.subagents` 的可续 child；角色与验收归 `dsh-workflow-kit`。这些 child 走 `codex` 路由时，其执行由本插件承载。 |
| 审批/提问桥接 | 权限判断仍归 Codex；它发出的审批与提问转发到 `ctx.approval` 与 `ctx.userQuestions`，没有应答者时按 fail-closed 拒绝。 |
| 执行事实 | Codex 自己执行工具，否则 DSH 日志对这段执行是盲的；每个已执行步骤都以带来源的 `user/message` 事件写入 Session，且可重放而不会重复。 |
| `ctx.codexExecution` | 给受信 Host 消费者的只读原生执行事实；不做 resume，也不发模型请求。 |
| `ctx.codexHandoff` | 受信 Host 把一条 Codex thread 从源 Session 移交给预留的后继 Session。 |
| `ctx.codexToolGate` | workflow session gate 桥：一个 Host handler 加一条 Codex PreToolUse hook 传输通道。 |

插件自身不做角色、profile 或权限策略。它负责执行：一个 Codex adapter、一个 backend、每个部署一个状态目录。

## 环境要求

- Node.js >= 22.19.0。
- 提供 `app-server` 的 Codex CLI（插件执行 `<command> app-server --stdio`，`command` 默认 `codex`）。
- `dsh.compatibility.dshReleases` 中列出的 DSH 版本（见[兼容性](#兼容性)）。
- 仅对启用 gate 的 Session：Codex PreToolUse hook 走 Unix domain socket，因此 hook IPC 限 Linux/macOS。其余能力与 DSH 平台一致。

## 安装

构建并打包：

```bash
npm ci
npm run build          # tsc -> lib/
npm test               # 单元与集成测试
npm pack               # dsh-codex-app-provider-<version>.tgz
```

把 tarball 装进 DSH profile，并把插件加入该 profile 的 bundle 列表（保留该 profile 原有的 bundle，下面的 `@deepseek-ai/dsh-base` 与 `@deepseek-ai/dsh-web-app` 是 Web profile 的形态）：

```jsonc
// <profile>/package.json
{
  "name": "dsh-profile-codex",
  "private": true,
  "dependencies": {
    "dsh-codex-app-provider": "file:/absolute/path/dsh-codex-app-provider-0.1.1.tgz"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-codex-app-provider"
      ]
    }
  }
}
```

在 profile 的 `cordis.patch.yml` 中加一个条目。一个部署只加载一个 Codex 插件，不要同时加载旧 Codex backend 或 host 插件：

```yaml
- id: dsh-codex-app-provider
  config:
    stateDir: /absolute/state/dir/codex
```

本仓库的 `cordis.patch.yml` 声明了同名条目，因此由 bundle 携带时无需再写 id。

## 配置

| 键 | 类型 | 默认值 | 含义 |
|---|---|---|---|
| `stateDir` | 绝对路径字符串 | `<DSH_HOME>/state/<profile>/codex` | 插件自有记录的存放目录。没有 launcher profile 时回落到 `$DSH_HOME`（再回落 `~/.dsh`）下的 `default` profile 名，绝不用进程当前目录。 |
| `command` | 字符串 | `codex` | 作为 App Server 执行的程序（`<command> app-server --stdio`）。 |
| `requestTimeoutMs` | 整数，1–2147483647 | `30000` | 单次 App Server 请求超时。 |
| `providerCwd` | 字符串 | DSH 启动目录 | 模型设置的工作目录，也是 Session 未记录工作目录时 Codex thread 的回落目录。 |

`stateDir` 下的持久化布局：

- `sessions/<url编码后的session-id>.json` —— 每个 Codex Session 一条记录：thread/turn 身份、执行 cwd、最近确认的 model/effort、投影后的事实、报告与 gate 绑定。原子写入，权限 `0600`。
- `owner.lock/owner.json` —— 单 owner 锁。同一状态目录不得被两个 provider 同时打开。

## 把 Codex 作为模型路由使用

- 插件注册的 provider id 是 `codex`。在 DSH 中按会话选择即可；主 Session 可以自由切换模型与 effort，而以固定执行输入创建的 child 会保持创建时的配置。
- 模型目录来自安装的 Codex 运行时（`config/read` 加分页 `model/list`，缓存 30 秒），因此可选模型与 reasoning effort 就是该 Codex 构建对外声明的那一套。本仓库不维护模型清单。
- 当 Codex 模型声明支持相应输入模态时，图片与 mention 随请求一起传递。
- Codex 发出的审批请求转发到 DSH 审批面（`allowed-once` → accept，`cancelled` → cancel，其余情况包含没有应答者 → decline）。结构化提问走 `ctx.userQuestions`。服务缺失时 fail-closed，插件不伪造同意。
- DSH Session 日志能看到 Codex 执行了什么：每个 item 变成一条来源为 `dsh-codex-app-provider` 的消息，身份由 `threadId`/`turnId`/`itemId` 推导，因此重放或冷恢复不会把同一条命令导入两次。
- 对话历史与压缩检查点归 DSH；当一段 DSH 历史被回放进 Codex thread 时，导入区间会被标记（`[DSH history import`），不会再次喂回 Codex。

## 委派

本插件是模型路由与原生执行底座，不是第二套委派系统。早期版本还带有 `codex_workers` 工具、自己的 worker 注册表、
报告账本与验收流程；这一面与核心 `ctx.subagents` 的生命周期重复，因此已删除。委派现在走核心：

- 一次性与可续 child：`subagent` / `subagent_fork` 工具（`ctx.subagents.startContinuable`），可续的那些配一套
  发消息 / 中断 / 列举的控制面；
- 走 `codex` 路由的 child：在 child 的 `agentOptions` 里指定 provider，其逐轮执行事实、用量与报告仍可通过
  `ctx.codexExecution.read(childSessionId)` 读取。

具体有哪些控制工具取决于 composition —— 若 profile 同时加载 Agent Teams，`send_message`、`list_agents`、
`interrupt_agent` 这三个名字属于 Team 面，不属于 subagent provider。

删除后接受的语义差异（完整判定见 `REVIEW.zh-CN.md` 附录 A）：

| 被删能力 | 替代 | 需要接受的差异 |
|---|---|---|
| `create`、`append`、`resume`、`close` | `ctx.subagents` 可续 child | child 是 DSH Session，不是裸的原生 thread |
| 按 `turnId` 的 `steer` | 按 child session 续话 | 没有逐轮寻址 |
| `interrupt(workerId, turnId)` | child session 级中断 | 作用域是子会话；已结束目标是静默 no-op |
| `list` / `get` / `reports` | 子会话投影 | 报告活动状态，不再是一份带 ack 状态的 worker 记录 |
| `ack` / `accept` | `dsh-workflow-kit` | 验收是 workflow 业务，不是模型路由 |
| worker 注册表与 store 的 worker 分支 | 本插件自己的 Session 记录 | Codex thread 的身份、用量与报告都在该记录里 |

模型路由需要的能力没有丢：删掉的是一套并行的生命周期，以及它自带的身份、投递与验收语义。

## Host 能力

这些是 Host 发布给其他受信插件的 Cordis 服务，不面向模型。

| 服务 | 成员 | 用途 |
|---|---|---|
| `ctx.codexExecution` | `read(nativeSessionId)`、`facts?(nativeSessionId)` | 只读执行事实：状态、cwd、已确认 model/effort、待确认配置、报告、用量。不做 resume，不发模型请求。`facts` 返回已执行的历史行，用于在另一个 provider 下继续同一任务。 |
| `ctx.codexHandoff` | `handoff(request)`、`read(sessionId)` | 让后继 Session 用同一条 Codex thread 继续一个任务。以 `requestId` 为键，重复请求复用已记录的移交。源记录被撤权，后继持有该 thread。`read` 返回 thread 归属（`threadId`、`handedOffTo`、`handoffFrom`）。 |
| `ctx.codexToolGate` | `register(hook, handler)`、`bind(sessionId, binding)` | 下文描述的 session gate 桥。唯一的 handler 及其策略归 workflow Host，provider 只负责承载绑定与 hook 调用。 |

## Workflow session gate 与 PreToolUse hook

插件承载 workflow session gate，自身不做 gate 判定。`dsh-workflow-kit` 注册唯一的业务 handler（`workflow.preToolUse`），把它启动的每个 child 绑定为 `{ role, hook, args }`，并用同一个确定性函数判定两个入口。provider 是传输层：

- **DSH 原生入口。** workflow 插件安装 DSH 工具 guard；provider 提供绑定存储与绑定查询。
- **Codex 入口。** provider 为每个 App Server 运行时生成一次性随机 runtime key，并且只把 `DSH_PRETOOL_ENABLED=1`、`DSH_PRETOOL_SOCKET`、`DSH_PRETOOL_RUNTIME` 注入**该运行时**的 spawn 环境。普通 Codex Session 不受影响。`lib/pretool-client.js` 是安装的 hook 命令：它把 hook payload 经 socket 送到 Host，并把 Codex 需要的判定打印出来。
- socket 位于 `mkdtemp` 目录（权限 `0700`），socket 本身 `0600`，插件卸载时一并删除。一个连接承载一次 JSON 请求与一次响应。
- 接收端只用 runtime key 解析 Session。hook payload 里的任何内容——`session_id`、role、参数——都不能选择或替换绑定。未知或过期 key、已释放记录、cwd 不符、`turn_id` 不是该 Session 当前轮次，全部拒绝。
- 每次运行时被替换或释放都会作废旧 key，因此重启或移交不会留下可用的旧 key。
- 未启用时 `lib/pretool-client.js` 以退出码 `0` 且无输出结束。已启用但传输缺失、输入非 JSON、连接失败、应答超过 3 秒或应答非法时，一律返回显式 deny。它从不打印 runtime key。

### 部署前置：安装并信任 hook

Codex 会静默跳过未受信或被禁用的 hook。启动 gated Session 之前，provider 对该 Session 的 cwd 调用 `hooks/list`，要求存在一条满足以下条件的条目：

- `command` 指向 `lib/pretool-client.js`；
- 未禁用且没有 `errors`；
- `trustStatus` 为 `managed` 或 `trusted`；
- 是 PreToolUse hook。

不存在这样的条目时，gated Session 会被拒绝并给出原因，而不是带着未生效的 gate 启动。

受管部署（首选；Linux 为 `/etc/codex/requirements.toml`，需要 root）。若目标文件已有 `[features]` 表，把 `hooks = true` 合并进去，不要追加第二个 `[features]` 表：

```toml
[features]
hooks = true

[[hooks.PreToolUse]]
matcher = "*"

[[hooks.PreToolUse.hooks]]
type = "command"
command = "<absolute-node> <absolute-provider>/lib/pretool-client.js"
timeout = 10
```

没有 root 时，把同样的 `[[hooks.PreToolUse]]` 条目加到用户配置，再从 `hooks/list` 读到该条目的 `currentHash`，按 Codex 报告的键写入信任哈希：

```toml
[hooks.state."<sourcePath>:pre_tool_use:<matcherIndex>:<hookIndex>"]
trusted_hash = "<currentHash>"
```

key 与哈希一致后 `trustStatus` 变为 `trusted`。代用户写信任记录等于绕过其信任提示，只应在明确授权的部署步骤中执行。

gate 的策略不在这里：某个 `role` 能写什么、能调用哪些工具名，由 workflow handler 决定。因此 provider 的覆盖范围就是传输层的范围——它检查 Codex 报告的工具调用及其参数，不解析 shell 程序，所以 shell 命令内部的写文件行为不在其覆盖内。

## 兼容性

| DSH 版本 | 结论 |
|---|---|
| `0.1.7-rc.2` | compatible |
| `0.2.0-rc.2` | compatible |

所有 `@deepseek-ai/dsh-*` 宿主包都声明为可选 `*` peer 依赖，因此 harness 兼容性门禁不会用某一代钉死本插件，一份构建可加载到每个已声明版本。仓库内的 `devDependencies` 钉住用于类型检查与测试的那一代（`0.1.7-rc.2`）。

`scripts/verify-dsh-compat.mjs` 才是让上表成立的依据：对每个已声明版本，它把该版 CLI 装进一次性的 `DSH_HOME` profile，加入两个插件 tarball，装配 profile，针对该版自身的接缝做探测，启动 web server，并断言插件能力面有应答。只有每一步都成立，该版本才会被判为 `compatible`。

```bash
node scripts/verify-dsh-compat.mjs                    # 所有已声明版本
node scripts/verify-dsh-compat.mjs 0.1.7-rc.2 0.2.0-rc.2
```

## 开发

```bash
npm run build                     # tsc -p tsconfig.json
npm run typecheck                 # tsc --noEmit
npm test                          # node --test test/*.test.mjs
npm run test:integration:handoff  # thread 移交集成测试
npm run test:live                 # 真实 Codex CLI 端到端
npm run test:live:handoff         # 真实模型后继移交（Codex → Codex）
npm run test:live:handoff:cross   # 真实模型延续（Codex → DeepSeek）
npm run publish                   # 暂存构建，原子替换 lib/
npm run publish:watch             # 源码变化即重新发布
```

本仓库的测试会派生进程，因此派生进程的用例需要允许派生的环境。已记录的运行使用 `node --test --test-isolation=none test/*.test.mjs`，在单进程内跑完整套测试。

测试分层，便于把失败归到正确层级：

- **单元/集成**（`npm test`）：状态存储、归属围栏、provider 转换、上下文过滤、工具 gate、执行事件、故障与恢复，使用脚本化 App Server。
- **确定性全栈**（`npm run test:live -- --fake`）：真实 Host 加真实插件，Codex CLI 换成脚本化 App Server——用于断言“首轮必须 resume 而不能 start”这类事实。
- **真实模型、hermetic**（`npm run test:live:handoff`、`:cross`、`scripts/live-hermetic.mjs`）：把 `HOME`、`CODEX_HOME`、`TMPDIR` 与 npm 缓存重定位到本仓库内的 `.live/<时间戳>/`，因此真实运行无需审批，也不会写到仓库之外。凭据副本在运行结束时删除。
- **装机形态**：把 tarball 装进真实 DSH profile 并重启 Host。

真实模型运行需要 Codex 登录状态与网络，不属于 `npm test`。

### 开发期的热重载

出厂底座以 `root: []` 启用 HMR：**配置类**变更（改 patch、安装、启停）对运行中的 Host 立即生效，
但**不监视任何模块文件**，因此在 opt-in 之前，改本插件的代码仍需重启。官方 recipe 写在 profile 的
patch 层：

```yaml
- id: hmr
  disabled: false
  config:
    root: ["."]
```

该 recipe 监视 profile 目录树，而用 `link:` 安装的插件在其中被拼成 `node_modules/<name>/...`，
会被默认的 `ignored: ["**/node_modules", ...]` 过滤，所以对本仓库不生效——在 0.2.0-rc.2 上实测：
官方 recipe 在 `touch lib/index.js` 后插件毫无反应，而把 `base` 指向本 checkout、`root: ["lib"]`
时几秒内即完成重载。

`scripts/enable-hmr.mjs` 会替你写入这条条目（默认 dry-run）：

```bash
node scripts/enable-hmr.mjs                # 打印将要写入的内容
node scripts/enable-hmr.mjs --write        # 写入 $DSH_PROFILE_DIR
node scripts/enable-hmr.mjs --write --profile ~/.dsh/profiles/<profile>
node scripts/enable-hmr.mjs --write --remove   # 回到出厂默认
```

HMR 监视 profile patch、home patch 与 profile manifest，因此这条条目**无需重启**即可生效；之后
`npm run build`（或常驻的 `tsc --watch` / `npm run publish:watch`）会在写入后约两秒触发重载
（`awaitWriteFinish` 2 秒 + 100 毫秒 debounce）。只监视本包的 `lib/`；重载会拆除插件实例，
因此正在运行的 Codex worker 会被中断。

这只是开发机设置。安装已发布版本的用户不需要它：首次安装会在运行中的 Host 内激活，而**替换**包
需要重启进程才能加载新的模块代际（`@deepseek-ai/dsh-plugin-manager` 已把这条列为已知限制）。

## 仓库结构

```text
src/
  index.ts              插件入口：配置、backend、adapter、服务、工具
  provider.ts           LLM adapter：模型、请求、事件、审批、提问
  history.ts            DSH 对话 ↔ 原生线程边界与历史导入
  usage.ts              token 记账：原生载荷 → 记录 → TokenUsage
  backend.ts            App Server RPC、thread/turn 状态机、恢复
  wire.ts               App Server 线格式翻译：输入、快照、thread 参数
  rpc.ts                codex app-server --stdio 传输（stdio 上的 JSON 行）
  process.ts            子进程与计时器接缝（ctx.subprocess、ctx.timer）
  store.ts              状态目录与单 owner 锁
  records.ts            记录的形态与记录校验
  context.ts            codex 路由的上下文过滤器
  facts.ts              写入 DSH Session 日志的执行事实消息
  execution.ts          只读原生执行事实（ctx.codexExecution）
  execution-events.ts   原生事件归约为事实与用量
  execution-inputs.ts   声明输入与实际应用输入的比对
  handoff.ts            thread 移交能力（ctx.codexHandoff）
  tool-gate.ts          gate 桥、hook 传输、hook 前置校验
  pretool-client.ts     安装到 Codex 的 PreToolUse hook 命令
  models.ts, browser-types.ts
cordis.patch.yml        唯一的 Host 插件条目
locale/                 插件目录文案（en、zh）
test/                   node:test 测试与脚本化 App Server 夹具
scripts/                兼容性验证、真实测试 harness、发布、watch
EXECUTION.md            实施日志与各阶段证据索引
```

## 进程与用量的归属

App Server 的进程策略来自部署，而不是自带一套。组合提供 `ctx.subprocess` 时，runtime 由它启动：
`terminate()` 在托管范围内执行 provider 自己的 TERM→KILL 梯度，`waitForExit()` 证明该范围已经清空，
因此 Codex CLI 的后代进程不会比启动它的插件实例活得更久。请求超时与关闭宽限来自 `ctx.timer`，
随 provider 释放，而不是裸 `setTimeout`。若组合两者都没有，App Server 仍会运行，只是作为本进程的
非托管子进程，插件会为此警告一次——与这两个能力出现之前的行为一致。

用量取自 Codex 自己的 `thread/tokenUsage/updated` 通知，并随 Session 记录一起落盘，因此冷恢复读到的是
本 provider 最后被告知的值。插件不读 Codex 的私有 rollout JSONL 来取用量。

## 已知限制

- workflow gate 的 Codex 路径需要已安装且受信的 PreToolUse hook（见上文）。没有它时 gated Codex Session 会拒绝启动；DSH 原生 gate 不依赖该前置条件。
- hook IPC 使用 Unix domain socket，未实现 Windows。
- gate 看到的是工具调用及其参数，不是 shell 程序的文件效果；`mcp__<server>__<name>` 工具与运行时注册代码（`cordis_define` / `cordis_run`）不在覆盖范围。
- Codex → DeepSeek 延续路径在隔离 profile 扩展准备与后继轮次的等待预算上仍有已知缺口；记录的证据见 `EXECUTION.md`。
- `EXECUTION.md` 是按时间顺序的实施日志，记录当前状态如何形成，不是插件的规格说明。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。

## 相关仓库

- `dsh-workflow-kit` —— 角色、profile、任务合同、lane、验收与集成；持有 workflow session gate 策略，并把带角色的 child 派发进本 provider。
- `dsh-subagent-ui-sidepanel` —— 原先位于本仓库的子会话侧栏/客户端半边。
