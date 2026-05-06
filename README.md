# SuperTask

[![npm version](https://img.shields.io/npm/v/opencode-supertask.svg)](https://www.npmjs.com/package/opencode-supertask)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

AI-powered task queue for [OpenCode](https://opencode.ai) agents — schedule, retry, and manage batch jobs with SQLite.

[简体中文](#简体中文)

## Installation

### Let an LLM do it

Paste this into any LLM agent (Claude Code, OpenCode, Cursor, etc.):

```
Install the opencode-supertask plugin by following: https://raw.githubusercontent.com/vbgate/opencode-supertask/main/README.md
```

<details>
<summary><b>Instructions for LLM agents</b></summary>

To install this plugin, perform these steps:

1. Add `"opencode-supertask"` to the `plugin` array in `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["opencode-supertask"]
}
```

2. Tell the user to restart OpenCode.

After restart, the plugin auto-injects:
- 10 MCP tools (`supertask_add`, `supertask_next`, `supertask_start`, `supertask_done`, `supertask_fail`, `supertask_get`, `supertask_list`, `supertask_status`, `supertask_retry`, `supertask_schedule`)
- A `supertask-runner` agent (used internally by the Gateway)
- Usage instructions in the system prompt

</details>

### Manual Installation

1. Add the plugin to your `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["opencode-supertask"]
}
```

2. Restart OpenCode

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

```bash
# Install globally for CLI + Gateway
bun install -g opencode-supertask

# Initialize (create config + run migrations)
supertask init

# Start Gateway (foreground)
supertask gateway

# Start Web Dashboard
supertask ui          # → http://localhost:3000
```

### Background Running

```bash
# pm2 (recommended)
pm2 start "supertask gateway" --name supertask-gateway

# systemd
cp deploy/supertask-gateway.service ~/.config/systemd/user/
systemctl --user enable --now supertask-gateway
```

## CLI Reference

```bash
supertask init                          # init config + db
supertask migrate                       # run migrations
supertask gateway                       # start gateway (foreground)
supertask ui                            # start web dashboard
supertask config                        # show current config

# Task management
supertask add -n "Task" -a "agent" -p "prompt" --importance 5
supertask list [--status pending] [--limit 20]
supertask get --id 1
supertask status
supertask cancel --id 1
supertask retry --id 1

# Scheduled templates
supertask template add --name "Daily" --agent "gen" \
  --prompt "..." --type cron --cron "0 9 * * *"
supertask template list
supertask template enable --id 1
```

## Architecture

```
Gateway (supertask gateway)
├── Worker     → claim tasks, spawn supertask-runner via opencode
├── Scheduler  → clone tasks from templates (cron / delayed / recurring)
└── Watchdog   → heartbeat timeout, auto-retry, data cleanup
```

Config file: `~/.config/opencode/supertask.json`

```json
{
  "worker": { "maxConcurrency": 2, "defaultModel": "zhipuai-coding-plan/glm-4.7" },
  "scheduler": { "enabled": true, "catchUp": "next" },
  "watchdog": { "heartbeatTimeoutMs": 600000, "retentionDays": 30 }
}
```

Key mechanisms:
- **Process lock** — SQLite `BEGIN IMMEDIATE` ensures single instance
- **Heartbeat** — Worker updates every 30s; Watchdog kills stale processes
- **Exponential backoff** — 30s × 2^n, capped at 30min
- **Dead letter queue** — Exhausted retries → `dead_letter`, manually recoverable
- **Batch isolation** — Same `batchId` serial; different `batchId` parallel
- **Priority** — `urgency DESC → importance DESC → createdAt ASC`

## Web Dashboard

`supertask ui` starts a dashboard at http://localhost:3000 with 4 pages:

| Page | Features |
|------|----------|
| Task Queue | Filter by status, retry, delete |
| Scheduled Tasks | Template CRUD, enable/disable, manual trigger |
| Execution Logs | task_runs history, log viewer |
| System Status | Config editor, concurrency monitor, stats |

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

#### 让 AI 帮你装

把这段话粘贴到任意 LLM agent（Claude Code、OpenCode、Cursor 等）：

```
安装 opencode-supertask 插件，参照：https://raw.githubusercontent.com/vbgate/opencode-supertask/main/README.md
```

#### 手动安装

在 `~/.config/opencode/opencode.json` 中添加：

```json
{
  "plugin": ["opencode-supertask"]
}
```

重启 OpenCode 即可。插件会自动注入 10 个 MCP 工具、supertask-runner Agent 和使用说明。

### 快速开始

```bash
bun install -g opencode-supertask
supertask init        # 初始化
supertask gateway     # 启动 Gateway
supertask ui          # Web 控制台
```

### 核心功能

- **任务队列** — 优先级调度、批次隔离、依赖管理
- **Gateway 常驻进程** — Worker + Scheduler + Watchdog，自动重试 + 指数退避
- **定时任务** — 支持 cron / delayed / recurring 三种调度类型
- **Web 控制台** — 任务监控、执行日志、在线配置
- **CLI 工具** — 完整的命令行管理

### 数据位置

- 数据库：`~/.local/share/opencode/tasks.db`
- 配置：`~/.config/opencode/supertask.json`
