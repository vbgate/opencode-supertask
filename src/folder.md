# src/ 目录文档

> [输入]: 命令行参数、HTTP 请求、MCP 插件调用
> [输出]: 任务 CRUD 操作、Worker 调度、Web Dashboard
> [定位]: 项目核心源码，包含所有业务逻辑

## 子目录

| 目录 | 职责 | 入口文件 |
|------|------|---------|
| `cli/` | Commander CLI 命令行工具 | `cli/index.ts` |
| `core/db/` | 数据库连接、Schema、迁移 | `core/db/index.ts` |
| `core/services/` | 业务服务层 | `core/services/task.service.ts` |
| `web/` | Hono Web Dashboard (SSR) | `web/index.tsx` |
| `worker/` | 后台 Worker 调度引擎 | `worker/index.ts` |

## 路径别名

```json
{
  "@core/*": "src/core/*",
  "@worker/*": "src/worker/*",
  "@web/*": "src/web/*",
  "@plugin/*": "plugin/*"
}
```
