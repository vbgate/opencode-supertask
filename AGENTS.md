# AGENTS.md

## 项目概述

opencode-supertask — 面向 OpenCode Agent 的 SQLite 任务队列与调度器。发布形态包括 OpenCode 插件、`supertask` CLI，以及可前台运行或由 pm2 托管的单实例 Gateway；Gateway 内部同时运行 Worker、Scheduler、Watchdog 和 Web Dashboard。

## 系统链路

```text
OpenCode 插件 / CLI / Dashboard
              ↓
TaskService / TaskRunService / TaskTemplateService
              ↓
SQLite（tasks / task_runs / task_templates）
              ↑
Gateway ─ Worker + Scheduler + Watchdog + Dashboard
```

- 插件在 `plugin/supertask.ts` 注册 11 个 `supertask_*` 工具：`add/next/start/done/fail/status/retry/list/get/schedule/upgrade`。
- Worker 通过参数数组直接执行 `opencode run --agent <task.agent> --format json <task.prompt>`；退出码决定成功或失败，Gateway 统一写任务状态和执行记录。
- `agents/supertask-runner.md` 与 `plugin/task.ts` 是旧架构遗留，不是当前 npm 运行链路；不得重新接入嵌套 runner。
- pm2 是可选守护层：仅显式运行 `supertask install` 时允许安装；插件加载不得静默安装全局依赖。前台运行使用 `supertask gateway`。

## 技术栈

- Bun runtime + TypeScript (strict)
- Drizzle ORM + SQLite (bun:sqlite)
- Hono (Web Dashboard SSR)
- Commander (CLI)
- pm2 (Gateway 守护进程)
- bun:test (测试框架)

## 常用命令

```bash
bun install           # 安装依赖
bun test              # 运行所有测试
bun run build         # 构建 (tsup)
bun run typecheck     # TypeScript 类型检查
bun run dev           # CLI 开发模式
bun run gateway       # 启动 Gateway
bun run ui            # 单独启动 Web Dashboard
bun run db:generate   # 根据 Schema 生成 Drizzle migration
bun run db:migrate    # 手动运行数据库迁移
```

## 运行时数据

- 数据库默认位于 `~/.local/share/opencode/tasks.db`；测试或隔离运行通过 `SUPERTASK_DB_PATH` 覆盖。
- 配置文件位于 `~/.config/opencode/supertask.json`，默认值在 `src/gateway/config.ts`。
- 数据库初始化时启用 WAL、创建 `gateway_lock` 并自动执行 `drizzle/` migrations。
- Gateway 用 SQLite `BEGIN IMMEDIATE` + `gateway_lock` 保证单实例；Dashboard 默认只监听 `127.0.0.1:4680`。
- Dashboard 的浏览器写请求必须通过同源检查，数据库字符串进入 HTML 前必须调用 `esc`；API 的 ID、状态和配置不得直接断言类型。

## 核心业务约束

- 任务状态：`pending | running | done | failed | dead_letter | cancelled`；执行记录状态：`running | done | failed`。
- `cwd` 是任务的项目隔离键；插件默认使用提交任务时的 `process.cwd()`，查询和状态变更必须保持同一作用域。
- 队列顺序保持 `urgency DESC → importance DESC → createdAt ASC → id ASC`；同一 `batchId` 串行，不同批次可并行，依赖任务仅在 `dependsOn` 指向的任务完成后运行。
- `maxRetries` 表示首次执行之外允许的重试次数；失败任务按指数退避，耗尽后进入 `dead_letter`，手动重试会重置重试预算。
- `retryBackoffMs` 和 `timeoutMs` 可按任务覆盖；调度模板克隆时必须保留 `cwd/batchId/maxRetries/retryBackoffMs/timeoutMs`。
- Watchdog 的 `checkIntervalMs` 是心跳检查间隔，`cleanupIntervalMs` 是数据清理间隔，两者不可混用；配置经 `validateConfig` 校验后才允许运行或保存。
- 调度模板支持 `cron | delayed | recurring`，Scheduler 将模板克隆为普通任务并受 `maxInstances` 限制；`delayed` 成功生成一次后必须自动禁用。

## 代码规范

- 禁止 `any` 类型、`@ts-ignore`、`eslint-disable`
- 禁止注释掉代码，直接删除未使用代码
- 路径别名: `@core/*`, `@gateway/*`, `@worker/*`, `@web/*`, `@plugin/*`
- 所有 DB 查询涉及时间排序必须加 `id` 作为第二排序键（createdAt/startedAt 精度只到秒）
- SQL 中 `NOT IN` 对 NULL 值不生效，需加 `OR column IS NULL`
- `tasks.createdAt/startedAt/finishedAt` 与 `task_runs.startedAt/finishedAt` 是秒级时间；`retryAfter/scheduledAt/heartbeatAt/lockedAt` 和模板调度时间是毫秒值，比较时必须显式统一单位
- 修改 `src/core/db/schema.ts` 后运行 `bun run db:generate`，并提交对应的 `drizzle/*.sql` 和 `drizzle/meta/*`

## 测试规范

- 测试文件在 `tests/` 目录
- Mock DB 辅助: `tests/helpers/mock-db.ts` (使用内存 SQLite + bun:test mock.module)
- 涉及 DB 的单元测试在 `beforeEach` 中调用 `setupTestDb()`，纯函数测试不需要初始化 DB
- Service 层测试直接调用静态方法，不经过 CLI
- CLI 集成测试通过 `execSync` 子进程执行，并用临时 `SUPERTASK_DB_PATH`，不得读写用户真实数据库

## 发布流程

- 修改代码 → 测试通过 → `bun run build` → git commit/push
- 创建 GitHub Release 自动触发 CI 发布到 npm（需要 NPM_TOKEN secret）
- **不要手动 npm publish**，通过 `gh release create v<x.y.z>` 触发
- 升级版本号在 `package.json` 的 `version` 字段

## 项目结构

```
src/core/           # 核心业务（Service、DB、纯函数）
  db/schema.ts      # Drizzle 表定义 (tasks, task_runs, task_templates)
  db/index.ts       # DB 连接、自动迁移（惰性 Proxy 单例）
  services/         # TaskService, TaskRunService, TaskTemplateService
  backoff.ts        # 指数退避
  cron-parser.ts    # cron 表达式解析
  duration.ts       # 时间解析 (30s/5min/1h/2d/PT30M)
src/gateway/        # Gateway 主进程
  scheduler/        # 定时调度器 + 模板克隆
  watchdog/         # 心跳检测 + 过期清理
  config.ts         # 配置加载 + deepMerge
src/worker/         # Worker 并发池 (spawn opencode run)
src/cli/            # Commander CLI
src/web/            # Hono Web Dashboard
src/daemon/         # pm2 安装、启停与升级
plugin/             # OpenCode 插件入口和工具定义
agents/             # runner 提示词备份（非运行时来源）
drizzle/            # SQL migrations 与元数据
tests/              # bun:test 单元与 CLI 集成测试
```
