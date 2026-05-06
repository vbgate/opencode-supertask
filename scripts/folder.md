# scripts/ 目录文档

> [输入]: 文件系统扫描、TaskService
> [输出]: 批量操作脚本
> [定位]: 一次性工具脚本，辅助批量任务管理

## 文件

| 文件 | 用途 |
|------|------|
| `batch-translate.ts` | 扫描中文 Markdown，为 9 种目标语言创建翻译任务（en/ja/ko/de/es/fr/pt/ru/zh-tw），Agent 为 `localize-gen`，模型为 `zhipuai-coding-plan/glm-4.7` |
| `reset-status.ts` | 批量重置 running/failed → pending，用于 Worker 异常退出后清理 |
