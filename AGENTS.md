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

- 插件在 `plugin/supertask.ts` 注册 8 个 `supertask_*` 工具：`add/next/status/retry/list/get/schedule/upgrade`；运行态与执行终态只允许 Gateway 写入，不得恢复外部 `start/done/fail`。
- Worker 通过参数数组直接执行 `opencode run --agent <task.agent> --format json <task.prompt>`；退出码决定成功或失败，Gateway 统一写任务状态和执行记录。
- `agents/supertask-runner.md` 与 `plugin/task.ts` 是旧架构遗留，不是当前 npm 运行链路；不得重新接入嵌套 runner。
- pm2 是可选守护层：仅显式运行 `supertask install` 时允许安装；插件加载不得静默安装全局依赖。前台运行使用 `supertask gateway`。

## 技术栈

- Bun runtime + TypeScript (strict)
- Drizzle ORM + SQLite (bun:sqlite)
- Hono (Web Dashboard SSR)
- Commander (CLI)
- pm2 (可选的 Gateway 守护进程)
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
bun run dev -- db check  # 检查数据库完整性与业务统计
```

## 运行时数据

- 数据库默认位于 `~/.local/share/opencode/tasks.db`；测试或隔离运行通过 `SUPERTASK_DB_PATH` 覆盖。
- 配置文件位于 `~/.config/opencode/supertask.json`，默认值在 `src/gateway/config.ts`。
- 数据库初始化时启用 WAL、创建 `gateway_lock` 并自动执行 `drizzle/` migrations。
- Gateway 用 SQLite `BEGIN IMMEDIATE` + `gateway_lock` 保证单实例；Dashboard 默认只监听 `127.0.0.1:4680`。
- Gateway 仅在 Worker、Scheduler、Watchdog 和 Dashboard 启动完成后写入 `gateway_lock.ready_at`；PM2 `online` 不能单独作为就绪依据，进程 PID 必须匹配新鲜 ready 锁。
- `/health` 必须同时反映组件活跃度和连续失败；`supertask doctor` 汇总 OpenCode、数据库、PM2 ready 锁、Dashboard 与日志轮转。显式 `supertask install` 配置有限保留的 PM2 日志轮转。
- 数据库检查、备份、清空和恢复统一经过 `DatabaseMaintenanceService`；CLI 清空/恢复必须显式确认并拒绝运行中任务，且只可自动停启 PID 与当前数据库新鲜 ready 锁一致的 PM2 Gateway；前台或无法确认归属的进程必须拒绝误杀。清空/恢复前必须自动创建校验通过的安全备份，默认在操作失败时也恢复原 Gateway 状态，`--keep-stopped` 除外。
- Dashboard 清空只能豁免当前 Gateway PID，仍必须服务端确认、拒绝运行中任务并在同一事务内先备份后删除；不得恢复为直接 `DELETE` 三张表的路由实现。
- Dashboard 的浏览器写请求必须通过同源检查，数据库字符串进入 HTML 前必须调用 `esc`；API 的 ID、状态和配置不得直接断言类型。

## 文档维护

- `docs/architecture.md` 是当前组件边界、执行链路和架构决策的权威说明；`docs/operations.md` 是配置、启停、重试和排障的权威说明。
- `docs/plans/` 与 `doc/项目分析.md` 是历史资料，不得据此恢复 systemd、独立 Dashboard 或嵌套 `supertask-runner`。
- 架构、状态语义、配置默认值或运行命令变化时，在同一提交中同步 `README.md`、`docs/architecture.md`、`docs/operations.md` 和本文件中的相关内容。

## 核心业务约束

- 任务状态：`pending | running | done | failed | dead_letter | cancelled`；执行记录状态：`running | done | failed`。
- `cwd` 是任务的项目隔离键；插件必须使用 OpenCode 工具上下文的 `directory`，不得信任模型传入的 `cwd`，查询和状态变更必须保持同一作用域。
- 队列顺序保持 `urgency DESC → importance DESC → createdAt ASC → id ASC`；全局并发和同一 `batchId` 串行必须依据数据库运行态，在 Gateway 重启后仍成立；不同批次可并行，依赖任务仅在同 cwd 的 `dependsOn` 完成后运行。
- `maxRetries` 表示首次执行之外允许的重试次数；失败任务按指数退避，耗尽后进入 `dead_letter`，手动重试会重置重试预算。
- `retryBackoffMs` 和 `timeoutMs` 可按任务覆盖；调度模板克隆时必须保留 `cwd/batchId/maxRetries/retryBackoffMs/timeoutMs`。
- 运行中任务进入 `cancelled` 后，Worker 必须在轮询周期内终止对应进程树并关闭 run；Gateway 关闭时先按 `shutdownGracePeriodMs` drain，只有剩余任务才重置为 `pending`。
- 删除任务必须拒绝 `running` 状态、仍有 `running` 执行记录，或仍被 `pending/running/failed/dead_letter` 任务依赖的前置任务；手动删除与过期清理都必须防止子进程失联和依赖悬空。
- Watchdog 处理数据库中的旧 PID 前必须校验进程命令与配置的 OpenCode 可执行文件匹配；Unix 上仅对确认的独立进程组发送信号。
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
- `db check/backup/clear/restore` 的交互式 stdout 必须人类可读；非 TTY 或显式 `--json` 必须保持可解析 JSON，成功与错误都要覆盖这三种模式
- `db check` 报告 `ok=false` 时必须返回非零退出码；CLI 数字参数必须完整匹配整数，不得用 `parseInt` 接受尾随字符或截断小数
- Gateway 构建产物 E2E 必须使用隔离数据库和假 OpenCode 可执行文件覆盖普通任务、失败重试、`delayed`、`recurring` 和 `cron`，不得为测试调用真实模型

## 发布流程

- 修改代码 → 测试通过 → `bun run build` → git commit/push
- 创建 GitHub Release 自动触发 CI 发布到 npm；工作流通过 npm Trusted Publisher/OIDC 获取短期发布凭据，不使用长期 `NPM_TOKEN`
- npm 包设置必须信任仓库 `vbgate/opencode-supertask` 的 `publish.yml`，Allowed actions 仅启用 `npm publish`
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
  config.ts         # 配置加载、校验与 v1 兼容
src/worker/         # Worker 并发池 (spawn opencode run)
src/cli/            # Commander CLI
src/web/            # Hono Web Dashboard
src/daemon/         # pm2 安装、启停与升级
plugin/             # OpenCode 插件入口和工具定义
agents/             # runner 提示词备份（非运行时来源）
docs/               # 当前架构、运维手册与历史设计资料
drizzle/            # SQL migrations 与元数据
tests/              # bun:test 单元与 CLI 集成测试
```
