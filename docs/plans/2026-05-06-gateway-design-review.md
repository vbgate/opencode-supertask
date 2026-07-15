# Gateway 设计文档评审

> [!WARNING]
> 历史评审记录，仅用于追溯当时的设计问题，不代表当前缺陷清单。结论是否仍成立应以源码和测试重新验证；当前事实见[当前架构与决策](../architecture.md)和[运行与排障手册](../operations.md)。

> 评审对象：[2026-05-06-gateway-design.md](./2026-05-06-gateway-design.md) v1.2
> 日期：2026-05-06
> 评审人：Droid（资深架构师视角）
> 置信度：8/10

整体方向正确，业界参考扎实，分进程取舍清晰；但 Schema 单位混乱、运行时态字段放错表、Watchdog 链路不闭合等问题需要在动手前修正，否则 T3-T5 会反复返工。

---

## 一、架构层面（基本认可，但表述需修正）

### 1.1 「Gateway 是唯一写者」与现实不符 🚨

第 10 节风险表写：

> SQLite 单写锁 → WAL 模式 + Gateway 是唯一写者

但 CLI / Plugin / Web Dashboard 都需要写库（add / cancel / retry / delete）。实际是 **WAL 多写者模型，靠 SQLite 自身串行化**，bunqueue 的 286K ops/sec 也是这个前提。

→ 建议改写为：「Gateway 是唯一**调度**写者；用户操作（CLI/Plugin/Web）写入由 SQLite WAL 串行化保证一致性」。

### 1.2 Worker concurrency=N 的实现复杂度被低估

现有 `src/worker/index.ts` 是同步 `while(true)` + 5s sleep + 单任务串行。改造为并发 N 涉及：

- Promise 池（不需要 worker_threads，opencode 子进程本身就在外部）
- 抢占的并发安全 ✅（`TaskService.start` 已经乐观锁）
- 心跳/取消信号要精确到任务粒度，不是 Worker 粒度

→ **建议**：第一版默认 `concurrency=1`，验证稳定后再放开；T1 不要混入并发改造。

### 1.3 Web Dashboard 与 Gateway 解耦的代价没说清

Gateway 重启期间 `heartbeat_at` 不更新，Dashboard 上会看到「running 但心跳停滞」状态——应在文档里明说「Dashboard 是只读视图，重启 Gateway 期间数据短暂滞后」，避免后续误以为是 bug。

---

## 二、Schema 层面（最大问题在这）

### 2.1 时间字段单位混乱 🚨🚨

现有 schema：

```ts
createdAt: integer('created_at', { mode: 'timestamp' })  // Drizzle 的 timestamp = 秒
```

设计文档新增字段全部裸 `INTEGER`（没标单位），但配置里又是毫秒（`heartbeat_interval_ms: 30000`）。

**这会埋雷**：心跳间隔 30s（毫秒），但 `heartbeat_at` 如果按秒存储，Watchdog 比较 `now() - heartbeat_at > 600000` 时直接误判。

→ **必须明确**：

- 推荐**新字段全部用 `timestamp_ms`（毫秒）**，理由是心跳和 cron `next_run_at` 都需要亚秒精度
- 老字段（createdAt 等）保持秒，文档里建表标注「**所有新字段单位 ms**」并加单元测试覆盖

### 2.2 运行时态字段不该放 tasks 表 🚨

设计文档把 `locked_at / locked_by / heartbeat_at` 全塞进 tasks 表。但项目里**已经有 `task_runs` 表**（一个任务可多次执行，记录 sessionId/log）。

`locked_by / heartbeat_at` 是**本次运行**的状态，应该放 `task_runs`：

```
tasks 表：任务定义 + 最终状态（pending/running/done/failed）
task_runs 表：本次执行的运行时态 + sessionId + heartbeat_at + worker_id + pid
```

Watchdog 逻辑也更干净：

> 找 `task_runs.status='running' AND heartbeat_at < now() - 10min` 的 run，标记 run failed，把对应 task 重置为 pending（如果还在 running）。

否则 tasks 表既是任务定义、又是运行时态，concurrency 一上去会出现「同一个 task 多次抢占心跳互相覆盖」的语义混乱。

### 2.3 PID 字段缺失 → Watchdog 僵尸检测不闭合 🚨

文档第 5.3 节说「僵尸进程清理：spawn PID 已死 → failed」。但**新 Schema 没加 PID 字段**，Worker 崩溃后 Watchdog 拿不到 PID 怎么 kill？

→ `task_runs` 必须加 `worker_pid INTEGER`、`child_pid INTEGER`（opencode 子进程 PID）。

### 2.4 task_templates 与 tasks 字段反范式重复

`agent / model / prompt / cwd / category / importance / urgency` 7 个字段在两表完全重复。可接受，但要写明：

> 模板字段在克隆时复制到 task；编辑模板不影响已生成的 task。

否则后续会有人想「为什么我改了模板老任务没变？」。

---

## 三、Scheduler

### 3.1 catch-up 策略缺失 ⚠️

Gateway 离线 3 小时、cron `0 * * * *` 有 3 次未执行，重启后：

- A. 只跑下一次（默认，避免风暴）
- B. 补跑全部（容易触发 thundering herd）
- C. 只补跑最近一次

→ 文档应明确选 A，并给 `catch_up: 'next' | 'all' | 'latest'` 配置项预留。

### 3.2 max_instances 检查的并发安全前提

`SELECT count(*) WHERE template_id=? AND status IN (pending, running)` + `INSERT` 不是原子操作。**单 Gateway 实例**前提下没问题，但要在文档里写死「Gateway 单实例运行」，并在 T1 加锁文件防止双开（`flock` 或 PID 文件）。

### 3.3 每秒查 SQL vs 内存最小堆

模板量 < 100 时每秒 SQL 完全 OK，但要在文档写明「设计上限 100 模板」，未来超过用堆。

---

## 四、Watchdog

### 4.1 重置任务前必须先 kill PID 🚨

文档现在的逻辑：

> heartbeat 超时 → tasks.status = pending

如果原 Worker 进程没死、只是卡住（系统负载、IO 阻塞），新 Worker 抢到任务后会**双跑**——opencode 子进程会创建两个 session、改两遍文件。

→ 正确顺序：

1. 找到超时 run
2. 拿 `child_pid` 尝试 `kill -9`（如果存在）
3. 标记 run failed
4. 重置 task 为 pending

这强依赖 §2.3 的 PID 字段。

### 4.2 heartbeat 10min 与 task_timeout 30min 的关系

心跳 30s 间隔，正常任务再长心跳也在更新；只有进程卡死才会触发 10min 超时——逻辑自洽。但文档应说明「**10min 心跳超时 < 30min 任务超时是有意为之**」，避免后续有人去对齐这俩值。

---

## 五、优雅关闭

### 5.1 「30s 等待」对 task_timeout=30min 的任务不够 🚨

`SIGTERM → 等当前任务完成（最长 30s）→ 重置为 pending` 这段有问题：

- 如果 30s 内子进程没完成，**子进程没被 kill 就重置 pending**，下个 Worker 抢到后双跑
- 30s 是给 systemd 的 stop 时限，但任务可以跑 30 分钟，量级差 60 倍

→ 正确做法二选一：

- **A. systemd `TimeoutStopSec=1800`**：给足任务跑完，不重置
- **B. 强制 kill 子进程后再重置**：保证一致性，接受任务被打断

文档应明确选哪个（推荐 A，配 `KillMode=mixed`）。

---

## 六、其他

### 6.1 缺少观测端点

Gateway 跑起来后怎么知道它健康？建议 Gateway 暴露一个最小 HTTP 端点 `:7777/health`（不是 Web Dashboard），systemd `ExecStartPost=curl localhost:7777/health` 也好用。

### 6.2 Plugin 工具 `supertask_schedule` 参数未展开

第 9 节 T5 提到加 plugin 工具，但参数 schema 没设计。建议补一段：

```ts
supertask_schedule({
  name, agent, model, prompt, cwd,
  schedule: { type: 'cron'|'delayed'|'recurring', expr|run_at|interval_ms },
  max_instances?: 1
})
```

### 6.3 任务清单顺序建议调整

当前 T1 → T2 → T3 → T4 → T5。建议：

- **T1 + T3（Schema）合并**：Gateway 骨架和 Schema 一起做，否则 T1 用旧 Schema 实现一遍、T3 改完又得改一遍
- **T2 信号处理放到 T4 之后**：先有 Watchdog 兜底，信号处理的边界条件才好测

---

## 七、Top 3 必改项总结

| # | 问题 | 影响 |
|---|------|------|
| 1 | 时间单位（秒/毫秒）混乱，新字段没标单位 | Watchdog/Scheduler 误判 |
| 2 | 运行时态（locked_by / heartbeat_at / pid）应放 task_runs，不放 tasks | 并发上去后语义崩坏 |
| 3 | Watchdog 重置前必须先 kill child PID（→ Schema 加 child_pid 字段） | 双跑导致数据被改两次 |

确认这三点后，可将设计文档升级到 v1.3。
