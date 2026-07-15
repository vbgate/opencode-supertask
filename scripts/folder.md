# scripts/ 目录文档

> [输入]: 文件系统扫描、TaskService
> [输出]: 批量操作脚本
> [定位]: 一次性工具脚本，辅助批量任务管理

这些脚本包含特定项目假设，不属于 npm 用户的常规运行链路。执行前必须阅读源码并确认数据库和硬编码路径；运行状态修复优先依赖 Gateway 的正常恢复逻辑。

## 文件

| 文件 | 用途 |
|------|------|
| `batch-translate.ts` | 针对硬编码 `opencodedocs` 路径扫描中文 Markdown，为 9 种语言创建 `localize-gen` 任务 |
| `reset-status.ts` | 离线手工将全部 running/failed 重置为 pending；不得与 Gateway 同时运行 |
