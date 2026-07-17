# SuperTask

[![npm version](https://img.shields.io/npm/v/opencode-supertask.svg)](https://www.npmjs.com/package/opencode-supertask)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

AI-powered task queue for [OpenCode](https://opencode.ai) agents — schedule, retry, and manage batch jobs with SQLite.

[简体中文](#简体中文)

Documentation: [current architecture](docs/architecture.md) · [operations and troubleshooting](docs/operations.md) · [document index](docs/README.md)

## Installation

### Quick Install

Install the CLI globally:

```bash
npm install -g opencode-supertask
```

Then add the plugin to `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["opencode-supertask"]
}
```

Restart OpenCode to load 8 queue-management `supertask_*` tools. Execution state is owned only by the Gateway; the plugin no longer exposes manual `start/done/fail` transitions. Then choose how to run the Gateway:

```bash
supertask install   # recommended for long-running use: explicit pm2 setup
supertask gateway   # foreground mode: no pm2 required
```

The plugin never installs global dependencies by itself. Without a running Gateway, queue-management tools still work, but scheduled and queued tasks are not executed and the Dashboard is unavailable.

Gateway task execution currently requires macOS or Linux. Windows is rejected at startup until the Worker can use an OS Job Object to guarantee that detached OpenCode descendants cannot survive cancellation or recovery.

### Uninstall

1. Run `supertask uninstall` to stop the Gateway and remove it from pm2
2. Remove `"opencode-supertask"` from `~/.config/opencode/opencode.json`
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

## CLI Reference

```bash
# Gateway management
supertask install                      # install Gateway as pm2 service
supertask uninstall                    # stop and remove from pm2
supertask gateway                      # start Gateway in foreground
supertask ui                           # open Web Dashboard in browser
supertask config                       # show current config
supertask doctor [--json]              # end-to-end runtime diagnostics

# Task management
supertask add -n "Task" -a "agent" -p "prompt" --importance 5 \
  --max-retries 3 --retry-backoff "30s" --timeout "30min"
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
- **Version-aware restart** — package changes preserve the existing PM2 runtime environment; replacement is refused before deletion if that environment can no longer invoke PM2, and failed startup rolls back the prior entry, Bun path, environment, and version
- **Process lock** — SQLite `BEGIN IMMEDIATE` ensures single instance, fences a process that loses ownership, and distinguishes a stale reused PID from a live Gateway
- **Readiness check** — PM2 PID must match a fresh, ready Gateway lock; `/health` reports Worker, Scheduler, Watchdog and cleanup-loop failures
- **Heartbeat** — Worker updates every 30s; new runs persist a per-run UUID in `locked_by` and launcher argv, and Watchdog signals a stale process group only when that identity and its OpenCode command match. Worker settles a normal exit only after the launcher returns a matching drain proof over private IPC; an unproved guardian exit remains quarantined until its process group is confirmed absent. Live legacy/v2 groups remain quarantined; an old run is recovered automatically only after both PID and PGID are confirmed absent.
- **Graceful shutdown** — stop claiming work, drain active tasks for 30s, then requeue only runs whose complete process tree is confirmed stopped
- **Fail-closed process isolation** — Unix uses an independent process group; Windows Worker startup is blocked until Job Object containment is available
- **External-only upgrades** — Gateway-managed OpenCode runs cannot invoke `supertask_upgrade`; upgrades must start from an external CLI or interactive session so they cannot terminate their own host Gateway
- **Exponential backoff** — configurable base × 2^n, capped at 30min
- **Dead letter queue** — `maxRetries` additional retries exhausted → `dead_letter`, manually recoverable
- **Batch isolation** — Same `batchId` remains serial across Gateway restarts; different `batchId` can run in parallel
- **Priority** — `urgency DESC → importance DESC → createdAt ASC → id ASC`
- **Local Dashboard boundary** — loopback-only listener, same-origin write checks, escaped database output
- **Guarded deletion** — active runs and prerequisites of executable dependent tasks cannot be deleted

## Web Dashboard

http://localhost:4680 — 4 pages:

The responsive Dashboard supports Chinese and English plus system, light, and dark themes. Language is stored in a same-site cookie, while theme preference stays in browser local storage; both survive refreshes without changing Gateway configuration.

Health endpoint: `GET http://localhost:4680/health` returns 200 only after Gateway startup completes and its internal loops remain active without an unrecovered loop failure. `supertask doctor` also checks OpenCode, SQLite, PM2 readiness, Dashboard health, log rotation, and on macOS the loaded LaunchAgent plus its recoverable PM2 dump.

| Page | Features |
|------|----------|
| Task Queue | Filter by status, retry, cancel, guarded delete |
| Scheduled Tasks | Template CRUD, enable/disable, manual trigger |
| Execution Logs | task_runs history with session tracking |
| System Status | Config editor, concurrency monitor, backup-first transactional database clear |

## Data

- Database: `~/.local/share/opencode/tasks.db` (SQLite WAL)
- Config: `~/.config/opencode/supertask.json`

## Requirements

- [Bun](https://bun.sh) >= 1.0
- [OpenCode](https://opencode.ai)

## License

MIT

---

<a id="简体中文"></a>

## 简体中文

SuperTask 是一个基于 SQLite 的 AI Agent 任务调度系统，专为 [OpenCode](https://opencode.ai) 设计。

详细文档：[当前架构与决策](docs/architecture.md) · [运行与排障手册](docs/operations.md) · [文档索引](docs/README.md)

### 安装

先安装全局 CLI：

```bash
npm install -g opencode-supertask
```

然后在 `~/.config/opencode/opencode.json` 中添加：

```json
{
  "plugin": ["opencode-supertask"]
}
```

重启 OpenCode 后会注入 8 个队列管理 `supertask_*` 工具。执行状态只允许 Gateway 写入，插件不再暴露手动 `start/done/fail` 状态迁移。随后选择一种 Gateway 运行方式：

```bash
supertask install   # 长期运行推荐：显式安装/配置 pm2 并启动 Gateway
supertask gateway   # 前台运行：不需要 pm2
```

插件不会自行安装全局依赖。Gateway 未运行时仍可管理队列，但不会执行排队/定时任务，也不会启动 Web 控制台。

### 卸载

1. 运行 `supertask uninstall` 停止 Gateway
2. 从 `~/.config/opencode/opencode.json` 中移除 `"opencode-supertask"`
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

### 核心功能

当前 Gateway 任务执行支持 macOS 和 Linux。Windows 在具备 Job Object 级进程树隔离前会拒绝启动，避免取消或重试时遗留 OpenCode 后代进程。

- **任务队列** — 优先级调度、批次隔离、依赖管理
- **安全停止** — 默认等待在途任务 30 秒；只有确认整棵进程树退出的任务才会被重新排队
- **进程守护** — 可选 pm2 崩溃恢复；PM2 kill timeout 不低于 Worker drain 宽限期加 15 秒，`stop/delete` 至少再等待 5 秒并在返回前持续持有可崩溃释放的 SQLite 生命周期锁，macOS 监督器不会击穿 PM2 的 `errored` 熔断；显式 `supertask install` 同时安装/配置有限保留的日志轮转，插件加载不会安装全局依赖
- **版本感知重启** — 已安装 pm2 时，插件加载会在包版本变化后安全替换 Gateway；旧环境无法执行 PM2 时会在删除前拒绝操作，否则保留原运行环境并在失败时回滚
- **外部升级边界** — Gateway 管理的 OpenCode 任务不能调用 `supertask_upgrade`；升级必须从外部 CLI 或非队列交互会话发起，避免任务终止承载自己的 Gateway
- **定时任务** — cron / delayed / recurring，支持友好时间格式
- **Web 控制台** — 任务监控、执行日志、在线配置、自动备份后事务性清空数据库；支持中英文、跟随系统/浅色/深色主题和移动端布局
- **Session 追踪** — 自动从 opencode run 输出中捕获 session ID
- **安全删除** — 活跃执行必须先取消并收敛；仍被可执行任务依赖的前置任务也不会被误删
- **安全重试** — 仅在依赖仍存在、同项目且可恢复时重置任务，历史清理并发时不会制造悬空 `pending`
- **一键诊断** — `supertask doctor` 检查真实 OpenCode、SQLite、PM2 ready 锁、Dashboard、日志轮转和 macOS 重启恢复链路

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

### 数据位置

- 数据库：`~/.local/share/opencode/tasks.db`
- 配置：`~/.config/opencode/supertask.json`
