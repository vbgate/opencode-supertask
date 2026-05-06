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
| `gateway/` | Gateway 常驻进程（Worker + Scheduler + Watchdog） | `gateway/index.ts` |
| `web/` | Hono Web Dashboard (SSR) | `web/index.tsx` |
| `worker/` | Worker 引擎（被 Gateway 调用） | `worker/index.ts` |

## 核心文件

| 文件 | 用途 |
|------|------|
| `core/backoff.ts` | 统一指数退避算法 |
| `core/services/task-template.service.ts` | 调度模板 CRUD + 计算下次运行时间 |
| `gateway/config.ts` | Gateway 配置加载 |
| `gateway/scheduler/cron-parser.ts` | cron 表达式解析 |
| `gateway/scheduler/job-templates.ts` | 模板克隆 + max_instances 检查 |
| `gateway/watchdog/heartbeat.ts` | 心跳超时检测 + kill + 重试/死信 |
| `gateway/watchdog/cleanup.ts` | 过期记录清理 |

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
