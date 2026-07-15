# plugin/ 目录文档

> [输入]: @opencode-ai/plugin SDK，src/core/services 中的服务
> [输出]: OpenCode MCP 插件，注册工具集供 Agent 调用
> [定位]: 将 SuperTask 能力暴露给 OpenCode Agent 的插件层

## 文件

| 文件 | 导出 | 工具前缀 | 工具数量 |
|------|------|---------|---------|
| `supertask.ts` | `SuperTaskPlugin` | `supertask_` | 11 个（add/next/start/done/fail/status/retry/list/get/schedule/upgrade） |
| `task.ts` | `TaskPlugin` | `task_` | 7 个；旧架构兼容文件，不在当前 npm 导出链路 |

## 设计

- 使用 `@opencode-ai/plugin` SDK 的 `tool()` 注册
- 参数 schema 使用 zod 风格定义
- 创建任务和查询时使用当前 `process.cwd()` 作为项目隔离 cwd
- 插件初始化会迁移数据库；Gateway 未运行时只在 PM2 已存在的前提下尝试启动，不会安装全局依赖
- 返回值统一为 JSON 字符串

当前执行链路见 [`docs/architecture.md`](../docs/architecture.md)。
