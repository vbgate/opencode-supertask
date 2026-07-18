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
- Worker 先启动等待握手的 launcher，持久化 launcher PID 后才通过参数数组执行 `opencode run --agent <task.agent> --format json <task.prompt>`；新 run 使用 `gated-v3-token-guardian`，每 run UUID 必须同时写入 `task_runs.locked_by` 和 launcher argv。launcher 只能在整个进程组排空后通过不传递给 OpenCode 的 IPC 发回绑定 UUID 的证明；无证明退出必须隔离，不得结算或释放批次。退出码决定成功或失败，Gateway 统一写任务状态和执行记录。当前只有 Unix 独立进程组能提供可恢复的整树退出证明；Windows 在引入 Job Object 前必须拒绝启动 Worker，不得退回不完整的父子 PID 扫描。
- Worker 校验 drain proof 后必须通过同一 IPC 回送绑定 UUID 的确认，launcher 收件后才退出；不得依赖旧 Bun 不可靠的 `process.send` callback。最低支持 Bun 1.1.45，CI 必须用该版本真实执行构建后的 launcher IPC smoke test。
- Worker 启动的受管 OpenCode 进程设置 `SUPERTASK_MANAGED_RUN=1`；该上下文必须拒绝 `supertask_upgrade`，避免升级流程删除并等待承载自己的 Gateway。升级只能从外部 CLI 或非队列 OpenCode 会话发起。
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
- 从 `0005` 起 migration 必须遵循 expand/contract 并保持 N-1 二进制兼容：只允许新增表、非唯一索引，以及可空或带默认值的新增列。删除、重命名、收紧约束和数据改写必须延后到旧版本不再是自动回滚目标后执行；测试会拒绝破坏该约束的 SQL。
- Gateway 用 SQLite `BEGIN IMMEDIATE` + `gateway_lock` 保证单实例；进程身份必须同时识别直接 Gateway 入口与公开的 `supertask gateway`/CLI 入口。Dashboard 默认只监听 `127.0.0.1:4680`。
- Gateway 必须先完成恢复收敛、Scheduler 初始化和 Dashboard 绑定，最后才启动 Worker，并把包版本与 `gateway_lock.ready_at` 一起写入；PM2 `online` 不能单独作为就绪依据，进程 PID、版本和运行作用域必须匹配新鲜 ready 锁。
- PM2 替换已有 Gateway 前必须先用保存的运行环境验证管理命令可执行；若新旧进程无法共用同一可回滚的 PM2 管理路径，必须在删除旧进程前失败关闭。
- PM2 替换、数据库维护、卸载与 macOS supervisor 检查必须先共用 `PM2_HOME/supertask-gateway.manage.sqlite` canonical SQLite 事务锁；兼容旧 custom lock 时还必须从 PM2 dump/运行环境和 LaunchAgent 恢复全部旧路径，并按固定顺序同时持有，不能因后续 CLI 缺少旧环境变量而绕过旧 supervisor。已安装 LaunchAgent 的 `PM2_HOME` 与当前 CLI 不同必须在任何修改前失败关闭，避免两个 PM2 daemon 争用同一 Gateway。不得恢复 PID/stale 文件锁。PM2 kill timeout 不得低于 Worker shutdown grace 加 15 秒，`stop/delete` 命令 timeout 不得低于实际 kill timeout 加 5 秒，管理锁必须持有到命令返回；显式低值必须在删除旧进程前失败关闭。
- macOS supervisor 只有在 `jlist` 成功且确认 Gateway 缺失、同时 `dump.pm2` 明确包含 Gateway 时才可 `resurrect`；状态未知、`errored`、`stopped` 和卸载后的空 dump 都不得触发重启。卸载必须停止并移除项目 LaunchAgent。
- `/health` 必须分别反映 Worker、Scheduler、Watchdog 和历史清理的活跃度与连续失败；`supertask doctor` 还要解析 OpenCode 最终配置，要求唯一的精确插件版本，核对对应缓存、PM2 实际 Gateway 入口包和 ready 锁版本，并验证 macOS LaunchAgent 与 PM2 dump 可恢复性。浮动 `@latest`/`@next` Gateway 入口必须失败；全局 CLI 版本不同只提示按原包管理器更新。PM2 替换/回滚必须保留既有 Bun 路径、完整运行环境和数据库作用域。
- 数据库检查、备份、清空和恢复统一经过 `DatabaseMaintenanceService`；CLI 清空/恢复必须显式确认并拒绝运行中任务，且只可自动停启 PID 与当前数据库新鲜 ready 锁一致的 PM2 Gateway；前台或无法确认归属的进程必须拒绝误杀。清空/恢复前必须自动创建校验通过的安全备份；清空必须动态删除全部业务表数据（包括 N+1 expand-only 表），通过延迟外键检查支持循环依赖，并保留 `gateway_lock` 与 migration 元数据。恢复来源必须从已打开的 SQLite 连接生成包含已提交 WAL 页的一致快照，并拒绝当前数据库的符号链接/硬链接别名。恢复必须动态校验 source/live 业务表和可写列：source-only 未知表/列在删除前失败关闭，共有未来列完整复制，live-only 列只允许可空/默认值且 live-only 新表必须清空，避免 N/N-1 形成混合时间点；随后在当前连接的排他事务内原位替换，不得关闭连接后 rename 换库。默认在操作失败时也恢复原 Gateway 状态，`--keep-stopped` 除外。
- Dashboard 清空只能豁免当前 Gateway PID，仍必须服务端确认、拒绝运行中任务并在同一事务内先备份后动态删除全部业务表；不得恢复为路由内直接 `DELETE` 的实现。
- Dashboard 的浏览器写请求必须通过同源检查，数据库字符串进入 HTML 前必须调用 `esc`；API 的 ID、状态和配置不得直接断言类型。
- Dashboard 必须区分配置文件中的保存值和 Gateway 启动时的运行值；网页自动重启只允许当前 PID、新鲜 ready 锁和运行作用域均匹配的 PM2 Gateway，并必须先返回 HTTP 响应再触发既有优雅退出，由 PM2 自动拉起。前台 Gateway 不得显示可用的自动重启入口。

## 文档维护

- `docs/architecture.md` 是当前组件边界、执行链路和架构决策的权威说明；`docs/operations.md` 是配置、启停、重试和排障的权威说明。
- `docs/plans/` 与 `doc/项目分析.md` 是历史资料，不得据此恢复 systemd、独立 Dashboard 或嵌套 `supertask-runner`。
- 架构、状态语义、配置默认值或运行命令变化时，在同一提交中同步 `README.md`、`docs/architecture.md`、`docs/operations.md` 和本文件中的相关内容。

## 核心业务约束

- 任务状态：`pending | running | done | failed | dead_letter | cancelled`；执行记录状态：`running | done | failed`。
- `cwd` 是任务的项目分组、隔离键和 OpenCode 工作目录；插件必须使用 OpenCode 工具上下文的 `directory`，不得信任模型传入的 `cwd`，查询和状态变更必须保持同一作用域。任务/模板入库前必须验证非空 `cwd` 是已存在的绝对目录；Worker 取到非法遗留目录时必须记录失败并直接进入 `dead_letter`，不得启动 OpenCode 或自动重试刷错。Dashboard 分组保持 `cwd → batchId → tasks`，不得另建会与任务漂移的项目表。
- 队列顺序保持 `urgency DESC → importance DESC → createdAt ASC → id ASC`；全局并发和同一 `batchId` 串行必须依据数据库运行态，在 Gateway 重启后仍成立；不同批次可并行，依赖任务仅在同 cwd 的 `dependsOn` 完成后运行。
- `maxRetries` 表示首次执行之外允许的重试次数；失败任务按指数退避，耗尽后进入 `dead_letter`。手动重试必须在同一写事务内确认依赖仍存在、同 `cwd` 且可恢复或已完成，才可重置重试预算，避免和历史清理并发制造悬空 `pending`。
- `retryBackoffMs` 和 `timeoutMs` 可按任务覆盖；调度模板克隆时必须保留 `cwd/batchId/maxRetries/retryBackoffMs/timeoutMs`。
- 运行中任务进入 `cancelled` 后，Worker 必须在轮询周期内终止对应进程树并关闭 run；只有确认整棵进程树退出后才能关闭、重试、释放批次或在 Gateway 停机时重置为 `pending`，否则必须保持隔离。
- 删除任务必须拒绝 `running` 状态、仍有 `running` 执行记录，或仍被 `pending/running/failed/dead_letter` 任务依赖的前置任务；手动删除与过期清理都必须防止子进程失联和依赖悬空。
- Watchdog 处理当前 guardian PID 前必须同时校验 launcher 路径、配置的 OpenCode 参数和 `locked_by` 中的每 run UUID；旧 v2/legacy 记录只要 PID/PGID 仍存活或无法确认就必须隔离且不得发信号，只有二者均明确消失才可恢复。组长已退出但进程组仍存活时不得按 `not-running` 恢复。旧版 `started_at`/`heartbeat_at` 同时为 NULL 的 running run 必须视为 stale 并按协议隔离，不得永久占用并发且逃逸诊断。Unix 使用独立进程组；Windows 在 Job Object 隔离完成前禁止启动 Worker。
- 旧版无 child PID 的 run 默认保持隔离；`run abandon` 只允许 `launch_protocol IS NULL`、owner PID 已退出、child PID 为空且关联任务已取消的记录，并要求显式 `ABANDON` 确认。未知非空协议和当前 guardian 协议必须 fail-closed。
- Watchdog 的 `checkIntervalMs` 是心跳检查间隔，`cleanupIntervalMs` 是数据清理间隔，两者不可混用；配置经 `validateConfig` 校验后才允许运行或保存。
- 调度模板支持 `cron | delayed | recurring`，Scheduler 自动克隆普通任务时受 `maxInstances` 限制；Dashboard 手动“立即运行一次”必须始终入队，但创建的任务仍计入后续自动调度的活跃实例数，并受 Worker 全局并发限制；`delayed` 自动生成一次后必须自动禁用。
- Dashboard 可创建和编辑定时任务，写入必须复用 `TaskTemplateService` 校验；编辑必须在即时事务内重算 `nextRunAt`，保留启用状态和历史执行时间，只影响以后生成的任务。Scheduler 克隆前必须核对扫描到的触发时间，防止并发编辑后按旧时间提前执行。
- Dashboard 可创建普通任务，必须暴露项目目录、模型、Agent、提示词、重要/紧急程度、批次、重试和超时，并在项目分组中显示运行、排队和异常数量；创建只负责持久入队，不得因 Worker 并发已满而拒绝。
- 普通任务编辑必须经 `TaskService` 同时服务 Dashboard 与 CLI，只允许 `pending/failed/dead_letter`，且不得修改 `cwd/dependsOn`；运行中和完成/取消终态拒绝修改。降低失败任务重试预算导致现有次数超限时必须立即收敛到 `dead_letter`。
- Dashboard 继续会话命令必须按 run ID 从服务端读取并校验 Session ID 后生成，不得把完整 Session ID 直接写入 HTML 或未经校验拼接成终端命令。
- `cron/recurring` 达到 `maxInstances` 时必须推进下一触发点，`delayed` 保持等待；到期模板扫描必须有界。不可恢复依赖应在状态事件中递归收敛，下游链不得在每个 Worker poll 全局扫描。

## 代码规范

- 禁止 `any` 类型、`@ts-ignore`、`eslint-disable`
- 禁止注释掉代码，直接删除未使用代码
- 路径别名: `@core/*`, `@gateway/*`, `@worker/*`, `@web/*`, `@plugin/*`
- 所有 DB 查询涉及时间排序必须加 `id` 作为第二排序键（createdAt/startedAt 精度只到秒）
- SQL 中 `NOT IN` 对 NULL 值不生效，需加 `OR column IS NULL`
- `tasks.createdAt/startedAt/finishedAt` 与 `task_runs.startedAt/finishedAt` 是秒级时间；`retryAfter/scheduledAt/heartbeatAt/lockedAt` 和模板调度时间是毫秒值，比较时必须显式统一单位
- 修改 `src/core/db/schema.ts` 后运行 `bun run db:generate`，并提交对应的 `drizzle/*.sql` 和 `drizzle/meta/*`
- 不得通过提高 migration 兼容性测试的基线来放行破坏性 migration；必须采用跨版本 expand/contract。

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
- 创建 GitHub Release 自动触发 CI 发布到 npm；稳定版进入 `latest`，预发布版进入 `next`；工作流通过 npm Trusted Publisher/OIDC 获取短期发布凭据
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
