# AGENTS.md

## 项目概述

opencode-supertask — AI Agent 任务调度系统，作为 OpenCode 插件运行。提供 CLI、Gateway 常驻进程、Web Dashboard。

## 技术栈

- Bun runtime + TypeScript (strict)
- Drizzle ORM + SQLite (bun:sqlite)
- Hono (Web Dashboard SSR)
- Commander (CLI)
- pm2 (Gateway 守护进程)
- bun:test (测试框架)

## 常用命令

```bash
bun test              # 运行所有测试
bun run build         # 构建 (tsup)
bun run typecheck     # TypeScript 类型检查
bun run dev           # CLI 开发模式
bun run gateway       # 启动 Gateway
bun run ui            # Web Dashboard
```

## 代码规范

- 禁止 `any` 类型、`@ts-ignore`、`eslint-disable`
- 禁止注释掉代码，直接删除未使用代码
- 路径别名: `@core/*`, `@gateway/*`, `@worker/*`, `@web/*`, `@plugin/*`
- 所有 DB 查询涉及时间排序必须加 `id` 作为第二排序键（createdAt/startedAt 精度只到秒）
- SQL 中 `NOT IN` 对 NULL 值不生效，需加 `OR column IS NULL`

## 测试规范

- 测试文件在 `tests/` 目录
- Mock DB 辅助: `tests/helpers/mock-db.ts` (使用内存 SQLite + bun:test mock.module)
- 每个测试文件独立初始化 DB (`beforeEach → setupTestDb()`)
- Service 层测试直接调用静态方法，不经过 CLI
- CLI 集成测试通过 `execSync` 子进程执行

## 发布流程

- 修改代码 → 测试通过 → `bun run build` → git commit/push
- 创建 GitHub Release 自动触发 CI 发布到 npm（需要 NPM_TOKEN secret）
- **不要手动 npm publish**，通过 `gh release create v<x.y.z>` 触发
- 升级版本号在 `package.json` 的 `version` 字段

## 项目结构

```
src/core/           # 核心业务（Service、DB、纯函数）
  db/schema.ts      # Drizzle 表定义 (tasks, task_runs, task_templates)
  db/index.ts       # DB 连接（全局 Proxy 单例）
  services/         # TaskService, TaskRunService, TaskTemplateService
  backoff.ts        # 指数退避
  cron-parser.ts    # cron 表达式解析
  duration.ts       # 时间解析 (30s/5min/1h/2d/PT30M)
src/gateway/        # Gateway 主进程
  scheduler/        # 定时调度器 + 模板克隆
  watchdog/         # 心跳检测 + 过期清理
  config.ts         # 配置加载 + deepMerge
src/worker/         # Worker 执行引擎 (spawn opencode run)
src/cli/            # Commander CLI
src/web/            # Hono Web Dashboard
src/daemon/         # pm2 进程管理
plugin/             # OpenCode 插件入口 (supertask_*/supertask_schedule 工具)
```
