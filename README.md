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

Restart OpenCode to load 11 `supertask_*` tools. Then choose how to run the Gateway:

```bash
supertask install   # recommended for long-running use: explicit pm2 setup
supertask gateway   # foreground mode: no pm2 required
```

The plugin never installs global dependencies by itself. Without a running Gateway, queue-management tools still work, but scheduled and queued tasks are not executed and the Dashboard is unavailable.

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

# Task management
supertask add -n "Task" -a "agent" -p "prompt" --importance 5 \
  --max-retries 3 --retry-backoff "30s" --timeout "30min"
supertask list [--status pending] [--limit 20]
supertask get --id 1
supertask status
supertask cancel --id 1
supertask retry --id 1

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

`db backup` creates and validates a standalone SQLite snapshot. For `db clear` and `db restore`, the CLI automatically stops a PM2 Gateway whose PID matches the current database's fresh ready lock, then restores its previous running state. Both commands create a safety backup before changing data and still refuse active tasks or an unverified/foreground Gateway. Use `--keep-stopped` to leave a previously running PM2 Gateway stopped.

All four `db` commands print a concise human-readable summary when stdout is an interactive terminal. Pipes, command substitution, and other non-interactive callers continue to receive JSON; pass `--json` to force JSON in a terminal:

```bash
supertask db check --json
supertask db check | jq '.counts'
```

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
- **Process supervision** — optional pm2 crash recovery; plugin load never installs pm2, but can reuse an existing installation
- **Version-aware restart** — if pm2 is already installed, plugin load starts or restarts the Gateway when the package version changes
- **Process lock** — SQLite `BEGIN IMMEDIATE` ensures single instance
- **Readiness check** — PM2 PID must match a fresh, ready Gateway lock; `/health` also checks component activity
- **Heartbeat** — Worker updates every 30s; Watchdog kills stale processes
- **Graceful shutdown** — stop claiming work, drain active tasks for 30s, then interrupt and requeue only unfinished tasks
- **Exponential backoff** — configurable base × 2^n, capped at 30min
- **Dead letter queue** — `maxRetries` additional retries exhausted → `dead_letter`, manually recoverable
- **Batch isolation** — Same `batchId` serial; different `batchId` parallel
- **Priority** — `urgency DESC → importance DESC → createdAt ASC → id ASC`
- **Local Dashboard boundary** — loopback-only listener, same-origin write checks, escaped database output

## Web Dashboard

http://localhost:4680 — 4 pages:

Health endpoint: `GET http://localhost:4680/health` returns 200 only after Gateway startup completes and its internal loops remain active.

| Page | Features |
|------|----------|
| Task Queue | Filter by status, retry, delete |
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

重启 OpenCode 后会注入 11 个 `supertask_*` 工具。随后选择一种 Gateway 运行方式：

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

- **任务队列** — 优先级调度、批次隔离、依赖管理
- **安全停止** — 默认等待在途任务 30 秒；超时任务才会被中断并重新排队
- **进程守护** — 可选 pm2 崩溃恢复；插件加载不会安装 pm2，但可复用机器上已有的 PM2
- **版本感知重启** — 已安装 pm2 时，插件加载会在包版本变化后启动或重启 Gateway
- **定时任务** — cron / delayed / recurring，支持友好时间格式
- **Web 控制台** — 任务监控、执行日志、在线配置、自动备份后事务性清空数据库
- **Session 追踪** — 自动从 opencode run 输出中捕获 session ID

### 数据库维护

```bash
supertask db check
supertask db backup [--output /path/to/tasks-backup.db]
supertask db clear --confirm CLEAR [--keep-stopped]
supertask db restore --from /path/to/tasks-backup.db --confirm RESTORE [--keep-stopped]
```

`db backup` 会生成并校验可独立恢复的 SQLite 快照。CLI 清空和恢复会先确认 PM2 PID 与当前数据库的新鲜 ready 锁一致，再自动停止并按原状态重启 Gateway；操作失败时也会尝试恢复 Gateway。它们仍会拒绝运行中任务、前台 Gateway 或无法确认归属的进程，并在修改数据前自动保留安全备份。传入 `--keep-stopped` 可让原本运行的 PM2 Gateway 保持停止。

四个 `db` 命令在交互式终端默认输出简洁的人类可读摘要；管道、命令替换和其他非交互调用继续得到 JSON。终端内需要 JSON 时传入 `--json`：

```bash
supertask db check --json
supertask db check | jq '.counts'
```

### 数据位置

- 数据库：`~/.local/share/opencode/tasks.db`
- 配置：`~/.config/opencode/supertask.json`
