# 继续 dsh-codex-app-provider：修掉 workflow profile RPC 405（2026-09-13 续）

项目：`/home/slepher/project/agents/dsh/dsh-codex-app-provider`（provider），业务包 `../dsh-workflow-kit`（workflow）。

**这份 prompt 是为"新工作区"写的。** 上一轮 session 的 DSH 文件策略是 `workspace-write`，工作区只圈定了 app-provider 目录，导致无法写入兄弟仓库 `../dsh-workflow-kit`（连它的 `.git` 都只读）。请在**有兄弟仓库写权限**的新工作区继续；代码落点主要在 workflow，其次是 provider。

先读 `README.md`、`EXECUTION.md`；两份都要读，阶段记录比历史状态新。上一轮完整交接文档保留为 `prompt-2026-09-13-previous.md`（内含更早的架构决策、已通过验收项、证据清单）。以工作区文件为准，保留已有实现和用户修改，不重新制定整体计划。

## 1. 仓库状态（已提交，不要重做）

| 仓库 | HEAD | 状态 |
|---|---|---|
| `dsh-codex-app-provider` | `a617deeb0a29aaf66821a62f3225f1bea55a55e4` | 本轮新建仓库并首次提交；`git status` clean；`.gitignore` = `node_modules/ lib/ dist/ *.tgz evidence/ .dsh-state/ .watch/` |
| `dsh-workflow-kit` | `e6b5dda0c612227f86fa718e49c5bd46d1ed1da8` | 已提交 workflow profile 特性；`lib/` 已加入 `.gitignore` 并从索引移除（磁盘文件保留） |
| `dsh-codex-kit` | 未改动 | 工作区 clean |
| `deepseek-harness` | 用户原有约 103 项本地修改 | **不得提交、不得清理** |

- provider 仓按用户要求"干净"：evidence/（含 42 个协调包 tarball、截图、日志）**不入库**，只在磁盘保留。
- workflow 仓 lib/ 不再入库；改源码后必须 `npm run build` 才能被 profile 使用。
- 版本：Node 24.13.1、npm 11.8.0、Codex 0.154.0、DSH 0.1.5-rc.1（14 个本地协调包），协调清单 `scripts/dsh-coordinated.json`（阶段 `e4-verified`）。

## 2. 用户当前环境与最新要求

- 用户**正在**运行 `dsh --profile workflow-kit-dev`，URL `http://127.0.0.1:3080/?token=…`（就是当前 GUI）。该 Host 加载的是 `~/.dsh/profiles/workflow-kit-dev/node_modules/` 里的**已安装拷贝**，不是源码 checkout。
- 已确认：`node_modules/dsh-workflow-kit` 与 `node_modules/dsh-codex-app-provider` 都是真实目录（非 symlink），provider `lib/index.js`、workflow `lib/profile-rpc.js` 时间戳为 2026-09-13 16:14/16:15。
  **结论：直接改源码不会生效，必须把源码构建进 profile，或改用 dev Host。**
- 用户要求："利用 dsh 的热部署功能直接修改，插件都在开发中，并不会破坏什么东西。" 即：允许在本机开发 profile 上做真实热部署验证，不必新建隔离安装。
- 用户同时要求生成本文件，因为上一轮权限不足，需要在新工作区工作。

### 热部署的正确入口（已核实）

workflow 仓自带 dev 编排（`scripts/dev.mjs` + `scripts/dev-host.mjs`），只有它启用 HMR：

```bash
cd /home/slepher/project/agents/dsh/dsh-workflow-kit
npm run dev -- --profile workflow-kit-dev \
  --app-provider /home/slepher/project/agents/dsh/dsh-codex-app-provider
# 等价：DSH_CODEX_APP_PROVIDER_CHECKOUT=/home/slepher/project/agents/dsh/dsh-codex-app-provider
```

- 它会校验 profile manifest 的 bundle 顺序必须是 `dsh-codex-app-provider` → `dsh-workflow-kit`，用 `--app-provider` checkout 绑定身份与 owner/stateDir 语义。
- HMR `root` 只覆盖 workflow 自己的 `lib/`（`expectedRoots = [<workflow>/lib]`）；`ignored: **/node_modules`、`**/.*`，`debounce: 100`。
- provider 源码改动**不**进 Host HMR：provider `scripts/watch.mjs` 走原子暂存构建/发布，且"执行源码变动"（backend/provider 等 core）会永久暂停本轮发布。provider 的 client-only 改动能发布。
- 因此：**405 的修复在 workflow 侧最省事**（`src/profile-rpc.ts` 改完 build，dev Host 经 HMR 重载）。若要改 provider，预期要重装/重启，先确认再动手。

## 3. 当前唯一核心故障：`/workflow` 路由没有注册（HTTP 405）

### 现象（真实、已复现，不是测试脚本问题）

- workflow 的同包客户端在原生 Session header 渲染 profile 选择器成功，但 `POST /workflow/profiles` 与 `POST /workflow/reload-configuration` 返回 **HTTP 405、空响应**；同进程 `/api/*` 全部 200。
- 405 来自 Web 外壳的 SPA fallback（非 GET 到静态兜底），含义是：**`/workflow` 这个 prefix 路由根本没注册到 `webServer`**。

### 本轮新增的硬证据

隔离复现脚本（未使用、也未改动真实 profile；`DSH_HOME` 指向工作区内副本，端口 4512x）：

- `evidence/probe-405/probe.yml`、`probe-plugin.mjs`、`probe-host.log`、`probe-405.mjs`（纯 cordis 最小 harness）。
- `probe-405.mjs`（最小 harness）：把 workflow `apply` 挂到一个普通 plugin 上下文，inner `ctx.inject(["connection","webServer"], …)` **会触发**，`connection.rpc.handle("/workflow", …)` **会被调用**。→ cordis 的 inner-inject 机制与 product 写法本身没问题。
- 真实 profile 复现（`probe-host.log`）关键行：

```text
PROBE405 workflow ctx has inject=function connection=true webServer=true
PROBE405 A inner callback fired; connection=true webServer=true
PROBE405 A rpc.handle threw: cannot get property "webServer" without inject
PROBE405 A after 1200ms: state=ACTIVE uid=176 prefixes=["/plugins","/api","/open-in-app/icon"] effects=[] routesBefore=2
PROBE405 B pending fiber state check done; prefixes=["/plugins","/api","/open-in-app/icon"]
```

由此确认：

1. workflow entry fiber `state=ACTIVE`，`connection/webServer/sessions/tools/agents/subagents/codexExecution` 在 **workflow fiber 自己的 ctx** 上都可解析（`fiberCtx.get(...) !== undefined`）。
2. boot 完成后 `webServer.prefixes` 只有 `/plugins`、`/api`、`/open-in-app/icon`，**没有 `/workflow`**；`effects=[]` 说明没有留下 route 注册 effect。
3. 用 workflow fiber 的 context **复刻**同样的 `ctx.inject(["connection","webServer"], …)`：回调确实触发，但回调体内访问 **`scope.webServer` 抛错**：`cannot get property "webServer" without inject`（即该 inner fiber 的依赖解析里 `webServer` 找不到，而 `connection` 找得到）。
4. 上一轮把根因写成"workflow 包缺 `webServer` 注入声明"是**过早结论**，已被本条推翻；`e5-profile-rpc-dependency.patch` 那次修改（connection → connection/webServer）不解决 405。

### 待查的关键点（下一轮从这里开始，不要重跑 DSH 全量回归）

- 为什么同一个 `ctx.inject([...])` 里 `connection` 可解析而 `webServer` 在 inner fiber 上解析失败：沿 cordis 4.0.2 的 `Fiber._checkImpl` / `ReflectService._getImpl(name)` / `ctx[symbols.isolate][name]` / `fiber.store` 对照 `provide()` 注册路径，确认两处用的 isolate 符号是否一致（`webServer` 由 `@deepseek-ai/dsh-host-webserver` 的 `webserver` entry 提供，该 entry 声明 `inject: [webStartup]`；`connection` 由 `client-connection` entry 提供，声明 `inject: [webRuntime]`）。
- 参考同进程工作正常的样例：`@deepseek-ai/dsh-api-gateway` 的 `TypertGatewayService` 构造函数里同时做了 `ctx.inject(["connection"], …)` 与 `ctx.inject(["connection","webServer"], …)`，实机可用。对比它与 workflow 的差异（它是 Service 类、在 entry fiber 构造期注入；workflow 是 `apply(ctx)` 函数里注入）。
- 注意 cordis `getTraceable`/`symbols.shadow` 语义：非 noShadow 服务的方法会把 `this.ctx` 还原为**调用者** ctx；访问 `scope.webServer` 报错说明是 shadow ctx 的解析问题，而不是 `webServer` 根本不存在。
- 最小修复后，先跑 `probe-405.mjs` + 隔离 probe（秒级、可反复），再在 dev Host + 真实浏览器上做 profile 选择/刷新验收。
- 诊断口径要求：区分"模拟/真实 Node/真实模型/真实浏览器"各自证明了什么，不要把模拟结论写成浏览器通过。

### 复现命令（新工作区可直接复用）

```bash
# 1) 纯 cordis 最小 harness（证明 inner-inject 机制没问题）
cd /home/slepher/project/agents/dsh/dsh-codex-app-provider
node evidence/probe-405/probe-405.mjs

# 2) 真实 profile 隔离复现（副本 DSH_HOME，端口 45125，不碰真实 profile/状态）
rm -rf evidence/probe-405/state && mkdir -p evidence/probe-405/state
DSH_HOME="$PWD/evidence/probe-405/home" \
PROBE_STATE_DIR="$PWD/evidence/probe-405/state/codex" \
PROBE_WORKFLOW_STATE_DIR="$PWD/evidence/probe-405/state/workflow" \
dsh --profile workflow-kit-dev --patch evidence/probe-405/probe.yml --port 45125 --no-open \
  > evidence/probe-405/probe-host.log 2>&1
grep -a PROBE405 evidence/probe-405/probe-host.log
```

`evidence/probe-405/home/profiles/workflow-kit-dev/` 是真实 profile 的小副本（只复制了 4 个配置文件），`node_modules` 是 symlink 到真实 profile，`cordis.patch.yml` 里 stateDir 改成了 `!!js process.env.PROBE_*_DIR`。每次跑前清 `evidence/probe-405/state/`，否则会撞 `stateDir is already owned by pid`。

浏览器侧脚本（上一轮 405 现场，保留可用）：`evidence/browser-workflow-profile-ui-run.mjs`、`evidence/browser-workflow-profile-refresh.mjs`；相关日志 `e5-workflow-rpc-browser.log`、`e5-workflow-host-browser-response.log`、`e5-workflow-host-diagnostic.log`。

## 4. 约束（沿用，不扩大）

- 不部署、不发布、不推送、不删除旧数据/旧项目；不启动 DSH 全量 GUI 回归；不运行无关 DSH 测试。
- 不手改 `node_modules` 做产品结论；诊断期的临时 instrumentation 只能用于定位，且必须在结论里标明，不得据此修改产品；完成后用正式 build/安装恢复。
- 不读取/复制认证文件；不用宽泛 `pgrep`。
- 兄弟仓库写入用精确补丁 + `git apply --check`，按权限升级执行；用户已明确允许在开发 profile 上做真实热部署验证。
- 用户强调"不要纠结于边角"：审批/附件/Queue-Steer/分页等场景不优先，先修 405 这条核心调用链。
- 保留已通过的真实闭环证据（合同交付、Host 冷恢复、子会话 Stop、人工 Allow/Reject、工具 UI、设置持久化）；引用时保留其原始范围，不声称更多。

## 5. 交付与记录

- 修好后：更新 `EXECUTION.md`（新增阶段小节，明确模拟/真实 Node/真实模型/真实浏览器各自证明范围）、必要时更新 `README.md` 状态行。
- 证据放 `evidence/`，沿用现有命名风格（`e5-…`、`browser-…`、patch 文件）。
- 两个仓库各自提交；provider 的 `evidence/` 继续不入库。
- 未解决就如实标注"405 仍存在"和已排除的假设，不要把假设写成根因。

## 6. 快速索引

- provider 源码：`src/`（`index.ts` 入口、`provider.ts`、`context.ts`、`backend.ts`、`rpc.ts`、`store.ts`、`client/`）
- workflow 源码：`../dsh-workflow-kit/src/`（本次故障点 `profile-rpc.ts`；`host.ts` 的 `inject = ["tools","agents","sessions","subagents","codexExecution"]`）
- 已安装 profile：`~/.dsh/profiles/workflow-kit-dev/`（另有 `~/.dsh/profiles/codex-dev/`）；状态目录 `~/.dsh/state/<profile>/…`
- 启动：`npm run dev -- --profile workflow-kit-dev --app-provider <provider-checkout>`（热部署）；或 `dsh --profile workflow-kit-dev`（无 HMR，加载安装拷贝）
- 既有诊断 patch：`evidence/e5-profile-rpc-dependency.patch`（未被证实有效，勿当作修复）
- 既有 405 记录：`evidence/e5-workflow-host-diagnostic.log`、`e5-workflow-rpc-browser.log`
