# SuperTask 文档索引

> 最后核对：2026-07-15

## 当前有效文档

| 文档 | 用途 | 权威范围 |
|---|---|---|
| [README](../README.md) | 安装、快速开始、CLI 摘要 | 面向使用者的入口 |
| [当前架构与决策](./architecture.md) | 组件边界、执行链路、状态语义、架构取舍 | 当前源码架构的权威说明 |
| [运行与排障手册](./operations.md) | 启停、PM2、配置、重试、备份、故障定位 | 当前运行行为的权威说明 |
| [AGENTS](../AGENTS.md) | 开发约束、测试规范、项目不变量 | 贡献者与 Agent 工作规则 |

如果文档与源码冲突，以测试和源码为准，并在同一个改动中修正文档。架构或运行语义发生变化时，至少检查 `architecture.md`、`operations.md`、`README.md` 和 `AGENTS.md`。

## 历史资料

`plans/` 和 `../doc/项目分析.md` 保留了 2026-05-06 的设计与评审过程，用于解释历史背景，不代表当前实现。其中关于 systemd、独立 Dashboard、嵌套 `supertask-runner` 和待办状态的描述已经过时。

`../agents/supertask-runner.md` 也是旧架构备份，不是安装产物或当前执行链路的一部分。
