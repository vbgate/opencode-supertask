# SuperTask 运行与排障手册

> 状态：当前有效
> 最后核对：2026-07-15

## 启动方式与 PM2

PM2 不是任务执行所必需的组件。Gateway 才负责 Worker、Scheduler、Watchdog 和 Dashboard；PM2 只负责让 Gateway 崩溃后重启，并配合系统启动项长期运行。

| 场景 | 命令 | 是否需要 PM2 |
|---|---|---|
| 本地开发、观察日志、临时运行 | `supertask gateway` | 否 |
| 源码开发 | `bun run gateway` | 否 |
| 长期后台运行 | `supertask install` | 是；缺失时会显式全局安装 |
| 打开已运行 Gateway 的 Dashboard | `supertask ui` | 否；该命令只打开浏览器 |

`supertask install` 会启动名为 `supertask-gateway` 的 PM2 进程，设置 5 秒重启延迟、最多 30 次重启，并把 PM2 kill timeout 设为 drain 宽限期加 5 秒；随后执行 `pm2 save` 并尝试配置 `pm2 startup`。如果系统启动项需要管理员命令，必须按 PM2 输出手工完成。

插件加载时会检查 `gateway_lock`：已有新鲜心跳就不处理；没有运行实例且机器已安装 PM2 时，会启动或按包版本重启 Gateway；没有 PM2 时只提示用户，不会静默安装全局依赖。

常用检查：

```bash
supertask config
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
```

| 数据 | 默认位置 | 覆盖方式 |
|---|---|---|
| SQLite | `~/.local/share/opencode/tasks.db` | `SUPERTASK_DB_PATH` |
| Gateway 配置 | `~/.config/opencode/supertask.json` | `SUPERTASK_CONFIG_PATH` |
| 目标 OpenCode 可执行文件 | `opencode` | `SUPERTASK_OPENCODE_BIN` |

数据库连接启用 WAL 和 5 秒 `busy_timeout`。每次新连接初始化会自动执行 migrations、启用外键并检查孤立记录；检查失败会拒绝继续运行，不会自动删除用户数据。

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

模板的 `maxInstances` 只统计该模板产生的 `pending` 和 `running` 任务。达到上限时保留到期状态，等容量释放后再生成一个实例；不会回放离线期间错过的每个周期。

## 健康检查与可观测性

Gateway 提供 `/health`，只有 PM2 PID 匹配新鲜 `gateway_lock.ready_at`，且 Worker、Scheduler、Watchdog 最近仍有活动时才返回 200。建议组合以下信号判断：

```bash
pm2 status
supertask status
curl -fsS http://127.0.0.1:4680/ >/dev/null
curl -fsS http://127.0.0.1:4680/health
```

- PM2 `online` 只说明包装进程存在；SuperTask 自身还要求 PM2 PID 与 ready 锁 PID 一致。
- `/health` 可访问说明 Gateway 的 HTTP、数据库锁及内部循环正常；如果禁用了 Dashboard，此信号不适用，PM2 管理仍使用 ready 锁判断。
- 最可靠的运行证据是 `pm2 logs supertask-gateway` 中的 Gateway 启动日志、任务状态变化和最新 `task_runs` 心跳。

如需无人值守运行，仍缺少指标、告警和日志轮转的项目级约定；应由实际部署环境补齐。

## 排障

### 排队任务不执行

1. 运行 `supertask status`，确认确实有 `pending` 或可重试的 `failed`。
2. 使用 PM2 时检查 `pm2 status` 和 `pm2 logs supertask-gateway`；不用 PM2 时直接运行 `supertask gateway` 观察启动错误。
3. 运行 `supertask config` 验证配置能否加载，确认 Worker 并发不为零、Scheduler 在需要模板时已启用。
4. 检查任务是否仍在 `retryAfter` 退避期、是否等待未完成的 `dependsOn`，或同一 `batchId` 是否已有任务运行。
5. 确认 `task.agent` 存在且不是已废弃的 `supertask-runner`，并确认任务 `cwd` 可访问。

### Gateway 提示已有实例

锁心跳 30 秒内被视为有效。先确认是否已有前台或 PM2 Gateway，不要直接删除 `gateway_lock`。异常退出后等待锁过期，PM2 会按重启策略再次尝试。

### 任务长时间 running

Watchdog 的恢复时间不是任务超时时间。Worker 的 `taskTimeoutMs` 控制正常运行时的硬超时；Watchdog 在心跳停止超过 `heartbeatTimeoutMs` 后，下一次检查才恢复任务。

运行中 `cancel` 会在下一个 Worker 轮询周期被发现，随后终止对应进程树、保留任务 `cancelled` 状态，并把本次 run 关闭为失败。

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

## 备份与恢复

一致性最简单的做法是在没有运行中任务时停止 Gateway，再复制数据库和配置。停止 PM2 进程可用 `pm2 stop supertask-gateway`，恢复后用 `pm2 start supertask-gateway`。

```bash
mkdir -p ~/supertask-backup
cp ~/.local/share/opencode/tasks.db ~/supertask-backup/tasks.db
cp ~/.config/opencode/supertask.json ~/supertask-backup/supertask.json
```

若不能停止 Gateway，单独复制 WAL 模式下的主数据库文件不保证包含最新事务，应使用 SQLite 在线备份能力，或同时正确处理 `-wal`/`-shm` 文件。恢复前先保留现有文件，不要覆盖唯一副本。

## 升级与卸载

```bash
supertask upgrade     # 刷新 OpenCode 插件缓存并重启 PM2 Gateway
supertask uninstall   # 仅从 PM2 移除 Gateway，保留其他 PM2 项和数据
```

`upgrade` 使用 `opencode plugin opencode-supertask@latest --global --force` 更新 OpenCode 实际加载的缓存，校验包版本和 `dist/gateway/index.js` 后再切换 PM2；新版未就绪会自动回滚旧 Gateway。该命令要求 OpenCode CLI 和 PM2 已安装。数据库迁移会在新版本首次初始化时自动运行；升级前备份是低成本的安全措施。

发布流程通过 GitHub Release 触发，也可带明确版本参数手动运行 `publish.yml` 处理发布基础设施故障。工作流使用 npm Trusted Publisher/OIDC，不依赖长期 `NPM_TOKEN`；npm 包设置必须信任仓库 `vbgate/opencode-supertask` 的 `publish.yml`。不要在本机手动 `npm publish`。

更完整的设计边界见[当前架构与决策](./architecture.md)。
