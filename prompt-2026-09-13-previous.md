# 继续 dsh-codex-app-provider（2026-09-13 保存）

项目：`/home/slepher/project/agents/dsh/dsh-codex-app-provider`。
先完整阅读 README.md、EXECUTION.md；阶段追加记录比前面的历史状态新。以工作区文件为准，保留本包和兄弟仓库已有实现及用户修改，不重新制定整体计划。

## 用户最新要求与当前判断

用户要求保存进度、生成本文件，并强调“不要纠结于边角”。本轮已停止扩展验证。下一轮优先解决 workflow profile UI 的实际 HTTP 405，这是当前明确未解决的核心集成问题；不要继续堆叠审批、附件或其他边角场景来代替解决主问题。

核心执行功能已实现并有真实调用证据，但不能称全部产品验收完成。真实浏览器曾发现 JSX 构建配置导致 `React is not defined`，现已修复；当前 workflow profile RPC 405 仍未解决。其余多次失败是测试定位、配置夹具或沙箱限制，不能统称产品缺陷。

## 架构及范围

- provider 为一个 npm 包、一个 Host 插件入口、同包 `./client`；复用旧 kit 的 backend/provider/context，不另建执行引擎，不依赖旧 backend 插件。
- `../dsh-workflow-kit` 是另一个业务包，已修改：负责 role/profile、配置选择、合同、提交及独立验收。它不计入“14 个协调包”。当前组合为 provider 1 包 + workflow 1 包 + 14 个现有 DSH 包的本地协调构建。
- 14 包是 DSH 执行参数、原生 Session/侧栏公开接缝、工具目录和 Web 外壳需要一起安装的产物，不是新拆出的 14 个 provider 模块。`scripts/dsh-coordinated.json` 为准，最新阶段 `e4-verified`；版本仍是含本地修改的 rc.1。Web 静态嵌入 ui-slots，之前已实际完成 host/client/web 构建，无需为元数据重复构建。
- 原生 Session、子代理、Conversation、输入、审批和侧栏必须复用；不复制聊天 UI，不导入其他插件私有组件。子代理位置使用原生 settings namespace，默认 sidebar，可选 main。
- 保留 Codex 原生执行/权限/审批/幂等/恢复语义；不能证明旧执行停止时，不接管或重发。
- 不部署、不发布、不推送、不删除旧数据/旧项目。只验证本包、workflow 和必要 DSH 接口；不运行 DSH 全量 GUI，不修复无关 WSL/Linux 基线。
- 不手改 node_modules，不读取/复制认证文件，不用宽泛 pgrep。兄弟仓库写入需精确补丁、`git apply --check` 后按权限升级应用。用户明确允许必要验证使用 evidence_runner；不要另行启动无关子代理。

## 已完成及证据（均在 evidence/，除明确标注临时目录）

- 原生 child 参数、profile 快照：`live-result.json`、`workflow-live-result.json`；真实 A=medium、B=high，删除配置/修改角色后 A 冷 Agent 恢复沿用快照。
- 原生外部工具事件：`external-live-result.json`；按 thread/turn/item/sequence 去重，DSH tool/call 为零。
- E3 公开 reasoning summary 已实现，仅保留公开摘要，过滤 raw reasoning；真实终态优先，未确认工具终态显示 unknown/Stop requested。`e3-native-turn-end-tests.log` 为模拟事件/服务及 bundle 34/34，不是所有摘要场景的真实模型证明。
- E4 公开 reusable slot mount、显式 SessionProvider、原生视图 retain、sidebar tab 已实现。必要双语 README/架构决策已补，`e4-mount-docs.patch`、`e4-mount-doc-pairing.log`。此前接口聚焦检查已通过，不扩大 DSH 测试。
- 实际浏览器设置 sidebar/main 持久化、原生 child tab、父子草稿隔离及关闭重开、Open in main、独立输入通过：`browser-live-final.log`、相关 browser-live 截图。
- 实际工具 UI：`browser-tool-ui-result.json`、`browser-live-tool-ui.png`。要在 Chat 展开 Thought 和 item details；之前在 Trajectory/Calls 找输出是测试路径错误。
- 整个 Host 冷恢复：`browser-host-recovery-result.json` 为 PASS_HOST_COLD_RECOVERY，沿用原 Session/thread 和角色/权限边界。仅对已确认结束的旧执行恢复。
- 实际 child Stop：`browser-e5-install-host-result.json` 的 correctedStopAttempt、`browser-e5-child-stop-result.json`，backend turn interrupted，未虚构未完成 command 的终态。按钮名是 `Stop generating`，首次用 `Stop` 未命中是脚本问题。
- 人工 Allow once/Reject：`browser-approval-interactive-final.json`、`browser-approval-reject-force-result.json`。仅隔离命令 wrapper 使用原生 `approvals_reviewer=user`；Allow 后 printf exit 0，Reject 后 item declined、无输出。自动审批结果单列 `browser-approval-result.json`。
- 真实 workflow 完整成功路径：`workflow-contract-live-result.json` 为 PASS_WORKFLOW_CONTRACT_DELIVERY，`e5-workflow-contract.log`，隔离 `/tmp/dsh-app-live-LPleNC`。T001 只读及 T002 工作树修改任务经过 adopt/dispatch/record-result/accept/integrate/release，T002 独立 reviewer passed，三个真实执行 completed。并非所有故障分支验收。
- workflow prepare/install/dev/watch/headless/pack 已迁移到新 provider；本包新增原子 watch，执行源码变动暂停本轮发布。dev 使用实际 provider checkout 绑定，保留原有 owner/overlay/进程身份语义，不为 provider 执行源码启用 Host HMR。

## 最新检查与候选

- 本包完整：`e5-provider-tests-escalated.log` 60/60、exit 0。沙箱首次 54/60 的失败日志保留，原因是 RPC/watch 子进程限制。无需无变化再跑全集。
- workflow 完整首次 `e5-workflow-tests.log` 为 40/41；唯一 exports 旧断言已迁移，`e5-workflow-exports-tests.log` 单项 1/1。不能声称有新的统一 41/41 运行。
- workflow dev 最新 15/15：`e23-dev-binding-tests.log`；两套 watch 各 4/4，均真实 Node 子进程夹具，不是真实模型。
- `e4-verified-pack.log`：14 个协调包打包成功。源码差异为 `evidence/dsh-source.patch`。
- `e5-pack-check.log`：provider-only 与 provider+workflow 两套独立安装/Cordis runtime 通过，staging `/tmp/dsh-workflow-kit-pack-yLO6jI`。
- provider 最新候选 `/tmp/dsh-app-e5-candidate/dsh-codex-app-provider-0.1.0.tgz`。
- workflow 后续补充 RPC webServer 注入的候选 `/tmp/dsh-workflow-e5-rpc/dsh-workflow-kit-0.1.0.tgz`；build、模拟 profile-rpc 2/2、pack 通过，但真实浏览器仍 405。上述 pack-check staging 早于这一注入补充。

## 当前唯一明确待解决的核心集成故障

隔离 `/tmp/dsh-app-live-ZLL7JJ`，官方 Web Host + 新 provider/workflow。两个真实原生 Session 已完成 PROFILE_UI_READY，profile 控件能渲染，但 POST `/workflow/profiles` 和 `/workflow/reload-configuration` 返回 HTTP 405、空响应，无法完成 UI profile 选择/刷新验收。

已保留 `e5-workflow-rpc-browser.log` 和临时目录中的 `browser-workflow-profile-ui-run.mjs`、`browser-workflow-profile-refresh.mjs`、`workflow-service-events.jsonl`。`../dsh-workflow-kit/src/profile-rpc.ts` 的内部注入已从 connection 改成 connection/webServer（`e5-profile-rpc-dependency.patch`），尚未解决 405。不要把这一假设写成已证实根因。

已观察到 tools/agents/sessions/subagents/codexExecution/connection/webServer 都 ready；诊断路由表未见 /workflow。早期 workflow ctx.get(connection) 为空的样本发生在 connection ready 前，不能据此证明隔离作用域有错。Connection.rpc 是 getter，每次返回新对象；给单次对象 handle 打补丁无法证明注册是否调用。不要继续基于无效探针改产品。

诊断过程中隔离安装曾回退到旧 tarball，后固定 manifest 到新候选；也曾违反约束手改隔离 node_modules 作诊断，已通过正式 tarball 安装恢复。临时诊断插件位于该隔离目录，不属于产品。下一步从真实失败链确定根因并作最小修复，保留 headless 可用，不能把 Web 服务变成外层必需注入。

## 收尾及待验证项

- workflow 诊断 Host 67446 已停止，诊断 exec cell 349 已终止；代理确认没有它遗留的 Host。最新结论及日志 `e5-workflow-host-diagnostic.log`：workflow apply 已进入、fiber state 2、await 成功；稳定的 ready 后 context/isolate 比较未完成，不作为根因。两个验证代理均已收尾，不要继续等待旧验证。
- `/tmp/dsh-app-live-lkvASx` 审批测试 Host 37446 已停止。一个旧测试 Session `codex:session-accb254f-7ec9-49cb-b712-12e590c02463`，request `19ba2308-1dbd-4fbc-8dea-e9d0f18b0e40`，原生 cancel 返回 session/not-found (not attached)，终态仍 unknown/unconfirmed。保留状态，不重发/接管/删除；详见 `browser-approval-cleanup-result.json`。
- 图片验证未完成。原 UI 截图上传被自动审批拒绝，未执行模型请求，见 `browser-image-live-result.json`；之后改用无元数据纯红 32×32 PNG `evidence/attachment-red.png`。安全替代尝试在 workspace/session 定位阶段被用户停止，未确认上传、未发起模型请求；Host 93093 已停止。隔离目录 `/tmp/dsh-app-live-lR5NTz` 保留。不要将附件记为产品失败或外部阻塞，也不要优先继续该边角。
- Queue/Steer、分页、one-shot/父不可用等更广交互尚未全面验收；不因此扩展本轮范围。
- 旧 kit 最后 `git status --short` 为空。DSH 原有五文件修改仍保留：session-controller commands.ts/types.ts/agent.host.spec.ts/session-models.host.spec.ts，以及 tool-cordis api-catalog.ts 的 persistDefault/liveOnly。DSH 原 HEAD `183f08e9c6dde7e36cd2318eaee70b0da08fb35e`；workflow 原 HEAD `ab8b10e55b85bdf7957ba88a7500abc7ea659e14`。workflow src/host.ts 尾部空行提示不要扩大清理。
- Node 24.13.1、npm 11.8.0、Codex 0.154.0；npm cache `/tmp/dsh-app-npm-cache`。Playwright 使用兄弟 inspector 已装版本，浏览器使用 `/home/slepher/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome`，无需下载或添加产品依赖。
- `scripts/test-live.mjs --browser` 只做隔离安装/dump-config，不启动服务/浏览器。可用 `DSH_PROVIDER_TEST_TARBALL`、`DSH_WORKFLOW_TEST_TARBALL` 指定候选，`DSH_LIVE_EVIDENCE_PREFIX` 避免覆盖证据；PASS_ISOLATED_INSTALLATION 不能当浏览器通过。

本轮按用户要求暂停开发和新验证，仅保存文档与已获得的证据。下一轮完成阶段后更新 EXECUTION.md，明确模拟、真实 Node、真实模型和真实浏览器各自证明的范围。

## 保存后用户追加：已安装日常开发 profiles

用户随后明确授权安装，现 `~/.dsh/profiles/codex-dev` 为 app-provider + Web，`~/.dsh/profiles/workflow-kit-dev` 为 app-provider + workflow + Web。均使用最新候选和 14 协调包；候选持久保存于本项目 `evidence/dev-profile-packages/`。原 codex-dev 全目录备份至 `~/.dsh/backups/profiles/codex-dev-1789287335221`，旧数据/其他 profile 保留。各 profile 使用 `~/.dsh/state/<profile>/codex` 独立 provider 状态，workflow 另有 workflow 状态子目录；providerCwd 沿用启动目录。默认主模型为 gpt-5.6-luna。

七角色及 workflow-default 已显式安装至 `~/.dsh/workflow-kit-dev`。npm 安装和最终 `dsh --profile <name> --dump-config` 均成功，未启动 Host/模型。证据 `evidence/dev-profiles-install-result.json`。启动命令 `dsh --profile codex-dev` 或 `dsh --profile workflow-kit-dev`。已知 workflow profile UI 405 仍在，不能把安装成功写成该问题已解决。
