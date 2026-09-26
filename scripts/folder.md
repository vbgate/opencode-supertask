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
| `opencode-compat-smoke.ts` | 先 `bun run build`；用真实 OpenCode 1.x/2.x 可执行文件、隔离 XDG 目录与本地假模型验证插件建任务、Gateway 执行、Session 捕获与继续会话（不调用真实模型） |
| `package-install-smoke.ts` | `npm pack` 后隔离安装，验证 CLI、migration 与插件入口 |
| `launcher-ipc-smoke.ts` | 在指定 Bun 版本上验证 launcher 排空证明 IPC |
