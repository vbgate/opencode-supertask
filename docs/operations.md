# SuperTask 运行与排障手册

> 状态：当前有效
> 最后核对：2026-07-16

## 启动方式与 PM2

PM2 不是任务执行所必需的组件。Gateway 才负责 Worker、Scheduler、Watchdog 和 Dashboard；PM2 只负责让 Gateway 崩溃后重启，并配合系统启动项长期运行。

| 场景 | 命令 | 是否需要 PM2 |
|---|---|---|
| 本地开发、观察日志、临时运行 | `supertask gateway` | 否 |
| 源码开发 | `bun run gateway` | 否 |
| 长期后台运行 | `supertask install` | 是；缺失时会显式全局安装 |
| 打开已运行 Gateway 的 Dashboard | `supertask ui` | 否；该命令只打开浏览器 |

`supertask install` 会启动名为 `supertask-gateway` 的 PM2 进程，设置 5 秒重启延迟、最多 30 次不稳定重启、默认 512 MB 内存重启阈值，并把 PM2 kill timeout 设为 drain 宽限期加 5 秒；随后安装/配置 `pm2-logrotate`（单文件 10 MB、保留 7 份、压缩、每小时检查）并执行 `pm2 save`。macOS 会直接安装用户级 `~/Library/LaunchAgents/com.supertask.pm2-resurrect.plist`，登录时运行 `pm2 resurrect`，不需要 sudo；其他系统继续使用 `pm2 startup`，如果需要管理员命令则按 PM2 输出手工完成。

插件加载时会检查 `gateway_lock`：已有新鲜心跳就不处理；没有运行实例且机器已安装 PM2 时，会启动或按包版本重启 Gateway；没有 PM2 时只提示用户，不会静默安装全局依赖。

常用检查：

```bash
supertask config
supertask doctor
supertask status
pm2 status
pm2 logs supertask-gateway
```

修改配置后必须重启 Gateway 才生效：

```bash
pm2 restart supertask-gateway
```

前台模式则用 `Ctrl-C` 停止后重新运行。停止会先等待 drain 宽限期，随后中断未完成任务并把它们重置为 `pending`，因此有外部副作用的任务仍应保证幂等。

## 初始化与数据位置

```bash
supertask init       # 首次创建最小配置并执行数据库迁移
supertask migrate    # 手动触发迁移；正常初始化也会自动迁移
supertask db check   # 完整性、外键、业务表和运行状态检查
```

| 数据 | 默认位置 | 覆盖方式 |
|---|---|---|
| SQLite | `~/.local/share/opencode/tasks.db` | `SUPERTASK_DB_PATH` |
| Gateway 配置 | `~/.config/opencode/supertask.json` | `SUPERTASK_CONFIG_PATH` |
| 目标 OpenCode 可执行文件 | `opencode` | `SUPERTASK_OPENCODE_BIN` |
| PM2 内存重启阈值 | `512M` | `SUPERTASK_PM2_MAX_MEMORY`，格式如 `256M` / `1G` |

数据库连接启用 WAL 和 5 秒 `busy_timeout`。每次新连接初始化会自动执行 migrations、启用外键并检查孤立记录；检查失败会拒绝继续运行，不会自动删除用户数据。

CLI 的任务/模板 ID、优先级、重试次数和列表数量均按完整十进制整数解析；带尾随字符、小数、越界值和未知任务状态会返回非零退出码，不会再由 `parseInt` 静默截断。

## 完整配置

未写出的字段使用下表默认值。Dashboard 保存配置时会进行分组浅合并和完整校验，写入采用临时文件后原子重命名，权限为 `0600`。

| 配置项 | 默认值 | 有效范围/说明 |
|---|---:|---|
| `configVersion` | `2` | 接受 1 或 2，加载后统一为 2 |
| `worker.maxConcurrency` | `2` | 1–64 |
| `worker.pollIntervalMs` | `1000` | 50–60000 ms |
| `worker.heartbeatIntervalMs` | `30000` | 1000–3600000 ms，必须小于心跳超时 |
| `worker.taskTimeoutMs` | `1800000` | 1000–604800000 ms；单任务可覆盖 |
| `worker.shutdownGracePeriodMs` | `30000` | 0–3600000 ms；Gateway 停止接单后等待在途任务的时间 |
| `scheduler.enabled` | `true` | 是否克隆到期模板 |
| `scheduler.checkIntervalMs` | `1000` | 100–60000 ms |
| `watchdog.heartbeatTimeoutMs` | `600000` | 1000–86400000 ms |
| `watchdog.checkIntervalMs` | `60000` | 1000–3600000 ms，不能大于心跳超时 |
| `watchdog.cleanupIntervalMs` | `86400000` | 60000–604800000 ms |
| `watchdog.retentionDays` | `30` | 1–3650 天 |
| `dashboard.enabled` | `true` | 是否随 Gateway 启动 |
| `dashboard.port` | `4680` | 1–65535，仅绑定 `127.0.0.1` |

建议以完整配置开始：

```json
{
  "configVersion": 2,
  "worker": {
    "maxConcurrency": 2,
    "pollIntervalMs": 1000,
    "heartbeatIntervalMs": 30000,
    "taskTimeoutMs": 1800000,
    "shutdownGracePeriodMs": 30000
  },
  "scheduler": {
    "enabled": true,
    "checkIntervalMs": 1000
  },
  "watchdog": {
    "heartbeatTimeoutMs": 600000,
    "checkIntervalMs": 60000,
    "cleanupIntervalMs": 86400000,
    "retentionDays": 30
  },
  "dashboard": {
    "enabled": true,
    "port": 4680
  }
}
```

版本 1 的兼容规则只有一项特殊语义：若没有 `watchdog.checkIntervalMs`，旧的 `watchdog.cleanupIntervalMs` 会被解释为心跳检查间隔；真实清理间隔回到默认的一天。保存后应使用版本 2 字段，避免继续混淆。

### 配置调优原则

- `heartbeatIntervalMs` 通常不超过 `heartbeatTimeoutMs` 的三分之一，给短暂卡顿留出余量。
- `checkIntervalMs` 越小，故障发现越快，但会增加数据库轮询；恢复最坏延迟约为 `heartbeatTimeoutMs + checkIntervalMs`。
- `maxConcurrency` 应同时考虑模型/API 配额、机器资源和 SQLite 写竞争，不应只按 CPU 核数设置。
- 长任务优先用任务或模板的 `timeoutMs` 单独覆盖，不要为了一个任务放大全局超时。
- `cleanupIntervalMs` 决定检查频率，`retentionDays` 决定保留窗口，两者不是同一个概念。

## 重试与调度操作

默认任务最多执行 4 次：首次执行加 3 次重试。失败退避为 30 秒、60 秒、120 秒，之后按同一指数规则增长，单次最多 30 分钟；基础间隔可由任务或模板覆盖。

```bash
supertask add -n "生成报告" -a "reporter" -p "汇总本周进展" \
  --max-retries 5 --retry-backoff 1min --timeout 45min

supertask retry --id 42   # 仅 failed/dead_letter；清零重试计数
```

模板的 `maxInstances` 统计该模板产生的 `pending`、`running` 和仍有自动重试预算的 `failed`。达到上限时保留到期状态，等容量释放后再生成一个实例；Dashboard 手动触发也不会绕过上限。不会回放离线期间错过的每个周期。

## 健康检查与可观测性

Gateway 提供 `/health`，只有 PM2 PID 匹配新鲜 `gateway_lock.ready_at`，且 Worker、Scheduler、Watchdog 最近仍有活动并且最近一次循环已经从错误中恢复时才返回 200。响应包含每个组件的 `lastSuccessAt`、`consecutiveFailures` 和 `lastError`。优先使用聚合诊断：

```bash
pm2 status
supertask doctor
supertask doctor --json
supertask status
curl -fsS http://127.0.0.1:4680/ >/dev/null
curl -fsS http://127.0.0.1:4680/health
```

- PM2 `online` 只说明包装进程存在；SuperTask 自身还要求 PM2 PID 与 ready 锁 PID 一致。
- `/health` 可访问说明 Gateway 的 HTTP、数据库锁及内部循环正常；如果禁用了 Dashboard，此信号不适用，PM2 管理仍使用 ready 锁判断。
- Watchdog 无法确认旧 PID 身份或无法确认子进程退出时会让任务保持隔离，并使 `/health` 降级；它不会为了恢复绿灯而冒险重派可能仍在执行的任务。
- 最可靠的运行证据是 `supertask doctor` 全部通过、`pm2 logs supertask-gateway` 中有启动/状态变化，以及最新 `task_runs` 心跳。`doctor` 失败时返回非零退出码，适合外部巡检。

显式安装会治理 PM2 日志；Worker 不再把完整模型输出重复写到 stdout，完整的截断结果仍保存在任务/run 中。项目仍不内置通知渠道和指标后端，可用外部巡检定期执行 `supertask doctor --json` 并对非零退出码告警。

## 排障

### 排队任务不执行

1. 运行 `supertask status`，确认确实有 `pending` 或可重试的 `failed`。
2. 使用 PM2 时检查 `pm2 status` 和 `pm2 logs supertask-gateway`；不用 PM2 时直接运行 `supertask gateway` 观察启动错误。
3. 运行 `supertask config` 验证配置能否加载，确认 Worker 并发不为零、Scheduler 在需要模板时已启用。
4. 检查任务是否仍在 `retryAfter` 退避期、是否等待未完成的 `dependsOn`，或同一 `batchId` 是否已有任务运行。不可恢复或丢失的依赖会自动把下游收敛到 `dead_letter`，不会永久保持 pending。
5. 确认 `task.agent` 存在且不是已废弃的 `supertask-runner`，并确认任务 `cwd` 可访问。

### Gateway 提示已有实例

锁心跳 30 秒内被视为有效。先确认是否已有前台或 PM2 Gateway，不要直接删除 `gateway_lock`。异常退出后等待锁过期，PM2 会按重启策略再次尝试。

### 任务长时间 running

Watchdog 的恢复时间不是任务超时时间。Worker 的 `taskTimeoutMs` 控制正常运行时的硬超时；Watchdog 在心跳停止超过 `heartbeatTimeoutMs` 后，下一次检查才恢复任务。

运行中 `cancel` 会在下一个 Worker 轮询周期被发现，随后终止对应进程树、保留任务 `cancelled` 状态，并把本次 run 关闭为失败。

运行中任务不能直接删除。执行 `supertask cancel --id <id>` 或在 Dashboard 点击“取消”后，还要等待对应 `running` 执行记录关闭；在此之前 CLI 和 Dashboard 删除接口都会返回冲突。这个保护避免任务记录先消失、Worker 无法再定位并终止仍在运行的子进程。

仍被 `pending/running/failed/dead_letter` 任务引用为 `dependsOn` 的前置任务也不能删除；Watchdog 的过期清理遵循同一保护。先处理或删除下游任务，避免制造永远无法满足的悬空依赖。已终态且不可重试的 `done/cancelled` 下游不会阻塞前置任务清理。

### 配置无法加载

`supertask config` 会输出具体字段错误。修复 `~/.config/opencode/supertask.json` 后重启 Gateway。不要靠删除字段反复试错；先对照上面的范围和两个跨字段约束。

### migration 或外键检查失败

先备份数据库，再定位孤立记录。若本机有 `sqlite3`：

```bash
sqlite3 ~/.local/share/opencode/tasks.db 'PRAGMA foreign_key_check;'
```

修复应针对具体记录来源；系统故意不自动删除孤立数据。不要通过关闭外键检查绕过启动错误。

### Dashboard 不可访问或写请求返回 403

- 确认 `dashboard.enabled=true`，端口没有被占用，并且访问 `http://127.0.0.1:<port>`。
- Dashboard 不对局域网地址监听；这是安全边界，不是网络配置遗漏。
- 浏览器写请求必须同源。经过反向代理、不同主机名或不同端口访问会被拒绝。

## 数据库检查、备份、清空与恢复

数据库维护统一经过 `DatabaseMaintenanceService`，CLI 和 Dashboard 清空不再直接操作业务表。

```bash
supertask db check
supertask db backup
supertask db backup --output ~/supertask-backup/tasks.db
```

- `db check` 运行 `PRAGMA integrity_check`、外键检查、必需表检查，并返回三张业务表和运行中记录的数量；检查不通过时仍输出完整报告，但进程退出码为非零，便于监控和 CI 正确判定失败。
- `db backup` 使用当前连接生成一致性快照，将其转换为不依赖 `-wal`/`-shm` 的独立 SQLite 文件，再用只读连接复检；目标文件已存在时拒绝覆盖。在线备份可以在 Gateway 运行时执行。
- 自动备份默认与数据库放在同一目录，名称包含用途、UTC 时间和随机后缀，文件权限为 `0600`。
- `check/backup/clear/restore` 在交互式终端输出人类可读摘要；stdout 非 TTY 时保持 JSON，终端脚本可传 `--json` 强制 JSON。成功和错误使用同一判断，便于 `supertask db check | jq` 等既有调用继续工作。

清空全部任务、执行记录和调度模板：

```bash
supertask db clear --confirm CLEAR
```

`db clear` 会先核对 PM2 进程 PID 与当前数据库的新鲜 ready 锁；匹配时自动优雅停止 Gateway，维护结束后按原状态重启并等待新的 ready 锁，数据库操作失败时也会尝试恢复运行。传入 `--keep-stopped` 会让原本运行的 PM2 Gateway 保持停止。前台 Gateway、陈旧锁或无法确认归属的进程不会被自动终止，命令会拒绝操作并要求人工停止。

清空仍会拒绝任何 `running` 任务/执行记录，在一个 `BEGIN IMMEDIATE` 事务内先生成 `pre-clear` 备份，再删除三张业务表；任一步失败都会回滚事务。它保留数据库结构、迁移记录、配置和自增序列。若数据库维护已完成但 PM2 重启失败，CLI 会明确报告“数据库维护已完成”，此时按错误提示检查 `pm2 logs supertask-gateway`，不要重复清空。Dashboard 的“清空数据库”复用同一服务，要求服务端确认并拒绝运行中任务；因为 Dashboard 本身位于当前 Gateway 内，它只豁免当前 Gateway PID，不豁免其他进程。

从备份恢复：

```bash
supertask db restore --from ~/.local/share/opencode/tasks.pre-clear-<time>-<id>.db --confirm RESTORE
supertask db check
curl -fsS http://127.0.0.1:4680/health
```

恢复使用与清空相同的 PM2 自动停启和 `--keep-stopped` 语义。它会先校验来源文件并自动创建当前库的 `pre-restore` 安全备份，然后用同目录暂存文件替换数据库、自动执行缺失 migration，再复检完整性。备份中遗留的 `running` 任务会恢复为 `pending`，对应运行记录关闭为 `failed`，旧 `gateway_lock` 不会继续生效。恢复失败时会尝试原子回滚，并在错误信息中给出安全备份路径。

不要在 Gateway 运行时删除或只复制 `tasks.db`；WAL 模式下最新事务可能还在 `tasks.db-wal`。配置文件仍需单独备份：

```bash
mkdir -p ~/supertask-backup
cp ~/.config/opencode/supertask.json ~/supertask-backup/supertask.json
```

## 升级与卸载

```bash
supertask upgrade     # 刷新 OpenCode 插件缓存并重启 PM2 Gateway
supertask uninstall   # 仅从 PM2 移除 Gateway，保留其他 PM2 项和数据
```

`upgrade` 先从 npm `dist-tags.latest` 查询具体版本，再让 OpenCode 安装该精确版本；只有缓存包版本完全一致且包含 `dist/gateway/index.js` 时才切换 PM2，避免陈旧的 `@latest` 缓存被误判为升级成功。新版未就绪会自动回滚旧 Gateway。该命令要求 npm、OpenCode CLI 和 PM2 已安装。数据库迁移会在新版本首次初始化时自动运行；升级前备份是低成本的安全措施。

发布流程通过 GitHub Release 触发，也可带明确版本参数手动运行 `publish.yml` 处理发布基础设施故障。工作流使用 npm Trusted Publisher/OIDC，不依赖长期 `NPM_TOKEN`；npm 包设置必须信任仓库 `vbgate/opencode-supertask` 的 `publish.yml`。不要在本机手动 `npm publish`。

更完整的设计边界见[当前架构与决策](./architecture.md)。
