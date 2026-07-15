# SuperTask Gateway 设计文档

> [!WARNING]
> 历史设计稿，不代表当前实现。systemd、独立 Dashboard 和嵌套 `supertask-runner` 方案均已被取代；当前事实见[当前架构与决策](../architecture.md)和[运行与排障手册](../operations.md)。

> 版本：v1.5 | 日期：2026-05-06 | 状态：设计阶段
> 变更记录：v1.2 → v1.3（Droid 评审 Top 3）→ v1.4（重试退避 + 优先级 + 分组并发）→ v1.5（补充 supertask-runner 架构角色）

## 1. 背景与动机

当前 Worker 和 Web 是独立进程，没有常驻调度器。这导致：

- **定时任务无法实现**：没有常驻进程，cron/delayed task 无从执行
- **崩溃无法自愈**：Worker 崩溃后，running 状态的任务永远卡住
- **运维碎片化**：需要分别启动 `bun run worker`、`bun run ui`
- **无法分组并发**：所有任务串行执行，不能按批次分组并行

**解决方案**：引入 Gateway 常驻进程（Worker + Scheduler + Watchdog）。Web Dashboard 保持独立。

## 2. 业界参考

| 项目 | Stars | 技术栈 | 值得借鉴 |
|------|-------|--------|---------|
| **[bunqueue](https://github.com/egeominotti/bunqueue)** | 414 | TypeScript/Bun | 心跳、DLQ、cron、MCP 服务器 |
| **[plandb](https://github.com/Agent-Field/plandb)** | 70 | Rust | SQL VIEW 计算任务就绪；文件即真相 |
| **[busytown](https://github.com/gordonbrander/busytown)** | 38 | TypeScript | cursor-based 投递；first-claim-wins |
| **[opengate](https://github.com/stefanodecillis/opengate)** | 2 | Rust/Axum | Agent 心跳注册；stale agent 自动清理 |
| **[agent-foundry](https://github.com/Code-and-Sorts/agent-foundry)** | - | Python/SQLite | queue leasing + backoff；PID 追踪 |

### 关键设计模式

1. **常驻进程**（bunqueue、OpenClaw）：Gateway 24h 运行，内含 Worker + Scheduler
2. **文件即真相**（plandb）：SQLite 是唯一数据源，多进程通过 WAL 并发读写
3. **心跳 + 租约**（opengate、agent-foundry）：超时自动释放任务
4. **关注点分离**：调度进程和展示进程独立运行
5. **并发控制是调度器职责**（plandb claim、bunqueue concurrency）：不污染数据模型

## 3. 技术栈

| 维度 | 选择 | 理由 |
|------|------|------|
| **运行时** | Bun | 内置 SQLite，与现有代码零迁移 |
| **语言** | TypeScript | 直接复用 TaskService、Drizzle schema |
| **ORM** | Drizzle | 已在用 |
| **数据库** | SQLite (WAL) | 已在用，多进程并发读写 |
| **Web 框架** | Hono | Dashboard 已在用 |
| **进程守护** | systemd | 崩溃自重启 + 日志 + 开机启动，零额外依赖 |
| **cron 解析** | cron-parser | 成熟库 |

## 4. 架构设计

### 4.1 整体架构

Gateway 和 Web Dashboard 是**两个独立进程**，通过共享 SQLite（WAL 模式）通信：

```
  ┌────────────────────────────────┐     ┌──────────────────────────┐
  │       SuperTask Gateway        │     │    Web Dashboard         │
  │       (systemd 守护)           │     │    (按需启动, 只读视图)   │
  │                                │     │                          │
  │  ┌──────────────────────────┐  │     │  Hono :3000              │
  │  │   Worker Engine          │  │     │  ├── Dashboard SSR      │
  │  │   ├── 调度循环            │  │     │  ├── REST API           │
  │  │   ├── 并发池 (Promise)   │  │     │  └── 手动刷新           │
  │  │   ├── 分组隔离 (Set)     │  │     │                          │
  │  │   └── spawn opencode run │  │     └────────────┬─────────────┘
  │  └──────────────────────────┘  │                  │
  │                                │                  │ 读
  │  ┌──────────────────────────┐  │                  ▼
  │  │   Scheduler              │  │     ┌──────────────────────┐
  │  │   ├── Cron               │  ├────►│  SQLite (WAL)        │
  │  │   ├── Delayed            │  │ 读写│  tasks.db            │
  │  │   └── Recurring          │  │     └──────────────────────┘
  │  └──────────────────────────┘  │                  ▲
  │                                │                  │ 写
  │  ┌──────────────────────────┐  │     ┌────────────┴─────────────┐
  │  │   Watchdog               │  │     │  CLI / MCP Plugin       │
  │  │   ├── 心跳超时 + kill    │  │     │  (supertask add/...)     │
  │  │   ├── 退避重试           │  │     │  (supertask_*)           │
  │  │   └── 数据清理           │  │     └──────────────────────────┘
  │  └──────────────────────────┘  │
  └────────────────────────────────┘
```

**写者模型**：Gateway 是唯一**调度**写者（抢占/心跳/完成/失败）；用户操作（CLI/Plugin/Web 的 add/cancel/retry/delete）由 SQLite WAL 串行化保证一致性。

**Dashboard 是只读视图**：Gateway 重启期间 heartbeat_at 不更新，Dashboard 会看到「running 但心跳停滞」，这是正常的短暂滞后，不是 bug。

### 4.2 目录结构

```
src/
├── gateway/
│   ├── index.ts              # Gateway 入口 + PID 文件锁
│   ├── config.ts             # 配置读取
│   ├── scheduler/
│   │   ├── index.ts          # 调度器主循环
│   │   ├── cron-parser.ts    # cron 表达式解析
│   │   └── job-templates.ts  # 模板克隆
│   └── watchdog/
│       ├── index.ts          # 看门狗主循环
│       ├── heartbeat.ts      # 心跳超时检测 + kill PID + 退避重试
│       └── cleanup.ts        # 过期数据清理
├── core/                     # Gateway 和 Web 共用
│   ├── db/
│   └── services/
├── web/                      # 独立进程，不变
│   └── index.tsx
├── worker/                   # 改造：从独立进程变为 Gateway 模块
│   └── index.ts
├── cli/                      # 不变
│   └── index.ts
└── plugin/                   # 不变
```

## 5. 功能规格

### 5.1 Worker Engine（复用 + 增强）

#### 两层执行架构

任务执行分两层 spawn，Gateway 不直接执行任务内容：

```
Gateway Worker (TypeScript 进程)
  │
  │ 1. TaskService.next() → 取任务
  │ 2. TaskService.start(id) → 乐观锁抢占
  │ 3. spawn("opencode run --agent supertask-runner -m ${model} --format json \"执行任务 ID: ${id}\"")
  │    ↓
  │    child_pid 记录到 task_runs（这是 supertask-runner 的 PID）
  │
  └── supertask-runner (LLM agent, ~/.config/opencode/agent/supertask-runner.md)
        │
        │ a. supertask_get(id) → 获取任务详情（agent, prompt, cwd, model）
        │ b. 跳过 start（Gateway 已标记 running）
        │ c. Bash("opencode run --agent ${task.agent} \"${task.prompt}\"")
        │    ↓
        │    这一层 Gateway 看不到，PID 无法追踪
        │
        └── task.agent（真正执行任务的 LLM agent，如 localize-gen、course-gen）
              │
              │ 执行具体工作（翻译、生成、审核等）
              │
              └── 完成后 supertask-runner 根据输出判断 done 或 fail
```

**各层职责**：

| 层 | 谁负责 | 职责 |
|----|--------|------|
| Gateway Worker | TypeScript 代码 | 轮询、抢占、心跳、spawn supertask-runner、记录 child_pid、超时 kill |
| supertask-runner | LLM agent（全局配置） | 取任务详情、spawn task.agent、判断结果、更新 done/fail |
| task.agent | LLM agent（项目级） | 执行具体任务内容 |

**supertask-runner 位置**：`~/.config/opencode/agent/supertask-runner.md`（全局 agent），任何项目目录下都可用。

**PID 追踪限制**：Gateway 只能追踪 supertask-runner 的 child_pid。task.agent 是 supertask-runner 内部通过 Bash spawn 的，Gateway 无法直接追踪。Watchdog kill child_pid 时会终止 supertask-runner，但其内部的 task.agent 子进程是否同时终止取决于进程组。

#### 并发调度（核心改造）

Worker 维护两个内存状态：

```ts
activeBatchIds: Set<string | null>   // 当前有 running 任务的 batchId
runningCount: number                  // 当前运行中任务总数
```

**调度循环**：

```
while (runningCount < maxConcurrency):
  1. next(excludedBatchIds: activeBatchIds)
     → WHERE status IN ('pending', 'failed 且 retryCount < maxRetries')
       AND (retry_after IS NULL OR retry_after <= now_ms())
       AND (batchId IS NULL OR batchId NOT IN (excludedBatchIds))
       AND 依赖检查
     → ORDER BY urgency DESC, importance DESC, created_at ASC
     → LIMIT 1
   2. 抢占成功:
     activeBatchIds.add(task.batchId)
     runningCount++
     spawn("opencode run --agent supertask-runner ...")
  3. 任务完成/失败:
     activeBatchIds.delete(task.batchId)
     runningCount--
```

**分组规则**：
- 同一 batchId 内的任务**串行**（该 batchId 有 running 时跳过）
- 不同 batchId 的任务**并行**（互不阻塞）
- batchId 为 NULL 的任务不参与分组限制
- 总并发数不超过 `maxConcurrency`

**执行示例**（maxConcurrency=2）：

```
组A: [A1, A2, A3]    组B: [B1, B2]

  A1 running ────── done → A2 running ─── done → A3 running
  B1 running ─ done → B2 running ─── done
  ↑ 同时 2 个               ↑ A2 等 A1 完成才能开始
```

#### 优先级调度

现有 `importance`（1-5）和 `urgency`（1-5）字段生效，ORDER BY 改为：

```sql
ORDER BY urgency DESC, importance DESC, created_at ASC
```

| urgency | importance | 典型场景 |
|---------|-----------|---------|
| 5 | 5 | 线上故障修复 |
| 5 | 3 | 紧急热修复 |
| 3 | 5 | 核心功能开发 |
| 3 | 3 | 常规任务 |
| 1 | 1 | 探索性任务 |

#### 其他增强

| 特性 | 现状 | 改造后 |
|------|------|--------|
| 心跳更新 | 无 | 每 30s 更新 task_runs.heartbeat_at |
| 崩溃恢复 | 无 | spawn 异常时标记 run failed + task failed |
| 执行超时 | 无 | 可配置 timeout（默认 30 分钟），超时自动 fail |
| 优雅关闭 | 无 | SIGTERM 等待当前任务完成 |
| PID 追踪 | 无 | spawn 时记录 child_pid 到 task_runs |

### 5.2 重试策略 + 退避

> 现有 tasks 表已有 `retry_count` 和 `max_retries` 字段。

#### 退避机制

任务失败后不立即重试，指数退避等待：

```
retry_after = now + retry_backoff_ms * 2^retry_count
上限：30 分钟
```

示例（retry_backoff_ms=30000）：

| 重试次数 | 等待时间 |
|---------|---------|
| 第 1 次 | 30s |
| 第 2 次 | 60s |
| 第 3 次 | 120s |
| 第 4 次 | 240s |
| 上限 | 30min |

#### dead_letter 状态

超过 max_retries 的任务标记为 `dead_letter`（死信），不再重试。

**Watchdog 恢复流程调整**：

```
1. 找超时 run
2. kill child_pid
3. 标记 run failed
4. IF retry_count < max_retries:
     重置 task = 'pending'
     retry_count++
     设置 retry_after（指数退避）
   ELSE:
     标记 task = 'dead_letter'
```

**任务状态完整流转**：

```
pending → running → done
                 → failed → pending（退避等待后重试）
                          → dead_letter（超过最大重试次数）
         → cancelled
```

#### Worker 轮询适配

```sql
WHERE status IN ('pending', 'failed')
  AND (retry_after IS NULL OR retry_after <= now_ms())
  ...
```

### 5.3 Scheduler（新增）

#### Schema 扩展：task_templates 表

> 所有时间字段单位 **毫秒（ms）**，与老字段（createdAt 等秒级 timestamp）区分。
> 模板字段在克隆时复制到 tasks；编辑模板不影响已生成的 task。

```sql
CREATE TABLE task_templates (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  agent           TEXT NOT NULL,
  model           TEXT DEFAULT 'default',
  prompt          TEXT NOT NULL,
  cwd             TEXT,
  category        TEXT DEFAULT 'general',
  importance      INTEGER DEFAULT 3,
  urgency         INTEGER DEFAULT 3,

  schedule_type   TEXT NOT NULL,          -- 'cron' | 'delayed' | 'recurring'
  cron_expr       TEXT,                   -- cron 表达式（cron 时必填）
  interval_ms     INTEGER,               -- 间隔毫秒（recurring 时必填）
  run_at          INTEGER,               -- 执行时间戳 ms（delayed 时必填）

  max_instances   INTEGER DEFAULT 1,
  max_retries     INTEGER DEFAULT 3,     -- 克隆给 task 的重试上限
  retry_backoff_ms INTEGER DEFAULT 30000, -- 克隆给 task 的退避基础间隔
  last_run_at     INTEGER,               -- ms
  next_run_at     INTEGER,               -- ms
  enabled         INTEGER DEFAULT 1,

  created_at      INTEGER DEFAULT (strftime('%s','now') * 1000),
  updated_at      INTEGER DEFAULT (strftime('%s','now') * 1000)
);
```

设计上限：100 个模板以内。超过时改用内存最小堆。

#### 调度逻辑

```
每秒检查 task_templates：
  1. WHERE enabled = 1 AND next_run_at <= now_ms()
  2. 检查 max_instances
  3. 从模板克隆一条新任务到 tasks 表（复制字段，含 max_retries/retry_backoff_ms）
  4. 更新 last_run_at，计算 next_run_at
```

#### catch-up 策略

Gateway 离线期间错过的 cron 执行，**只跑下一次**，不补跑历史。避免 thundering herd。

预留配置：`catch_up: 'next'`（默认）| `'all'` | `'latest'`。

#### 支持的调度类型

| 类型 | 示例 | 说明 |
|------|------|------|
| `cron` | `0 9 * * 1-5` | 标准 cron 表达式 |
| `delayed` | `run_at: 1715000000000` | 一次性延迟执行 |
| `recurring` | `interval_ms: 3600000` | 固定间隔循环 |

### 5.4 Watchdog（新增）

> 心跳超时 10min < 任务超时 30min 是有意为之：正常任务再长心跳也在更新，
> 只有进程真正卡死/崩溃才触发 10min 超时。这两个值不要对齐。

#### 超时恢复流程（先 kill 再重试/死信）

> child_pid 是 supertask-runner 进程的 PID。kill child_pid 后，
> supertask-runner 内部的 task.agent 子进程可能仍在运行（取决于进程组）。
> 为此 Gateway spawn 时使用 `detached: false`，确保子进程随父进程一起终止。

```
每 60s 检查：
  1. 找 task_runs WHERE status='running' AND heartbeat_at < now_ms() - 600000
  2. 拿 child_pid，尝试 kill -9（如果进程还存在）
  3. 标记 task_runs.status = 'failed'
  4. 检查 tasks.retry_count < tasks.max_retries:
     YES → 重置 task = 'pending'，retry_count++，设置 retry_after
     NO  → 标记 task = 'dead_letter'
```

#### 已完成任务清理

| 功能 | 间隔 | 逻辑 |
|------|------|------|
| 数据清理 | 每 24h | 超 30 天的 done/failed/dead_letter 任务及对应 runs 删除 |

### 5.5 Schema 完整扩展

> **时间字段约定**：tasks 表老字段（createdAt/startedAt/finishedAt）保持 Drizzle `timestamp`（秒）。
> 新增字段全部用 **毫秒（ms）**，与心跳/调度配置一致。代码中用 `Date.now()` 取值。

#### tasks 表新增字段

```sql
ALTER TABLE tasks ADD COLUMN retry_after INTEGER;      -- 退避到期时间（ms）
ALTER TABLE tasks ADD COLUMN timeout_ms INTEGER;       -- 执行超时（ms）
ALTER TABLE tasks ADD COLUMN template_id INTEGER;       -- 来源模板 ID
ALTER TABLE tasks ADD COLUMN scheduled_at INTEGER;      -- 计划执行时间（ms）
```

tasks 表状态扩展：`pending | running | done | failed | dead_letter | cancelled`

#### task_runs 表新增字段（运行时态放这里）

```sql
ALTER TABLE task_runs ADD COLUMN locked_at INTEGER;     -- 抢占时间（ms）
ALTER TABLE task_runs ADD COLUMN locked_by TEXT;         -- Worker ID
ALTER TABLE task_runs ADD COLUMN heartbeat_at INTEGER;   -- 心跳时间（ms）
ALTER TABLE task_runs ADD COLUMN worker_pid INTEGER;     -- Gateway Worker 进程 PID
ALTER TABLE task_runs ADD COLUMN child_pid INTEGER;      -- opencode 子进程 PID
```

**设计原则**：
- `tasks` 表：任务定义 + 最终状态（pending/running/done/failed/dead_letter/cancelled）
- `task_runs` 表：本次执行的运行时态（sessionId/heartbeat/pid/worker_id）

### 5.6 Plugin 工具扩展

Scheduler 对应的 MCP 工具参数：

```ts
supertask_schedule({
  name: string,
  agent: string,
  prompt: string,
  model?: string,
  cwd?: string,
  category?: string,
  importance?: number,
  urgency?: number,
  batchId?: string,              // 模板生成的任务归属的批次
  schedule: {
    type: 'cron' | 'delayed' | 'recurring',
    cron_expr?: string,
    run_at?: number,
    interval_ms?: number,
  },
  max_instances?: number,
  max_retries?: number,          // 默认 3
  retry_backoff_ms?: number,     // 默认 30000
})
```

## 6. 配置

路径：`~/.config/opencode/supertask.json`

```json
{
  "worker": {
    "max_concurrency": 2,
    "poll_interval_ms": 1000,
    "heartbeat_interval_ms": 30000,
    "task_timeout_ms": 1800000,
    "default_model": "zhipuai-coding-plan/glm-4.7"
  },
  "scheduler": {
    "enabled": true,
    "check_interval_ms": 1000,
    "catch_up": "next"
  },
  "watchdog": {
    "heartbeat_timeout_ms": 600000,
    "cleanup_interval_ms": 60000,
    "retention_days": 30
  },
  "logging": {
    "level": "info",
    "format": "json"
  }
}
```

## 7. 进程管理

### 防双开

Gateway 启动时用 PID 文件锁（`flock`），确保只有一个实例运行：

```ts
const lockFile = openSync(lockPath, 'w');
flockSync(lockFile, 'exnb');
writeSync(lockFile, process.pid.toString());
```

### 开发

```bash
bun run gateway                      # 启动 Gateway
bun run ui                           # 启动 Dashboard（按需）
bun --watch src/gateway/index.ts     # 开发热重载
```

### 生产

```ini
# ~/.config/systemd/user/supertask-gateway.service
[Unit]
Description=SuperTask Gateway
After=network.target

[Service]
Type=simple
ExecStart=/path/to/bun run /path/to/src/gateway/index.ts
Restart=always
RestartSec=5
TimeoutStopSec=1800
KillMode=mixed
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
```

- `TimeoutStopSec=1800`：给足 30 分钟任务跑完
- `KillMode=mixed`：SIGTERM 只发主进程，子进程由 Gateway 代码管理

```bash
systemctl --user enable supertask-gateway
systemctl --user start supertask-gateway
journalctl --user -u supertask-gateway -f
```

## 8. 优雅关闭

```
SIGTERM 接收
  ├── 停止 Scheduler（不再生成新任务）
  ├── 停止 Worker 轮询（不再抢占新任务）
  ├── 等待当前任务完成（systemd 给 1800s）
  ├── 超时后 kill 所有 child_pid（supertask-runner 进程，内部 task.agent 随之终止）
  ├── 未完成任务的 task_runs 标记 failed
  ├── 未完成任务的 tasks 重置为 pending
  ├── 关闭数据库连接
  ├── 释放 PID 文件锁
  └── 进程退出 (code 0)
```

## 9. 实施任务

### T1：Gateway 骨架 + Schema 扩展

- [ ] `src/gateway/config.ts` — 读取配置 + 环境变量
- [ ] `src/gateway/index.ts` — 入口 + PID 文件锁 + 启动 Worker/Scheduler/Watchdog
- [ ] 改造 `src/worker/index.ts` — 从独立 while(true) 改为并发调度模块（内存 Set + Promise 池）
- [ ] Drizzle migration：tasks 表增加 retry_after / timeout_ms / template_id / scheduled_at
- [ ] Drizzle migration：task_runs 表增加 locked_at / locked_by / heartbeat_at / worker_pid / child_pid
- [ ] TaskService.next() 增加 excludedBatchIds 参数 + retry_after 过滤 + 优先级排序
- [ ] TaskRunService.heartbeat(runId) 方法
- [ ] TaskRunService.updatePid(runId, childPid) 方法
- [ ] npm script: `gateway` → `bun run src/gateway/index.ts`
- [ ] 验证：`bun run gateway` 启动后 Worker 正常并发调度 + 分组隔离生效

### T2：Watchdog + 重试退避

- [ ] `src/gateway/watchdog/heartbeat.ts` — 找超时 run → kill child_pid → 退避重试或 dead_letter
- [ ] `src/gateway/watchdog/cleanup.ts` — 清理 30 天前的记录
- [ ] `src/gateway/watchdog/index.ts` — 看门狗主循环
- [ ] TaskService.fail() 增加 retry_after 计算（指数退避）
- [ ] 验证：手动设置 run running + 超时心跳 → Watchdog kill + 退避重试 → 超过 max_retries → dead_letter

### T3：信号处理 + 优雅关闭

- [ ] SIGTERM/SIGINT 处理
- [ ] 停止 Scheduler → 停止 Worker → kill child_pid → 重置未完成 → 关闭 DB → 释放 PID 锁
- [ ] 验证：Ctrl+C 后无卡死 running 任务、无残留 opencode 子进程

### T4：Scheduler

- [ ] Drizzle migration：新增 task_templates 表（含 max_retries / retry_backoff_ms）
- [ ] `src/gateway/scheduler/cron-parser.ts` — cron 解析（cron-parser 库）
- [ ] `src/gateway/scheduler/job-templates.ts` — 模板克隆（字段复制，含重试配置）
- [ ] `src/gateway/scheduler/index.ts` — 每秒检查 next_run_at + catch-up=next
- [ ] CLI 命令：`supertask template add/list/enable/disable`
- [ ] Plugin 工具：`supertask_schedule`（参数见 §5.6）
- [ ] 验证：创建 `*/1 * * * *` 模板 → 每分钟生成任务 → 重启后不补跑历史

### T5：生产加固

- [ ] 结构化 JSON 日志
- [ ] systemd service 文件模板
- [ ] README 更新（含 supertask-runner.md 安装步骤到 `~/.config/opencode/agent/`）
- [ ] supertask-runner.md 加入项目 `agents/` 目录（备份），README 说明复制到全局

## 10. 风险与取舍

| 风险 | 应对 |
|------|------|
| SQLite 写锁 | Gateway 是唯一调度写者；用户操作由 WAL 串行化；单 Gateway + PID 文件锁防双开 |
| Gateway 崩溃 | SQLite 持久化 + systemd Restart=always + 启动时 Watchdog 恢复超时任务 |
| 单机不可扩展 | 设计取舍，定位是单机 SQLite；需要分布式时迁移到 PostgreSQL |
| cron catch-up | 默认只跑下次，不补跑历史 |
| 模板量上限 | 100 以内，超过改用内存最小堆 |
| 分组并发安全 | 单 Gateway 实例，内存 Set 保证同 batchId 不并发；乐观锁兜底 |
| PID 追踪只能到 supertask-runner | spawn 时 `detached: false`，kill supertask-runner 时内部 task.agent 随之终止 |
| supertask-runner 全局配置 | 依赖 `~/.config/opencode/agent/supertask-runner.md` 存在，文档说明安装步骤 |
