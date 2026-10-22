# dsh-codex-app-provider

[English](README.md) | [中文](README.zh-CN.md)

Run the Codex CLI App Server as a native DSH model route, with its own executions recorded in the DSH Session log.

`dsh-codex-app-provider` is a single DSH Host plugin. It registers the `codex-app` LLM adapter, carries Codex's own approvals and questions into the DSH conversation surfaces, persists what Codex executed into the DSH Session log, and publishes the Host capabilities that describe a Codex thread. It ships no browser UI: child-session panels belong to `dsh-subagent-ui-sidepanel`, and role/profile policy belongs to `dsh-workflow-kit`.

- [What it provides](#what-it-provides)
- [Requirements](#requirements)
- [Install](#install)
- [Configuration](#configuration)
- [Using Codex as a model route](#using-codex-as-a-model-route)
- [Delegation](#delegation)
- [Host capabilities](#host-capabilities)
- [Workflow session gate and the PreToolUse hook](#workflow-session-gate-and-the-pretooluse-hook)
- [Compatibility](#compatibility)
- [Development](#development)
- [Repository layout](#repository-layout)
- [Known limitations](#known-limitations)
- [License](#license)
- [Related repositories](#related-repositories)

## What it provides

```
DSH native Session / native child Agent
  → LLM route: codex-app
  → dsh-codex-app-provider (Host plugin)
    → provider adapter (models, requests, events, approvals, questions)
    → internal backend (App Server RPC, thread/turn state, store, recovery)
  → codex app-server --stdio (thread / turn / item)
  → native events mapped back onto the DSH Session
```

| Surface | What it is |
|---|---|
| `codex-app` LLM adapter | The installed Codex runtime as a DSH provider: model catalog, request conversion, streamed events, token usage, cancellation. |
| Context filter | Removes DSH-injected context (system/developer messages, runtime context, skill catalog, already-imported execution facts) from requests sent to Codex. |
| Delegation | Owned by DSH core: `ctx.subagents` continuable children, with `dsh-workflow-kit` owning roles and acceptance. This plugin carries their execution when they run on the `codex-app` route. |
| Approval / question bridge | Codex keeps its own permission judgment; its approval and question requests are forwarded to `ctx.approval` and `ctx.userQuestions`, and decline fail-closed when no answerer is composed. |
| Execution facts | Codex executes its own tools, so the DSH log would otherwise be blind to it. Each executed step is committed to the Session as a sourced `user/message` event, idempotently. |
| `ctx.codexExecution` | Read-only native execution facts for trusted Host consumers; performs no resume and no model request. |
| `ctx.codexHandoff` | Trusted-Host handover of one Codex thread from a source Session to a reserved successor Session. |
| `ctx.codexToolGate` | The workflow session-gate bridge: a Host handler plus a Codex PreToolUse hook transport. |

The plugin applies no role, profile or permission policy of its own. It owns execution: one Codex adapter, one backend, one state directory per deployment.

## Requirements

- Node.js >= 22.19.0.
- A Codex CLI that provides `app-server` (the plugin spawns `<command> app-server --stdio`). `command` is blank by default, which auto-detects the CLI on this system: `codex`/`codex.exe` on `PATH`, or the JavaScript entry an npm `.cmd`/`.bat` shim launches (run with Node). Set `command` only to override detection.
- A DSH release listed in `dsh.compatibility.dshReleases` (see [Compatibility](#compatibility)).
- For gated Sessions only: the Codex PreToolUse hook transport uses a Unix domain socket, so hook IPC is Linux/macOS. Everything else works where DSH works.

## Install

Build and pack the plugin:

```bash
npm ci
npm run build          # tsc -> lib/
npm test               # unit and integration tests
npm pack               # dsh-codex-app-provider-<version>.tgz
```

Install the tarball into a DSH profile and add the plugin to that profile's bundle list (keep the bundles the profile already loads — `@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-web-app` below are the Web profile's):

```jsonc
// <profile>/package.json
{
  "name": "dsh-profile-codex",
  "private": true,
  "dependencies": {
    "dsh-codex-app-provider": "file:/absolute/path/dsh-codex-app-provider-0.2.1.tgz"
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

Add one entry to the profile's `cordis.patch.yml`. A deployment loads exactly one Codex plugin; do not also load a legacy Codex backend or host plugin:

```yaml
- id: dsh-codex-app-provider
  config:
    stateDir: /absolute/state/dir/codex
```

`cordis.patch.yml` in this repository declares the same entry name, so a bundle that carries the plugin needs no extra id.

## Configuration

| Key | Type | Default | Meaning |
|---|---|---|---|
| `stateDir` | string (absolute) | `<DSH_HOME>/state/<profile>/codex` | Where the plugin keeps its own records. A boot without a launcher profile falls back to `$DSH_HOME` (then `~/.dsh`) under the `default` profile name, never to the process's current directory. |
| `command` | string | auto-detect | Executable run as the App Server (`<command> app-server --stdio`). Blank searches this system's `PATH` for a spawnable Codex; a Windows npm shim prefers the native `codex.exe` its package ships (hidden window, faster start) and only falls back to the JavaScript entry when no native binary exists. Set it only to override detection. |
| `requestTimeoutMs` | integer, 1–2147483647 | `30000` | Per-request App Server timeout. |
| `providerCwd` | string | the directory DSH was launched in | Working directory for model settings, and the fallback working directory for a Codex thread whose Session records none. |
| `allowMainSession` | boolean | `false` | Whether a top-level Session may select and use this route. When `false`, the route is hidden from the model menu and refused for main-Session streams, and only managed workflow children run here. |
| `toolBridge.enabled` | boolean | `false` | Expose allow-listed DSH tools to Codex as native dynamic tools and execute their callbacks through DSH's tool pipeline. The declaration is frozen on a new thread, so enabling or changing it needs a new DSH Session. |
| `toolBridge.allow` | string[] | `cordis_inspect_list`, `cordis_inspect_query`, `plugin_manager`, `plugin_market`, `skill`, `read` | Exposure ceiling. The shipped set is `allow` ∩ the tools the main request presented ∩ the scoped `ctx.tools.schemas(agent)`; it never grants permission by itself. |

The editable fields above (`command`, `allowMainSession`, `toolBridge.*`) are
live: the package ships a browser half that registers the configuration surfaces,
so they can be changed from **Settings → Codex app** (or the plugin's Configure
page) without editing the profile patch. The same page shows a **Check now**
button: the Host resolves the executable, runs its `--version`, reads the App
Server's model catalog and caches the answer; reopening the page reuses that
cached answer, and only the button re-runs detection. Writes go to the Loader entry
config; a new App Server runtime picks up `command`, and the main-session gate
and bridge settings are read per decision. `stateDir`, `providerCwd` and
`requestTimeoutMs` stay deployment inputs and need a plugin reload.

Persistence layout under `stateDir`:

- `sessions/<encoded-session-id>.json` — one record per Codex-backed Session: thread/turn identity, execution cwd, last confirmed model/effort, projected facts, reports and gate binding. Written atomically, mode `0600`.
- `owner.lock/owner.json` — single-owner lock. A state directory must not be opened by two providers at once.

## Using Codex as a model route

- The plugin registers the provider id `codex-app`. Select it per Session in DSH as usual; the main Session may switch model and effort freely, while a child created with fixed execution inputs keeps them.
- The model catalog is read from the installed Codex runtime (`config/read` plus a paged `model/list`, cached for 30 seconds), so the models and reasoning efforts you can pick are exactly what that Codex build advertises. There is no model list in this repository.
- Images and mentions travel with the request when the Codex model advertises the input modality.
- Approval requests raised by Codex are forwarded to the DSH approval surface (`allowed-once` → accept, `cancelled` → cancel, everything else including no answerer → decline). Structured questions go to `ctx.userQuestions`. Missing services fail closed; the plugin never fabricates consent.
- The DSH Session log shows what Codex executed: each item becomes a sourced `dsh-codex-app-provider` message whose identity is derived from `threadId`/`turnId`/`itemId`, so replay or cold recovery cannot import the same command twice.
- Conversation history and compaction checkpoints stay DSH-owned; when a DSH history is replayed into a Codex thread, the imported range is marked (`[DSH history import`) so it is not fed back to Codex again.

## Main-Session gate and the native tool bridge

`allowMainSession` defaults to `false`, which reserves the route for managed
workflow children — requests that carry native execution inputs. In that mode:

- the model catalog reports no models, so the composer menu and `modelAvailable`
  stop offering the route;
- a top-level `stream()` fails with `MAIN_SESSION_DISABLED`; title/summary calls
  return without starting a process, and a main-Session `/compact` is refused;
- the plugin still publishes `ctx.codexExecution.catalog()`, so
  `dsh-workflow-kit`'s settings page can offer `codex-app` models for child
  roles that the composer menu hides;
- disabling the route retires a saved global default and open Session
  selections onto another advertised route, so the UI does not stall on
  "Select model".

`toolBridge.enabled` exposes selected DSH tools to Codex as native dynamic
tools. Codex calls them back through `item/tool/call`; the provider binds each
call to the live Agent and executes it with `ctx.tools.execute`, so DSH scoped
policy, guards, approvals and cancellation apply unchanged. Every call is
recorded in the DSH Session log as a sourced `user/message`
(`codex-bridge:<thread>:<turn>:<call>`) before Codex is answered; that identity
is filtered from the history sent back to Codex, so a replay is never presented
as a new instruction. The first version carries text results only, does not
cover PTC presentation, and needs no MCP server, port or second approval store.
The declaration is written only on `thread/start` — a new or changed selection
is refused on an existing thread, because the protocol has no field for adding
tools to a resumed thread.

## Delegation

This plugin is a model route and a native execution base, not a second delegation
system. Earlier releases also shipped a `codex_workers` tool with its own worker
registry, report ledger and acceptance workflow; that surface duplicated the
core `ctx.subagents` lifecycle, so it was removed. Delegation now happens
through the core:

- one-shot and continuable children: the `subagent` / `subagent_fork` tools
  (`ctx.subagents.startActivation`), with a message/interrupt/list control
  surface for the continuable ones;
- a child that runs on the `codex-app` route: name the provider in the child's
  `agentOptions`, and its per-turn execution facts, usage and reports stay
  readable through `ctx.codexExecution.read(childSessionId)`.

Which concrete control tools exist depends on the composition — in a profile
that also loads Agent Teams, the names `send_message`, `list_agents` and
`interrupt_agent` belong to the Team surface, not to the subagent provider.

Accepted differences from the removed tool (the comparison is recorded in
`REVIEW.zh-CN.md` appendix A):

| Removed capability | Replacement | Difference to accept |
|---|---|---|
| `create`, `append`, `resume`, `close` | continuable children via `ctx.subagents` | the child is a DSH Session, not a bare native thread |
| `steer` addressed by `turnId` | continuation addressed by child session | no per-turn addressing |
| `interrupt(workerId, turnId)` | the child-session interrupt | child-session scope; a settled target is a silent no-op |
| `list` / `get` / `reports` | the child-session projection | reports activity, not a worker record with its own ack state |
| `ack` / `accept` | `dsh-workflow-kit` | acceptance is workflow business, not a model route |
| the worker registry and its store branch | this plugin's own Session record | a Codex thread's identity, usage and reports stay in that record |

Nothing the model route needs was dropped: what went away is a parallel
lifecycle with its own identity, delivery and acceptance semantics.

## Host capabilities

These are Cordis services the Host publishes for other trusted plugins. They are not model-facing.

| Service | Members | Purpose |
|---|---|---|
| `ctx.codexExecution` | `read(nativeSessionId)`, `facts?(nativeSessionId)` | Read-only execution facts: state, cwd, confirmed model/effort, pending configuration, reports, usage. No resume, no model request. `facts` returns already-executed history lines for continuing an assignment under another provider. |
| `ctx.codexHandoff` | `handoff(request)`, `read(sessionId)` | Continue one assignment on a successor Session with the same Codex thread. Keyed by `requestId`, so a repeated request reuses its recorded handover. The source record is de-authorized; the successor owns the thread. `read` reports thread ownership (`threadId`, `handedOffTo`, `handoffFrom`). |
| `ctx.codexToolGate` | `register(hook, handler)`, `bind(sessionId, binding)` | The session-gate bridge described below. The workflow Host owns the one handler and its policy; the provider only carries bindings and hook calls. |

## Workflow session gate and the PreToolUse hook

The plugin carries the workflow session gate; it makes no gate decisions. `dsh-workflow-kit` registers the one business handler (`workflow.preToolUse`), binds each child it starts to `{ role, hook, args }`, and evaluates both entry points with the same deterministic function. The provider is the wire:

- **DSH-native entry point.** The workflow plugin installs the DSH tool guard; the provider supplies the binding storage and the binding lookup.
- **Codex entry point.** The provider generates a random runtime key per App Server runtime and injects `DSH_PRETOOL_ENABLED=1`, `DSH_PRETOOL_SOCKET`, `DSH_PRETOOL_RUNTIME` into *that runtime's* spawn environment only. An ordinary Codex Session is untouched. `lib/pretool-client.js` is the installed hook command: it carries the hook payload to the Host over the socket and prints Codex's decision.
- The socket lives in a `mkdtemp` directory (mode `0700`), the socket itself is `0600`, and both are removed when the plugin is disposed. One connection carries one JSON request and one response.
- The receiver resolves the Session from the runtime key alone. Nothing in the hook payload — not `session_id`, not a role, not arguments — can select or replace a binding. Unknown or expired keys, released records, a mismatched cwd, and a `turn_id` that is not the Session's current turn are all refused.
- Every runtime replacement or release retires the old key, so a restart or a handover cannot leave a usable key behind.
- `lib/pretool-client.js` exits `0` with no output when it is not armed. When it is armed but the transport is missing, the input is not JSON, the connection fails, the answer takes more than 3 seconds, or the answer is invalid, it returns an explicit deny. It never prints the runtime key.

### Deployment prerequisite: an installed, trusted hook

Codex silently skips an untrusted or disabled hook. Before starting a gated Session, the provider calls `hooks/list` for that Session's cwd and requires an entry that:

- names `lib/pretool-client.js` in its `command`,
- is not disabled and reports no `errors`,
- has `trustStatus` of `managed` or `trusted`,
- is a PreToolUse hook.

If no such entry exists, the gated Session is refused with the reason instead of starting with an unenforced gate.

Managed deployment (preferred; on Linux `/etc/codex/requirements.toml`, needs root). If the target file already has a `[features]` table, merge `hooks = true` into it — do not append a second `[features]` table:

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

Without root, add the same `[[hooks.PreToolUse]]` entry to the user configuration, then read the entry's `currentHash` from `hooks/list` and record the trust hash under the key Codex reported:

```toml
[hooks.state."<sourcePath>:pre_tool_use:<matcherIndex>:<hookIndex>"]
trusted_hash = "<currentHash>"
```

`trustStatus` becomes `trusted` once the key and hash match. Writing a trust record on a user's behalf bypasses their trust prompt; do it only as an explicitly authorized deployment step.

The gate is policy-free here: what a `role` may write or which tool names it may call is decided by the workflow handler. The provider's own coverage limits are therefore the transport's limits — it checks the tool call and its arguments as Codex reports them, and it does not parse shell programs, so file effects inside a shell command are out of scope.

## Compatibility

The DSH host range is **`>=0.2.1-rc.1 <0.2.2-0`**: rc.1 is the minimum; alpha releases and 0.2.2 are excluded. Development dependencies and the lockfile remain pinned to `0.2.1-rc.2`. Shared host services remain peer dependencies. `dsh.compatibility.dshReleases` records verified releases and does not replace the installation gate.

Update both plugins together to `0.2.1`. There are no older DSH API fallbacks. The `workingDirectory` service supplies the current execution directory independently of the Session's original project. An existing Codex thread keeps its directory; create a new Session/child after changing it.

After building both plugins, run the local folder preflight to check version rejection, entry points and localized resources. It installs no DSH runtime, changes no profile and downloads no Office components:

```bash
node scripts/verify-dsh-compat.mjs
```

Then add the provider folder followed by the workflow folder through the existing DSH plugin page. Verify activation, settings reads/writes and child continuation there; preflight alone does not establish live compatibility.

## Development

```bash
npm run build                     # tsc -p tsconfig.json
npm run typecheck                 # tsc --noEmit
npm test                          # node --test test/*.test.mjs
npm run test:integration:handoff  # thread-handoff integration
npm run test:live                 # real Codex CLI, end to end
npm run test:live:handoff         # real-model successor handoff (Codex → Codex)
npm run test:live:handoff:cross   # real-model continuation (Codex → DeepSeek)
npm run release                   # staged build, atomic replace of lib/
npm run release:watch             # republish on every source change
```

The provider's suites spawn child processes, so the cases that spawn need an environment allowed to do so. The recorded runs used `node --test --test-isolation=none test/*.test.mjs` to run the whole suite in one process.

Test layers, so a failure is reported at the right level:

- **Unit / integration** (`npm test`): state store, ownership fencing, provider conversion, context filtering, tool gate, execution events, failures and recovery, with a scripted App Server.
- **Deterministic full stack** (`npm run test:live -- --fake`): the real Host plus real plugins with the Codex CLI replaced by a scripted App Server — for assertions such as "the first turn resumes a thread and never starts one".
- **Real model, hermetic** (`npm run test:live:handoff`, `:cross`, `scripts/live-hermetic.mjs`): `HOME`, `CODEX_HOME`, `TMPDIR` and the npm cache are relocated into `.live/<timestamp>/` inside this checkout, so a real run needs no approval and writes nothing outside the repository. Credential copies are deleted when the run finishes.
- **Installed deployment**: install the tarballs into a real DSH profile and restart the Host.

Real-model runs need Codex login state and network; they are not part of `npm test`.

### Hot reload while developing

The shipped base bundle enables HMR with `root: []`: configuration changes
(patch edits, installs, enable/disable) apply to a running Host immediately,
but **no module files are watched**, so editing this plugin's code needs a
restart until you opt in. Its README gives the official recipe, to be written
in the profile's patch layer:

```yaml
- id: hmr
  disabled: false
  config:
    root: ["."]
```

That recipe watches the profile tree. A plugin installed with `link:` resolves
to `node_modules/<name>/...` there and is filtered out by the default
`ignored: ["**/node_modules", ...]`, so it does not reload this checkout —
measured on 0.2.0-rc.2: the official recipe left the plugin untouched on a
touched `lib/index.js`, while `base` pointed at the checkout with
`root: ["lib"]` reloaded it within seconds.

`scripts/enable-hmr.mjs` writes that entry for you (dry run by default):

```bash
node scripts/enable-hmr.mjs                # print the change
node scripts/enable-hmr.mjs --write        # apply to $DSH_PROFILE_DIR
node scripts/enable-hmr.mjs --write --profile ~/.dsh/profiles/<profile>
node scripts/enable-hmr.mjs --write --remove   # back to the shipped default
```

HMR watches the profile patch, the home patch and the profile manifest, so the
entry applies without a restart; afterwards `npm run build` (or a running
`tsc --watch` / `npm run release:watch`) reloads the plugin about two seconds
after the write (`awaitWriteFinish` 2 s + 100 ms debounce). Only this package's
`lib/` is watched, and a reload tears down the plugin instance, so live Codex
workers are interrupted.

This is a development-machine setting only. A user who installs a published
build does not need it: a first install activates in the running Host, while a
package **replacement** needs a process restart to load a fresh module
generation, as `@deepseek-ai/dsh-plugin-manager` documents.

## Repository layout

```text
src/
  index.ts              plugin entry: config, backend, adapter, services, tool
  provider.ts           LLM adapter: models, requests, events, approvals, questions
  history.ts            DSH conversation <-> native thread boundary and history import
  usage.ts              token accounting: native payload -> record -> TokenUsage
  backend.ts            App Server RPC, thread/turn state machine, recovery
  wire.ts               App Server wire translation: inputs, snapshots, thread params
  rpc.ts                codex app-server --stdio transport (JSON lines over stdio)
  process.ts            child-process and timer seams (ctx.subprocess, ctx.timer)
  store.ts              the state directory and the single-owner lock
  records.ts            what a recorded Session is, and record validation
  context.ts            context filter for the codex route
  facts.ts              executed-fact messages committed to the DSH Session log
  execution.ts          read-only native execution facts (ctx.codexExecution)
  execution-events.ts   native event reduction into facts and usage
  execution-inputs.ts   declared vs. applied execution inputs
  handoff.ts            thread handover surface (ctx.codexHandoff)
  tool-gate.ts          gate bridge, hook transport, hook preflight
  pretool-client.ts     the installed Codex PreToolUse hook command
  models.ts, browser-types.ts
cordis.patch.yml        the one Host plugin entry
locale/                 plugin catalog text (en, zh)
test/                   node:test suites and scripted App Server fixtures
scripts/                compat verification, live harnesses, publish, watch
EXECUTION.md            implementation log and per-phase evidence references
```

## Process and usage ownership

The App Server inherits its process policy from the deployment instead of owning one. When the
composition provides `ctx.subprocess`, the runtime is spawned through it: `terminate()` runs the
provider's TERM→KILL ladder over its whole managed range, and `waitForExit()` proves that range
gone, so a descendant of the Codex CLI cannot outlive the plugin instance that started it.
Request deadlines and the shutdown grace come from `ctx.timer`, so they are released with the
provider rather than with a bare `setTimeout`. A composition that provides neither capability still
runs the App Server, as an unmanaged child of this process, and the plugin logs one warning saying
so — the same behaviour as before those capabilities existed.

Usage is taken from Codex's own `thread/tokenUsage/updated` notification and persisted with the
Session record, so a cold recovery reports the last value this provider was told. This plugin does
not read Codex's private rollout JSONL for usage.

## Known limitations

- The workflow gate's Codex path needs an installed, trusted PreToolUse hook (above). Without it, gated Codex Sessions refuse to start; DSH-native gating is independent of that prerequisite.
- Hook IPC uses a Unix domain socket and is not implemented for Windows.
- The gate sees the tool call and its arguments, not a shell program's file effects; `mcp__<server>__<name>` tools and runtime code registration (`cordis_define` / `cordis_run`) are outside it.
- The Codex → DeepSeek continuation path has known gaps in isolated profile extension preparation and in its settle budget for a slow successor turn; see `EXECUTION.md` for the recorded evidence.
- `EXECUTION.md` is a chronological implementation log. It records how the current state was reached and is not a specification of the plugin.

## License

MIT — see [LICENSE](LICENSE).

## Related repositories

- `dsh-workflow-kit` — roles, profiles, task contracts, lanes, acceptance and integration; owns the workflow session-gate policy and dispatches role-bound children into this provider.
- `dsh-subagent-ui-sidepanel` — the child-session sidebar/client half that used to live here.
