# OpenCode SuperTask

AI Agent 任务调度系统 — OpenCode 插件 + CLI + Gateway 常驻进程。

基于 SQLite 的高性能任务队列，支持并发调度、定时任务、自动重试、心跳检测。

## 快速开始

```bash
# 安装
bun install -g opencode-supertask

# 初始化（创建配置 + 运行迁移）
supertask init

# 启动 Gateway（前台）
supertask gateway

# 后台运行（推荐 pm2）
pm2 start "supertask gateway" --name supertask-gateway

# 启动 Web Dashboard
supertask ui
# → http://localhost:3000
```

## OpenCode 集成

在 `opencode.json` 中注册插件：

```json
{
  "plugin": ["opencode-supertask"]
}
```

插件自动完成：
- 注册 10 个 `supertask_*` MCP 工具
- 注入 `supertask-runner` Agent（无需手动复制配置文件）
- 注入使用指南到 system prompt

## CLI 命令

```bash
supertask init                          # 初始化（配置 + 迁移）
supertask migrate                       # 运行数据库迁移
supertask gateway                       # 启动 Gateway（前台）
supertask ui                            # 启动 Web Dashboard
supertask config                        # 显示当前配置

# 任务管理
supertask add -n "任务名" -a "agent" -p "提示词" --importance 5
supertask list [--status pending] [--limit 20]
supertask get --id 1
supertask status
supertask cancel --id 1
supertask retry --id 1

# 定时任务模板
supertask template add --name "每日翻译" --agent "gen" --prompt "..." --type cron --cron "0 9 * * *"
supertask template list
supertask template enable --id 1
supertask template disable --id 1
```

## Gateway 架构

```
Gateway 进程（supertask gateway）
├── Worker         → 抢占 pending 任务，spawn supertask-runner 执行
├── Scheduler      → 定时克隆模板任务（cron/delayed/recurring）
└── Watchdog       → 心跳检测 + 自动重试 + 过期清理
```

配置文件：`~/.config/opencode/supertask.json`

```json
{
  "worker": {
    "maxConcurrency": 2,
    "pollIntervalMs": 1000,
    "heartbeatIntervalMs": 30000,
    "taskTimeoutMs": 1800000
  },
  "scheduler": {
    "enabled": true,
    "catchUp": "next"
  },
  "watchdog": {
    "heartbeatTimeoutMs": 600000,
    "cleanupIntervalMs": 60000,
    "retentionDays": 30
  }
}
```

核心机制：
- **进程锁**：SQLite `BEGIN IMMEDIATE`，保证单实例
- **心跳**：Worker 每 30s 更新，Watchdog 检测超时后 kill
- **自动重试**：指数退避（30s × 2^n，上限 30min）
- **死信队列**：超过重试次数 → `dead_letter`，可手动恢复
- **批次隔离**：同 batchId 串行，不同 batchId 并发
- **优先级**：urgency DESC → importance DESC → createdAt ASC

## 生产部署

### systemd

```bash
# 编辑 deploy/supertask-gateway.service，替换 bun 路径
cp deploy/supertask-gateway.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now supertask-gateway
journalctl --user -u supertask-gateway -f
```

### pm2

```bash
pm2 start "supertask gateway" --name supertask-gateway
pm2 logs supertask-gateway
pm2 restart supertask-gateway
```

## Web Dashboard

`supertask ui` 启动后访问 http://localhost:3000

四个页面：
- **任务队列**：状态筛选、分页、重试、删除
- **定时任务**：模板管理、启用/禁用、手动触发
- **执行日志**：task_runs 列表、日志查看
- **系统状态**：配置编辑、并发占用、队列统计

## 数据存储

- 数据库：`~/.local/share/opencode/tasks.db`（SQLite WAL）
- 配置：`~/.config/opencode/supertask.json`

## 从源码安装

```bash
git clone https://github.com/javazys/supertask.git
cd supertask
bun install
bun run build
supertask init
```
