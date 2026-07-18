# SuperTask

[![npm version](https://img.shields.io/npm/v/opencode-supertask.svg)](https://www.npmjs.com/package/opencode-supertask)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

AI-powered task queue for [OpenCode](https://opencode.ai) agents — schedule, retry, and manage batch jobs with SQLite.

[简体中文](#简体中文)

Documentation: [changelog](CHANGELOG.md) · [current architecture](docs/architecture.md) · [operations and troubleshooting](docs/operations.md) · [document index](docs/README.md)

## Installation

### Quick Install

Resolve the current release once, then install both the CLI and OpenCode plugin with that exact version:

```bash
VERSION="$(npm view opencode-supertask dist-tags.latest)"
npm install -g "opencode-supertask@$VERSION"
opencode plugin "opencode-supertask@$VERSION" --global --force
```

This writes an exact `opencode-supertask@<version>` entry. Do not change it to bare `opencode-supertask` or `@latest`; a floating cache key can select stale files after an upgrade.

Restart OpenCode to load 8 queue-management `supertask_*` tools. Execution state is owned only by the Gateway; the plugin no longer exposes manual `start/done/fail` transitions. Then choose how to run the Gateway:

```bash
supertask install   # recommended for long-running use: explicit pm2 setup
supertask gateway   # foreground mode: no pm2 required
```

The plugin never installs global dependencies by itself. Without a running Gateway, queue-management tools still work, but scheduled and queued tasks are not executed and the Dashboard is unavailable.

Upgrades do not require uninstalling. Run `supertask upgrade`: it pins the exact latest plugin, replaces the Gateway, detects whether the global `supertask` came from npm or Bun, and synchronizes the CLI to that same version. `supertask doctor` fails if the CLI, plugin, Gateway package, or ready lock disagree. Versions through 0.1.33 cannot retroactively update their own old CLI, so upgrade from those releases by installing the new global CLI once with the original package manager, then run the new `supertask upgrade`.

Gateway task execution currently requires macOS or Linux. Windows is rejected at startup until the Worker can use an OS Job Object to guarantee that detached OpenCode descendants cannot survive cancellation or recovery.

Run `supertask install` and `supertask upgrade` from the same terminal environment in which `opencode run --agent <name>` works. An explicit install or upgrade refreshes the Gateway's OpenCode/XDG/provider execution environment while keeping the proven Bun path, PM2 identity, database/config scope, and rollback runtime pinned. This matters when a custom primary agent selects a provider through environment variables or a non-default OpenCode config directory.

### Uninstall

1. Run `supertask uninstall` to stop the Gateway and remove it from pm2
2. Remove the `"opencode-supertask@<version>"` entry from `~/.config/opencode/opencode.json`
3. Restart OpenCode

To clear all task data safely, use the backup-first database command:

```bash
supertask db clear --confirm CLEAR
```

If the matching Gateway is managed by PM2, the CLI stops it first and restarts it after maintenance.

### CLI Install / Uninstall

```bash
supertask install     # Explicitly install/configure pm2 and start Gateway
supertask uninstall   # Stop and remove Gateway from pm2
```

### From Source

```bash
git clone https://github.com/vbgate/opencode-supertask.git
cd opencode-supertask
bun install
bun run build
```

Then add the local path to your config:

```json
{
  "plugin": ["/path/to/opencode-supertask"]
}
```

## Quick Start

After starting the Gateway with `supertask install` or `supertask gateway`, use the MCP tools in OpenCode:

```
Create a task: "帮我生成项目的 README" with agent "explore"
```

Or open the Web Dashboard:

```bash
supertask ui          # Opens http://localhost:4680 in browser
```

The Task Queue page groups work by project directory and can create ordinary queued tasks with a model, prompt, priority, batch, retries, and timeout. Choose the project with the built-in folder browser; the form then reads that directory's real `opencode agent list` and `opencode models` results. Models are grouped by provider, while only Agents that OpenCode marks as directly runnable are offered. A full worker pool does not reject a new task—it remains pending in SQLite.

Retry, timeout, and recurring-interval fields offer common presets first. Number-and-unit controls appear only under **Custom**, while one-time schedules use a local date/time picker. “Use the Agent / OpenCode default model” means SuperTask does not pass `-m`.

## SuperTask vs cron, PM2, and shell scripts

SuperTask is not a replacement for every scheduler. If you only have a few fixed, independent `opencode run` commands, use `crontab`, a system timer (`launchd`/`systemd`), GitHub Actions, or PM2 `cron_restart`. They are simpler and do not require the SuperTask Gateway.

| Requirement | Prefer |
| --- | --- |
| Run a few fixed, independent commands at fixed times | `crontab`, `launchd`, or a `systemd` timer |
| Restart one long-running process on a schedule | PM2 `cron_restart` |
| Run a fixed serial pipeline | A shell script |
| Manage a changing set of Agent jobs with durable state | SuperTask |

`crontab` can start `opencode run` without this plugin, but it does not natively provide:

- a durable queue with per-task and per-run state after process or machine restarts;
- dynamic creation and editing from OpenCode, CLI, and Web instead of editing an OS crontab;
- shared concurrency limits, priority ordering, dependencies, and per-project/batch serialization;
- retry budgets, exponential backoff, dead-letter handling, and manual recovery;
- safe cancellation of a managed OpenCode process tree, session tracking, and searchable execution history.

A loop such as `opencode run ... && opencode run ...` is also a valid solution for a fixed serial pipeline. It does not know how to accept new work, reorder it, resume an individual failed job, or expose reliable queue state unless those capabilities are built separately with a database, locks, logs, and process supervision—in effect, a task queue.

SuperTask's scheduler creates ordinary durable queue tasks, so scheduled and manually submitted work share the same concurrency, retry, cancellation, and history rules. The trade-off is that the Gateway must be running to dispatch work. For 24/7 use, run it under the optional PM2 installation or another process supervisor; `crontab` remains the better choice when an OS-level fixed schedule is all you need.

## CLI Reference

CLI help and interactive database/doctor summaries support Chinese and English. The default is `auto`: `zh*` system locales use Chinese and all other locales use English. Override it globally with `supertask --lang zh-CN <command>`, `supertask --lang en <command>`, or `SUPERTASK_LANG=zh-CN|en`. JSON field names and raw diagnostic errors are unchanged for scripts and Agents.

```bash
# Gateway management
supertask install                      # install Gateway as pm2 service
supertask uninstall                    # stop and remove from pm2
supertask gateway                      # start Gateway in foreground
supertask ui                           # open Web Dashboard in browser
supertask config                       # show current config
supertask doctor [--json]              # end-to-end runtime diagnostics
supertask upgrade                      # pin latest plugin version and replace Gateway

# Task management
supertask add -n "Task" -a "agent" -p "prompt" --importance 5 \
  --max-retries 3 --retry-backoff "30s" --timeout "30min"
supertask edit --id 1 --model "openai/gpt-5" --importance 5 --prompt "updated"
supertask list [--status pending] [--limit 20]
supertask get --id 1
supertask status
supertask cancel --id 1
supertask retry --id 1   # invalid/missing dependencies are rejected
supertask delete --id 1   # running tasks must be cancelled and fully stopped first
supertask run abandon --id 7 --confirm ABANDON  # legacy null-PID quarantine only

# Scheduled templates (friendly duration format)
supertask template add --name "Daily" --agent "gen" \
  --prompt "..." --type cron --cron "0 9 * * *"
supertask template add --name "Delayed" --agent "gen" \
  --prompt "..." --type delayed --delay "30min"
supertask template add --name "Hourly" --agent "gen" \
  --prompt "..." --type recurring --interval "1h" \
  --batch "reports" --retry-backoff "30s" --timeout "30min"
supertask template list
supertask template enable --id 1

# Database maintenance
supertask db check
supertask db backup [--output /path/to/tasks-backup.db]
supertask db clear --confirm CLEAR [--keep-stopped]
supertask db restore --from /path/to/tasks-backup.db --confirm RESTORE [--keep-stopped]
```

`db backup` creates and validates a standalone SQLite snapshot. For `db clear` and `db restore`, the CLI automatically stops a PM2 Gateway whose PID matches the current database's fresh ready lock, then restores its previous running state. Both commands create a safety backup before changing data and still refuse active tasks or an unverified/foreground Gateway. Clear dynamically empties every business table, including expand-only tables introduced by a newer compatible schema, while preserving the Gateway lock table and migration metadata. Restore reads the source through SQLite into a consistent standalone snapshot, including committed WAL-only pages, rejects symlink/hardlink aliases of the live database, and migrates the staged snapshot. It dynamically restores every compatible business table and writable column; source tables/columns unknown to the live schema fail closed before deletion, while target-only expand columns must be nullable/defaulted and target-only future tables are reset to the older snapshot's empty state. The final replacement runs inside one exclusive transaction so a concurrent successful write cannot disappear. Use `--keep-stopped` to leave a previously running PM2 Gateway stopped.

All four `db` commands print a concise human-readable summary when stdout is an interactive terminal. Pipes, command substitution, and other non-interactive callers continue to receive JSON; pass `--json` to force JSON in a terminal:

```bash
supertask db check --json
supertask db check | jq '.counts'
```

`db check` exits non-zero when integrity, foreign keys, or required tables fail, while still printing the complete report. CLI IDs and integer options are parsed strictly: values such as `12abc` or `3.5` are rejected instead of being truncated.

`run abandon` is an emergency escape hatch for an old-version run that has no recorded child PID and whose owner has exited. `supertask doctor` and Watchdog logs print the affected task/run IDs. First cancel the task from its recorded `cwd`, independently confirm that no legacy OpenCode process remains, then enter the exact `--confirm ABANDON` command. Current guardian runs, live owners and runs with a child PID are always rejected.

### Duration Format

Schedule supports friendly duration strings:

| Format | Examples |
|--------|----------|
| Seconds | `30s`, `5sec` |
| Minutes | `5min`, `30minutes` |
| Hours | `1h`, `2hours` |
| Days | `1d`, `3days` |
| Weeks | `1w`, `2weeks` |
| ISO 8601 | `PT30M`, `PT1H30M` |

## Architecture

```
Gateway (foreground or optionally managed by pm2)
├── Worker     → claim tasks, execute the target agent via opencode run
├── Scheduler  → clone tasks from templates (cron / delayed / recurring)
├── Watchdog   → heartbeat timeout, auto-retry, data cleanup
└── Dashboard  → Web UI on port 4680 (Hono SSR)
```

Config file: `~/.config/opencode/supertask.json`

The complete configuration reference and restart semantics are documented in [Operations and Troubleshooting](docs/operations.md).

```json
{
  "configVersion": 2,
  "worker": { "maxConcurrency": 2, "taskTimeoutMs": 1800000, "shutdownGracePeriodMs": 30000 },
  "scheduler": { "enabled": true, "checkIntervalMs": 1000 },
  "watchdog": {
    "heartbeatTimeoutMs": 600000,
    "checkIntervalMs": 60000,
    "cleanupIntervalMs": 86400000,
    "retentionDays": 30
  },
  "dashboard": { "enabled": true, "port": 4680 }
}
```

Key mechanisms:
- **Process supervision** — optional pm2 crash recovery with a 512 MB default memory restart threshold and a kill timeout no lower than Worker drain grace + 15 seconds; lifecycle operations and the macOS supervisor acquire the canonical `PM2_HOME` SQLite lock plus any recovered legacy custom lock for the whole mutation, reject a macOS LaunchAgent/CLI `PM2_HOME` mismatch before mutation, and never bypass PM2's `errored` fuse
- **Version-aware restart** — automatic recovery preserves the existing PM2 runtime environment; an explicit install/upgrade refreshes the OpenCode/provider execution environment while pinning the prior PM2/Bun/database/config identity. Replacement is refused before deletion if the old environment can no longer invoke PM2, and failed startup rolls back the complete prior runtime and version
- **Process lock** — SQLite `BEGIN IMMEDIATE` ensures single instance, fences a process that loses ownership, and distinguishes a stale reused PID from a live Gateway
- **Readiness check** — PM2 PID must match a fresh, ready Gateway lock; `/health` reports Worker, Scheduler, Watchdog and cleanup-loop failures
- **Heartbeat** — Worker updates every 30s; new runs persist a per-run UUID in `locked_by` and launcher argv, and Watchdog signals a stale process group only when that identity and its OpenCode command match. Worker settles a normal exit only after the launcher returns a matching drain proof over private IPC; an unproved guardian exit remains quarantined until its process group is confirmed absent. Live legacy/v2 groups remain quarantined; an old run is recovered automatically only after both PID and PGID are confirmed absent.
- **Graceful shutdown** — stop claiming work, drain active tasks for 30s, then requeue only runs whose complete process tree is confirmed stopped
- **Bun IPC compatibility** — after sending a bound drain proof, the launcher waits for a matching Worker acknowledgment instead of relying on the unreliable `process.send` callback in older Bun versions
- **Fail-closed process isolation** — Unix uses an independent process group; Windows Worker startup is blocked until Job Object containment is available
- **External-only upgrades** — Gateway-managed OpenCode runs cannot invoke `supertask_upgrade`; upgrades must start from an external CLI or interactive session so they cannot terminate their own host Gateway
- **Exponential backoff** — configurable base × 2^n, capped at 30min
- **Dead letter queue** — `maxRetries` additional retries exhausted → `dead_letter`, manually recoverable
- **Project and batch isolation** — `cwd` groups and isolates project queries; the same non-empty `batchId` is a global serialization key across projects and Gateway restarts, while different or omitted batches can run in parallel
- **Priority** — `urgency DESC → importance DESC → createdAt ASC → id ASC`
- **Local Dashboard boundary** — loopback-only listener, same-origin write checks, escaped database output
- **Guarded deletion** — active runs and prerequisites of executable dependent tasks cannot be deleted

## Web Dashboard

http://localhost:4680 — 4 pages:

The responsive Dashboard supports Chinese and English plus system, light, and dark themes. Language is stored in a same-site cookie, while theme preference stays in browser local storage; both survive refreshes without changing Gateway configuration.

Health endpoint: `GET http://localhost:4680/health` returns 200 only after Gateway startup completes and its internal loops remain active without an unrecovered loop failure. `supertask doctor` also checks OpenCode, SQLite, PM2 readiness, Dashboard health, log rotation, and on macOS the loaded LaunchAgent plus its recoverable PM2 dump. It requires the effective OpenCode plugin configuration to use one exact version, verifies that exact cache package, and compares it with the global CLI, actual PM2 Gateway entry, and ready-lock version; floating `@latest`/`@next` paths or any component version mismatch fail diagnostics.

| Page | Features |
|------|----------|
| Task Queue | Browse a project folder, load its runnable Agents/models, see running/queued/error counts, create or edit prioritized tasks, retry, cancel, guarded delete, and copy a validated `opencode --session …` command |
| Scheduled Tasks | Create and edit model, Agent, prompt, project directory, schedule, retries, and timeout with common duration presets; Run now always queues a task |
| Execution Logs | Structured Agent output, errors, tools, exact reproducible command, raw OpenCode JSONL, and session tracking |
| System Status | Config editor with saved/active state, PM2-backed save-and-restart, concurrency monitor, and backup-first transactional database clear |

## Data

- Database: `~/.local/share/opencode/tasks.db` (SQLite WAL)
- Config: `~/.config/opencode/supertask.json`

## Requirements

- [Bun](https://bun.sh) >= 1.1.45 (CI verifies launcher IPC on both the minimum and current versions)
- [OpenCode](https://opencode.ai)

## License

MIT

---

<a id="简体中文"></a>

## 简体中文

SuperTask 是一个基于 SQLite 的 AI Agent 任务调度系统，专为 [OpenCode](https://opencode.ai) 设计。

详细文档：[更新记录](CHANGELOG.md) · [当前架构与决策](docs/architecture.md) · [运行与排障手册](docs/operations.md) · [文档索引](docs/README.md)

### 安装

先解析一次稳定版号，再用同一个精确版本安装全局 CLI 和 OpenCode 插件：

```bash
VERSION="$(npm view opencode-supertask dist-tags.latest)"
npm install -g "opencode-supertask@$VERSION"
opencode plugin "opencode-supertask@$VERSION" --global --force
```

最终配置应是精确的 `opencode-supertask@<version>`，不要改成裸包名或 `@latest`；浮动缓存键可能在升级后仍命中旧文件。

重启 OpenCode 后会注入 8 个队列管理 `supertask_*` 工具。执行状态只允许 Gateway 写入，插件不再暴露手动 `start/done/fail` 状态迁移。随后选择一种 Gateway 运行方式：

```bash
supertask install   # 长期运行推荐：显式安装/配置 pm2 并启动 Gateway
supertask gateway   # 前台运行：不需要 pm2
```

插件不会自行安装全局依赖。Gateway 未运行时仍可管理队列，但不会执行排队/定时任务，也不会启动 Web 控制台。

升级无需卸载，执行 `supertask upgrade`。它会精确安装最新插件、替换 Gateway，并根据全局 `supertask` 的真实路径识别 npm 或 Bun 后同步 CLI；无法安全确认包管理器时会明确失败并给出精确命令。`doctor` 把 CLI、插件、Gateway 任一版本不一致视为异常。由于 0.1.33 及更早版本还不具备 CLI 自动同步能力，从这些版本升级时先用原包管理器安装一次新 CLI，再运行新版 `supertask upgrade`。

请在手动执行 `opencode run --agent <名称>` 能工作的同一个终端环境中运行 `supertask install` 或 `supertask upgrade`。显式安装/升级会刷新 Gateway 使用的 OpenCode、XDG 与模型 Provider 执行环境，同时固定已经验证的 Bun、PM2、数据库/配置作用域，并保留完整旧环境用于失败回滚。这能避免自定义主 Agent 在终端正常、但 Gateway 仍沿用旧 Provider 凭据或旧 OpenCode 配置目录。

### 快速开始

启动 Gateway 后，可以直接打开 Web 管理界面：

```bash
supertask ui          # 打开 http://127.0.0.1:4680
```

“任务队列”页可按项目目录查看、创建和编辑普通任务，设置 Agent、模型、提示词、优先级、批次、重试和超时；“定时任务”页可创建和编辑 cron、延迟执行与循环任务。项目目录可直接用文件夹选择器浏览；选定后，页面会在该目录执行本机 `opencode agent list` 和 `opencode models`，只显示可直接运行的 Agent，并按 Provider 分组模型。并发已满时新任务仍会成功入队并等待，不会因当下没有空位而拒绝创建。

重试等待、单次超时和循环间隔默认是“30 秒”、“15 分钟”、“每 1 小时”这类直接选项；只有选择“自定义”才显示数字和单位。一次性任务使用本地日期时间选择器。“跟随 Agent / OpenCode 默认模型”表示不传 `-m`。

### CLI 语言与命令速查

CLI 帮助以及 `doctor`、数据库维护命令的交互式摘要支持中英文。默认 `auto`：系统 locale 以 `zh` 开头时显示中文，否则显示英文。可以显式切换：

```bash
supertask --lang zh-CN --help
supertask --lang en add --help
SUPERTASK_LANG=zh-CN supertask doctor
```

语言设置不改变 JSON 字段和后端原始诊断错误，Agent、管道与脚本仍可稳定解析。

```bash
# Gateway 与诊断
supertask install | uninstall | gateway | ui | doctor

# 普通任务
supertask add | edit | list | get | status | retry | cancel | delete

# 定时任务与数据库
supertask template add | list | enable | disable | delete
supertask db check | backup | clear | restore
```

### 卸载

1. 运行 `supertask uninstall` 停止 Gateway
2. 从 `~/.config/opencode/opencode.json` 中移除 `"opencode-supertask@<version>"`
3. 重启 OpenCode

安全清理所有任务数据：

```bash
supertask db clear --confirm CLEAR
```

若当前数据库对应的 Gateway 由 PM2 管理，CLI 会自动停止并在维护结束后恢复运行。

### 定时任务

支持友好的时间格式：

```bash
# 30秒后执行
supertask template add --type delayed --delay "30s" ...

# 每5分钟循环
supertask template add --type recurring --interval "5min" ...

# 每天上午9点（cron）
supertask template add --type cron --cron "0 9 * * *" ...
```

### 与 crontab、PM2、Shell 脚本的区别

SuperTask 并不是所有定时场景的替代品。如果只是按固定时间运行少量、互不依赖的 `opencode run`，优先使用 `crontab`、`launchd` / `systemd` 定时器、GitHub Actions 或 PM2 `cron_restart`：它们更简单，也不依赖 SuperTask Gateway。

| 需求 | 更合适的方案 |
| --- | --- |
| 固定时间运行少量、互不依赖的命令 | `crontab`、`launchd` 或 `systemd` 定时器 |
| 定时重启一个长期运行的进程 | PM2 `cron_restart` |
| 按固定顺序执行一串命令 | Shell 脚本 |
| 管理会动态变化、需要持久状态的 Agent 任务 | SuperTask |

`crontab` 完全可以直接启动 `opencode run`，但它默认不提供：

- 进程或机器重启后仍可恢复的持久任务队列，以及逐任务、逐次执行状态；
- 从 OpenCode、CLI 和 Web 动态创建、编辑任务，而不是修改操作系统的 crontab；
- 全局并发限制、优先级、依赖关系，以及跨项目生效的全局同批次串行；
- 重试次数、指数退避、失败任务隔离（死信）和人工恢复；
- 对受管 OpenCode 进程树的安全取消、Session 追踪和可查询的执行历史。

`opencode run ... && opencode run ...` 或循环脚本也适合固定的串行流水线；但它无法直接接收新任务、调整顺序、单独恢复某个失败任务或展示可靠的队列状态。若再自行补数据库、锁、日志解析和进程守护，本质上就是重新实现一套任务队列。

SuperTask 的定时器会生成普通的持久队列任务，因此定时任务与手动任务共用并发、重试、取消和历史记录规则。代价是 Gateway 必须运行才能派发任务；需要 7×24 小时运行时，应使用可选的 PM2 安装或其他进程守护。若需求仅是操作系统按固定时间拉起一条命令，`crontab` 仍是更合适的选择。

### 核心功能

当前 Gateway 任务执行支持 macOS 和 Linux。Windows 在具备 Job Object 级进程树隔离前会拒绝启动，避免取消或重试时遗留 OpenCode 后代进程。

- **任务队列** — `cwd` 项目分组与查询隔离、优先级调度、全局同批次串行、依赖管理；工作目录必须是已存在的绝对目录
- **安全停止** — 默认等待在途任务 30 秒；只有确认整棵进程树退出的任务才会被重新排队
- **进程守护** — 可选 pm2 崩溃恢复；PM2 kill timeout 不低于 Worker drain 宽限期加 15 秒，`stop/delete` 至少再等待 5 秒并在返回前持续持有可崩溃释放的 SQLite 生命周期锁，macOS 监督器不会击穿 PM2 的 `errored` 熔断；显式 `supertask install` 同时安装/配置有限保留的日志轮转，插件加载不会安装全局依赖
- **版本感知重启** — 自动恢复继续使用原 PM2 运行环境；显式安装/升级会刷新 OpenCode/Provider 执行环境，同时固定原 PM2、Bun、数据库与配置身份。旧环境无法执行 PM2 时会在删除前拒绝操作，新环境启动失败时完整回滚旧环境
- **外部升级边界** — Gateway 管理的 OpenCode 任务不能调用 `supertask_upgrade`；升级必须从外部 CLI 或非队列交互会话发起，避免任务终止承载自己的 Gateway
- **定时任务** — cron / delayed / recurring，常用间隔直接选择，只在自定义时输入数字和单位；`maxInstances` 限制自动调度，手动“立即运行一次”始终入队并在全局并发已满时等待
- **Web 控制台** — 按项目目录显示运行/排队/异常数量，可浏览文件夹并动态读取该项目本机 OpenCode 可运行 Agent/模型，可创建和编辑带提示词、优先级、批次、重试与超时的普通任务和定时任务；执行记录分层展示真实命令、Agent 输出、错误、工具和原始 JSONL；支持配置重启、安全清库、中英文、深浅主题和移动端
- **Session 追踪** — 自动从 opencode run 输出中捕获 session ID；任务页和执行记录页可复制经过校验的 `opencode --session …` 命令继续会话
- **安全删除** — 活跃执行必须先取消并收敛；仍被可执行任务依赖的前置任务也不会被误删
- **安全重试** — 仅在依赖仍存在、同项目且可恢复时重置任务，历史清理并发时不会制造悬空 `pending`
- **一键诊断** — `supertask doctor` 检查真实 OpenCode、精确锁定的插件配置/缓存、全局 CLI、PM2 实际 Gateway 入口与 ready 锁版本、SQLite、Dashboard、日志轮转和 macOS 重启恢复链路；浮动 `@latest`/`@next` 路径或任一组件版本不一致都会判异常

### 数据库维护

```bash
supertask db check
supertask db backup [--output /path/to/tasks-backup.db]
supertask db clear --confirm CLEAR [--keep-stopped]
supertask db restore --from /path/to/tasks-backup.db --confirm RESTORE [--keep-stopped]
```

`db backup` 会生成并校验可独立恢复的 SQLite 快照。CLI 清空和恢复会先确认 PM2 PID 与当前数据库的新鲜 ready 锁一致，再自动停止并按原状态重启 Gateway；操作失败时也会尝试恢复 Gateway。它们仍会拒绝运行中任务、前台 Gateway 或无法确认归属的进程，并在修改数据前自动保留安全备份。清空会动态删除全部业务表数据，包括兼容的新版本 expand-only 表，同时保留 Gateway 锁表和 migration 元数据。恢复通过 SQLite 源连接生成包含已提交 WAL 页的一致快照，拒绝当前数据库的符号链接/硬链接别名，并动态恢复所有兼容的业务表与可写列；source-only 未知表/列会在删除前失败关闭，目标侧新增列必须可空或有默认值，目标侧新增表按旧快照的空状态清理。暂存快照迁移后再在排他事务中原位替换业务数据，避免并发写入成功后被静默覆盖。传入 `--keep-stopped` 可让原本运行的 PM2 Gateway 保持停止。

四个 `db` 命令在交互式终端默认输出简洁的人类可读摘要；管道、命令替换和其他非交互调用继续得到 JSON。终端内需要 JSON 时传入 `--json`：

```bash
supertask db check --json
supertask db check | jq '.counts'
```

`db check` 发现完整性、外键或必需表异常时会返回非零退出码，同时保留完整报告。CLI 的 ID 与整数参数采用严格解析，`12abc`、`3.5` 等输入会直接报错，不再截断成另一个合法值。

旧版本若在记录 child PID 前崩溃，Watchdog 会安全隔离该 run，`supertask doctor` 与 Gateway 日志会给出任务/run ID。先在任务记录的 `cwd` 执行 `supertask cancel --id <taskId>`，独立确认没有遗留 OpenCode 进程，再执行 `supertask run abandon --id <runId> --confirm ABANDON`。该命令只关闭 owner 已退出、child PID 为空且任务已取消的旧版 run；当前 guardian run、存活 owner 或已记录 PID 的 run 一律拒绝。

新 run 使用 `gated-v3-token-guardian`，每次执行的 UUID 同时写入 `task_runs.locked_by` 和 launcher argv；Watchdog 只有在 launcher、OpenCode 参数与 UUID 全部匹配时才会终止进程组。Worker 还要收到 launcher 在整组排空后通过独立 IPC 返回的同 UUID 证明，才结算正常退出；guardian 无证明退出会隔离到进程组明确消失。旧 v2/legacy 记录若 PID 或 PGID 仍存活或无法确认，只保持隔离且不自动发信号；PID 与进程组均明确消失后才安全恢复。

排空证明采用双向确认：Worker 校验证明后回送同 UUID，launcher 收件后才退出；该握手不依赖旧 Bun 不可靠的 `process.send` 回调。最低支持 Bun 1.1.45，CI 同时验证最低版本和当前版本。

### 数据位置

- 数据库：`~/.local/share/opencode/tasks.db`
- 配置：`~/.config/opencode/supertask.json`

### 运行要求

- Bun 1.1.45 或更高版本
- OpenCode
- Gateway Worker 当前支持 macOS 与 Linux；Windows 在 Job Object 进程树隔离完成前拒绝启动
- PM2 只在运行 `supertask install` 时显式安装/使用；前台 `supertask gateway` 不依赖 PM2
