# SuperTask

[![npm version](https://img.shields.io/npm/v/opencode-supertask.svg)](https://www.npmjs.com/package/opencode-supertask)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

AI-powered task queue for [OpenCode](https://opencode.ai) agents — schedule, retry, and manage batch jobs with SQLite.

[简体中文](#简体中文)

## Installation

### Quick Install

Add the plugin to `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["opencode-supertask"]
}
```

Restart OpenCode. That's it.

The plugin auto-starts a Gateway process (via pm2) and injects:
- 10 MCP tools (`supertask_add`, `supertask_next`, `supertask_start`, `supertask_done`, `supertask_fail`, `supertask_get`, `supertask_list`, `supertask_status`, `supertask_retry`, `supertask_schedule`)
- A `supertask-runner` agent (used internally by the Gateway)
- A Web Dashboard at http://localhost:4680

### Uninstall

1. Run `supertask uninstall` to stop the Gateway and remove it from pm2
2. Remove `"opencode-supertask"` from `~/.config/opencode/opencode.json`
3. Restart OpenCode

To clean up all data, delete the database:

```bash
rm ~/.local/share/opencode/tasks.db
```

### CLI Install / Uninstall

```bash
supertask install     # Install Gateway as pm2 service (auto-start, crash recovery)
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

After installation, the Gateway starts automatically. Use the MCP tools in OpenCode:

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
supertask add -n "Task" -a "agent" -p "prompt" --importance 5
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
  --prompt "..." --type recurring --interval "1h"
supertask template list
supertask template enable --id 1
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
Gateway (managed by pm2)
├── Worker     → claim tasks, execute the target agent via opencode run
├── Scheduler  → clone tasks from templates (cron / delayed / recurring)
├── Watchdog   → heartbeat timeout, auto-retry, data cleanup
└── Dashboard  → Web UI on port 4680 (Hono SSR)
```

Config file: `~/.config/opencode/supertask.json`

```json
{
  "configVersion": 2,
  "worker": { "maxConcurrency": 2, "taskTimeoutMs": 1800000 },
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
- **Auto-start** — Plugin auto-installs pm2 and starts Gateway on first use
- **Auto-upgrade** — Plugin detects version changes and auto-reloads Gateway
- **Process lock** — SQLite `BEGIN IMMEDIATE` ensures single instance
- **Heartbeat** — Worker updates every 30s; Watchdog kills stale processes
- **Exponential backoff** — 30s × 2^n, capped at 30min
- **Dead letter queue** — `maxRetries` additional retries exhausted → `dead_letter`, manually recoverable
- **Batch isolation** — Same `batchId` serial; different `batchId` parallel
- **Priority** — `urgency DESC → importance DESC → createdAt ASC`

## Web Dashboard

http://localhost:4680 — 4 pages:

| Page | Features |
|------|----------|
| Task Queue | Filter by status, retry, delete |
| Scheduled Tasks | Template CRUD, enable/disable, manual trigger |
| Execution Logs | task_runs history with session tracking |
| System Status | Config editor, concurrency monitor, clear database |

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

### 安装

在 `~/.config/opencode/opencode.json` 中添加：

```json
{
  "plugin": ["opencode-supertask"]
}
```

重启 OpenCode 即可。插件会自动：
- 安装 pm2 并启动 Gateway 常驻进程
- 注入 10 个 MCP 工具和 supertask-runner Agent
- 启动 Web 控制台（http://localhost:4680）

### 卸载

1. 运行 `supertask uninstall` 停止 Gateway
2. 从 `~/.config/opencode/opencode.json` 中移除 `"opencode-supertask"`
3. 重启 OpenCode

清理所有数据：`rm ~/.local/share/opencode/tasks.db`

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
- **自动启动** — 插件首次加载时自动安装 pm2 并启动 Gateway
- **自动升级** — 插件更新后自动检测版本变化并 reload Gateway
- **定时任务** — cron / delayed / recurring，支持友好时间格式
- **Web 控制台** — 任务监控、执行日志、在线配置、清空数据库
- **Session 追踪** — 自动从 opencode run 输出中捕获 session ID

### 数据位置

- 数据库：`~/.local/share/opencode/tasks.db`
- 配置：`~/.config/opencode/supertask.json`
