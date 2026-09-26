# plugin/ 目录文档

> [输入]: @opencode-ai/plugin SDK，src/core/services 中的服务
> [输出]: OpenCode MCP 插件，注册工具集供 Agent 调用
> [定位]: 将 SuperTask 能力暴露给 OpenCode Agent 的插件层

## 文件

| 文件 | 导出 | 工具前缀 | 工具数量 |
|------|------|---------|---------|
| `supertask.ts` | 默认导出 `{ id, server, setup }`；具名 `SuperTaskPlugin`（1.x）、`setupSuperTaskV2`（2.x） | `supertask_` | 8 个（add/next/status/retry/list/get/schedule/upgrade） |

## 设计

- 工具只定义一次（`defineTool`，zod 参数）：OpenCode 1.2.20+ 读取 `default.server`，经 `tool()` 结构注册；OpenCode 2.x 读取 `default.setup`，经 `ctx.tool.transform` 注册同名工具，输入为同一 zod 定义生成的 JSON Schema，执行时再用 zod 校验
- 项目隔离 cwd：1.x 取工具上下文 `context.directory`，2.x 取插件实例的 `ctx.location.directory`（2.x 每个项目位置各有一个插件实例）；调用者传入的旧 `cwd` 参数不会改变作用域
- 系统说明：1.x 经 `experimental.chat.system.transform`，2.x 经 `session.hook("context")`
- 任务的 `running/done/failed` 状态只允许 Gateway Worker 写入，插件不再暴露绕过执行器的生命周期工具
- 插件初始化会迁移数据库；Gateway 未运行时只在 PM2 已存在的前提下尝试启动，不会安装全局依赖
- 返回值统一为 JSON 字符串（2.x 包装为 `{ content }`）

当前执行链路见 [`docs/architecture.md`](../docs/architecture.md)。
