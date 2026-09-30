# dsh-codex-app-provider 实现方案

> 当前用户需求：[plugin-requirements.md](../plugin-requirements.md)。

> 2026-09-15（拆分）：本插件现在是**纯 Host 插件**。子会话的打开位置设定、`subagent/open` 拦截、标题栏入口和侧栏面板已迁到 `dsh-subagent-ui-sidepanel`；本仓库不再有 client 半边（无 `./client` 导出、无 `dsh.client`）。
>
> 2026-09-15（权限与审批）：**权限判断归 Codex，审批请求转发给 DSH。**
> - 插件不再替 Codex 决定权限。`streamAuxiliary`（标题、压缩等辅助调用）原本硬编码 `approvalPolicy: "never"` + `sandbox: "read-only"`——那是 `21ac0fd` 之后遗漏的一处，现已移除，辅助调用与主路径一样不注入任何权限档。
> - Codex 主动发出的审批请求转发到 `ctx.approval.request({ agent, toolName, callId, reason, signal })`，用户就在 DSH 自己的审批面（`ui-approval` 注册在 `conversation.composer` 的 chain，绑定当前 Session）上决定；决定再回到 `backend.decideApproval`。`allowed-once` → accept，`cancelled` → cancel，其余（含 `unavailable`）→ decline，不伪造同意。
> - 结构化提问同理转发到 `ctx.userQuestions.ask(...)`（此前 `deps.questions` 声明了却从未使用）。
> - 私有的 `/codex-approval` 浏览器通道及其自绘审批卡已删除；`bridgeApproval`/`bridgeUserInput` 在缺少 answerer 时 fail-closed。
> - 辅助调用的事件循环现在与主路径一样处理 `approval.requested` / `userInput.requested`，否则去掉权限注入后那条路径会在审批上空转。
>
> 下文是阶段设计与项目参考；旧 core 补丁、协调包、角色权限和恢复方案按统一基线修订。

状态：实施中。日期：2026-09-13。单包 provider、workflow 消费者和原生侧栏已实现；隔离安装、真实 child 参数链、合同交付、Host 冷恢复、浏览器设置/草稿隔离/工具呈现、workflow profile 选择/刷新已通过限定场景验收。审批、中断及其余交互仍在验证，详见 EXECUTION.md。

本文保留迁移设计；[EXECUTION.md](EXECUTION.md) 保留分阶段实现和验证记录。技术方案应服务上方用户需求，历史状态不代表当前候选已验收。

## 1. 目标与原则

在 DSH 原生主会话和原生子 Agent 中使用 Codex App Server，复用当前 `dsh-codex-kit` 的执行能力，逐步退出独立 kit 对话与 RPC。

**优先迁移已有设计、源码和测试，将 backend 执行逻辑与 provider/Host 接入合并到一个 `dsh-codex-app-provider` 插件。** backend 是插件内部模块，不再作为独立插件或外部包依赖。界面复用 DSH 原生 UI，同一插件包提供系统设置和子代理侧栏的轻量客户端入口，不另设 Codex UI 插件；角色/profile 仍归 workflow。迁移已有执行引擎，不重新实现。

继承的设计依据：

- [当前重构方案](../dsh-codex-kit/refactory.md)：继承原生 Session、spawn 优先、职责边界及 kit 退出条件；其中保留独立 backend 包的部署安排，由本文的单插件决定替代。
- [角色与 profile 设计](../dsh-codex-kit/docs/role-profiles.md)：配置、创建快照、切换和恢复语义。
- [已有验证记录](../dsh-codex-kit/docs/target-gaps.md)：历史测试与真实执行记录，不能当作新项目已经通过验收。

源码基线：`../dsh-codex-kit`，Git commit `eedbef08fc2b2121f14007720e63563aa1a6e264`，编写方案时工作区干净。实施前检查该仓库后续变更，再迁移；不以旧行号或旧测试数量作为当前事实。

现有本地版本基线为 Node >=22.19、DSH 0.1.7-rc.2、Codex CLI 0.154.0。隔离验收不写死任何一代：临时 profile 只装本包 `devDependencies` 钉的那一代 CLI 与插件 tarball，其余 dsh 包由 npm 按插件自身的 peer 范围解析，与真实 profile 的行为一致。后续 DSH 接缝若真需要源码变更，临时构建一组含变更的协调包并在文档里记录确切版本/commit（2026-09 的 e3/e4 协调集与其清单已退役，不再随包保存），不能仍宣称未修改的 rc 已满足全功能要求。

## 2. 最终执行链与所有权

```text
DSH 原生主 Session / 原生 child Agent
  → DSH LLM route: codex
  → dsh-codex-app-provider（唯一 Codex 插件入口）
    → 内部 provider / Host 适配
    → 内部 backend / RPC / store
  → Codex App Server thread / turn
  → provider 映射原生事件、审批、问题、用量和终态
  → 对应 DSH Session / Conversation
```

| 模块 | 唯一职责 |
|---|---|
| 插件内 provider/Host 模块 | provider 注册、模型目录、DSH 请求转换、执行参数传递、原生事件与交互桥接、上下文过滤、卸载清理 |
| 插件内 backend 模块 | App Server RPC、thread/turn、状态机、存储、幂等、执行权限和实际参数校验、恢复 |
| DSH | Session 日志、真实父子关系、Agent 生命周期、原生对话组件及侧栏容器；补充必要的打开动作和显式 Session 渲染接缝 |
| 本插件客户端及设置模块 | 系统设置行、打开位置配置、子代理侧栏 tab 注册和原生组件装配 |
| workflow | role/profile 文件、父 Session 选择、创建时快照、任务调度、流程授权和验收、配置 UI |
| 旧 kit | 尚未替代的历史会话和活跃 worker 入口，随消费者迁移退出 |

部署只安装一个 `dsh-codex-app-provider` 包，Host 使用一个插件入口；Web 客户端由同包 `./client` 和 `dsh.client` 元数据加载。保留内部 provider/backend 的代码职责划分，不拆成两个插件或两个发布包。保留 `codex` route；执行记录 ID 与存储语义不因包合并而改变。内部服务名按实际消费者需要处理，无消费者时不保留旧服务兼容入口。

Codex 原生 shell/file 等执行继续由 Codex 驱动，并接入宿主审批与执行边界。不能为套用社区代码而关闭它们，改成全部由 DSH 动态工具执行。两种执行模型不是等价替换。

## 3. 迁移清单：先搬现有能力

以下路径均相对 `../dsh-codex-kit/packages/dsh-codex-kit-backend/`。

| 当前来源 | 处理方式 | 新项目/原模块落点 |
|---|---|---|
| `src/host/provider.ts` | 迁移现有 adapter，先只调整 import；保留会话绑定、history replay、图片、auxiliary、审批、问题、usage、取消等逻辑 | 本项目 `src/provider.ts` |
| `src/host/context.ts` | 迁移过滤与 provider 选择判断；后续为明确执行指令增加正式传递通路 | 本项目 `src/context.ts` |
| `src/host/index.ts` | 从现入口抽取 provider 注册、可选服务注入、context filter 和 disposal；不整文件照搬 | 本项目 `src/index.ts` |
| `src/rpc.ts`、`src/backend.ts`、`src/store.ts` | 连同现有状态机、恢复和持久化逻辑迁入，改为插件内部引用 | 本项目同名模块 |
| `src/models.ts`、`src/skills.ts`、`src/browser-types.ts`、`src/service.ts` | 迁移实际执行依赖的实现和类型；将服务构造/配置与 Host 注册归入唯一入口，不保留第二个 apply 插件 | 本项目内部模块及 `src/index.ts` |
| `src/host/identity.ts` | 原生 child 若需要相同身份校验则迁移对应逻辑，不运行时引用旧包；旧 worker 消费者暂留原项目 | 按实际调用迁移 |
| `src/host/controller.ts`、`src/host/delivery.ts` | 保留旧 worker 控制及通知，待 workflow 消费者迁移后再退役 | 旧 Host |
| `src/conversation.ts` | backend 当前直接引用，P1 连同依赖迁入以保持行为；其解析能力与 kit 聊天 UI 区分，后续只删除已无调用的投影方法 | 本项目 `src/conversation.ts` |
| kit 客户端及 `/api/codex` bridge | 不迁移独立聊天 UI/RPC，旧消费者暂留原项目；只借用同包客户端构建和元数据模式 | 旧项目/DSH |
| `test/provider.test.mjs` | 随 adapter 迁移现有用例与 FakeServer，调整 import，使用真实 backend 实现 | 本项目 `test/provider.test.mjs` |
| `test/host.test.mjs` 等 | 只迁移 provider/context 注册相关用例；worker 身份、派发和通知测试留原地 | 按职责拆分现测试 |
| backend 的 failures、ownership、store、执行与恢复测试 | 随对应执行模块迁移，保留断言与故障注入；仅旧 worker 专用测试留原项目 | 本项目 `test/` 与旧项目各自职责 |

源码迁移必须保持可追溯来源并保留许可证。新项目成为已迁移执行逻辑的维护位置；旧项目仅为尚未结束的任务及历史消费者保留原实现，不建立长期双向同步或两套功能开发。消费者退出后删除旧实现，不为保留旧包名增加重导出插件。

## 4. 最小项目结构与安装

目标结构如下；当前实际实现范围以 EXECUTION.md 执行记录为准：

```text
dsh-codex-app-provider/
  README.md                 # 设计与功能边界
  EXECUTION.md              # 按阶段执行及验收记录
  package.json
  tsconfig.json
  cordis.patch.yml
  LICENSE
  src/
    index.ts
    provider.ts
    context.ts
    settings.ts            # DSH settings namespace/schema，共享字段类型
    client/
      index.ts             # 同包 ./client，设置行与侧栏注册
      SidebarSetting.tsx
      ChildConversation.tsx # 挂载 DSH 原生对话，不复制 transcript
    backend.ts
    conversation.ts        # 当前 backend 的直接依赖
    rpc.ts
    store.ts
    models.ts
    browser-types.ts        # 沿用执行类型，按实际依赖裁剪
    skills.ts              # 仅迁移执行路径实际需要的能力
  test/
    backend.test.mjs
    failures.test.mjs
    ownership.test.mjs
    store.test.mjs
    provider.test.mjs
    host.test.mjs           # 仅在拆出的 Host 验收需要时增加
```

沿用 TypeScript、Node test runner 和 Cordis/DSH 依赖，不引入新框架或通用 transport 抽象。复用现有构建配置中的必要选项，迁入所需源码和类型后使用包内引用，不依赖 `dsh-codex-kit-backend` 的安装、发布或兄弟目录链接。

`cordis.patch.yml` 只注册一个 `dsh-codex-app-provider` Host 插件项，同包客户端按 DSH 的客户端加载契约启用。唯一 Host `apply` 入口完成配置读取、内部 backend 构造、provider 注册、上下文过滤和生命周期清理；客户端 `apply` 仅注册设置行和侧栏展示。内部类与文件可继续分工，但不再分别声明 backend/Host 两个插件入口。

- 同一部署只注册一个 `codex` adapter、一个上下文过滤器，创建一个执行 backend；每项请求只有一条执行消费链。
- 插件卸载先停止接收新请求、中止在途调用并解除注册/订阅，再关闭内部 backend 及其 App Server 进程；沿用现有清理逻辑并验证次序。
- 新部署只加载新插件，不加载旧 backend、旧 Host 或 kit UI。原生 UI 不需要本项目再注册独立聊天插件。
- 有活跃旧任务时，由旧部署完成后再切换；确需保留旧入口时，将其留在隔离部署和状态目录中，不在新插件内部嵌入旧插件以维持兼容。

安装切换按明确插件 ID 停用旧入口，再启用新入口。不得靠重复注册失败实现选择，也不新增永久的“双 provider 模式”配置。

## 5. 必须补齐的接缝

### 5.1 原生 child 的执行配置

复用 DSH 进程内 spawn + codex route。普通主会话或 child 不依赖 workflow；带 role 的 child 由 workflow 解析后提交完整执行参数。

现 `provider.ts` 的 `turnOptions()` 只传 model/effort，`context.ts` 会过滤 system 和 agent-instructions。不能假定把角色写入 persona 就能进入 Codex。

实施时沿真实 DSH Agent 创建、请求组装和恢复路径，确认可用的正式接口，传递并持久化：

- 明确的 model、reasoningEffort、developerInstructions；
- cwd 与已有 ExecutionBoundary 所需约束；
- 真实 child Session 身份及合法调用方/执行授权。

优先复用现有 CreateSessionOptions、ExecutionBoundary、threadParams 和参数核对逻辑；只补已证实缺少的接口，不在文本里夹带 JSON、借标题传身份或建立全局当前配置。

workflow 在创建时捕获实际配置，child 恢复沿用该配置；插件内 backend 保存执行所需值，不读取 role/profile 文件。P1 为保持可编译可比较可暂留未暴露的旧 worker 方法及类型；P2 的原生执行路径只消费明确参数，验收前删除无消费者的角色解析回调；旧项目的角色回调仅暂时服务旧 worker，随消费者迁移删除。

模型/effort/边界不匹配应在任务正文发送前失败。角色/profile 来源仅由 workflow child/attempt 记录持有，原生终态不代替 workflow 验收。

### 5.2 原生 transcript 与交互

保留并迁移已有审批、permissions、requestUserInput、图片与 usage 桥接。缺少交互服务时保留明确拒绝/空答案语义，不伪造用户同意。

当前 provider 的 stream 主要输出 text/usage/finish。补齐原生工具、reasoning、执行进度等展示时，先检查 DSH 的标准事件及外部执行呈现接口，再映射 backend 已有事件。不能把已经由 Codex 执行的工具记录作为可执行 `tool-call` 交给 DSH，造成二次执行。

如果 DSH 缺少外部执行事件接口，在 DSH 补最小接缝；不复制 kit transcript，也不另建 UI 专用 worker store。审批、输入和 Stop 始终绑定确切 Session/thread/turn；迟到事件不得串入下一任务。

### 5.3 恢复与故障边界

复用已有 unknown 状态、idempotencyKey、thread/turn 校验和单 owner 存储。迁移不改变既有 key/记录语义；有必要变化时明确版本和恢复分支。

重点核验：当前 provider 遇到 unknown 会调用 `resumeSession(..., true)`，而 backend 的 true 表示已确认旧进程停止。先复现断线/超时路径，补上可靠的进程归属与停止证据；无法确认就返回明确的未知状态，不能直接将 true 当作自动重试开关。

另一项验收是 RPC uncertain/进程退出能使 provider 等待者收到可处理的错误或终态，不能只更新 store 而令流无限等待。修复应在迁入后拥有该生命周期的模块完成，不加一套独立重试循环。

审批中断后的恢复不能只凭持久化请求 ID 重新批准旧请求；应校验仍存在的真实请求和归属。中断请求已受理与执行已经结束保持不同语义。

## 6. 与 workflow、侧栏及旧数据的协作

workflow 配置安装、profile 选择器及 Session 选择持久化继续按原角色设计实现，不迁入本项目。provider 不提供 profiles API，不依赖 `/api/codex` 查询配置。

DSH 原生子代理侧栏按下述系统设置选择打开位置：本插件客户端负责配置入口和 tab 装配，DSH 提供原生组件及必要接缝。使用确切父子地址，父子面板分别处理输入、草稿、Queue/Steer、审批、Stop 和分页。关闭侧栏仅解除展示订阅。第一版不增加多代理布局管理器。

新原生 child 与旧 backend worker 是不同执行对象。Codex 自行创建的 native child 也不自动投影为 DSH child。第一阶段仅验收 spawn；fork 兼容性单独验证。

旧数据不自动批量转换。已有活跃任务由原 owner 完成，新建任务在部署切换后走新入口。新项目初次验证使用独立 stateDir；生产切换如需复用原记录，必须先停止旧 owner、验证格式及绑定兼容，再由单一 backend 接管，禁止两服务同时打开同一状态目录。

仅在原生主对话、子会话控制、历史与恢复完成替代，且旧 UI/RPC 无消费者后删除 kit；本项目创建或 provider 搬迁不等于满足删除条件。


### 6.1 系统设置：子代理默认打开位置

此项取代原方案“第一版固定侧栏、暂不配置”的安排。系统设置 → 通用，注册一行“子代理默认打开位置”，可选择“右侧栏”或“主区域”，默认“主区域”。默认值是官方行为：该字段同时约束原生目录项，未显式选择时不得接管官方点击。无需为单个选项增加独立设置页面。

第一版作用于本插件启用的 DSH 原生子代理目录打开动作，不按 child provider 区分；不改变普通 Session 导航、父模型或 workflow profile。作用域沿用当前部署的 DSH settings provider，同一设置文档的客户端共享该值，不另建浏览器或 Session 偏好。

当前安装的 DSH 0.1.5-rc.1 **没有现成的子代理打开位置配置项**：ui-subagent 的 Host 入口没有注册设置，客户端直接调用 `sessions.openSubagent(address)`。本插件新增此字段，使用 DSH 已有设置机制；注册字段并不自动实现侧栏行为。

### 6.2 原生设置注册、持久化与同步

按用户决定，取消独立的 `DSH_HOME/dsh-codex-app-provider/settings.json` 方案。Host 向 `ctx.settings` 注册 `dsh-codex-app-provider` namespace，schema 声明 `subagentOpenPosition` 为 `sidebar` / `main`，默认 `main`，标记 `applies: 'live'`。

默认文件由 DSH `dsh-settings-file` 管理，位置为 `<DSH_HOME>/settings.yaml`，本项示例：

```yaml
dsh-codex-app-provider:
  subagentOpenPosition: main
```

如果部署已自定义 settings provider 或文件路径，则完全沿用其配置；本插件不拼接路径、不直接打开文件，也不修改全局 provider.path。这里保存 UI 偏好，执行 stateDir、workflow role/profile 和 Codex 登录配置继续使用各自归属。

实施直接复用现有机制：

- Host 参照 DSH ui-conversation 的设置注册模式，在可用的 settings 服务上注册 schema；注册和观察者由插件生命周期释放。headless 缺少 settings 服务不阻塞 Codex 执行。
- 客户端通过 `settings.general.item` 注册单项设置行，复用 DSH 原生控件、locale 和保存/错误状态。
- 读取、订阅和修改走 DSH 已有 `settingsScope` 与认证设置通路，参照现有原生偏好的实现；通过 scope.set 写字段，由 DSH 自动携带 revision；需要固定编辑时版本的操作才用 scope.mutate(ops, expectedRevision)，复用冲突拒绝机制。不得自行添加 `readUiSettings` / `setSubagentOpenPosition` RPC。
- schema 默认值、字段校验、持久化、写锁、文件格式、外部编辑监听和客户端同步由 DSH 设置机制负责。不增加 JSON store、文件 watcher、轮询、SSE 或 localStorage 副本。
- 只有 scope snapshot 为 ready、mode 为 host 且 writable 时启用保存；memory/unavailable 状态显示无法持久化，不将内存修改伪装为已保存。保存失败、revision 冲突或 provider 只读时沿用原生错误/禁用语义，不显示未提交的值为已保存。运行中外部无效配置沿用 DSH 的最后有效值与诊断；启动时 namespace 无法注册则设置功能不可用，不伪造默认值已加载。
- 默认打开动作读取客户端已同步的有效设置。设置尚未就绪或服务不可用时使用原生主区域行为；不为每次点击重新读磁盘。保存并同步后对下一次默认打开生效，不要求重启。

此前只有设计文档，没有创建独立配置文件，因此本次不需要配置迁移器。

### 6.3 打开位置路由与原生面板

已核实当前 ui-subagent 的目录动作直接调用 `sessions.openSubagent(address)`，它会切换主区域。仅注册设置字段和设置行不能改变此行为，必须补打开动作接缝。

实施时在 DSH ui-subagent 的目录打开动作提供一个最小可扩展入口（具体接口名在实现阶段确定），插件在其中解析默认位置。默认无扩展时沿用原生主区域行为。不得 monkey-patch sessions 方法、操作 DOM 抢点击或先导航主区再恢复父会话。

```text
点击原生子代理目录项
  → 捕获确切 parentSessionId / childSessionId / mode
  → 读取 DSH settingsScope 中的有效设置（显式“在主区域打开”则直接走主区域）
    → main：原生 sessions.openSubagent(address)
    → sidebar：打开/切换注册的子代理 tab，主区域 Session 不变
```

右侧通过 `sidebarRightTabs` 注册类型，通过 `sidebar.right.pane.tab` 注册内容。面板**复刻**主区对话的观感而不是挂载主区组件（理由见 6.5）；Session scope 必须绑定 child，不能沿用全局 selected Session。

配置只影响下一次默认打开动作。切换为 main 不关闭已有侧栏、不丢草稿、不停止 child；保留“在主区域打开”显式操作。one-shot 只读、parent 不可用时的输入/Stop 限制继续沿用原生语义。

异步加载 child 面板期间，如果用户已经导航离开父 Session 或又点击另一个 child，旧打开请求应取消/失效，不把旧 child 面板强行打开。插件卸载解除设置行、打开动作和 tab 注册，释放展示订阅；单独关闭面板不取消任务。

### 6.4 侧栏面板为什么是复刻而不是挂载主区组件

挂载主区 UI 这条通道在运行的（打补丁的）core 里**是通的**，已核实：

- `dsh-client-ui-conversation` 的 `main.conversation` 注册为 `{ kind: 'single', scope: 'session-maybe', reusable: true }`；
- `dsh-client-ui-slots` 具备 `reusable` / `mount` 运行时；
- `SessionProvider` 接受显式 `sessionId`（省略时继承外层 scope，无法解析则渲染 `empty`）；
- `dsh-api-session-controller` 提供 `retainSubagent(address): () => void`。

也就是说本可以这样写：tab body 声明 `children: { 'codex.child.conversation': { kind: 'single', scope: 'session', mount: 'main.conversation' } }`，再用 `<SessionProvider sessionId={childSessionId}>` 包住 `renderSlot`，并用 `retainSubagent` 保活非当前 child 的 Session（这正是早前 `.watch/publish-build` 那一版的写法）。没有采用，是因为三个具体代价：

1. **拿到的是整块主区。** 安装核心里**只有一处** `reusable: true`，就是 `main.conversation`；它的注册同时声明 `conversation.session`、`conversation.session.header`、`conversation.composer` 等子槽，所以侧栏 tab 里会塞进“会话头部 + 会话视图 + 输入框”整套外壳，与 tab 自身标题重复。`conversation.session` / `conversation.view` 都没有标 reusable，没有更细粒度的可复用槽。
2. **审批与提问会失去入口。** Codex 审批走本插件自己的 `/codex-approval` 浏览器通道（`installApprovalRpc`），并**刻意不接 DSH 审批策略**：`provider.ts` 明确“the plugin never asks DSH's approval policy to decide for Codex”，没有交互通道时 fail-closed 直接拒绝。原生对话的审批卡片接的是 DSH approval 交互，本插件从未注册那条路，挂载后审批 UI 失效。
3. **草稿与流的所有权改变，且再欠一笔补丁债。** 现在每个 tab 一条独立 `SessionEventStream`、草稿按地址存、关 tab 只释放展示；换成原生后草稿与流由 session controller 按会话持有（同一 child 开两个 tab 会共享草稿），且 `retainSubagent` 与 `subagent/open` 同属本地补丁 API。

因此当前实现选择复刻观感：保住审批通道、每 tab 独立草稿与紧凑布局，代价是样式是抄的、会随主区演进漂移。

**若要“用主区 UI 又保住插件能力”**，正解不是在插件里绕，而是在 core 上**新增一个 reusable 的会话视图槽**（例如把 `conversation.view` 标为 `reusable`）：侧栏只挂消息视图，头部、输入框和审批仍归插件。这条需要 core 侧改动与补丁集更新。

### 6.5 本项验收

- 设置界面可选择两种位置；刷新页面/重启后选择保留；值由当前 DSH settings provider 持久化，默认位于 settings.yaml 的本插件 namespace，不创建独立配置文件。
- 验证 schema 默认值、非法枚举拒绝、只读 provider、写入失败和 revision 冲突；复用 DSH 原生错误语义，不重复测试其文件存储实现；查看设置和打开面板不会触发模型请求。
- 保存后通过 DSH 原生同步更新其他页面；默认 file provider 启用 watch 时手工编辑可同步生效；自定义 settings 文件路径也能正常使用。
- sidebar 保持父主区，main 使用原生导航；显式主区打开不受默认值限制；切换设置不搬移已打开面板或丢弃草稿。
- 父子同时输入、输出、审批、Stop 和历史分页不串 Session；连续点击/父会话切换不产生迟到导航。
- 同一包安装 Host 与轻量客户端即可使用；headless 不需要 UI 服务，卸载后恢复 DSH 默认打开行为。

## 7. 实施顺序与验收

| 阶段 | 实际工作 | 完成判据 |
|---|---|---|
| P0 迁移基线 | 核对源版本、内部模块依赖、DSH 参数与生命周期接口；运行现有相关测试，确认文件迁移清单 | 分清已有能力与缺口；不升级依赖，不重写 backend |
| P1 单插件迁移 | 迁入 backend/RPC/store、adapter/context 及对应测试，合并服务构造与 Host 注册，切换旧插件部署 | 仅加载新插件即可用原生主会话，不依赖旧 backend/Host/kit UI 或 workflow；模型选择、图片、双 turn 复用、审批/问题、取消、auxiliary、history replay 保持现有行为 |
| P2 原生 child 纵向链 | workflow 提交解析参数，真实 spawn，补指令/边界/恢复传递；处理 unknown 恢复与断线收敛 | child 身份、实际 model/effort/指令/边界进入真实请求；恢复不重读 profile；未知执行不重复派发；不同 child 不串事件 |
| P3 原生呈现与可配置侧栏 | 映射已有 backend 执行事件；同包客户端实现系统设置与侧栏 tab；DSH 补打开动作及原生呈现接缝；workflow 独立配置 UI | 工具仅执行一次；父子并发输出、分别输入/Stop/审批、只读约束、关闭重开和分页通过；仅打开面板不发模型请求 |
| P4 消费者收敛 | workflow 迁移旧 worker 控制/报告消费，按替代清单退出 kit，清除已无消费者的旧 provider/RPC | 无重复 provider、执行 owner、通知或会话目录；保留历史入口与流程合同所需能力；可独立安装新 provider |

P2 优先复用已有接口，不在确认 spawn 无法满足之前另建专用 subagent provider。跨仓库变更按实际职责落点实施；本方案不要求把 workflow 或 DSH UI 源码搬进新项目。

## 8. 验证与交付证据

沿用已有检查，不为搬迁重建测试体系：

1. 迁移前在源仓库运行相关基线；迁移后在本项目运行同一批 provider 及 backend 的 failures、ownership、store、执行与恢复用例。旧项目仅继续验证尚存的旧消费者。
2. 使用真实 DSH LlmRuntime/Session/subagent 验证注册与参数链，不能用手工构造 child ID 的 FakeServer 测试代替真实 spawn。
3. 只为新增接缝补必要回归：role 指令透传；profile A/B 创建后恢复 A；unknown 不重复派发；断线使等待者结束；父子 Stop/审批隔离；工具事件不触发重复执行。
4. 先模拟，再用隔离 stateDir、DSH_HOME 和 workspace 做真实 Codex 执行验证；不使用生产活跃 thread，不改变用户登录配置。
5. 本插件负责 settings namespace/schema、设置行和侧栏路由检查；DSH 负责原生组件与双面板接缝检查，profile 配置/选择检查归 workflow；无需启动一套 kit UI。
6. 发布前完成构建、包内容与独立安装检查：只安装并加载一个 Codex 插件，package/bundle 不引用旧 backend/Host 插件，运行时无需兄弟仓库源码或旧包。

每阶段记录源/目标版本、检查命令、退出状态及关键行为证据。历史 PASS 不自动继承；未跑的真实恢复或 UI 场景保持未验证。测试通过后进入下一阶段，不重复开展无新增问题的全仓审计。

## 9. 社区参考的使用边界

[wingoo/codex-plugin-dsh](https://github.com/wingoo/codex-plugin-dsh) 可参考原生注册、checkpoint、工具目录变化处理和进程生命周期。它由 DSH 执行动态工具、限制 Codex 原生工具，不能整套替换本项目执行语义。只有本地实现确有缺口时才借鉴相关代码，并核对具体版本与许可证。

[codex-acp](https://github.com/agentclientprotocol/codex-acp) 可参考子代理事件身份与历史恢复；其对象是 Codex native child，不能直接套成 DSH spawn child 或照搬其 root 控制路由。

本次不实施 OAuth proxy、ACP transport、Codex → DeepSeek 委派、native child 投影、历史批量迁移或 profile 继承。社区调查结论仅作为设计参考，不扩展本次迁移范围。

## 10. 构建前已确定的接口约束

- Host 配置沿用 `stateDir`、`command`、`requestTimeoutMs`、`providerCwd`。首次隔离运行显式指定独立 stateDir，执行状态不写入 settings.yaml。客户端设置只包含本文的子代理打开位置。
- 主 Session 继续允许 DSH 原生模型/effort 切换；workflow child 的创建配置固定，恢复不从父会话当前选择重算。两者不能用同一个“所有会话冻结模型”规则处理。
- 创建时参数必须可从 DSH 持久记录恢复。新增 child 执行配置按 DSH 的 descriptor/Session 格式规则扩展，并有对应的模型可见指令记录；隐藏 descriptor 不能独自承担模型可见指令的审计来源。
- 原生外部执行事件是展示/事实输入，不是要求 DSH 再执行一次工具的命令；同一 thread/turn/item 的流式增量与最终项合并为一项，恢复读取不得重复执行。
- child 打开接缝必须让显式 main 绕过默认路由，无处理者时只执行一次原生主区导航；侧栏的 Session 绑定必须可释放而不关闭实际 child。
- 完整交付包含新插件、本次必需的 DSH 接缝和 workflow 原生 child 消费适配。P1 可独立交付基础 provider，但不能将其称为完整目标完成；旧 kit 删除是满足迁移条件后的单独收尾，不作为提前删数据的理由。

## 11. workflow session gate：Codex → DSH 同步前置校验

workflow Host 通过 `ctx.codexToolGate` 注册一个具名 handler（`workflow.preToolUse`），并把每个子 Session 绑定为 `{ role, hook, args }`。`role` 只是 Host 的业务标签，本包不枚举、不解释它。绑定在子 Session 首次启动前登记，随 `StoredSession.options.gate` 持久化；同一 Session 只能重述相同绑定，不同绑定必须新建 Session。

执行路径：

- provider 为该 App Server runtime 生成一次性随机 runtime key，并只在**带 gate 的 runtime** 的 spawn 环境注入 `DSH_PRETOOL_ENABLED=1`、`DSH_PRETOOL_SOCKET=<socket>`、`DSH_PRETOOL_RUNTIME=<key>`；不修改 `process.env`，普通 Session 行为不变。
- socket 位于 `mkdtemp` 生成的 0700 目录，socket 本身 0600，插件 dispose 时删除。IPC 为「一连接一请求/响应」的单行 JSON：`{ runtime, event }` → `GateDecision`。
- `lib/pretool-client.js` 是 hook command：未带 ENABLED 标记时 **退出 0 且无输出**；已启用但地址/key 缺失、stdin 非法、连接失败、3 秒超时或返回非法时，一律输出有效 deny。stdout 只输出协议，不打印 runtime key。
- receiver 只用 runtime key 解析 Session：hook payload 里的 `session_id`、`role`、参数都不能替换 Host 绑定。过期/未知 key、已释放或已交接的 record、与 record 不符的 cwd、与当前 turn 不符的 `turn_id` 一律拒绝。
- 每次 runtime 替换或释放都会作废旧 key，因此重启、交接后旧 key 失效。
- provider 记录 `hook/started`/`hook/completed`，使「hook 已调用且 DSH 拒绝」与「Codex 根本没尝试该工具」可区分。

### 11.1 部署前置：安装受管 hook 并确保其可信

**未受管 hook 即使 `enabled: true` 也会被静默跳过**（`trustStatus: "untrusted"`，不报错）。因此 provider 在启用 gated Session 前对该 runtime 的 cwd 调用 `hooks/list`，要求存在一条 `command` 指向本包 `lib/pretool-client.js` 的 PreToolUse 条目、`enabled` 为真、无 `errors`，且 `trustStatus` 为 `managed` 或 `trusted`；任一不满足即拒绝启动并报告具体原因。

受管部署（首选，Linux 为 `/etc/codex/requirements.toml`，需 root）。若目标配置已存在 `[features]`，把 `hooks = true` 合并进该表，**不要追加第二个 `[features]` 表**：

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

`matcher` 用 `"*"`：这是本机已受信插件 hook 的既有写法，且实测命中。

用户配置 + 信任记录（无 root 时）：追加上述 `[[hooks.PreToolUse]]` 条目后，读取 `hooks/list` 返回条目的 `currentHash`，写入

```toml
[hooks.state."<sourcePath>:pre_tool_use:<matcherIndex>:<hookIndex>"]
trusted_hash = "<currentHash>"
```

`sourcePath` 为该配置文件绝对路径；key 与 `currentHash` 相等后 `trustStatus` 变为 `trusted`。代用户写信任记录等于绕过信任提示，只在明确授权的部署步骤中执行。

未修改部署配置时，请报告该部署前置未完成：DSH 原生 guard 不依赖本桥，可以单独完成与验收；但不得把 mock 测试记为 Codex 侧真实接入成功。

### 11.2 覆盖范围

覆盖：Codex `Bash` 等已知 shell 名与 `apply_patch`（整份 patch 的每个路径）、以及 Host 已注册的所有工具调用在 PreToolUse 阶段被拒。

不覆盖：shell 程序内部的 `open/write/rename`、解释器、后台进程、任意 MCP 副作用；工具名清单追不上的 `mcp__<server>__<name>` 与可在运行时注册并执行代码的 `cordis_define`/`cordis_run`。本包不解析 shell AST，也不把命令字符串做成黑名单。首版不实现 Windows hook IPC。
