# SuperTask 当前架构与决策

> 状态：当前有效
> 最后核对：2026-07-19
> 适用版本：源码 `main` 分支，当前开发基线 0.1.41

## 结论与适用边界

当前方案对“单机、本地 OpenCode、轻量持久队列”是合理且克制的：SQLite 降低部署成本，单 Gateway 集中执行和调度，PM2 只作为可选守护层。它符合本项目约束下的最佳实践，但不是分布式队列的通用最佳方案。

以下需求出现时，应重新评估存储和协调层，而不是继续堆补丁：

- 多台机器共同消费、Gateway 高可用或水平扩容；
- 严格的 exactly-once、可证明的任务租约或事务型外部副作用；
- 对公网开放 Dashboard、多用户鉴权或细粒度权限；
- 大规模积压、长时间历史查询或独立的可观测性平台。

## 系统边界

```text
OpenCode 插件 ─┐
supertask CLI ─┼──> Service 层 ───> SQLite（WAL）
Dashboard ─────┘       ↑                 ↑
                       │                 │
               ┌───────┴─────────────────┴───────┐
               │ 单实例 Gateway                  │
               │ Worker | Scheduler | Watchdog   │
               │ Dashboard（127.0.0.1:4680）     │
               └─────────────────────────────────┘
                              ↑
                    PM2（可选的进程守护层）
```

插件、CLI、Dashboard 和 Gateway 都会通过 Service 层读写同一个 SQLite 文件，因此 Gateway 不是数据库的唯一写者。Gateway 是自动执行、定时调度、心跳恢复和内嵌 Dashboard 的唯一运行进程。

| 组件 | 职责 | 主要源码 |
|---|---|---|
| Service 层 | 校验、CRUD、状态流转、队列排序、数据库维护 | [`src/core/services/`](../src/core/services/) |
| 数据层 | SQLite 连接、WAL、迁移、外键校验、单例锁表 | [`src/core/db/index.ts`](../src/core/db/index.ts) |
| Worker | 抢占任务、启动目标 Agent、心跳、超时和结果落库 | [`src/worker/index.ts`](../src/worker/index.ts) |
| Scheduler | 检查到期模板并克隆普通任务 | [`src/gateway/scheduler/`](../src/gateway/scheduler/) |
| Watchdog | 恢复心跳过期任务、清理历史数据 | [`src/gateway/watchdog/`](../src/gateway/watchdog/) |
| Dashboard | 本地 SSR 页面与管理 API；按 `cwd` 汇总项目，浏览本机文件夹，在选定项目内读取 OpenCode 可运行 Agent/模型，创建编辑普通与定时任务，分层展示执行命令和日志，区分保存/运行配置，并提供响应式中英文界面及浏览器本地主题偏好 | [`src/web/index.tsx`](../src/web/index.tsx)、[`src/web/ui.ts`](../src/web/ui.ts) |
| PM2 适配 | 显式安装、启停、版本变化后的重启 | [`src/daemon/pm2.ts`](../src/daemon/pm2.ts) |

## Gateway 生命周期

Gateway 启动时按以下顺序工作：

1. 初始化数据库，自动执行 `drizzle/` migrations，开启外键并运行 `PRAGMA foreign_key_check`；有孤立记录时直接拒绝启动。`0005` 起 migration 强制 expand-only，以保证新版本未 ready 时 PM2 仍可安全回滚到 N-1 二进制。
2. 用 `BEGIN IMMEDIATE` 更新 `gateway_lock`。锁每 10 秒心跳；活跃或身份无法确认的 Gateway PID 会阻止双主，身份识别覆盖直接 Gateway 入口和公开的 `supertask gateway`/CLI 前台入口；陈旧锁若已确认 PID 被无关进程复用才安全接管。旧 owner 更新不到自己的锁时会自停；此时 `ready_at` 仍为空。
3. 加载并校验配置；非法配置直接失败，不静默回退。
4. 先收敛孤儿运行态和不可恢复依赖，初始化 Scheduler，再绑定内嵌 Dashboard；所有可能阻止启动的初始化完成后才启动 Watchdog 与 Worker，并把当前包版本和 `ready_at` 一起写入锁。Dashboard 端口冲突等启动失败不会先执行队列任务。
5. Gateway 把本次启动时的配置快照注入 Dashboard。网页保存配置只原子写文件，不伪装成已热加载；仅当 PM2 进程 PID、新鲜 ready 锁和运行作用域都匹配当前 Gateway 时，网页才允许在响应返回后发送 `SIGTERM`，复用既有优雅停机并由 PM2 自动拉起。前台 Gateway 不提供网页自动重启。
5. 收到 `SIGINT` 或 `SIGTERM` 时先停止接单，等待 `worker.shutdownGracePeriodMs`；宽限期内完成的任务正常落库。剩余任务只有在受管进程组确认排空后，才会原子关闭 run 并重置为 `pending`；无法确认排空的 run 保持隔离，交给 Watchdog 继续处理。

单例锁防止两个 Gateway 同时调度，但不构成跨主机租约。SQLite 文件只适合由同一台机器上的进程共享。

## 任务执行链路

```text
TaskService.claimNext()（BEGIN IMMEDIATE 内选择并转为 running）
  ├─ 状态：pending，或已到 retryAfter 的 failed
  ├─ 依赖：dependsOn 指向的任务必须 done
  ├─ 批次：排除数据库中已有 running 任务的非空 batchId
  └─ 排序：urgency DESC → importance DESC → createdAt ASC → id ASC
          ↓
创建 task_run，启动等待握手的 launcher
          ↓
持久化 launcher PID 后才放行：
opencode run --agent <task.agent> --format json [-m <model>] [--variant <variant>] <task.prompt>
          ↓
退出码 0 → task/run done；其他退出或启动错误 → task/run failed 或 dead_letter
```

Worker 通过无 LLM 的 launcher 直接执行目标 Agent，不再嵌套 `supertask-runner`。新 run 使用 `gated-v3-token-guardian`：每次执行生成独立 UUID，同时写入 `task_runs.locked_by` 和 launcher argv；Watchdog 只有在 launcher 路径、OpenCode 参数和该 UUID 全部匹配时才会向进程组发信号。launcher 在 PID 成功落库前不会启动 OpenCode；父进程提前退出会关闭握手管道，避免产生未登记的执行进程。OpenCode 及仍属于受管进程组的后代全部退出后，launcher 还必须通过不传递给 OpenCode 的 IPC 返回绑定该 UUID 的排空证明；guardian 异常退出且无证明时，Worker 保持 run 与批次隔离，直到进程组明确消失。受管 OpenCode 进程带有 `SUPERTASK_MANAGED_RUN=1`，插件在该上下文拒绝执行升级，避免任务删除并等待承载自己的 Gateway；升级只能从外部 CLI 或非队列会话发起。`task.agent=supertask-runner` 会被明确拒绝并进入死信。

新执行记录会快照实际模型和 variant，并在 OpenCode JSONL 前附加一条 SuperTask 命令元数据，保存 Worker 真正传给 launcher 的可执行文件、参数数组和 `cwd`。Dashboard 从该结构生成可复制的终端命令，并分开展示 Agent 文本、错误、工具与原始日志；旧 run 没有元数据时仍可查看原始输出。variant 为空时不传 `--variant`，由 Agent/模型配置决定；非空时作为独立 argv 传递。

排空证明使用双向确认：Worker 校验 launcher 发来的 UUID 后回送同 UUID，launcher 收件后才退出。该握手不依赖 Bun 旧版本不可靠的 `process.send` callback，同时保留“父进程确实收到证明”这一结算前提。

这里的隔离与排空单位是 Unix 进程组，不是按父子关系追踪的任意后代集合。普通子进程会继承该组，受取消、超时和停机管理；主动调用 `setsid()`、使用 `detached: true` 或以 daemon 方式离组的进程不在 SuperTask 的可证明边界内，launcher 无法确认或终止它们。任务若需要长期后台服务，应使用外部服务管理器并自行管理生命周期，不应把这类进程视为受管 run 的一部分。

`cwd` 是任务的项目分组与隔离键，也是子进程工作目录。插件使用 OpenCode 工具上下文的 `directory`，不信任模型传入的 `cwd`；插件侧查询和状态变更按同一目录限定。Service 在普通任务和模板入库前要求非空 `cwd` 是已存在的绝对目录，Dashboard 复用该校验。为兼容旧数据，Schema 仍允许 NULL；Worker 若取到不存在、相对或文件型的遗留目录，会创建失败 run 并直接将任务收敛到 `dead_letter`，不启动 OpenCode、不给它自动重试刷日志。Dashboard 直接聚合现有 `tasks.cwd`，形成 `cwd → batchId → tasks` 的最小分组层次，没有额外的可漂移项目表。

Dashboard 的文件夹浏览只作用于回环地址上的本机路径选择。选定 `cwd` 后，Gateway 以该目录为工作目录并行执行 `opencode agent list` 和 `opencode models --verbose`，结果短时缓存；新任务下拉框过滤 `subagent` 和历史 `supertask-runner`，只提供可直接传给 `opencode run --agent` 的 Agent，并按模型元数据列出其声明支持的 variants。编辑旧任务时保留数据库原值，即使该模型或 variant 当前不可发现也不会因不相关编辑被强制改写。

`running`、任务终态和 `task_runs` 执行终态只由 Gateway 写入。CLI 和插件不暴露 `start/done/fail`，避免外部调用制造没有 owner/PID 的运行记录或让任务与 run 状态分裂。Worker 的候选筛选与 `running` 转换由 `claimNext` 在同一即时事务完成，并使用事务返回的最新任务快照，外部编辑不能插入两阶段窗口破坏批次串行或让 Worker 执行旧配置。普通任务的可编辑配置由 `TaskService.update` 统一处理，只接受 `pending`、`failed` 和 `dead_letter`；不允许迁移 `cwd` 或改依赖，运行中与完成/取消终态拒绝修改，避免已执行 run 与任务配置失真。Dashboard 与 `supertask edit` 共用该边界。

## 状态与重试语义

```text
pending ──抢占──> running ──成功──> done
   ↑                 ├─普通失败且有预算──> failed ──退避到期后再次抢占──┐
   │                 ├─心跳超时且有预算──> pending（带 retryAfter）───┤
   │                 └─预算耗尽──────────> dead_letter               │
   └──────────────手动 retry（重置计数）<─────────────────────────────┘

pending / running / failed ──cancel──> cancelled
```

- `maxRetries` 是首次执行之外允许的重试次数。默认 3 表示最多执行 4 次。
- 第 `retryCount` 次失败后的等待时间是 `min(retryBackoffMs × 2^(retryCount-1), 30 分钟)`。
- 普通失败保存为 `failed`；退避到期后 Worker 可以直接重新抢占。Watchdog 恢复则保存为带 `retryAfter` 的 `pending`。
- 超出预算进入 `dead_letter`，不会自动执行；编辑 `failed` 任务并降低预算导致立即停止重试时，会在同一事务递归收敛整条依赖链。手动 retry 仅在依赖仍存在、同 `cwd` 且仍可恢复或已完成时将状态改回 `pending`，并把 `retryCount` 清零。校验与状态更新使用同一写事务，避免和历史清理并发制造悬空依赖。
- 单次任务可指定模型 `variant` 并覆盖 `maxRetries`、`retryBackoffMs` 和 `timeoutMs`；模板克隆时会复制这些字段。
- 删除不是运行态迁移：`running` 任务或仍存在 `running` 执行记录的任务必须先取消并等待 Worker 关闭 run；仍被 `pending/running/failed/dead_letter` 任务依赖的前置任务也拒绝删除。手动删除和 Watchdog 过期清理都遵守依赖保护，避免制造悬空任务。

## 并发、超时与故障恢复

- 全局并发由 `worker.maxConcurrency` 控制，默认 2；Worker 每次接单前同时统计 `running` 任务和仍未关闭的 running run，因此 Gateway 重启或取消收敛期间不会暂时突破额度。
- 同一非空 `batchId` 依据数据库中的任务/run 运行态全局串行；Gateway 重启后旧任务尚未收敛时，同批次新任务仍不会启动。不同批次和空 `batchId` 可以并行。
- Worker 硬超时、运行中取消和宽限期后的关闭会终止并确认受管 Unix 进程组排空。Windows 的父子 PID 链在中间进程退出后无法提供等价证明，因此 Gateway 在引入 Job Object 前直接拒绝启动。Watchdog 处理当前 `gated-v3-token-guardian` 时会同时校验 launcher、目标 OpenCode 参数和每 run UUID，避免 PID 被另一条合法 SuperTask 执行复用后误杀。旧 `gated-v2-guardian` 或无协议记录若 PID/PGID 仍存活或无法确认，只保持隔离且绝不自动发信号；只有 PID 与进程组都明确消失才恢复数据库状态。
- Worker 定时更新 `task_runs.heartbeatAt`。Watchdog 在 owner PID 已退出或心跳过期时立即检查子进程，确认其结束后在一个事务内关闭 run，并按同一重试预算恢复任务。
- 进程组排空后的数据库结算若暂时失败，Worker 继续持有任务、批次和心跳，先按 `250ms → 1s → 4s` 快速重试，随后在 Gateway 存活期间每 5 秒低频重试，避免丢失已知退出结果或等待 Watchdog 超时。停机时会在完整 `shutdownGracePeriodMs` 内继续结算，宽限期耗尽后才按 at-least-once 语义交给 Watchdog。
- Gateway 获得单实例锁后、Worker 接单前，会把不存在 active run 的遗留 `running` 任务恢复为 `pending`；run 先记录 owner 与等待握手的 launcher PID，再允许 launcher 启动 OpenCode，关闭创建 run 到持久化子进程身份之间的崩溃窗口。
- 升级前旧版产生的 `launch_protocol IS NULL`、child PID 为空且 owner 已退出的 run 默认永久隔离。公开的 `run abandon` 只在任务已取消并经人工强确认后关闭这类 run；任何非空未知/受管协议、存活 owner 或已记录 PID 都 fail-closed，避免未来协议被旧 CLI 当作 legacy 绕过。
- 输出只保留最后 64 KiB，避免单任务无限占用 Gateway 内存；发现 JSON 输出中的 `sessionID` 会写入执行记录。

该实现提供 at-least-once 倾向的本地恢复，不保证 exactly-once。任务执行外部副作用时，应自行设计幂等键或可重复执行策略。

## 调度语义

模板支持 `cron`、`recurring` 和一次性 `delayed`：

- Scheduler 只克隆普通任务，实际执行仍遵循队列优先级、批次、重试和超时规则。
- Dashboard 创建和编辑都复用 `TaskTemplateService` 的校验；编辑在即时事务内重算 `nextRunAt`，保留启用状态和历史执行时间，并只影响之后生成的任务。Scheduler 克隆前会核对扫描到的触发时间，避免并发编辑后按旧时间提前执行。
- `maxInstances` 只限制自动调度，统计同模板下 `pending`、`running` 和仍有自动重试预算的 `failed`。Dashboard 手动“立即运行一次”始终创建普通 `pending` 任务；该任务仍计入后续自动调度的活跃实例数，并在 Worker 全局并发已满时排队。
- `cron`/`recurring` 到期但已达 `maxInstances` 时会原子推进到下一触发点，避免每个 tick 重复抢写同一模板；`delayed` 仍保持原触发点等待空位。
- 到期扫描按 `(nextRunAt, id)` 使用每批 100 条的游标，单个 tick 不会把全部过期模板一次性装入内存。
- `delayed` 成功克隆一次后自动禁用。
- `cron` 与 `recurring` 的下一次时间基于本次成功克隆时的当前时间计算。
- 当前没有可配置的 catch-up/backfill；Gateway 离线期间错过的多个周期不会逐个补跑。恢复后最多生成一个到期实例，再从当前时间计算下一次。

## 关键架构决策

| 决策 | 当前选择 | 理由 | 何时改变 |
|---|---|---|---|
| 执行模型 | Worker 直接运行目标 Agent | 少一层 LLM、状态写入者明确、PID 更可控 | 需要独立远程执行协议时 |
| 进程守护 | PM2 可选，前台模式始终可用 | 守护不应成为开发和插件加载的硬依赖 | 有统一容器或 OS 服务管理平台时 |
| Gateway 执行环境 | 自动恢复沿用旧环境；显式安装/升级刷新 OpenCode/XDG/Provider 环境，但固定 PM2、Bun、数据库与配置身份；替换前用目标环境预检 OpenCode | 自定义 Agent 应与发起安装/升级的可用终端一致，同时不能让环境刷新误切数据库或 PM2 daemon；坏环境不会先停掉健康 Gateway | 引入独立密钥/执行环境管理器时 |
| PM2 生命周期互斥 | 先持有 `PM2_HOME` 下的 canonical SQLite `BEGIN IMMEDIATE` 锁，再按固定顺序持有从当前环境、dump/运行环境和 LaunchAgent 恢复的旧 custom 锁；LaunchAgent 与当前 CLI 的 `PM2_HOME` 不同则在修改前失败关闭；`stop/delete` 持锁等待至少 kill timeout + 5 秒 | 崩溃自动释放，避免绕过旧 supervisor、启动第二个 PM2 daemon、PID 复用、stale-unlink ABA 或 PM2 尚未结束时提前进入下一临界区 | 迁移到单一外部服务管理器时 |
| 持久化 | SQLite WAL | 零服务依赖，适合单机队列 | 多机消费、高写入并发或 HA 时 |
| migration 回滚 | N/N-1 expand/contract 兼容 | PM2 可在新版未 ready 时安全恢复旧二进制 | 引入数据库版本化快照回滚协议时 |
| 配置错误 | 校验失败并拒绝启动 | 避免错误配置被默认值掩盖 | 不改变；可增加更友好的诊断 |
| 调度补偿 | 不回放全部错过周期 | 避免恢复时瞬间制造积压 | 业务明确要求补账并定义上限时 |
| 数据库维护 | Service 统一数据安全；CLI 编排匹配当前 ready 锁的 PM2 Gateway 自动停启 | 避免各入口实现不完整的危险 SQL，并防止维护命令误停另一套实例 | 存储迁移到外部数据库时重做维护协议 |
| Dashboard | 嵌入 Gateway，仅监听 loopback；详情默认语义化，原始 JSON/JSONL 退到折叠排障入口 | 少一个常驻进程，默认不暴露网络面，同时不把数据库结构直接当作人类界面 | 需要公网/团队访问时拆分并加鉴权 |

## 安全边界

Dashboard 只绑定 `127.0.0.1`，所有请求的 Host 必须是 `localhost`、`127.0.0.1` 或 `[::1]`，浏览器写请求还检查 `Sec-Fetch-Site` 和同源 `Origin`，数据库字符串输出到 HTML 前转义。网页需要 PM2/systemd 状态时通过独立、总超时受限的 Bun runner 异步探测，并在 Gateway 内短时缓存，不阻塞 Worker、Watchdog 或锁心跳。这是本机可信用户边界，不是完整鉴权系统；不要通过反向代理或端口转发直接暴露到不可信网络。

数据库危险操作集中在 `DatabaseMaintenanceService`：备份通过 SQLite 序列化得到一致快照，并转换成无需 WAL sidecar 的独立文件；清空在 `BEGIN IMMEDIATE` 内完成备份并动态删除全部业务表数据（包括新版本 expand-only 表），同时保留 `gateway_lock` 和 migration 元数据，循环外键通过事务级延迟检查收敛；恢复从已打开的 SQLite 源连接序列化包含已提交 WAL 页的一致快照，拒绝当前库的符号链接/硬链接别名，执行缺失 migration 和复检，再动态比较 source/live 业务表与可写列。source-only 表/列会在任何删除前失败关闭；双方共有的未来列完整复制；live-only 列仅在可空或带默认值时允许，live-only 新表按旧时间点的空状态清理，避免旧二进制恢复新快照或新二进制恢复旧快照时形成混合数据。最终在当前连接的 `BEGIN EXCLUSIVE` 事务中原位替换业务数据。恢复期间并发写入只能在事务前完成或在提交后成功，不存在“写入已返回成功却被文件换位静默丢失”的窗口。CLI 层只对“PM2 PID 与当前数据库新鲜 ready 锁一致”的 Gateway 自动停启，并在操作失败时恢复原运行状态；其他活跃 Gateway 仍由 Service 拒绝，避免误杀另一套实例。Dashboard 清空只允许当前 Gateway 且仍拒绝运行中任务。恢复会清理运行时锁，并把快照中的遗留运行状态收敛为可重新调度的状态。Watchdog 历史清理使用防重入、有索引的有界事务批次；不可恢复的依赖通过递归事件更新一次收敛整条下游链，不再在每个 Worker poll 全局扫描。

## 已知限制与后续触发点

以下是当前源码行为，不应由文档掩盖：

- `/health` 检查 ready 锁、Worker/Scheduler/Watchdog/历史清理活跃时间和连续失败，并保留最近错误；`supertask doctor` 分别验证终端与 PM2 保存环境中的 OpenCode，再解析最终插件配置，要求精确版本并核对对应缓存、全局 CLI、PM2 实际 Gateway 入口包和 ready 锁版本，同时验证 macOS LaunchAgent 的程序路径、加载状态和 PM2 dump 可恢复性。`doctor --smoke` 进一步提交真实队列任务验证完整执行链。浮动 `@latest`/`@next` 入口或任一组件版本不一致都失败关闭。macOS supervisor 只恢复 dump 中明确存在但 `jlist` 确认缺失的 Gateway，不会把状态未知或 `errored` 当作恢复信号。显式 `supertask install` 会配置 `pm2-logrotate`，但仍没有指标导出和告警集成。
- 单实例锁、任务抢占和状态更新足以覆盖当前单机模型，但不提供分布式租约和 exactly-once 保证。

这些限制一旦成为真实故障来源，应先写复现测试，再调整实现与本文档。
