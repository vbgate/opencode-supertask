# Changelog

All notable user-facing changes are recorded here. This project follows semantic versioning while it is in the `0.x` development series.

## [0.1.36] - 2026-07-18

### Added

- `supertask doctor --smoke` now queues a real Gateway-managed OpenCode task and verifies its exact response. Agent, model, project directory, and timeout are selectable; ordinary `doctor` remains free of model calls.
- Task, scheduled-task, and run details now open as labeled, human-readable summaries. Raw JSON remains available in a collapsed troubleshooting section and can still be copied.

### Fixed

- PM2 install, upgrade, and stale-Gateway replacement now execute `opencode --version` using the exact target Gateway environment before stopping the old process. A broken saved `PATH`, executable, or cwd fails closed without disrupting the working Gateway.
- `supertask doctor` now diagnoses terminal OpenCode and PM2/Gateway OpenCode separately, preventing a successful interactive shell check from hiding a broken daemon environment.
- Execution logs now expand directly beneath the run that was clicked instead of appearing at the bottom of the page.

[0.1.36]: https://github.com/vbgate/opencode-supertask/compare/v0.1.35...v0.1.36

## [0.1.35] - 2026-07-18

### Added

- Task and scheduled-task forms now include a server-side project folder browser. After a project is selected, the Dashboard runs that project's local `opencode agent list` and `opencode models` commands and exposes only directly runnable Agents plus the models actually available on the machine.
- Retry delays, run timeouts, and recurring intervals now use common human-readable presets. Number-and-unit input is shown only after choosing “Custom”; one-time schedules continue to use a local date/time picker.
- New Worker runs record the exact executable, argument array, and working directory. Execution Logs present the reproducible shell command, model text, failure diagnostics, and tool activity while retaining the complete raw OpenCode JSONL.

### Fixed

- The model selector now explains that “default” follows the selected Agent/OpenCode configuration and does not pass `-m`, and splits large model catalogs into provider and model selectors.
- OpenCode subagents are no longer offered as direct `opencode run --agent` choices, avoiding silent fallback to a default primary Agent. Existing task values remain editable for compatibility.

[0.1.35]: https://github.com/vbgate/opencode-supertask/compare/v0.1.34...v0.1.35

## [0.1.34] - 2026-07-18

### Fixed

- Explicit `supertask install` and `supertask upgrade` now refresh the Gateway's OpenCode, XDG, and model-provider execution environment from the invoking terminal. PM2 identity, Bun, `HOME`, `PATH`, all `SUPERTASK_*` scope, database/config paths, and the complete rollback runtime remain pinned.
- Failed Worker runs now record the effective Agent, model source, and working directory next to the OpenCode exit code, making terminal-vs-Gateway differences diagnosable.
- `supertask doctor` now fails when the global CLI, exact OpenCode plugin, PM2 Gateway package, and ready-lock versions do not all match.

### Added

- CLI help and interactive `doctor` / database summaries support `auto`, `zh-CN`, and `en` through `--lang` or `SUPERTASK_LANG`.
- Upgrade now detects whether the installed global CLI came from npm or Bun and synchronizes it to the same exact version after the plugin and Gateway are ready.
- README and operations guidance now cover custom primary Agent troubleshooting and execution-environment refresh behavior in both user languages.

### Compatibility

- JSON field names and raw backend diagnostic errors are unchanged; language selection only affects human-facing help and summaries.

## [0.1.33] - 2026-07-18

This release contains the full 0.1.32 change set plus a deterministic database-restore concurrency regression test. It is the stable upgrade target after 0.1.31.

### Fixed

- Pinned plugin installation and Gateway launch to one exact npm version, rejecting stale floating `@latest` / `@next` cache entries and invalid file-as-directory working paths.
- Recorded and validated task working directories before queueing so Gateway-launched OpenCode runs execute in the submitting project.
- Hardened launcher/Worker IPC with a per-run guardian token and bidirectional drain proof; unknown or still-live process trees remain quarantined instead of being settled or retried unsafely.
- Made database clear/restore backup-first, transactional, WAL-consistent, schema-compatible across expand-only N/N-1 releases, and safe against concurrent successful writes.
- Hardened PM2 replacement, rollback, lifecycle locking, kill timeouts, macOS restart supervision, and Bun 1.1.45 IPC compatibility.

### Added

- Project-directory grouping, project statistics, task creation/editing, priority/model controls, and project running-state visibility in the Web Dashboard.
- Web creation/editing for cron, delayed, and recurring tasks; “Run now” always creates a normal queued task and waits behind the global concurrency limit.
- PM2-backed “save and restart” configuration flow, light/dark/system themes, Chinese/English Web UI, and mobile layout.
- Global same-`batchId` serialization across projects and Gateway restarts, while independent batches can execute concurrently.
- Safe task deletion, dependency-aware retry, legacy quarantined-run recovery tooling, and stronger end-to-end diagnostics.

[0.1.34]: https://github.com/vbgate/opencode-supertask/compare/v0.1.33...v0.1.34
[0.1.33]: https://github.com/vbgate/opencode-supertask/compare/v0.1.31...v0.1.33
