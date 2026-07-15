# SuperTask 当前架构与决策

> 状态：当前有效
> 最后核对：2026-07-15
> 适用版本：源码 `main` 分支，首次建立时为 0.1.20

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
| Service 层 | 校验、CRUD、状态流转、队列排序 | [`src/core/services/`](../src/core/services/) |
| 数据层 | SQLite 连接、WAL、迁移、外键校验、单例锁表 | [`src/core/db/index.ts`](../src/core/db/index.ts) |
| Worker | 抢占任务、启动目标 Agent、心跳、超时和结果落库 | [`src/worker/index.ts`](../src/worker/index.ts) |
| Scheduler | 检查到期模板并克隆普通任务 | [`src/gateway/scheduler/`](../src/gateway/scheduler/) |
| Watchdog | 恢复心跳过期任务、清理历史数据 | [`src/gateway/watchdog/`](../src/gateway/watchdog/) |
| Dashboard | 本地 SSR 页面与管理 API | [`src/web/index.tsx`](../src/web/index.tsx) |
| PM2 适配 | 显式安装、启停、版本变化后的重启 | [`src/daemon/pm2.ts`](../src/daemon/pm2.ts) |

## Gateway 生命周期

Gateway 启动时按以下顺序工作：

1. 初始化数据库，自动执行 `drizzle/` migrations，开启外键并运行 `PRAGMA foreign_key_check`；有孤立记录时直接拒绝启动。
2. 用 `BEGIN IMMEDIATE` 更新 `gateway_lock`。锁每 10 秒心跳，30 秒未更新才允许新实例接管；此时 `ready_at` 仍为空。
3. 加载并校验配置；非法配置直接失败，不静默回退。
4. 启动 Worker、Watchdog、Scheduler，最后按配置启动内嵌 Dashboard；全部成功后才写入 `ready_at`。
5. 收到 `SIGINT` 或 `SIGTERM` 时停止调度，终止当前子进程，将本实例的 `running` 任务重置为 `pending`，并把仍为 `running` 的执行记录标为失败。

单例锁防止两个 Gateway 同时调度，但不构成跨主机租约。SQLite 文件只适合由同一台机器上的进程共享。

## 任务执行链路

```text
TaskService.next()
  ├─ 状态：pending，或已到 retryAfter 的 failed
  ├─ 依赖：dependsOn 指向的任务必须 done
  ├─ 批次：排除当前 Worker 已运行的非空 batchId
  └─ 排序：urgency DESC → importance DESC → createdAt ASC → id ASC
          ↓
TaskService.start() 条件更新，pending/failed → running
          ↓
创建 task_run，直接 spawn：
opencode run --agent <task.agent> --format json [-m <model>] <task.prompt>
          ↓
退出码 0 → task/run done；其他退出或启动错误 → task/run failed 或 dead_letter
```

Worker 直接执行目标 Agent，不再嵌套 `supertask-runner`。这减少了一层 LLM 决策、递归风险和 PID 追踪歧义；`task.agent=supertask-runner` 会被明确拒绝并进入死信。`agents/supertask-runner.md` 仅是历史备份。

`cwd` 是任务的项目隔离键，也是子进程工作目录。插件创建任务时强制记录当前 `process.cwd()`；插件侧查询和状态变更按同一 `cwd` 限定。

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
- 超出预算进入 `dead_letter`，不会自动执行；手动 retry 将状态改回 `pending`，并把 `retryCount` 清零。
- 单次任务可覆盖 `maxRetries`、`retryBackoffMs` 和 `timeoutMs`；模板克隆时会复制这些字段。

## 并发、超时与故障恢复

- 全局并发由 `worker.maxConcurrency` 控制，默认 2。
- 同一非空 `batchId` 在单个 Gateway 内串行；不同批次和空 `batchId` 可以并行。
- Worker 硬超时和正常关闭在 Unix 上终止子进程组，Windows 上终止直接子进程。
- Worker 定时更新 `task_runs.heartbeatAt`。Watchdog 发现心跳过期时终止记录的 `childPid`、关闭本次 run，并按同一重试预算恢复任务。
- 输出只保留最后 64 KiB，避免单任务无限占用 Gateway 内存；发现 JSON 输出中的 `sessionID` 会写入执行记录。

该实现提供 at-least-once 倾向的本地恢复，不保证 exactly-once。任务执行外部副作用时，应自行设计幂等键或可重复执行策略。

## 调度语义

模板支持 `cron`、`recurring` 和一次性 `delayed`：

- Scheduler 只克隆普通任务，实际执行仍遵循队列优先级、批次、重试和超时规则。
- `maxInstances` 统计同模板下 `pending` 和 `running` 数量；达到上限时本轮不克隆。
- `delayed` 成功克隆一次后自动禁用。
- `cron` 与 `recurring` 的下一次时间基于本次成功克隆时的当前时间计算。
- 当前没有可配置的 catch-up/backfill；Gateway 离线期间错过的多个周期不会逐个补跑。恢复后最多生成一个到期实例，再从当前时间计算下一次。

## 关键架构决策

| 决策 | 当前选择 | 理由 | 何时改变 |
|---|---|---|---|
| 执行模型 | Worker 直接运行目标 Agent | 少一层 LLM、状态写入者明确、PID 更可控 | 需要独立远程执行协议时 |
| 进程守护 | PM2 可选，前台模式始终可用 | 守护不应成为开发和插件加载的硬依赖 | 有统一容器或 OS 服务管理平台时 |
| 持久化 | SQLite WAL | 零服务依赖，适合单机队列 | 多机消费、高写入并发或 HA 时 |
| 配置错误 | 校验失败并拒绝启动 | 避免错误配置被默认值掩盖 | 不改变；可增加更友好的诊断 |
| 调度补偿 | 不回放全部错过周期 | 避免恢复时瞬间制造积压 | 业务明确要求补账并定义上限时 |
| Dashboard | 嵌入 Gateway，仅监听 loopback | 少一个常驻进程，默认不暴露网络面 | 需要公网/团队访问时拆分并加鉴权 |

## 安全边界

Dashboard 只绑定 `127.0.0.1`，浏览器写请求检查 `Sec-Fetch-Site` 和同源 `Origin`，数据库字符串输出到 HTML 前转义。这是本机可信用户边界，不是完整鉴权系统；不要通过反向代理或端口转发直接暴露到不可信网络。

## 已知限制与后续触发点

以下是当前源码行为，不应由文档掩盖：

- 运行中 `cancel` 只改变数据库状态，不会立即终止正在执行的子进程；子进程会继续到退出或超时。
- Watchdog 心跳超时路径目前终止记录的直接 `childPid`，不像 Worker 超时路径那样终止 Unix 进程组；若 Agent 再派生进程，可能留下后代进程。
- 正常关闭会立即中断在途任务并重置为 `pending`，没有“停止接单并等待全部完成”的 drain 模式。
- `/health` 会检查 ready 锁与 Worker、Scheduler、Watchdog 活跃时间，但仍没有指标导出、结构化日志轮转策略或告警集成。
- 单实例锁、任务抢占和状态更新足以覆盖当前单机模型，但不提供分布式租约和 exactly-once 保证。

这些限制一旦成为真实故障来源，应先写复现测试，再调整实现与本文档。
