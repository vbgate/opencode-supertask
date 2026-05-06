# OpenCode SuperTask (OST)

SuperTask 是一个基于 SQLite 的高性能任务队列管理系统，专为 OpenCode Agent 设计。它允许你批量创建任务、管理依赖，并通过后台 Worker 自动调度 Agent 执行。

## 核心特性

- **SQLite 驱动**：轻量、快速，无需额外数据库服务。
- **CLI 管理**：提供完整的命令行工具进行任务增删改查。
- **Agent 集成**：通过 MCP 插件将任务能力暴露给 OpenCode Agent。
- **Gateway 常驻进程**：集成 Worker + Scheduler + Watchdog，支持心跳检测、自动重试、定时任务、过期清理。
- **并发安全**：基于 SQLite 进程锁保证单实例运行，batchId 级别的同组串行隔离。

## 安装与配置

### 前置条件

- [Bun](https://bun.sh) >= 1.0
- [OpenCode](https://opencode.ai) CLI

### 1. 克隆并安装

```bash
git clone https://github.com/javazys/supertask.git ~/code/supertask
cd ~/code/supertask
bun install
```

### 2. 初始化数据库

数据库位于 `~/.local/share/opencode/tasks.db`，首次运行自动创建。

```bash
bun run db:migrate
```

### 3. 部署 Runner Agent

```bash
mkdir -p ~/.config/opencode/agent
cp agents/supertask-runner.md ~/.config/opencode/agent/
```

### 4. 注册 OpenCode 插件

在你的 OpenCode 配置文件（`opencode.json`）中注册：

```json
{
  "plugin": [
    "/your/path/to/supertask"
  ]
}
```

构建插件：

```bash
bun run build
```

### 5. 启动 Gateway

前台运行（调试）：

```bash
bun run gateway
```

systemd 常驻（生产）：

```bash
# 编辑 deploy/supertask-gateway.service，将路径替换为实际路径
cp deploy/supertask-gateway.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now supertask-gateway

# 查看日志
journalctl --user -u supertask-gateway -f
```

---

## CLI 使用指南

### 任务管理

```bash
supertask add --name "任务名称" --agent "localize-gen" --prompt "提示词..." --importance 5
supertask list [--status pending] [--batch <id>] [--limit 20]
supertask get --id 1
supertask status [--batch <id>]
supertask cancel --id 1
supertask delete --id 1
supertask retry --id 1              # 重试单个失败/死信任务
supertask retry --batch <batchId>   # 批量重试
```

### 调度模板管理

```bash
supertask template add \
  --name "每日翻译" \
  --agent "localize-gen" \
  --prompt "翻译所有未翻译的文档" \
  --type cron \
  --cron "0 9 * * *" \
  --max-instances 2

supertask template list
supertask template enable --id 1
supertask template disable --id 1
supertask template delete --id 1
```

支持三种调度类型：`cron`（cron 表达式）、`delayed`（定时执行）、`recurring`（固定间隔循环）。

---

## Runner Agent

**配置文件**：`~/.config/opencode/agent/supertask-runner.md`（项目备份：`agents/supertask-runner.md`）

手动运行：

```bash
opencode run --agent supertask-runner
```

Gateway 自动调用，通常不需要手动执行。

## Web Dashboard

```bash
bun run ui
# 打开 http://localhost:3000
```

只读视图，展示任务列表、状态统计、执行记录，支持重试和删除操作。与 Gateway 共享同一个 SQLite 数据库，可以同时运行。

---

## Gateway（常驻进程）

Gateway 是 SuperTask 的核心运行时，集成了 Worker、Scheduler 和 Watchdog。

### 启动

```bash
bun run gateway
```

或通过 systemd（参见 `deploy/supertask-gateway.service`）。

### 架构

```
Gateway 进程
├── Worker         → 抢占 pending 任务，spawn supertask-runner 执行
├── Scheduler      → 定时克隆模板任务（cron/delayed/recurring）
└── Watchdog       → 心跳检测 + 过期清理
```

### 配置

配置文件：`~/.config/opencode/supertask.json`，未创建时使用默认值。

```json
{
  "worker": {
    "maxConcurrency": 2,
    "pollIntervalMs": 1000,
    "heartbeatIntervalMs": 30000,
    "taskTimeoutMs": 1800000,
    "defaultModel": "zhipuai-coding-plan/glm-4.7"
  },
  "scheduler": {
    "enabled": true,
    "checkIntervalMs": 1000,
    "catchUp": "next"
  },
  "watchdog": {
    "heartbeatTimeoutMs": 600000,
    "cleanupIntervalMs": 60000,
    "retentionDays": 30
  }
}
```

### 核心机制

- **进程锁**：基于 SQLite `BEGIN IMMEDIATE`，保证单实例运行
- **心跳**：Worker 每 30s 更新 task_runs.heartbeat_at，Watchdog 检测超时后 kill 进程
- **自动重试**：失败任务按指数退避（30s × 2^n，上限 30min）自动重试
- **死信队列**：重试次数耗尽后标记为 `dead_letter`，可通过 `retry` 命令手动恢复
- **批次隔离**：同一 batchId 的任务串行执行，不同 batchId 并发
- **优先级**：urgency DESC → importance DESC → createdAt ASC
