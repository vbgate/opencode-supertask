# OpenCode SuperTask (OST)

SuperTask 是一个基于 SQLite 的高性能任务队列管理系统，专为 OpenCode Agent 设计。它允许你批量创建任务、管理依赖，并通过后台 Worker 自动调度 Agent 执行。

## 🚀 核心特性

- **SQLite 驱动**：轻量、快速，无需额外数据库服务。
- **CLI 管理**：提供完整的命令行工具进行任务增删改查。
- **Agent 集成**：通过 MCP 插件将任务能力暴露给 OpenCode Agent。
- **Worker 调度**：支持后台 Worker 自动轮询并抢占式执行任务。
- **并发安全**：基于乐观锁的任务抢占机制，支持多 Worker 并发运行。

## 📦 安装与配置
### 1. 安装依赖

```bash
cd ~/code/opencodedocs/supertask
bun install
```

### 2. 初始化数据库

数据库位于 `~/.local/share/opencode/tasks.db`。

```bash
# 生成迁移文件 (如有修改 schema)
bun run db:generate

# 执行迁移
bun run db:migrate
```

### 3. 配置 OpenCode

在你的 OpenCode 配置文件（通常是 `opencode.json` 或 `~/.opencode/config.json`）中注册插件：

```json
{
  "plugin": [
    "/Users/javazys/code/opencodedocs/supertask"
  ]
}
```

重新构建插件以生效：

```bash
bun run build
```

---

## 🛠️ CLI 使用指南

CLI 入口：`src/cli/index.ts`

### 添加任务

```bash
bun run src/cli/index.ts add \
  --name "任务名称" \
  --agent "localize-gen" \
  --prompt "任务提示词..." \
  --importance 5
```

### 查看任务列表

```bash
# 列出所有任务
bun run src/cli/index.ts list

# 筛选 pending 状态
bun run src/cli/index.ts list --status pending
```

### 查看统计

```bash
bun run src/cli/index.ts status
```

### 删除/取消任务

```bash
# 删除任务
bun run src/cli/index.ts delete --id 1

# 取消任务
bun run src/cli/index.ts cancel --id 1
```

---

## 🤖 Runner Agent

**SuperTask Runner** 是一个专门的 Agent，用于执行队列中的任务。

**配置文件**：`~/.config/opencode/agent/supertask-runner.md`

### 手动运行

```bash
cd ~/code/opencodedocs
opencode run --agent supertask-runner "执行下一个任务"
```

### 工作原理

1. Runner 启动后，通过 `supertask_next` 获取任务。
2. 只要有任务，它就会用 Bash 调用 `opencode run --agent <task.agent>` 执行具体的子 Agent（如 `localize-gen`）。
3. 执行完成后，自动标记任务为 `done`。

---

## 👷 后台 Worker (推荐)

Worker 脚本可以自动轮询数据库，抢占任务并调用 `supertask-runner` 执行。

### 启动 Worker

```bash
# 前台运行（测试）
bun run scripts/worker.ts

# 指定模型运行（覆盖任务配置）
bun run scripts/worker.ts -m gemini-2.0-flash

# 后台运行（生产）
nohup bun run scripts/worker.ts > worker.log 2>&1 &
```

**并发执行**：你可以启动多个 Worker 进程，它们会自动竞争任务，互不干扰。

### 批量创建任务

我们提供了一个脚本扫描中文文档并批量创建翻译任务：

```bash
bun run scripts/batch-translate.ts
```

该脚本会自动跳过已存在的任务（基于任务名去重）。
