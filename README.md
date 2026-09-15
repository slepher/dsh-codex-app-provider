# dsh-codex-app-provider 实现方案

> 当前用户需求：[plugin-requirements.md](../plugin-requirements.md)。

> 2026-09-15：已移除子会话打开位置配置。插件现有标题栏按钮固定打开右侧栏；下文涉及位置设置的内容为历史设计。
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

现有本地版本基线为 Node >=22.19、DSH 0.1.5-rc.1、Codex CLI 0.154.0。P1 保持版本不变，避免把依赖升级混入搬迁。后续 DSH 接缝若需要源码变更，使用包含变更的一组协调构建包并记录确切版本/commit，不能仍宣称未修改的 rc.1 已满足全功能要求。

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

此项取代原方案“第一版固定侧栏、暂不配置”的安排。系统设置 → 通用，注册一行“子代理默认打开位置”，可选择“右侧栏”或“主区域”，默认“右侧栏”。无需为单个选项增加独立设置页面。

第一版作用于本插件启用的 DSH 原生子代理目录打开动作，不按 child provider 区分；不改变普通 Session 导航、父模型或 workflow profile。作用域沿用当前部署的 DSH settings provider，同一设置文档的客户端共享该值，不另建浏览器或 Session 偏好。

当前安装的 DSH 0.1.5-rc.1 **没有现成的子代理打开位置配置项**：ui-subagent 的 Host 入口没有注册设置，客户端直接调用 `sessions.openSubagent(address)`。本插件新增此字段，使用 DSH 已有设置机制；注册字段并不自动实现侧栏行为。

### 6.2 原生设置注册、持久化与同步

按用户决定，取消独立的 `DSH_HOME/dsh-codex-app-provider/settings.json` 方案。Host 向 `ctx.settings` 注册 `dsh-codex-app-provider` namespace，schema 声明 `subagentOpenPosition` 为 `sidebar` / `main`，默认 `sidebar`，标记 `applies: 'live'`。

默认文件由 DSH `dsh-settings-file` 管理，位置为 `<DSH_HOME>/settings.yaml`，本项示例：

```yaml
dsh-codex-app-provider:
  subagentOpenPosition: sidebar
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

右侧通过 `sidebarRightTabs` 注册类型，通过 `sidebar.right.pane.tab` 注册内容，复用 DSH 原生 Conversation/输入/审批组件。Session scope 必须绑定 child，不能沿用全局 selected Session；若现有组件不能显式绑定，在 DSH 补必要公开接缝，不复制组件源码。

配置只影响下一次默认打开动作。切换为 main 不关闭已有侧栏、不丢草稿、不停止 child；保留“在主区域打开”显式操作。one-shot 只读、parent 不可用时的输入/Stop 限制继续沿用原生语义。

异步加载 child 面板期间，如果用户已经导航离开父 Session 或又点击另一个 child，旧打开请求应取消/失效，不把旧 child 面板强行打开。插件卸载解除设置行、打开动作和 tab 注册，释放展示订阅；单独关闭面板不取消任务。

### 6.4 本项验收

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
