# SuperTask 运行与排障手册

> 状态：当前有效
> 最后核对：2026-07-16

## 启动方式与 PM2

PM2 不是任务执行所必需的组件。Gateway 才负责 Worker、Scheduler、Watchdog 和 Dashboard；PM2 只负责让 Gateway 崩溃后重启，并配合系统启动项长期运行。

当前 Gateway 任务执行支持 macOS 和 Linux。Windows Worker 会明确拒绝启动；仅靠 `taskkill /T` 无法在父链断裂后证明所有 OpenCode 后代已退出，必须等 Job Object 隔离完成后再开放。

| 场景 | 命令 | 是否需要 PM2 |
|---|---|---|
| 本地开发、观察日志、临时运行 | `supertask gateway` | 否 |
| 源码开发 | `bun run gateway` | 否 |
| 长期后台运行 | `supertask install` | 是；缺失时会显式全局安装 |
| 打开已运行 Gateway 的 Dashboard | `supertask ui` | 否；该命令只打开浏览器 |

`supertask install` 会启动名为 `supertask-gateway` 的 PM2 进程，设置 5 秒重启延迟、最多 30 次不稳定重启、默认 512 MB 内存重启阈值，并把 PM2 kill timeout 设为 drain 宽限期加 15 秒；显式 `SUPERTASK_PM2_KILL_TIMEOUT_MS` 低于该安全下限会在删除旧进程前失败关闭。PM2 `stop/delete` 的命令等待时间至少为实际 kill timeout 加 5 秒，显式 `SUPERTASK_PM2_COMMAND_TIMEOUT_MS` 低于该值同样会在破坏性命令前拒绝。随后安装/配置 `pm2-logrotate`（单文件 10 MB、保留 7 份、压缩、每小时检查）并执行 `pm2 save`。替换、维护和卸载由独立 SQLite 事务锁串行化，并一直持锁到 `stop/delete` 返回；进程崩溃时锁由内核自动释放。替换已有 Gateway 时会沿用其 Bun 路径和完整运行环境（包括数据库、配置与 OpenCode 路径），新进程未 ready 会恢复旧入口、环境和版本。删除旧进程前还会用保存的运行环境预检 PM2；Node/npm/Homebrew 迁移导致该环境无法再执行 PM2 时会拒绝替换，避免启动与回滚同时失败。macOS 会安装用户级 `~/Library/LaunchAgents/com.supertask.pm2-resurrect.plist`；监督器只在 `jlist` 成功确认 Gateway 缺失且 `dump.pm2` 明确包含该项时执行 `resurrect`，不会绕过 PM2 的 `errored` 熔断。卸载会先保存不含 Gateway 的 dump，再停止并删除项目 LaunchAgent。

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
| PM2 命令硬超时 | `15000` ms | `SUPERTASK_PM2_COMMAND_TIMEOUT_MS`；超时后强制终止 CLI，避免管理锁和 macOS supervisor 永久卡死 |
| PM2 管理锁等待 | `15000` ms | `SUPERTASK_PM2_MANAGEMENT_LOCK_TIMEOUT_MS`；超过后拒绝并发生命周期操作 |
| macOS supervisor 命令超时 | 继承 PM2 命令硬超时 | `SUPERTASK_PM2_SUPERVISOR_COMMAND_TIMEOUT_MS` 可单独覆盖 |

数据库连接启用 WAL 和 5 秒 `busy_timeout`。每次新连接初始化会自动执行 migrations、启用外键并检查孤立记录；检查失败会拒绝继续运行，不会自动删除用户数据。为了让 PM2 在新版未 ready 时安全恢复旧 Gateway，`0005` 起 migration 只允许 expand-only 变更：新增表、非唯一索引，以及可空或带默认值的新增列。删除、重命名、收紧约束和数据改写必须放到后续 contract 版本，等旧二进制不再是回滚目标后执行。

PM2 生命周期操作和 macOS supervisor 始终先获取 `PM2_HOME/supertask-gateway.manage.sqlite` 这一 canonical 锁。为兼容旧安装曾通过 `SUPERTASK_PM2_MANAGEMENT_LOCK` 指定的路径，新版本会从当前环境、PM2 dump/运行环境和 LaunchAgent 恢复旧锁，并按固定顺序同时持有 canonical 与全部旧锁后才修改 PM2；后续 shell 即使不再携带旧变量，也不会绕过仍在运行的旧 supervisor。若已安装 LaunchAgent 保存的 `PM2_HOME` 与当前 CLI 不同，所有生命周期和数据库维护操作都会在修改前失败关闭；请按错误提示用原 `PM2_HOME` 重试，避免两个 PM2 daemon 反复争抢同一 Gateway。

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

supertask retry --id 42   # 仅 failed/dead_letter；依赖仍有效时清零重试计数
```

若任务的 `dependsOn` 已丢失、跨 `cwd` 或进入不可恢复终态，单个和批量重试都会跳过该任务，避免生成永远无法执行的 `pending`。

模板的 `maxInstances` 统计该模板产生的 `pending`、`running` 和仍有自动重试预算的 `failed`。达到上限时保留到期状态，等容量释放后再生成一个实例；Dashboard 手动触发也不会绕过上限。不会回放离线期间错过的每个周期。

## 健康检查与可观测性

Gateway 提供 `/health`，只有 PM2 PID 匹配新鲜 `gateway_lock.ready_at`，且 Worker、Scheduler、Watchdog、历史清理最近仍有活动并且最近一次循环已经从错误中恢复时才返回 200。响应包含每个组件的 `lastSuccessAt`、`consecutiveFailures` 和 `lastError`。`doctor` 在 macOS 还会校验已加载 LaunchAgent 的 PM2 绝对路径、`PM2_HOME` 和 `dump.pm2` 中的 Gateway。优先使用聚合诊断：

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
- Dashboard 顶栏可切换中文/English 和跟随系统/浅色/深色主题。语言写入当前站点 Cookie，主题写入浏览器本地存储；它们只影响当前浏览器显示，不修改 Gateway 配置。
- 新 run 使用 `gated-v3-token-guardian`，每 run UUID 会同时写入 `task_runs.locked_by` 和 launcher argv。Watchdog 只有在 launcher、OpenCode 参数与 UUID 全部匹配时才终止进程组；Worker 仅在收到 launcher 通过独立 IPC 返回的同 UUID 排空证明后才结算正常退出。guardian 无证明退出会保持 run 和批次隔离，进程组明确消失后才作失败收敛。旧 v2/legacy 记录的 PID 或 PGID 仍存活、被复用或无法确认时只隔离且不发信号，只有二者都明确消失才恢复。无法确认子进程退出时 `/health` 会降级；旧版 `started_at`/`heartbeat_at` 同时缺失的运行记录也会立即进入诊断隔离。
- 旧版 `launch_protocol IS NULL` 且没有 child PID 的 run 无法自动证明进程退出。`doctor` 和 Watchdog 日志会给出任务/run ID：先在任务 `cwd` 执行 `supertask cancel --id <taskId>`，人工确认没有遗留 OpenCode，再执行 `supertask run abandon --id <runId> --confirm ABANDON`。未知非空协议、当前 guardian、存活 owner 或已记录 child PID 都会失败关闭，不能用该命令绕过。
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

锁心跳 30 秒内被视为有效。先确认是否已有前台或 PM2 Gateway，不要直接删除 `gateway_lock`。陈旧锁仍指向确认存活的 Gateway 时继续拒绝双主；若 PID 已被无关进程复用，身份检查会在锁陈旧后安全接管。身份无法确认时保持保守拒绝并记录日志。

### 任务长时间 running

Watchdog 的恢复时间不是任务超时时间。Worker 的 `taskTimeoutMs` 控制正常运行时的硬超时；Watchdog 在心跳停止超过 `heartbeatTimeoutMs` 后，下一次检查才恢复任务。

运行中 `cancel` 会在下一个 Worker 轮询周期被发现，随后终止对应进程树、保留任务 `cancelled` 状态，并把本次 run 关闭为失败。

若升级前的旧 Worker 恰好在启动 OpenCode 后、记录 PID 前崩溃，Watchdog 会保守保留无 PID run，避免重复执行。只有 `doctor`/日志明确标为旧版隔离，且你已独立确认不存在遗留进程时，才使用上述 `run abandon` 流程；该命令只关闭 run，任务继续保持 `cancelled`，不会自动重试。

运行中任务不能直接删除。执行 `supertask cancel --id <id>` 或在 Dashboard 点击“取消”后，还要等待对应 `running` 执行记录关闭；在此之前 CLI 和 Dashboard 删除接口都会返回冲突。这个保护避免任务记录先消失、Worker 无法再定位并终止仍在运行的子进程。

仍被 `pending/running/failed/dead_letter` 任务引用为 `dependsOn` 的前置任务也不能删除；Watchdog 的过期清理遵循同一保护，并以 500 条为单个事务批次逐步清理，避免历史积压形成超大事务。仍有 active run 的取消任务不会被清理。先处理或删除下游任务，避免制造永远无法满足的悬空依赖。

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
- 主题或语言显示异常时，可先切回“跟随系统”或重新选择语言；这两项是浏览器本地偏好，不影响任务与数据库。

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

清空仍会拒绝任何 `running` 任务/执行记录，在一个 `BEGIN IMMEDIATE` 事务内先生成 `pre-clear` 备份，再动态删除全部业务表数据；这包括由兼容新版本引入、当前旧二进制并不认识的 expand-only 表，循环外键在提交时统一校验。任一步失败都会回滚事务。它保留数据库结构、`gateway_lock`、迁移记录、配置和自增序列。若数据库维护已完成但 PM2 重启失败，CLI 会明确报告“数据库维护已完成”，此时按错误提示检查 `pm2 logs supertask-gateway`，不要重复清空。Dashboard 的“清空数据库”复用同一服务，要求服务端确认并拒绝运行中任务；因为 Dashboard 本身位于当前 Gateway 内，它只豁免当前 Gateway PID，不豁免其他进程。

从备份恢复：

```bash
supertask db restore --from ~/.local/share/opencode/tasks.pre-clear-<time>-<id>.db --confirm RESTORE
supertask db check
curl -fsS http://127.0.0.1:4680/health
```

恢复使用与清空相同的 PM2 自动停启和 `--keep-stopped` 语义。它会先校验来源文件，通过已打开的 SQLite 源连接生成包含已提交 WAL 页、无需 sidecar 的一致暂存快照，并拒绝来源是当前数据库的符号链接或硬链接别名；随后执行缺失 migration，再自动创建当前库的 `pre-restore` 安全备份。恢复会动态比较 source/live 业务表及可写列：source-only 未知表/列在任何删除前拒绝；共有未来列完整恢复；live-only 列必须可空或有默认值，live-only 新表会清空为旧快照尚未创建时的状态。业务数据在当前连接的 `BEGIN EXCLUSIVE` 事务中原位替换和复检，不通过关闭连接后改名换库；因此维护期间的其他写入要么在恢复事务前完成，要么等待后在恢复提交后落库，不会先成功再被静默覆盖。备份中遗留的 `running` 任务会恢复为 `pending`，对应运行记录关闭为 `failed`，旧 `gateway_lock` 不会继续生效。提交前任一步失败都会回滚，并在错误信息中给出安全备份路径。

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

`upgrade` 先从 npm `dist-tags.latest` 查询具体版本，再让 OpenCode 安装该精确版本；只有缓存包版本完全一致且包含 `dist/gateway/index.js` 时才切换 PM2。替换和回滚都复用原 PM2 保存的 Bun 路径与完整环境，ready 检查也针对原数据库，避免升级后静默切换数据域。该命令要求 npm、OpenCode CLI 和 PM2 已安装。数据库迁移会在新版本首次初始化时自动运行；升级前备份是低成本的安全措施。

升级必须从 Gateway 外部发起。Worker 管理的队列任务会被标记为受管执行上下文，插件在其中拒绝 `supertask_upgrade`；不要把“升级 SuperTask”作为队列任务提交，否则升级会返回安全拒绝提示。

发布流程通过 GitHub Release 触发，也可带明确版本参数手动运行 `publish.yml` 处理发布基础设施故障。稳定版本发布到 npm `latest`，带 prerelease 后缀的版本只发布到 `next`。工作流使用 npm Trusted Publisher/OIDC，不依赖长期 `NPM_TOKEN`；不要在本机手动 `npm publish`。

更完整的设计边界见[当前架构与决策](./architecture.md)。
