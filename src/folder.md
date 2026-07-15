# src/ 目录文档

> [输入]: 命令行参数、HTTP 请求、MCP 插件调用
> [输出]: 任务 CRUD 操作、Gateway 调度、Web Dashboard
> [定位]: 项目核心源码，包含所有业务逻辑

## 子目录

| 目录 | 职责 | 入口文件 |
|------|------|---------|
| `cli/` | Commander CLI 命令行工具 | `cli/index.ts` |
| `core/db/` | 数据库连接、Schema、迁移 | `core/db/index.ts` |
| `core/services/` | 业务服务层 | `core/services/task.service.ts` |
| `gateway/` | 单实例 Gateway（Worker + Scheduler + Watchdog + Dashboard） | `gateway/index.ts` |
| `web/` | Hono Web Dashboard（默认嵌入 Gateway，也可源码独立运行） | `web/index.tsx` |
| `worker/` | Worker 并发池，直接执行目标 Agent | `worker/index.ts` |
| `daemon/` | 可选 PM2 安装、启停与版本重启 | `daemon/pm2.ts` |

## 核心文件

| 文件 | 用途 |
|------|------|
| `core/backoff.ts` | 统一指数退避算法 |
| `core/cron-parser.ts` | cron 表达式校验与下一次运行时间 |
| `core/duration.ts` | CLI 友好时长与 ISO 8601 解析 |
| `core/services/task-template.service.ts` | 调度模板 CRUD + 计算下次运行时间 |
| `gateway/config.ts` | Gateway 配置加载、校验与 v1 兼容 |
| `gateway/scheduler/job-templates.ts` | 模板克隆 + `maxInstances` 检查 |
| `gateway/watchdog/heartbeat.ts` | 心跳超时检测 + kill + 重试/死信 |
| `gateway/watchdog/cleanup.ts` | 过期记录清理 |

架构和运行语义以 [`docs/architecture.md`](../docs/architecture.md) 为准。

## 路径别名

```json
{
  "@core/*": "src/core/*",
  "@worker/*": "src/worker/*",
  "@gateway/*": "src/gateway/*",
  "@web/*": "src/web/*",
  "@plugin/*": "plugin/*"
}
```
