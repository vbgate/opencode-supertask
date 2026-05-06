# plugin/ 目录文档

> [输入]: @opencode-ai/plugin SDK，src/core/services 中的服务
> [输出]: OpenCode MCP 插件，注册工具集供 Agent 调用
> [定位]: 将 SuperTask 能力暴露给 OpenCode Agent 的插件层

## 文件

| 文件 | 导出 | 工具前缀 | 工具数量 |
|------|------|---------|---------|
| `supertask.ts` | `SuperTaskPlugin` | `supertask_` | 10 个（add/next/start/done/fail/status/retry/list/get/schedule） |
| `task.ts` | `TaskPlugin` | `task_` | 7 个（add/next/start/done/fail/status/retry） |

## 设计

- 使用 `@opencode-ai/plugin` SDK 的 `tool()` 注册
- 参数 schema 使用 zod 风格定义
- 默认 `process.cwd()` 作为项目隔离 cwd
- 返回值统一为 JSON 字符串
