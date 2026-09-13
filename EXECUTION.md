# dsh-codex-app-provider 执行文档

状态：E0/E1 完成；E2.1 和 E3 设置子集已实现；基础独立安装与真实主会话通过，完整目标未完成。日期：2026-09-13。配套设计：[README.md](README.md)。本文中的命令是实施时执行的步骤，不是已运行结果。

## 1. 开工约定

从本项目根目录执行。先读 README，再按 E0 → E1 → E2 → E3 → E4 → E5 执行；E6 为旧消费者退役。每阶段达到完成判据才推进，不将测试模拟、真实执行和浏览器验证混为一项。

固定目标：一个 npm 包、一个 Host 插件入口、同包客户端；迁移现有 Codex backend/provider，而非重写；UI 复用 DSH；偏好使用原生 settings；role/profile 归 workflow。详细行为以 README 为准。

当前已有迁移源码、同包设置客户端、测试及本地证据。续接从 E2.2 开始，不重抄已迁移源码，不需要重新讨论包拆分、配置目录、OAuth 或 ACP 路线。具体 DSH 扩展名由实现阶段在现有契约中确定；本文件给出接口行为和检查落点，不把待新增 API 写成已存在的方法。

## 2. 工作区与源码导航

| 位置（相对本项目） | 使用方式 |
|---|---|
| `../dsh-codex-kit` | 源码及测试迁移基线；初期只读，保留旧部署能力 |
| `../deepseek-harness` | DSH 源码，必要接缝在所属包修改；先读取其 AGENTS.md 及对应目录要求 |
| `../dsh-workflow-kit` | workflow child/attempt、角色配置及调度消费适配；先读取该仓库自身规则 |
| 源项目 `node_modules/@deepseek-ai/*/lib/types` | 本地安装的 rc.1 类型事实，与 DSH checkout 的版本分别记录 |

源项目核心文件位于 `packages/dsh-codex-kit-backend/src/`；对应测试位于该包 `test/`。UI 构建参考 `packages/dsh-codex-kit/package.json` 与 `scripts/build-client.mjs`，只复用打包/加载模式，不搬独立聊天页面。

当前已核实的 DSH 导航点：

| 功能 | 源码/契约位置 |
|---|---|
| 原生 spawn | `packages/subagent/subagent-spawn-in-process/src/index.ts`、`subagent-in-process-driver/src/index.ts` |
| child 持久化/恢复 | `packages/subagent/subagent/src/descriptor.ts` 与 `types.ts`；已安装 `dsh-subagent/lib/types/descriptor.d.ts` |
| Agent 请求传参 | `packages/core/agent`、`packages/core/agent-loop`；已安装 `dsh-llm/lib/types/types.d.ts` 的 GenerateOptions |
| 子代理目录打开动作 | `packages/client/ui-subagent/src/client/index.ts` 的 catalogActions/openChild |
| Session 客户端绑定 | `packages/api/session-controller/src/client/` |
| 原生 Conversation 合成 | `packages/client/ui-conversation/src/client/contract/` 与 `apply.ts` |
| 右侧 tab | `packages/client/ui-sidebar-right/src/client/`；已安装 tab-registry/contract/slots 类型 |
| Host 设置示例 | `packages/client/ui-conversation/src/index.ts`、`submission-settings.ts` |
| 客户端设置示例 | `packages/client/ui-conversation/src/client/apply.ts`、`settings/EnterBehaviorRow.tsx` |
| settings scope | 已安装 `dsh-client-ui-settings/lib/types/client/settings-contract.d.ts`、`settings-scope.d.ts` |
| workflow 现消费者 | `src/workers.ts`、`host.ts`、`workflow.ts`、`store.ts`、`roles.ts` |

源码版本可能移动文件；找不到时用 `rg --files` / `rg` 找同名符号，不以猜测的路径创建第二套实现。

## E0. 固定基线和建立本地检查记录

**产出：** 确认迁移版本、工作区变更和测试基线；把结果填入本文末尾。

从新项目执行只读核验：

```bash
pwd
node --version
npm --version
codex --version
git -C ../dsh-codex-kit rev-parse HEAD
git -C ../dsh-codex-kit status --short
git -C ../deepseek-harness rev-parse HEAD
git -C ../deepseek-harness status --short
git -C ../dsh-workflow-kit status --short
```

在源项目运行 backend 基线（首次缺依赖时先按其锁文件安装）：

```bash
cd ../dsh-codex-kit
npm run build -w dsh-codex-kit-backend
node --test packages/dsh-codex-kit-backend/test/provider.test.mjs packages/dsh-codex-kit-backend/test/backend.test.mjs packages/dsh-codex-kit-backend/test/failures.test.mjs packages/dsh-codex-kit-backend/test/store.test.mjs packages/dsh-codex-kit-backend/test/ownership.test.mjs
```

确认 Node >=22.19、DSH 0.1.5-rc.1、Codex CLI 0.154.0 与本地事实一致；不一致时记录差异，先验证受影响契约，不自动升级。上述 git 命令只适用于已有仓库；新目录无需先建立远端或发布。

**通过判据：** 清楚哪些测试原本通过、哪些是现存失败；没有重置他人修改。已有失败只阻塞受影响行为的“迁移等价”判断，不把源项目顺手扩展为修复任务。

## E1. 搬迁并形成单插件基础版本

**负责位置：** 本项目；暂不修改旧项目注册或生产 profile。

### E1.1 源码和依赖闭包

迁入 backend 的 `rpc.ts`、`backend.ts`、`store.ts`、`models.ts`、`skills.ts`、`browser-types.ts`、`conversation.ts`，以及 `host/provider.ts` → `src/provider.ts`、`host/context.ts` → `src/context.ts`。

先调整 import 保持行为，不同时重写状态机。`backend.ts` 当前直接引用 conversation/models/skills，不能因文件名像 UI 就省略。初次编译可保留未暴露的旧 worker 方法及类型；不得注册旧 codex_workers 工具、角色目录、通知或 RPC。E2/E5 按实际调用删除剩余旧功能，不复制旧 UI 来满足编译。

合并 `service.ts` 的配置和 backend 构造与 `host/index.ts` 的 provider 注册，形成唯一 `src/index.ts`：

1. 读取 `stateDir`、`command`、`requestTimeoutMs`、`providerCwd`，沿用既有校验及默认规则。
2. 构造一个 CodexSessionBackend 与其 AppServer factory。
3. 注入 sessions/agents/llm；审批、userQuestions、attachments、settings 使用可选接缝，不能让 headless 等待 UI 服务。
4. 注册唯一 codex adapter 和上下文过滤器，保留注册 disposer。
5. 卸载停止新调用、关闭 adapter、解除订阅，最后 await backend.close；用现有 lifecycle API 表达，不靠未等待的后台 Promise。

内部测试直接 import `lib/backend.js` / `lib/rpc.js` / `lib/store.js` / `lib/provider.js`；无需为了旧测试 import 形式扩大公共 exports。

### E1.2 包与构建

创建单 package.json，名称 `dsh-codex-app-provider`，ESM，保留许可证；迁入现有 tsconfig 的严格类型/NodeNext/ES2022 选项。依赖按迁入源码真实 import 选择，DSH 相关版本与基线一致，禁止依赖旧 kit/backend 包或源码路径。

确定以下脚本契约，供后续步骤直接调用：

| 命令 | 要实现的含义 |
|---|---|
| `npm run build` | 编译 Host；E3 加入客户端后同时构建 client 及发布所需声明/资源 |
| `npm run typecheck` | 对已实现的 Host 和 Client 编译面执行 noEmit 检查 |
| `npm test` | 执行本项目已有及新增 Node 测试；此前显式 build，不重复藏入 pretest |
| `npm run test:live` | E5 增加的隔离 DSH profile 验证入口，缺少必要运行条件时明确报未运行 |

迁移时建立本项目锁文件，不复制源 workspace 的锁文件。公共入口 `.` 指向 Host；E3 增加 `./client` 和 dsh.client 元数据。bundle 只插入本项目的 Host 项，不插入 backend/host 第二项。

客户端构建借用已有 esbuild 脚本的加载格式，但必须修改 entry/outfile/module id；编译产物只包含本包文件，DSH 共享模块按实际宿主加载规则声明，不能把所有 bare imports 都设 external 后假定浏览器能解析。

### E1.3 迁移测试与首个闭环

迁移 E0 的五份测试，调整 import；Host 注册测试只迁移 provider/context 部分。保留 FakeServer 和断言，不以测试文件数量为指标。

```bash
npm install
npm run build
npm run typecheck
npm test
npm pack --dry-run
```

检查模型目录查询不创建用户 thread；普通 Session 双 turn 复用、图片、审批/问题、auxiliary、取消和 replay 保持原行为。测试使用临时 stateDir，不引用源项目 lib。通过后 E1 是基础 provider，不是完整交付。

## E2. 恢复修复与真实原生 child 配置链

**依赖：** E1。**负责位置：** 本项目执行模块、必要 DSH 创建/恢复接缝、workflow 原生 child 消费者。

### E2.1 先解决未知执行状态

用迁入 FakeServer/真实 RPC 故障注入复现 turn/start 超时、进程退出和恢复。检查现有 unknown → resumeSession(..., true) 的停止依据，不能仅凭 unknown 自动确认。

最小修复必须保证：无可靠停止证据不接管；断线让 provider 等待者结束并报告错误；同 idempotencyKey 不再次发送任务；迟到的完成/审批不污染新 turn。测试须断言实际 RPC 次数和流结束，不只检查 store.state。保留原 thread/turn 校验；不要把失败恢复成新的 thread 后静默重做任务。

### E2.2 固定参数输入和持久化

使用已有 CreateSessionOptions / ExecutionBoundary 作为执行参数基础，不再定义 role/profile 到模型的第二套解析器。

沿 DSH `spawn → AgentOptions → request assembly → GenerateOptions → adapter` 和 `descriptor → cold resume` 两条路径确认载体。目标必须同时承载 model、reasoningEffort、developerInstructions、cwd/boundary 与真实身份。已存在的正式字段直接复用；缺字段时在所属 DSH 契约添加最小结构，并更新创建、序列化、恢复和所有受影响消费者。

默认优先在原生 child 持久创建配置中记录完整执行快照，由恢复后的 Agent/请求传递给 provider，不在插件建立一张 child 配置影子表。主会话直接使用本次原生模型选择；只有 workflow 创建的 child 使用固定快照。

验收前将确定的 DSH 字段/扩展名、文件、版本写入本文记录。以下语义不允许留待猜测：

- 原生 Session ID 是实际绑定身份，不能伪造目录条目。
- 模型可见 role 指令既进入真实 Codex developerInstructions，也按 DSH 规则可从日志重建；不能只写模型隐藏 descriptor。
- provider 上下文过滤继续排除 DSH 背景注入，不用取消全部过滤作为角色透传修复。
- 已存配置在恢复时不读父 profile；实际模型/effort/边界校验失败在任务正文之前停止。
- 执行授权在真实 caller 边界校验；不把旧 workerId 授权条件套到伪造 child 上，也不删除权限检查换取可执行。

### E2.3 workflow 适配

在 workflow 仓库修改现有 workers/host/workflow/store，而非将整个 workflow 搬入本插件。创建入口从真实父 Session 获取当前 profile，一次性解析 role 指令、model/effort、执行边界；通过原生 spawn 创建 child，并在 child/attempt 记录来源及实际参数。

角色配置保留 README 所引用的文件语义：workflow 自己安装/加载 roles 与 JSON profiles，无继承、无隐式回退；选择绑定父 Session；切换只影响后续创建。已有 workflow 配置能力先复用，缺失部分在 workflow 实现。workflow UI 独立挂到原生父会话，不依赖 kit。

管理和结算改用原生 child 控制/结果，保留原流程授权、验收和任务合同；不得将 inactive 当作验收成功，不重复发结果通知。本插件不新增 profile API。

**通过判据：** 真实 DSH spawn 创建两个独立 Session；profile A/B 各派一个 child，修改/删除配置后恢复 A 仍使用 A；普通无 workflow 的主 Session/child 可运行。实际请求记录证明指令/模型/边界已传达。fork 保持单独未验证，不能借 spawn 的结果宣称兼容。

## E3. 接入原生系统设置和外部执行呈现

**依赖：** E1；执行事件完整验收依赖 E2。**负责位置：** 本插件 Host/Client，必要 DSH 事件接缝。

### E3.1 原生设置

新增 `src/settings.ts`，共用 namespace、字段及类型；Host 使用 `ctx.settings.register('dsh-codex-app-provider', schema, { applies: 'live' })`，schema 默认 `subagentOpenPosition: 'sidebar'`。schema 写法复用 DSH submission-settings.ts。

客户端使用 `ctx.settingsScope.bind({ namespace: 'dsh-codex-app-provider' })`，通过 getSnapshot/subscribe 读状态，通过 `scope.set('subagentOpenPosition', value)` 保存，revision 由 DSH 负责。注册 settings.general.item；仅 ready + host + writable 可保存。不可持久化或读取失败显示原生错误状态，路由使用 main。

不新建文件存储/RPC，不修改 provider.path，不写 localStorage。默认由 DSH 写入 settings.yaml；用户自定义 provider 时仍可使用。设置加载/保存不发 Codex 请求。

单包增加客户端入口及 locale，借用源 kit 的 manifest/build 模式；headless 不加载客户端。新增针对本字段的默认值、非法值、保存失败/冲突、memory 模式用例，不重测 DSH 写锁实现。

### E3.2 外部执行记录

枚举 backend 当前发布的 thread.notification、turn.output、turn.state、usage、审批/问题事件，形成明确映射。原生 assistant 文本和 usage 继续现有 stream；工具/推理等用 DSH 可表达“外部已执行事实”的接口呈现。

若缺接口，在 DSH 定义可持久化的外部执行事件及对应原生 Conversation node；provider 只提交事实，不复制页面 JSX。映射键包含确切 session/thread/turn/item，增量和最终项合并，失败/中断保留真实状态，重放只重建展示。

**通过判据：** 真实 shell/file 工具执行一次，原生记录可回看；父子工具及审批归属正确；DSH Agent Loop 没有再次执行同一工具。设置与呈现的必要 Host/Client 跨包构建全部通过。

## E4. 配置驱动的原生子代理侧栏

**依赖：** E2、E3；可先完成不依赖真实模型的交互部分。

1. 在 DSH ui-subagent 打开动作增加最小公开扩展接缝，按其注册规范管理 disposer。插件处理默认打开位置；显式 main 与无插件路径直接调用原生 sessions.openSubagent 一次。不得覆盖 sessions 方法或绑定 DOM 点击。
2. 客户端注册 sidebarRightTabs 类型及 keyed sidebar.right.pane.tab 内容。地址包含 parentSessionId、childSessionId、mode；通过原生 Session controller 验证和绑定，而非信任字符串即可获得权限。
3. 复用 DSH 原生 Conversation 的显式 Session scope；组件若依赖全局 selected Session，先在 DSH 拆出可复用接缝。按 DSH slots/service 契约装配，不通过导入另一个插件的私有组件绕过公开契约。
4. 默认一个 child tab，点击另一个 child 切换该 tab；主区仍是父 Session。保留显式主区域打开。默认值切换不搬移已开面板或清除草稿。
5. 取消迟到打开请求；关闭 tab 只释放展示，Stop 才控制执行。遵循 one-shot、continuable、parent-unavailable 的原生只读/Stop 规则。

**必须检查：** 父子同时输出；各自草稿/发送/Queue/Steer；审批和 Stop；分页；连续点两个 child；打开期间切换父会话；关闭再打开；切换 main/sidebar；插件卸载后恢复默认导航。所有控制断言目标 Session，不只看面板是否出现。

DSH 变更按其 AGENTS.md 执行相关 GUI 检查；涉及已组装浏览器输出时运行其要求的浏览器验证。不修改 node_modules 作为交付，不静默升级整套 DSH。

## E5. 隔离集成与可安装交付

**依赖：** E1–E4。目标是证明一个安装包真实工作，不是只证明 TS 编译。

1. 为新插件建立隔离 DSH profile、workspace、stateDir，通过 DSH 官方 profile 启动机制运行。复用已有 Codex 登录状态进行验证，不把登录文件复制进项目，也不更改用户正在运行的 profile。
2. 若 DSH 有本次源码改动，构建并安装相互一致的 DSH 包集，记录 commit/版本；不能让旧 rc.1 依赖偶然从工作区解析到新源码后声称安装通过。
3. 实现 `npm run test:live`，复用仓库现有测试写法启动上述 profile，记录 provider、native Session ID、thread/turn、实际配置及终态。先模拟，后真实；凭证/平台缺失只记 UNRUN，不伪造 PASS。
4. 核验原生主会话新建/历史/续聊、模型切换、图片、工具、审批、结构化问题、Stop、冷恢复；核验 DeepSeek/DSH 父 Agent → Codex child 与 profile A/B 恢复；核验设置和侧栏浏览器行为。
5. 构建并打包，在干净临时消费目录安装 tarball 及协调的 DSH 依赖，确认运行不访问兄弟源码或旧 kit 包；通过隔离 profile 加载，不另写 Codex/DSH daemon launcher。

在本项目按顺序执行，脚本由前述阶段建立：

```bash
npm run build
npm run typecheck
npm test
npm pack --dry-run
npm pack
npm run test:live
```

打包检查 files 覆盖 Host、Client、类型、样式、locale、bundle 与许可证；本项目仅一个 Host 插件项，./client 属同包。检索旧包名只允许来源文档/许可证保留，生产 import、依赖和 bundle 中不得残留。

**完整通过判据：** README 的核心行为、设置及侧栏验收均有证据；只有一个执行 owner 和 codex route；没有 role/profile 第二事实源；默认 settings 文件保存成功；同包独立安装通过。确实未验证的场景逐项保留，不能以总体 PASS 掩盖。

## E6. 旧消费者退役与最终清理

新插件验收不自动授权删除所有旧数据。先列出现存 kit UI/RPC、旧 backend worker、workflow 和活跃任务消费者及替代入口。

生产切换先让旧任务结束或通过原有合法控制收敛，停止旧 owner 后启用新插件；保留旧状态目录。需要旧历史入口时使用隔离旧部署，不在同部署同时注册 codex route。复用状态文件仅在格式、身份和锁验证后进行，不自动批量转换。

删除新插件中已无消费者的旧角色回调、独立 main/worker 目录和专用投影方法，并对应收敛迁移测试；执行 reports/usage/replay 仍有调用则保留。旧项目的 UI/RPC/包只在 README 的替代条件满足后退出。未达到删除条件时明确记录保留原因，不为追求清零创建兼容插件。

## 3. 失败处理与续接

- 找不到预期 DSH 接缝：在对应阶段记录现有调用、所需最小契约和受影响消费者，再在 DSH 实现；不以假 API 或本地补丁绕过。独立的基础迁移可以继续。
- 检查失败：区分基线已有、迁移引入和平台/凭证不可用；修复当前工作导致的失败后重跑受影响检查，不无目的重复全套审计。
- 每阶段结束更新下表。中断后从第一个未完成阶段恢复，先检查工作区差异，不重抄源码、不覆盖他人修改。
- 发布、生产部署与旧数据删除不是本轮文档交付的一部分；实际构建时按当时用户授权处理，不在开工前重复询问已经确定的设计选择。

## 4. 执行记录（由实施者填写）

| 阶段 | 状态 | 实际修改/契约 | 命令与退出状态、证据 | 剩余问题 |
|---|---|---|---|---|
| E0 基线 | PASS（模拟基线） | Node v24.13.1、npm 11.8.0、Codex 0.154.0；已安装 DSH 0.1.5-rc.1；kit eedbef08fc2b2121f14007720e63563aa1a6e264；DSH 183f08e9c6dde7e36cd2318eaee70b0da08fb35e；workflow ab8b10e55b85bdf7957ba88a7500abc7ea659e14 | 2026-09-13；源目录 npm run build -w dsh-codex-kit-backend 首次 exit 2（EROFS），相同命令提权重跑 exit 0；E0 所列五文件 node --test exit 0，见 evidence/e0-tests.log | DSH 已有 commands.ts、types.ts、agent.host.spec.ts、session-models.host.spec.ts、api-catalog.ts 修改，保留；新目录未初始化 Git；真实运行未验证 |
| E1 单插件迁移 | PASS（模拟） | 迁移执行模块和 40 个原用例；拆出 context 测试，新增真实 Cordis/LlmRuntime headless 注册、卸载释放 owner.lock、重载测试；唯一 apply + codex route；无旧包运行依赖 | 本目录 npm install、npm run build、npm run typecheck、npm test、npm pack --dry-run 均 exit 0；node --test --test-isolation=none test/*.test.mjs：42/42 PASS；evidence/e1-*.log | 完整客户端和真实执行待 E2–E5；旧 worker 内部方法按 E1 约定暂留 |
| E2 恢复与 child | PARTIAL | E2.1：backend 发布持久 session.uncertain；隔离迟到 transport 事件、保留进程至 await close；provider 主/auxiliary/compact 等待者处理 unknown；取消自动 confirmedStopped=true | e2-uncertain-red.log exit 1 复现无限等待；e2-tests.log 43/43 exit 0；e2-rpc.log 真实 Node 子进程超时/退出 2/2 exit 0（提权） | E2.2 参数链及真实 spawn/A-B/冷 Agent 恢复已通过（见续接记录）；workflow 原生 child、真实合同交付与 Host 冷恢复已通过限定场景（见续记）；故障与交互验收继续 |
| E3 设置与原生事件 | PARTIAL | Host ctx.settings.register(dsh-codex-app-provider, SettingsSchema, {applies:live})；同包 ./client + dsh.client；客户端 settingsScope.bind/getSnapshot/subscribe/set；默认 sidebar、未就绪 main | e3-build.log、e3-typecheck.log exit 0；e3-settings.log 2/2 exit 0；e3-client-bundle.log exit 0（模拟 ModuleLoader） | 真实外部工具、设置持久化与侧栏路由通过；公开摘要及终态有聚焦测试，审批/Stop 浏览器验收继续 |
| E4 侧栏 | PARTIAL | 原生公开 mount、显式 Session、视图租约、设置路由及同包 tab 已装配 | 14 包协调构建/打包通过；JSX 修复后设置、原生 child、草稿隔离、主区打开及工具节点真实浏览器通过 | Queue/Steer、审批/Stop、分页等完整交互继续验收 |
| E5 独立安装/真实验证 | PARTIAL：独立安装 / 基础真实主会话 PASS | scripts/test-live.mjs 创建临时 DSH_HOME/profile/workspace/stateDir；tarball + 固定 DSH rc.1 包集；官方 dsh --profile 启动，登录配置原地复用 | 2026-09-13，DSH_TEST_NPM_CACHE=/tmp/dsh-app-npm-cache npm run test:live exit 0；523 个消费依赖安装 exit 0；Host import、dump-config、真实 headless exit 0；evidence/live-result.json | 后续真实 spawn/A-B、workflow 合同、Host 冷恢复与浏览器子集已通过（追加记录）；审批/图片/Stop 等剩余场景尚无完整证据 |
| E6 旧消费者退役 | TODO | — | 未运行 | 受旧任务和历史替代条件约束 |

记录使用实际日期、cwd、命令、exit code、源码版本和必要日志位置；不记录凭证。新增的 DSH API 名称及版本必须在 E2/E4 行填清，方便后续构建和安装复现。

### E0 / E1 来源记录（2026-09-13）

`src/{backend,rpc,store,models,skills,browser-types,conversation}.ts` 来自基线 backend 包同名源码；`provider.ts`、`context.ts` 来自其 `src/host/`；五份核心测试保持断言，仅改包内 import；context 用例从 host.test.mjs 拆出。`LICENSE` 原样保留来源包 MIT / Copyright (c) 2026 DeepSeek。服务构造与 Host 注册合入唯一 `src/index.ts`，不安装旧 worker 工具和 RPC。

E0 补充：默认 Node 子进程测试输出仅显示 5 个文件，通过 `node --test --test-isolation=none` 同一五文件明确得到 40/40 PASS（exit 0）。E1 首次网络访问 EPERM，提权安装后发现 npm 自动选择 rc.2 peer 产生 ERESOLVE（exit 1）；现按源锁中的 12 个实际 DSH 依赖闭包设置根 overrides，重新生成本项目锁文件，安装 exit 0；TypeScript 5.9.3、@types/node 24.13.3、Cordis 4.0.2。独立消费者仍须显式协调 DSH 版本，npm 根 overrides 不会随依赖包继承。

E2 RPC 检查：受限沙箱中 Node 子进程 stdin 管道未送达，最小 echo 子进程直接 exit 0，导致 RPC 测试在 thread/start 前失败；相同测试提权重跑，真实 timeout/exit 两项通过。不关闭 Codex 执行权限或审批以通过检查。

E3：客户端打包沿用源项目 ModuleLoader 格式，module id 为 dsh-codex-app-provider；只 external React 共享运行时，其他实际 runtime 依赖打入本包，未将全部 bare imports 设 external。尚未注册子代理 tab，不把偏好行当作侧栏已实现。

### 当前可复现证据与续接点（2026-09-13）

- cwd：`/home/slepher/project/agents/dsh/dsh-codex-app-provider`；`npm run build`、`npm run typecheck`、`npm pack --dry-run`、`npm pack` exit 0，日志为 `evidence/current-build.log`、`current-typecheck.log`、`current-pack-dry.log`、`package.json`。
- `npm test` 提权运行 exit 0，48/48 PASS，无 skipped/cancelled；`evidence/current-tests.log`。其中 FakeServer/注册/客户端加载为模拟，`rpc-failure.test.mjs` 使用真实 Node 子进程但不是模型运行；不得合并称为真实 Codex 48 项通过。
- 隔离真实环境保留在 `/tmp/dsh-app-live-rAeTkh`。唯一原生主 Session：`session-dcd9fbf3-8d22-4c4e-871a-b4be1854e52a`；thread `01a098dd-3663-7230-b5cd-1ca15986e0f1`；turn `01a098dd-36fd-7cd2-94bd-5be8f8fca832`；实际 model `gpt-5.6-luna`、effort `medium`、report completed，输出 `DSH_CODEX_APP_OK`。本项目 stateDir 和原生 Session 压缩日志均在隔离目录中；未复制登录文件。
- `scripts/dsh-baseline.json` 是源锁中 DSH 注册表包的版本清单，不是源 workspace 锁文件；干净消费目录自行生成锁。消费目录里的 provider 是 tarball 安装，不是源码链接；运行依赖不导入旧 kit/backend。
- E2.2 已实施参数通路与 descriptor v4，完整实际接口和新增证据见下方续接记录；此段原先的“尚未实施”已被本轮源码和验证替代。
- E2.3 已切换 workflow 原生 child 消费与 profile 配置/选择；当前实现和模拟验证见下方追加记录。真实 workflow profile 运行、浏览器及安装/dev 脚本迁移仍未完成。
- E3 原生外部执行呈现、E4 打开动作/显式 Session Conversation scope/tab、E5 完整浏览器与真实恢复验收尚未完成。设置保存已接原生机制，但没有侧栏消费者；file provider 默认持久化及浏览器跨页同步仍未验证。
- E6 保留旧项目、数据和消费者；尚未满足替代条件。兄弟仓库的用户修改保持原样，无生产部署、发布或推送。

### E2.2 续接记录（2026-09-13，实施中）

- 已重新完整读取 README/EXECUTION，核对 DSH 基线仍为 `183f08e9c6dde7e36cd2318eaee70b0da08fb35e`，保留原有 5 个修改；workflow 与旧 kit 未修改。
- 新增 DSH 正式 `LlmExecutionOptions` / `ExecutionBoundary`，通过 `AgentOptions.execution → agent-loop.prepareRequest → LlmCallConfig.execution → request/header.config.execution → GenerateOptions.execution` 传递。显式执行 Agent 的 provider/model/指定 effort/执行输入在请求准入前校验固定；普通 Agent 保留原模型选择。
- `subagent/descriptor` writer 为 4，continuable 的 `execution` 创建时快照并在 `continuation.coldResume` 还原；继续读取不含 execution 的 v3。`childSessionMeta(..., cwd)` 从明确边界传递真实 child cwd。共享 child option 解析捕获独立执行值，不隐式继承父 execution。DSH SDK provider 明确拒绝其协议不能承载的 execution。
- provider 比较实际 live Agent 的 Session 身份与创建快照；backend 继续保存执行所需 options，通过 native Session 绑定消费；开发指令进入 `thread/start.developerInstructions`，边界沿用已有 `threadParams` 和实际响应核对。模型/effort、指令或边界不匹配时不调用 `turn/start`。
- `pnpm exec vitest run packages/llm/llm/tests/call-config.spec.ts packages/subagent/subagent/tests/child-agent.spec.ts packages/subagent/subagent/tests/continuation-inheritance.spec.ts packages/subagent/subagent/tests/service.spec.ts packages/subagent/subagent-dsh-sdk/tests/subagent-dsh-sdk.spec.ts`：exit 0，122/122，见 `evidence/e22-dsh-tests.log`。真实 DSH spawn/持久化/冷恢复，模型为 MockAdapter，不是真实 Codex。
- 本项目 `npm run build`、`npm run typecheck` exit 0；提权 `npm test` exit 0，50/50，见 `evidence/e22-all-tests.log`。后续边界响应修复仍需再次运行受影响检查。
- DSH `pnpm run build:lib:host` 曾因沙箱 lib/types 写入 EROFS 失败；提权构建 exit 0。后续声明式 schema 添加曾出现 TS2352，修正 Session ID 品牌与枚举 schema 后构建 exit 0；SDK 最新拒绝分支尚须更新构建。见 `evidence/e22-dsh-build.log`。
- `scripts/pack-dsh.mjs` / `scripts/dsh-coordinated.json` 记录源码来源和协调包；版本仍标记 rc.1，但明确是含本地修改的源码构建，不是注册表 rc.1。本项目 llm/agent/session 开发依赖通过本地 tarball 安装，未手改 node_modules。SDK 修改还须加入协调包清单；最终源码 patch 还须补新文件内容。
- `npm run test:live -- --native-child` 已实现隔离 profile 测试入口，测试插件为 `test/native-child-driver.mjs`，按实际 child Session ID 检查 A/B 和 A 冷 Agent 恢复；这尚不等于 Codex 进程冷恢复或 workflow profile 验收。首次协调独立安装 PASS（523 个依赖），真实执行 FAIL：`/tmp/dsh-app-live-WOS6Pr`。新 child 创建在任务正文前因边界核对失败；旧 unknown 记录全部保留，未自动确认或重发。
- 失败诊断显示 Codex 0.154.0 返回 `workspaceWrite, writableRoots: [], networkAccess:false, excludeTmpdirEnvVar:true, excludeSlashTmp:true, approvalPolicy:never`。已用该安装版本生成 `/tmp/dsh-codex-0154-protocol`；官方 [配置参考](https://learn.chatgpt.com/docs/config-file/config-reference) 将 writable_roots 定义为额外可写根。正在校正明确可写 cwd 在实际响应中省略时的比较，仍校验额外根、临时目录、网络和审批；不将该失败写作外部阻塞。
- 诊断曾有一次从本项目 cwd 启动同一隔离 profile；没有发送任何 turn，记录在 `native-child-diagnostic.json`。随后均在隔离 workspace 复现。独立 profile 与 state 始终在 `/tmp`，没有生产部署、发布、推送或数据删除。
- 剩余：完成边界修复验证、真实 child 参数链；补 DSH 相关文档/生成契约/快照检查和协调最终产物；继续 E2.3 workflow 原生 child 消费。E3 外部执行呈现、E4、完整 E5、E6 未实施，保持原阶段状态。

### E2.2 真实参数链验证及 E2.3 开始（2026-09-13）

- 最终 `pnpm run build:lib:host` exit 0；`node scripts/pack-dsh.mjs` exit 0。七包协调清单已含 SDK；`evidence/dsh-source.patch` 已含新增 execution.ts，未将未提交源码冒称注册表发布。
- 边界校正后 `node --test --test-isolation=none test/provider.test.mjs test/backend.test.mjs` 34/34、exit 0；本包 build/pack exit 0。
- 真实隔离复跑 `DSH_TEST_NPM_CACHE=/tmp/dsh-app-npm-cache npm run test:live -- --native-child` exit 0，`evidence/live-result.json` 为 `PASS_NATIVE_CHILD_PARAMETER_CHAIN`。隔离目录 `/tmp/dsh-app-live-U7gRdF`，native parent `session-2c257d43-5b59-4743-9cc1-8f9c4739aee4`；A child `cb04bd53-abda-4ba8-8cbb-da1e53d78c5d`、B child `5a622436-6c25-480d-961d-9835bae63ae7`。两个 child 实际模型 gpt-5.6-luna、medium；A 两个完成报告、B 一个，分别输出 A/A 与 B。thread/turn 完整身份见 JSON。
- 该测试真实执行 DSH `startContinuable → Agent → request/header → provider → Codex`，销毁 A 的 Agent 后从 descriptor 冷恢复；没有销毁整个 backend/Host 进程，不代表 E5 进程冷恢复通过。A/B 是明确指令测试样本，不是 workflow profile 文件切换验收。
- 调试时修正测试读取 `assistant/message.data.message.content`；父会话可响应原生结算通知，native-child 模式验证其实际对应 Session 的 completed 报告，不复用基础 main-only 的精确 marker 条件；main-only 模式仍保留精确 marker。前一次 child 独立断言通过保存在 `evidence/e22-native-child-result.json`，整次失败状态不改写成通过。
- E2.3 已在 workflow 新增 `src/configuration.ts` 与 `test/configuration.test.mjs`：共用 DSH home 路径解析、严格 JSON 映射、普通文件扫描、诊断隔离、原子刷新和创建参数副本。`npm run build` exit 0，配置测试 2/2 exit 0，见 `evidence/e23-workflow-build.log` 与 `e23-configuration-tests.log`。尚未接入 Host/调度器；运行时角色仍来自旧路径，不声称已迁移。
- 下一步：workflow Session 选择、显式安装、原生 child 创建与控制/验收；DSH 文档及生成契约检查；其余 E3/E4/E5/E6 仍未完成。

E2.3 追加：workflow `WorkflowStore.selectedProfile/selectProfile` 已实现父原生 Session 独立选择、默认值首次初始化、持久化与写失败保持旧值；`installConfiguration` 仅显式调用，验证协议路径和全部冲突后独占创建默认文件，保护修改与自建文件。配置/安装/存储 6/6 测试通过，build exit 0。这些模块尚未接入运行时 Host，不能代替 profile UI 或 native child 验收。

DSH 文档门槛 `pnpm run test:docs` 修复类型示例漂移、语言切换与 Note Status 位置后最终 16 passed / 0 failed，exit 0（`evidence/e22-dsh-docs.log`）。本包新增 Host 只读 `ctx.codexExecution.read(nativeSessionId)`，状态与终态报告来自同一后端快照，未公开 backend 管理 API；用于 workflow 区分 DSH 等待结束与 Codex 实际执行停止。Host 卸载会撤销该服务，角色/profile 和报告验收仍归 workflow。build 与 51 项现有测试通过，专门的脱离存储副本断言正在补验。

E2.3 消费者切换进展：workflow `src/workers.ts` 已改用 `startContinuable`、原生 host prompt queue/steer 与 `subagents.interrupt`；`host.ts` 注入 `subagents/codexExecution`，`workflow.ts` 从 workflow 配置捕获角色，Python 导出不再将当前模型表冻结进 plan。旧 `dsh-codex-kit-backend` 运行依赖已移除，旧项目未修改。执行报告仍从本包迁入的 backend 读取；workflow 保存 child 配置来源、提交回执及验收，不复制执行状态和报告正文。

`evidence/e23-workflow-native-contract-tests.log`：6/6、exit 0（模拟原生服务，包含原有完整合同/验收/集成/释放及丢失响应恢复断言）；配置/原生消费者/存储聚焦 9/9、exit 0；Host/导出 2/2、exit 0。不是 workflow 真实模型或 profile UI 验收。现有安装/dev/headless 检查还需要按新包组合迁移。

测试迁移曾被自动审批拒绝直接覆盖，理由为保护用户修改；已确认既有测试相对 Git 无修改，将原文件保存于 `evidence/e23-original-tests/`，以 `git apply --check` 验证的补丁完成迁移，后续审批允许。补丁为 `e23-native-test-migration.patch` 和 `e23-host-test-migration.patch`。没有绕过审批或覆盖用户改动。

### E2.3 原生 profile 选择与复用核对（2026-09-13）

- workflow 同包 `./client` 使用原生 `conversation.session.header.utilities`、Session hook、locale 和 Connection RPC，增加 profile 选择、刷新及只读角色映射。Host `/workflow` 仅接受原生 Session ID 与 profile ID；沿用 Connection 身份校验，选择持久化归 workflow，没有替代原生聊天 UI。浏览器行为尚未验证。
- 客户端类型构建发现公开声明引用的 `dsh-client-store` / `dsh-api-session-controller` 未安装；加入开发依赖。首次 npm 安装因间接 peer 混入 rc.2 失败，随后复用 `scripts/dsh-baseline.json` 的 rc.1 overrides 并保留协调 tarball overrides，安装与 `npm run build` exit 0。没有采用 legacy-peer-deps 或手改 node_modules。
- `node --test --test-isolation=none test/profile-rpc.test.mjs test/host.test.mjs test/native-workers.test.mjs test/backend-consumer.test.mjs test/workflow.test.mjs test/configuration.test.mjs test/store.test.mjs`：exit 0，15/15，无 skipped/cancelled，见 `evidence/e23-integrated-tests.log`。这些是模拟原生服务验证，不是真实模型或浏览器验证；旧 headless/安装/dev 检查仍待迁移，未声称整个 workflow 测试集通过。
- DSH `pnpm run verify-doc-graphs` 与 `pnpm run verify-cordis-catalog` 均 exit 0，分别验证 6 个图文档、97 个生成文件/区域。前次 doc-sync 仅这两项失败，现已分别修复验证；最终协调产物仍需包含后续源码及目录变化。
- 对照当前旧 backend 源码的复用证据为 `evidence/backend-reuse-comparison.json`：store.ts、models.ts、skills.ts、conversation.ts 完全一致；rpc.ts 仅修改 clientInfo.name；backend.ts 当前差异为 48 行新增、25 行删除，集中于恢复故障、实际执行参数核对和只读报告快照。这里的行数仅记录对照结果，不代表独立验收。旧 kit 源码没有修改。

### E2.3 显式安装及真实 profile child（2026-09-13）

- workflow 新增 `npm run install:configuration -- --profile <name> [--dsh-home <home>] [--patch <path> ...]`，使用 DSH `loadProfileDirectory/composeEntries/loadOptionalPatches/loadOverlayPatches` 合成部署配置，与 Host 共用 `configurationDirectory`。没有启动 Host、自动创建部署、第二份安装路径配置或配置 RPC。命令当前要求相关路径和 enabled 状态为字面值；不执行 `!!js`。默认 implementationStandardDir 沿用既有兄弟 skill 路径。
- `prepare:local` 改为校验并 `npm ci` 安装锁文件中的协调 tarball，缺失产物在运行 npm 前失败，不再安装/构建或写入旧 kit。原脚本/测试保存于 `evidence/e23-original-scripts`；精确补丁为 `e23-prepare-local.patch`。
- `test/prepare-local.test.mjs test/install-configuration.test.mjs` exit 0，2/2，见 `evidence/e23-install-entry-tests.log`。原生 overlay 整体替换 config，测试按此语义提供完整安装配置；用户修改文件保留检查通过。
- `DSH_TEST_NPM_CACHE=/tmp/dsh-app-npm-cache npm run test:live -- --workflow-child` 真实执行 exit 0，`evidence/workflow-live-result.json` 为 PASS_WORKFLOW_NATIVE_CHILD_PROFILES。独立安装新 provider/workflow tarball 和七个协调 DSH 包，原主会话证据 `live-result.json` 保留。
- 隔离目录 `/tmp/dsh-app-live-I7yNhM`，parent `session-038daba1-7ed5-48cb-b8e1-3f7ff1a39ee0`；A `b968ae56-1727-4f71-841a-c96e93c6ecb9`、B `85a564e4-d564-4845-9e4d-0c5128853124`，实际均 gpt-5.6-luna，effort A=medium / B=high。删除 A profile 并修改 reviewer 指令后，A descriptor 冷恢复仍为原参数并输出 A；A/B 输出 A/A 与 B。请求头和执行记录均已断言。
- 该真实测试由隔离 Loader 测试插件调用实际 WorkflowConfiguration/WorkflowStore/WorkflowWorkers，经原生 DSH spawn 执行；验证原生 completed 不自动变成 workflow accepted，以及 workflow accept 不改写执行报告。完整 codex_workflow 任务合同/集成/释放仍只有模拟测试；整个 Host/backend 进程冷恢复、浏览器、旧 dev/watch/pack 检查迁移仍待实施。

### E3 外部执行事实与原生 Conversation 节点（2026-09-13）

- DSH `Session.append` 对非表面信息事件接受第三参数 `{ ignorable: true }`，沿用已有信封和持久化兼容规则，不引入新 Session 格式或动态事件名称注册。消息表面的 surface intent 仍必填；信息事件不会进入 deriveMessages。Session 聚焦 63/63，exit 0；Host 构建 exit 0。
- provider 记录精确 thread/turn/item 的 `codex/execution` 原始工具/plan 事实；backend 订阅携带已提交的 sequence，重放用原生日志去重。客户端注册 `conversation.chat.node`，复用迁入的 `createConversationProjector` 合并流式输出与完成项，同包呈现，不导入私有聊天组件。推理内容当前继续过滤；公开 reasoning summary 及完整中断呈现尚未补验。
- provider build、完整 52/52 回归及 pack exit 0；随后新增节点合并检查与信息事件检查 2/2，exit 0，见 `evidence/e3-provider-tests.log` / `e3-execution-event-tests.log`。未声称浏览器已通过。
- E3 协调包改用 `evidence/dsh-packages/e3-session/` 路径，解决同名 tarball 被 npm 复用旧类型声明的问题。版本仍明确为含本地 E2/E3 修改的 rc.1 源码构建；`scripts/dsh-coordinated.json` 记录来源，最终文档及生成目录变更还需进入最终协调集。
- 首次真实工具测试已保留为 `evidence/external-live-first-failure.json` / `.log`：实际每回合 Codex 执行多条命令，测试预设一条导致计数失败。改为逐 item 唯一性、目标命令结果存在与 DSH 零工具调用的断言，未重发旧 Session 任务。
- `DSH_TEST_NPM_CACHE=/tmp/dsh-app-npm-cache npm run test:live -- --external-events` 最终 exit 0，`evidence/external-live-result.json` 为 PASS_EXTERNAL_EXECUTION_EVENTS；独立目录 `/tmp/dsh-app-live-CpxUlI`，parent `session-bda81f28-1d4b-42ae-8de7-9b16cecd498b`。A/B 及 A 冷 Agent 恢复读取的信息事件均带 ignorable，实际命令输出存在，同一原生 item 仅一个完成项，DSH tool/call 为零。完整事件和 thread/turn 见 JSON；不是浏览器或整个进程恢复验收。
- 文档快检发现 Session 公共类型示例、Note 格式及先前生成图的双语行号漂移，已逐项修正并重跑；尚待结果。外部事件兼容说明保留为有效决策，与追加接口说明互链，没有归档/删除旧说明。E4 打开动作、显式 Session scope 及配置侧栏尚未实施。

### E4 原生打开与显式会话生命周期（2026-09-13，进行中）

- DSH `ui-subagent` 增加同步 bail 事件 `subagent/open`，携带确切 `SubagentAddress` 和 `originSessionId`；无消费者时原生 `sessions.openSubagent` 只调用一次。`catalogActions.openChild(address, 'main')` 显式绕过默认位置路由。聚焦 3/3、exit 0：`evidence/e4-open-action-tests.log`，源码精确补丁 `e4-open-action.patch`。
- DSH 框架 `SessionAreaProps.sessionId` 与原生 `SessionProvider` 支持显式绑定；省略时继承外层作用域，无法解析时显示 empty，绝不回退父会话。`session-provider.client.spec.tsx` 7/7、exit 0：`evidence/e4-explicit-scope-tests.log`。日志中的缺失 area renderer 异常是已有预期拒绝断言，最终无未处理错误。
- `ISessions.retainSubagent(address)` 验证原生目录地址、打开原生 Session 历史与 follow，按视图计数保留客户端 scope，返回幂等释放函数；不改变主区选择，不调用 Host interrupt。`sessions-service.client.spec.ts` 47/47、exit 0：`evidence/e4-view-lease-tests.log`。首次测试在 Cordis 测试宿主初始化前销毁 root 产生未处理错误，按已有测试的 readiness 模式修正后复跑；不以首次断言通过作为成功。
- 本包设置行改为 inject.hooks/settings 与框架 `useSettings`，不再将整个 SettingsScope 传入组件或自行建立外部订阅。build exit 0；client/settings 聚焦 3/3、exit 0：`evidence/e4-settings-build.log`、`e4-settings-tests.log`。
- 上节 E3 文档快检最终 16 passed / 0 failed / 0 skipped、exit 0：`evidence/e3-dsh-docs.log`。这不包含本次新增 E4 公共接口文档。
- 当前 E4 仅完成这些源码接缝与聚焦检查；协调客户端构建、公共接口文档、原生 Conversation 侧栏 tab 装配、配置路由以及浏览器均未完成。现有七包 tarball 不能代表这些新增客户端接口。

E4 范围修正（用户 2026-09-13 指示）：停止为本任务运行 DSH 全量回归或修复无关基线。此前 GUI 汇总 5330 passed / 1 failed / 1 skipped；唯一失败为现有 Linux 无桌面测试读取了 WSL2 内核事实。用于定位的 WSL fixture 修改已按精确反向补丁撤回，产品源码未因该问题修改。后续只运行本包、workflow 与必要新增接口的相关检查；构建协调包仍是实际调用链必需步骤。

原生挂载补丁在中断前已应用：`SlotSpec.reusable` 由原生 Conversation 所有者显式开放；消费者通过独立命名槽位的 `mount` 引用原生贡献，不重复声明或接管原生子槽位。引用绑定原声明生命周期，卸载消费者不删除来源。此前触发的聚焦 core 检查 29/29、exit 0（`e4-native-slot-mount-tests.log`），不再扩展测试 DSH 无关部分。Host/client 协调产物构建 exit 0；本包侧栏装配正在接入这些新产物。

workflow watch 已复用原子暂存构建/发布与执行源码变化暂停语义，改为 `--app-provider` / `DSH_CODEX_APP_PROVIDER_CHECKOUT`，暂存包含客户端配置和构建脚本。4/4 Node 子进程检查通过（`e23-watch-tests.log`），不是真实模型运行。dev 启动脚本的整体迁移仍待完成。

### E4 侧栏装配与协调打包补记（2026-09-13）

- `src/client/ChildConversation.tsx` 已通过显式 `SessionProvider` 渲染独立 `codex.child.conversation`，以公开 `mount: main.conversation` 复用原生 Conversation；没有复制聊天 UI 或导入其他插件私有组件。来源以 `reusable: true` 开放，挂载绑定来源声明 epoch，来源卸载后不会误接新声明。
- 客户端可选注入 sessions/sidebarRight/sidebarRightTabs，注册 codex-child resource tab，地址包含 parent/child/mode；原生 `subagent/open` 读取 settings snapshot，未 ready 或 origin 与当前主区不一致时不消费。显式主区按钮沿用 `sessions.openSubagent`。视图按 tab AbortSignal 保留，隐藏/切换不释放，关闭及插件卸载释放；注册和清理通过 slots.inject 的 generator disposer 归属。
- `evidence/e4-client-route-tests.log` 3/3、exit 0：本包模拟 ModuleLoader/服务调用检查，覆盖位置路由、过期父请求、原生 mount、视图幂等和卸载清理；不代表浏览器验收。
- DSH `pnpm run build:lib:host`、`pnpm run build:lib:client`、`pnpm run build:web` 已成功，分别见 `e4-dsh-host-build.log`、`e4-dsh-client-build.log`、`e4-web-build.log`。web 外壳静态包含 ui-slots，必须随协调集更新。本次仅修正打包脚本及清单中的 build 描述，不为元数据重复构建。
- `node scripts/pack-dsh.mjs e4-sidebar`、本包 `npm pack --ignore-scripts` 成功，见 `e4-coordinated-pack.log` / `e4-provider-pack.log`。实际 `scripts/dsh-coordinated.json` 为 14 包，含原七包、session-controller、ui-slots/ui-renderer/ui-conversation/ui-subagent、tool-cordis 和 web frontend；源码差异在 `evidence/dsh-source.patch`。版本是本地修改后的 rc.1，不是注册表原包。
- 新协调类型包与 ui-sidebar-right 开发依赖已安装；本包 build 成功，见 `e4-provider-install.log` / `e4-provider-build.log`。旧 kit 当前工作区干净；保留 DSH 与 workflow 的现有修改。
- `scripts/test-live.mjs --browser` 已实现隔离 Web bundle 安装及 dump-config，状态为 `PASS_ISOLATED_INSTALLATION` 时仅证明安装；它不启动 Web Host 或浏览器。补记时尚无本轮浏览器运行证据，正在执行隔离安装与浏览器准备。原生 mount 的双语契约及决策说明仍需补齐。

### E3/E4 真实浏览器首轮与消费者继续迁移（2026-09-13）

- 隔离 `node scripts/test-live.mjs --browser --native-child` exit 0，`browser-live-result.json` 为 PASS_ISOLATED_INSTALLATION，目录 `/tmp/dsh-app-live-lkvASx`。找到已有 Chromium 143.0.7499.4，沙箱启动 EPERM/SIGTRAP 后精准提权成功；没有下载浏览器。
- 真实官方 Web Host 已启动，Playwright 实际看到 New Session、workspace picker 和 Settings；首次尚未发送模型请求。设置行因本包 `React is not defined` 崩溃，原始错误和截图在 `browser-live-ui.log` / `browser-live-*.png`，不将页面能打开称为侧栏通过。
- 根因是 esbuild 没有显式读取 `tsconfig.client.json`，默认采用 Host 配置。已在本包及 workflow 的 `build-client.mjs` 指定客户端配置；本包打包检查新增实际调用 bundle 内 ExecutionNode 的 JSX，覆盖缺少全局 React 的运行环境。正在构建、重装并复验真实浏览器。
- 原生 mount 的 ui-slots/ui-conversation 双语 README 与 `2026-09-13-reusable-slot-mounts` 决策已补齐。三组 pairing write exit 0，见 `e4-mount-doc-pairing.log`；这是配对记录检查，尚不代表完整文档检查。
- 公开 reasoning summary 已沿用本机 Codex 0.154.0 生成协议实现：writer 仅保留摘要字段及 summaryTextDelta，拒绝原始 textDelta，完成项剔除 content；projector 使用原有逐 item 状态合并摘要分段。节点增加摘要标题及真实 interrupted 状态标签。`e3-summary-build.log` exit 0，聚焦 `e3-summary-tests.log` 11/11、exit 0（模拟事件和客户端调用）。首次测试缺 react-dom 的失败已保存 `e3-summary-first-failure.log`；修正测试直接读既有 React 元素，没有新增依赖。尚未完成所有取消/unknown 后迟到终态的节点呈现，不以状态标签代替完整生命周期验收。
- workflow `headless-files.mjs` / `pack-check.mjs` / `runtime-pack-check.mjs` 已迁移为 provider-only 和 provider+workflow 两种组合，支持同包 ./client，拒绝旧 kit 运行依赖。staging 构建及两次临时安装成功；初次运行时断言失败是夹具未登记 parent Session，真实身份校验拒绝正确。已修正夹具，原失败在 `e23-pack-check.log` / `e23-pack-runtime-diagnostic.log`；headless 聚焦 3/3 exit 0。完整 pack 重验仍待通过。
- workflow dev 改为 `--app-provider` / `DSH_CODEX_APP_PROVIDER_CHECKOUT`，owner/overlay helper 从旧 kit 原样迁入后只更新插件组合。统一 provider 的 lib 不进入 Host HMR；workflow lib 仍热更新。本包新增 watch 复用原子暂存发布，执行源码变化永久暂停本轮发布；client-only 构建可发布，同包客户端刷新后读取。dev/两类 watch 的 Node 子进程验证正在执行，旧 kit 未修改。

E2.3/dev 续记：`e23-dev-tests.log` 最终 exit 0，14 个 dev + 3 个 headless，共 17/17；`e4-provider-watch-tests.log` 提权后 4/4 exit 0，均为真实 Node 子进程，模拟 npm/build/watch/Host，不是真实模型。dev 读取配置复用 `loadProfileDirectory`，无需增加 CLI 开发依赖。此前 npm 安装因 EROFS 失败且提权被自动审批拒绝（将 npm 修改 node_modules 视为违反约束），随后通过复用现有 loader 消除该依赖需求；未绕过审批。HMR 夹具使用 update 代替 insert 的失败保留在 `e23-dev-hmr-first-failure.log`。

`e23-pack-check.log` 最终 exit 0，provider-only 与 provider+workflow 两种隔离包、安装及 Node/Cordis runtime 均通过；staging `/tmp/dsh-workflow-kit-pack-lpPofi` 保留。客户端校验为包内容/入口检查，浏览器另行验收。新的 `--workflow-contract` 使用独立证据前缀，允许显式选择此次 staging tarball；真实 codex_workflow 合同、候选、独立 reviewer、集成与释放正在运行，尚无通过结论。

### E4 首个真实侧栏闭环（2026-09-13）

- JSX 修复后本包 build exit 0；串行执行 bundle/外部事件检查 4/4、exit 0。首次错误地将 build 与读产物测试并发引起的失败保留在 `e4-jsx-build.log`，只接受构建结束后的串行结果。
- 新 tarball `/tmp/dsh-app-live-lkvASx/dsh-codex-app-provider-0.1.0.tgz` 正常安装成功；同一隔离 profile 的官方 Web Host 重启后实际浏览器设置行正常显示。`sidebar → main → reload → sidebar` 保存回读通过，没有 React/slot 崩溃。日志 `browser-live-final.log`，截图 `browser-live-settings-roundtrip.png`。
- 浏览器通过原生 workspace picker 选择 `/tmp/dsh-app-live-lkvASx/workspace` 并提交真实父输入。parent `session-b0cb690e-ce98-41de-ac90-06c3a5e86982`，A `5555f546-342c-4d5d-8335-b6e8ab2ba780`，B `bc562ea4-11fe-48a0-9f94-03837e254fb7`；真实 driver 为 PASS_EXTERNAL_EXECUTION_EVENTS。点击原生 `2 subagents → native role A`，原生 Conversation 在右侧 Codex tab 出现，主区保持父 Session。截图 `browser-live-child-sidebar-open.png` / `browser-live-child-sidebar-final.png`，父代理已实际查看首张截图。
- 这一步证明设置持久化、真实模型工具事实及侧栏装配；尚不覆盖父子同时输入/审批/Stop/分页或 Host 冷恢复。另有一个浏览器 404 响应待按具体资源判断影响，未因该响应扩展 DSH 全量回归。
- 完整流程测试首次 profile 漏配四个要求角色，在 dispatch T001 前置检查被拒绝（adopt 已完成、executions 为空），见隔离 `/tmp/dsh-app-live-SrFw3X/native-child-result.json`。测试配置已补齐七角色，不接管或重发该旧执行；后续使用新的隔离目录。

### E3/E5 合同交付、整进程恢复与终态呈现（2026-09-13）

- `workflow-contract-live-result.json` / `e5-workflow-contract.log`：真实隔离 `/tmp/dsh-app-live-LPleNC` 为 PASS_WORKFLOW_CONTRACT_DELIVERY，命令 exit 0。T001 只读任务及 T002 工作树修改任务均完成 dispatch、record-result、accept、integrate、release；T002 经独立 reviewer passed，三个真实执行 completed。使用 `/tmp/dsh-workflow-kit-pack-lpPofi` 两个 staging tarball；这不是后续终态 UI 修改的验收，也不代表所有故障分支通过。
- `browser-host-recovery-result.json` 为 PASS_HOST_COLD_RECOVERY：原 A/B 完成后，停止精确 Host 句柄 22608 并等待退出；只移除隔离 profile 的测试驱动，保留状态和 workspace，再启动官方 Host。A 沿用原 Session 与 thread `01a09990-7268-7381-995b-c794f4ae6698` 完成新 turn，角色指令及禁网执行边界保持。没有接管未确认停止的执行。
- 真实浏览器父子未发送草稿在关闭/重开侧栏后分别保留；Open in main area 仅带入 child 草稿。A 独立输入完成，parent/B 没有新增执行。截图及恢复事实见上述 JSON。实际工具完成事件有 DSH_TOOL_A/B，但浏览器 Trajectory/Calls 展开仍未显示该文本，继续按失败证据定位；不将事件存在等同于工具 UI 通过。
- 未完成 Codex item 根据真实 turn.state/session.uncertain 更新为 failed/interrupted/unknown；completed turn 缺少 item 完成事实时保留 unknown。原生 Stop 结束 DSH turn 后，状态型 Conversation definition 通过公开 turn data 将未完成项标为“已请求停止，执行终态待确认”，不虚构工具已停止。真实 item 终态优先。`e3-native-turn-end-build.log` exit 0、`e3-native-turn-end-tests.log` 34/34（模拟事件/服务与 bundle 调用），尚未安装到上述浏览器 profile。
- workflow dev 新增 profile 必须实际解析到所监视 provider checkout 的检查，防止监视源码却运行另一包。`e23-dev-binding-tests.log` 最新 15/15、exit 0，属于真实 Node 子进程夹具，不是真实模型。

E3 浏览器工具呈现复核：`browser-tool-ui.mjs` 实际点击 Chat 原生 Thought disclosure，再点击 Codex item 的 details summary。四个节点从 hidden-until-found/details closed 变为可见/open，显示命令、cwd、`DSH_TOOL_A.` 和 `Exit code: 0`，见 `browser-tool-ui-result.json` / `browser-live-tool-ui.png`。先前在 Trajectory/Calls 查找输出属于验收路径错误，不是产品缺陷；没有为此修改代码。唯一 404 为 `/open-in-app/icon/filemanager`，本任务不修复该图标路径。

最新本包完整测试 `node --test --test-isolation=none test/*.test.mjs`：沙箱 54/60、exit 1（RPC 两项、watch 四项子进程受限）；相同命令提权后 60/60、exit 0，见 `e5-provider-tests.log` / `e5-provider-tests-escalated.log`。最新候选打包 exit 0，`/tmp/dsh-app-e5-candidate/dsh-codex-app-provider-0.1.0.tgz`，见 `e5-provider-pack.log`。新候选的浏览器 Stop 检查仍待实际运行。

E5 打包续记：`e4-verified-pack.log` exit 0，最新协调清单为 14 包并记录 host/client/web 构建；`dsh-source.patch` 已刷新包含包文档。`e5-pack-check.log` exit 0，最新 staging `/tmp/dsh-workflow-kit-pack-yLO6jI` 的两种独立安装与 Cordis runtime 通过。workflow 全集初次 40/41（`e5-workflow-tests.log`），唯一 exports 测试仍断言旧版本不含客户端，已按 ./client/Web/optional peer 契约迁移，正在单项复验。

新版 Stop 首次浏览器脚本用精确名称 `Stop` 未命中按钮，实际原生 accessible name 为 `Stop generating`。命令自然 completed，不能记作中断通过；安装和失败截图保留 `browser-e5-install-host-result.json` / `browser-e5-child-stop.png`，正在用正确原生标签重验。另一个 workflow Web 隔离安装 `/tmp/dsh-app-live-ZLL7JJ` 为 PASS_ISOLATED_INSTALLATION（`browser-workflow-live-result.json`），此时仅安装/dump-config、尚未浏览器验证。`--browser --workflow-child` 使用独立证据前缀，避免覆盖 provider 浏览器证据。

workflow exports 契约迁移后单项 1/1、exit 0（`e5-workflow-exports-tests.log`）；其余 40 项在上述完整运行通过。没有重跑整套后声称新的统一 41/41 结果。产品源码和已验证 staging 包不受此测试断言修改影响。

E5 child Stop 真实闭环：新候选中 A 的 `sleep 20; printf DSH_STOP_SHOULD_NOT_COMPLETE` 进入 Running 后，实际点击 `Stop generating`。turn `01a099a5-01c6-76a3-9d84-c73bdd05dc28` 的 backend 终态 interrupted，命令无 completed/output，parent/B 没有新增执行。UI 保守显示 `Stop requested; execution outcome unconfirmed`，与原生 DSH abort 后无法持续确认外部 item 的语义一致。见 `browser-e5-install-host-result.json` correctedStopAttempt 和 `browser-e5-child-stop.png`；首次按钮未命中事实仍保留。随后审批检查误选 codex-aux 标题执行记录，不能将其 never/read-only 选项归给普通 Session；正在按确切原生 Session ID 复核。

E5 审批与 workflow UI 续记：按实际用户输入定位后的两个普通 Session 均执行 `printf DSH_APPROVAL_OK`，经 Codex autoApprovalReview 后 exit 0，未发出交互审批请求，见更新后的 `browser-approval-result.json`；这是自动审批事实，人工 Reject/Allow once 尚未验收。workflow 两个真实 Session 已完成 PROFILE_UI_READY，但 profile 读取/刷新返回 HTTP 405。安装的 Connection.handle 内部按调用作用域读取 webServer，真实 Cordis 禁止未声明注入的服务访问；workflow RPC 作用域漏了 webServer。已用 `e5-profile-rpc-dependency.patch` 将注入补为 connection/webServer，构建与实际浏览器复验进行中，不提前宣称修复通过。

人工审批续记：只在隔离 provider.command 使用 `codex-approval-wrapper.sh`，CLI 传原生 `approvals_reviewer=user` 与 `approval_policy=on-request`，未改用户全局配置或认证。真实 `item/commandExecution/requestApproval` 已出现；Allow once 后无副作用 printf 完成，exit 0。Reject 按确切 Session/requestId 复核后确认 command item declined、无输出、请求消失（`browser-approval-interactive-final.json`）。此前按任意最新记录/跨 Session DOM 定位的失败均保留，不混作产品通过证据。最后一个测试待审批 Session 仍在通过原生取消收敛，不能在它结束前宣称测试环境已清理。

workflow RPC 修复后的 build 与模拟 RPC 2/2 通过，但真实浏览器仍 405，见 `e5-workflow-rpc-browser.log`；因此 webServer 注入补充尚未解决完整问题。临时诊断已确认 tools/agents/sessions/subagents/codexExecution/connection/webServer 均 ready，正在检查实际路由表。诊断安装曾将隔离 workflow 回退到旧 tarball，已要求固定隔离 manifest 的新候选路径；配置解析失败的临时 fixture 不作为产品结论。

### 保存当前进度，停止扩展验证（2026-09-13，最新）

用户要求“保存当前进度，生成新的 prompt.md”，并强调“不要纠结于边角”。已停止开发、新验证及进一步诊断，生成根目录 `prompt.md` 供直接续接；保留所有产品实现、用户修改及失败证据。未部署、发布、推送或删除旧数据/项目。

- **真实且仍未解决的核心问题**：workflow profile 读取/刷新在真实浏览器中返回 HTTP 405，普通 /api 请求正常。前文将“缺少 webServer 注入”写为根因过早，应以本条纠正：补充注入后仍 405，根因未证实。诊断确认 workflow apply 进入、fiber state 2、await 成功；早期 connection:false 样本早于 ready，不能据此判断 scope/isolate 故障。ready 后稳定比较未完成，停止于此，不继续扩大探针或修改外层必需依赖。
- **已解决的真实问题**：provider/workflow 的客户端 JSX 构建采用错误 tsconfig，导致浏览器 React undefined；已显式指定 tsconfig.client.json，并完成串行构建、包调用与真实浏览器复验。
- **测试问题及未覆盖项单列**：错误的工具 UI 展开路径、Stop 按钮名称、跨 Session 审批定位、合同夹具漏角色、pack 夹具漏 parent、旧 exports 断言及沙箱子进程限制均已记录；不能将它们称为新产品缺陷。未完成附件、Queue/Steer、分页等广泛交互验收，不意味着它们已失败，也不应优先于 profile 405。
- 人工 Allow once 与 Reject 的真实结果已保存 `browser-approval-interactive-final.json`，Reject 为 item declined、无输出。最后遗留测试 Session `codex:session-accb254f-7ec9-49cb-b712-12e590c02463` 的原生 cancel 返回 session/not-found (not attached)，终态保持 unknown/unconfirmed；不接管、不重发、不删除。审批 Host 37446 已停止，见 `browser-approval-cleanup-result.json`。
- 图片尝试中，上传内部 UI 截图被自动审批拒绝，未执行上传模型请求；原拒绝保留 `browser-image-live-result.json`。安全替代使用无元数据的纯红 32×32 PNG `attachment-red.png`，在 workspace/session 定位阶段按用户指示停止，未确认上传、未发起模型请求。隔离 `/tmp/dsh-app-live-lR5NTz` 安装曾成功，但不是图片验收通过，也不是当前外部阻塞；最后 Host 93093 已停止。
- workflow 隔离 `/tmp/dsh-app-live-ZLL7JJ` 曾被手改 node_modules 用于临时诊断，违反本任务约束；现已通过正式 `/tmp/dsh-workflow-e5-rpc/dsh-workflow-kit-0.1.0.tgz` 恢复，无该手工 instrumentation。固定了新候选 manifest；临时诊断插件及日志保留在隔离目录，不属于产品。最后 Host 67446 已停止，exec cell 349 已终止，代理报告无遗留 Host。日志 `e5-workflow-host-diagnostic.log`；两个验证代理均已收尾，无旧测试需要等待。
- 保存时只读核对兄弟 Git 状态：旧 kit 干净；DSH 和 workflow 当前修改保留，未清理无关尾部空行。最新 DSH 协调清单仍为 e4-verified 的 14 个现有 DSH 包；另有 provider、workflow 各一个业务包。最新通过的本包全集仍为 60/60；workflow 仍准确记录全集 40/41 加修正后单项 1/1，不宣称重新跑过统一全集。

下一轮按 `prompt.md` 优先解决 workflow profile 405，再完成这条必要真实 UI 调用链。不要重新制定整体计划、重跑 DSH 全量回归，或继续围绕边角反复测试。

### 用户授权安装两个日常开发 profile（2026-09-13）

用户明确要求分别安装 `codex-dev`（仅 app-provider）和 `workflow-kit-dev`（app-provider + workflow）。已完成 `~/.dsh/profiles/` 下安装，均使用 DSH base/Web bundle 和 e4-verified 的 14 个本地协调包。provider/workflow 最新候选已从临时目录保存到 `evidence/dev-profile-packages/`，安装 manifest 引用这些稳定路径，不引用测试驱动或临时诊断插件。

原 `codex-dev` 是旧 dsh-subagents-codex 开发配置，整个目录完整移至 `/home/slepher/.dsh/backups/profiles/codex-dev-1789287335221` 后装入新 profile，旧数据及其他 profile 未删除。两者分别使用 `~/.dsh/state/<profile>/codex`；workflow 自有状态使用 `~/.dsh/state/workflow-kit-dev/workflow`。未指定 providerCwd，沿用启动工作目录；默认主模型 codex/gpt-5.6-luna。

显式调用 workflow 既有安装入口，安装七角色及 `workflow-default` 到 `~/.dsh/workflow-kit-dev`，无配置诊断错误。两个 profile 的 npm 安装、暂存装配、最终实际 `dsh --profile <name> --dump-config` 均 exit 0；证据 `dev-profiles-install-result.json`、`codex-dev-installed-config.log`、`workflow-kit-dev-installed-config.log`、`workflow-kit-dev-configuration-install.log`。未启动 Host 或模型请求；已知 workflow profile UI 405 仍未修复。启动分别为 `dsh --profile codex-dev`、`dsh --profile workflow-kit-dev`。

### workflow profile RPC 405 根因定位与修复（2026-09-13）

- **根因（已用真实 Cordis 组件复现，不再是假设）**：`Connection.rpc.handle` 的注册实现把路由的所有权写成 `owner = this.ctx`，即 Connection 服务自身 fiber 的 context。真实 Web 部署中 Connection row 只声明 `inject: [webRuntime]`（`packages/bundle/web-app/cordis.patch.yml`），其 fiber 解析不了 `webServer`，于是 `owner.webServer.register(route)` 抛 `cannot get property "webServer" without inject`；`installProfileRpc` 的注册回调整体失败，`/workflow` 前缀路由从未注册，浏览器请求落到 SPA fallback 得到 HTTP 405。上一轮把它写成“workflow 漏声明 webServer 注入”不成立：`connection/webServer` 补充注入后仍走同一条 Connection 所有权路径，因此仍 405。
- **证据分层**：`evidence/probe-405b/exact-repro.mjs`、`fix-candidate.mjs`、`owner-ident.mjs` 用真实 `HostConnectionService` 证明 `scope.webServer` 可解析，而 `connection.rpc.handle` 必抛；`owner-ident` 同时证明 RPC 的 `owner` 不是调用方 context。这些是模拟/真实 Cordis 组件结论，不含浏览器。
- **修复（落在 workflow，`src/profile-rpc.ts`）**：不再经 `connection.rpc.handle`，改为在 `ctx.inject(["connection","webServer"], scope)` 内用 `scope.effect(() => scope.webServer.register(...))` 直接注册 `/workflow` 前缀路由（与同进程 `webCtx.effect(() => webCtx.webServer.register(route))` 的既有正确写法一致），并在路由内复用 `connection.requestRejection` 与 `clientRequestSchema`/`serverResponseSchema`，保持原 Connection 信封与信任语义。路由随注入 fiber 卸载自动注销。
- **回归测试**：`test/profile-rpc.test.mjs` 用真实 Cordis + 真实 `HostConnectionService` 装配真实 fiber；把注册临时改回旧写法时 4/4 失败（`cannot get property "webServer" without inject`），修复后 4/4 通过。同文件覆盖挂载、信封/405/415/信任语义、冷 Session、异步校验顺序和卸载注销。`test/host.test.mjs` 断言随之更新为“路由经 WebServer 注册、Connection channel 为空、卸载后 routes=0”。workflow 全集 `e5-workflow-405-fix-tests.log` **43/43、exit 0**；构建 `e5-workflow-405-fix-build.log` exit 0；打包 `e5-workflow-405-fix-pack.log` exit 0。
- **真实 Node/HTTP 端到端**：`evidence/verify-workflow-route-live.mjs` 启动真实 `@deepseek-ai/dsh-host-webserver`（OS 分配端口）+ 真实 `HostConnectionService`，加载安装到 profile 的 workflow 包，用真实 `fetch` 打点。`e5-workflow-405-fixed-route.log` 为 `ok=true`：路由表含 `/workflow`，`POST /workflow/profiles` 200 且返回真实 profile 视图（`workflow-default`），冷 Session 200，缺失 Session 返回 `ok:false`，`GET /workflow/profiles` 404，卸载后路由清空。同一脚本对未修复的旧包 `e5-workflow-405-prefix-route.log` 与对未申明注入的调用方探针均为 `cannot get property "webServer" without inject`。
- **安装**：修复包已 `npm install --no-save` 进 `~/.dsh/profiles/workflow-kit-dev`（`e5-workflow-405-profile-install.log`）；安装件与当前源码重建产物 sha256 一致（`ba22232b…`），`node_modules/dsh-workflow-kit/lib/profile-rpc.js` 已含新注册。
- **真实浏览器验收（通过）**：用户重启 `dsh --profile workflow-kit-dev`（3080）后，`evidence/browser-workflow-profile-live.mjs` 用真实 Chromium 打开该 Host。原生 Session header 的 profile 选择器正常渲染（`workflow-default`），`/workflow/profiles`、`/workflow/reload-configuration`、`/workflow/select-profile` 以及重载后的再次 `/workflow/profiles` **全部 200**，无 `[role=alert]` 报错，重载页面后选择保持 `workflow-default`。日志 `e5-workflow-405-browser.log`、结构化结果 `browser-workflow-profile-live.json`。截图未取（活动会话持续重绘，截图等待稳定帧超时），不影响该结论；修复前同一条真实浏览器链路为 405（`e5-workflow-rpc-browser.log`）。

### E3 设置行与系统设置风格对齐（2026-09-13）

- **问题**：`settings.general.item` 的每一行由贡献方自己负责内边距与分隔线（ui-settings-general 只做列布局并去掉末尾分隔线），provider 原来的行是裸 `<label>` + 原生 `<select>`，与系统行的标题/说明/胶囊选择器风格不一致。
- **改动（provider 客户端）**：`SidebarSetting.tsx` 改为与原生行同构的 `.codex-setting-*` 结构：标题（14px）+ 说明（12px）文本列，右侧 36px 高、18px 圆角胶囊，胶囊内是视觉隐藏的原生 `<select>`（保留键盘/滚轮/无障碍语义）加 DSH 同款 chevron（`icons.tsx`，取自 ui-primitives 的 `IconChevronDownOutline14` 路径）。新说明文案 `description`（中英）已加入 `locales.ts`。
- **样式注入**：同包客户端由 esbuild 打包、没有 CSS 管线，也没有可被部署加载的独立 CSS 产物，因此在 `styles.ts` 首次渲染时注入一次 `<style data-plugin-css="dsh-codex-app-provider">`（沿用 DSH 构建的标签约定），几何与 token 逐条对齐原生行（`padding: 16px 0`、`gap: 8px`、`border-bottom: 0.5px solid var(--dsw-alias-border-l2)`、`--dsw-alias-bg-module-platform`/`--dsw-alias-interactive-bg-hover`）。headless（无 DOM）直接跳过注入。
- **验证**：`test/client-bundle.test.mjs` 新增打包断言（行几何、胶囊几何、结构类名、`aria-hidden` 值、select 的 `aria-label`/`aria-busy`、样式标签），与既有 loader 测试合计 2/2 通过；provider 全集 `e5-provider-tests-after-row.log` **61/61、exit 0**。真实浏览器 `evidence/browser-settings-row-compare.mjs` 在 3080 上把系统行与本行逐项比对：本行 `padding 16px 0`、`gap 8px`、胶囊 `36px / 18px`，与原生 `oY77xG_row`、`hVGvvW_row`、`pDMMbG_row` 完全一致；本行为该列最后一行，因此按 ui-settings-general 约定不画末尾分隔线（原生行显示 `1px solid`）。结构度量见 `browser-settings-row-live.json`。
- **范围**：只改本插件设置行的呈现与文案，不改 settings schema、默认值（仍为 `sidebar`）、写路径或打开位置行为。

#### 选择器改为原生 Menu 结构（2026-09-13，接用户反馈）

- **问题**：第一版把视觉隐藏的原生 `<select>` 套在胶囊里，胶囊外观对了，但**展开后的弹层仍是浏览器原生菜单**（系统蓝高亮、直角、无勾选），与系统 `Menu`（r20 卡片、hover 填充、选中项尾部勾）不一致。
- **改动**：`SidebarSetting.tsx` 换成真正的按钮 + 菜单：触发器是 `<button aria-haspopup="menu" aria-expanded>`，菜单用 `react-dom` 的 `createPortal` 挂到 `document.body`（设置面板有 `overflow: hidden/auto`，就地绝对定位会被裁切），定位为触发器下方 4px、右对齐；键盘支持 Escape/上下键/Enter，文档级 pointerdown 关闭；`role="menu"` + `role="menuitemradio"` + `aria-checked`。`icons.tsx` 增加同款勾选图标。
- **依赖**：`react-dom` 是 shell 的平台模块（`packages/client/web/src/platform.ts` 的 `PLATFORM_MODULES` 显式包含它），因此加入 `scripts/build-client.mjs` 的 external，`package.json` 的 peer/dev 也补齐；bundle 只留 `require("react-dom")`，不会带第二份 ReactDOM。本地 `node_modules/react-dom` 用符号链接指到相邻 checkout 的 18.3.1 以便类型检查，不改 lockfile。
- **验证**：`test/client-bundle.test.mjs` 断言改为菜单几何/结构（r20、4px 内边距、`--dsw-specific-menu`、`--dsw-elevation-prominent`、40px·r10 单元格、`role: "menu"`/`"menuitemradio"`、`aria-checked`，并断言旧的 `codex-setting-control` 已消失），2/2 通过；provider 全集 `e5-provider-tests-after-menu.log` **61/61、exit 0**。真实浏览器 `browser-settings-menu-live.mjs` 在 3080 打开胶囊后实测：卡片 `radius 20px`、`padding 4px`、`background rgb(53,54,56)`、elevation 描边阴影、`min-width 218px`；两项 `menuitemradio` 各 40px 高、10px 圆角，选中项 `aria-checked=true` 且带勾；菜单在触发器下方 4px、右边缘对齐（`ok=true`，见 `browser-settings-menu-live.json`）。
- **热更新实证**：此改动是纯客户端改动，**未重启 Host**。provider 候选写入 profile 后，运行中的 `dsh-client-hmr` 已把浏览器内的旧 bundle 换掉——同一浏览器实测 `.codex-setting-control`（原生 select）数量为 0、新样式标签存在，且 `/plugins/events` 的 SSE 正常输出 `graph` 帧。此前把"改客户端也要重启"当作结论是过宽的表述，已纠正。
- **落点说明**：写入 `~/.dsh/profiles/workflow-kit-dev` 的四次提权都是**部署动作**（`npm install --no-save` 把候选 tarball 装进该 profile 的 `node_modules`），不是插件在写 DSH_HOME：插件执行状态走 config `stateDir`，唯一偏好走 DSH 原生 settings（`<DSH_HOME>/settings.yaml`，由 `dsh-settings-file` 负责）。工作区内的 build/pack 从不触发审批。
