# SuperTask

**AI-Powered Task Queue for OpenCode** — Schedule, retry, and manage batch jobs for AI agents.

[简体中文](#简体中文)

---

## Features

- **Task Queue** — SQLite-based, zero-config. Create, prioritize, batch, and schedule tasks.
- **Gateway Daemon** — Worker + Scheduler + Watchdog in one process. Auto-retry with exponential backoff.
- **CLI** — Full task & template management from the terminal.
- **Web Dashboard** — Real-time monitoring, execution logs, config editing.
- **OpenCode Plugin** — 10 MCP tools auto-injected. Agent auto-registered. Zero setup.
- **Batch Isolation** — Same-batch tasks run serially; different batches run in parallel.
- **Priority Scheduling** — `urgency` × `importance` × FIFO.

## Quick Start

```bash
bun install -g opencode-supertask
supertask init        # create config + run migrations
supertask gateway     # start gateway (foreground)
supertask ui          # web dashboard → http://localhost:3000
```

### OpenCode Integration

```jsonc
// opencode.json
{
  "plugin": ["opencode-supertask"]
}
```

That's it. 10 MCP tools (`supertask_add`, `supertask_next`, etc.) and the `supertask-runner` agent are auto-injected.

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
supertask gateway                       # start gateway
supertask ui                            # start web dashboard
supertask config                        # show config

supertask add -n "Task" -a "agent" -p "prompt" --importance 5
supertask list [--status pending]
supertask status
supertask retry --id 1

supertask template add --name "Daily" --agent "gen" \
  --prompt "..." --type cron --cron "0 9 * * *"
supertask template list
supertask template enable --id 1
```

## Architecture

```
Gateway (supertask gateway)
├── Worker     → claim tasks, spawn supertask-runner via opencode
├── Scheduler  → clone tasks from templates (cron/delayed/recurring)
└── Watchdog   → heartbeat timeout detection, auto-retry, cleanup
```

Config: `~/.config/opencode/supertask.json`

```json
{
  "worker": { "maxConcurrency": 2 },
  "scheduler": { "enabled": true, "catchUp": "next" },
  "watchdog": { "heartbeatTimeoutMs": 600000, "retentionDays": 30 }
}
```

Key mechanisms:
- **Process lock**: SQLite `BEGIN IMMEDIATE` ensures single instance
- **Heartbeat**: Worker updates every 30s; Watchdog kills stale processes
- **Exponential backoff**: 30s × 2^n, capped at 30min
- **Dead letter queue**: Exhausted retries → `dead_letter`, manually recoverable
- **Batch isolation**: Same `batchId` → serial; different `batchId` → parallel

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

### 功能亮点

- **任务队列** — 零配置 SQLite 驱动，支持优先级、批次、依赖
- **Gateway 常驻进程** — Worker + Scheduler + Watchdog 三合一，自动重试 + 指数退避
- **CLI 工具** — 完整的任务和模板管理命令
- **Web 控制台** — 实时监控、执行日志、在线编辑配置
- **OpenCode 插件** — 10 个 MCP 工具自动注入，supertask-runner Agent 自动注册
- **批次隔离** — 同批次串行，不同批次并行，互不阻塞

### 快速开始

```bash
bun install -g opencode-supertask
supertask init        # 初始化配置 + 数据库
supertask gateway     # 启动 Gateway（前台）
supertask ui          # Web 控制台 → http://localhost:3000
```

在 `opencode.json` 中注册插件：

```jsonc
{
  "plugin": ["opencode-supertask"]
}
```

后台运行推荐 pm2：

```bash
pm2 start "supertask gateway" --name supertask-gateway
```

### 数据位置

- 数据库：`~/.local/share/opencode/tasks.db`
- 配置：`~/.config/opencode/supertask.json`
