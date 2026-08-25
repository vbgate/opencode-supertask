export type Locale = 'zh-CN' | 'en' | 'es';
export type ActiveTab = 'tasks' | 'templates' | 'runs' | 'system';

const ZH = {
    'app.name': 'SuperTask',
    'app.dashboard': '控制台',
    'app.tagline': '可靠的本地 Agent 任务中心',
    'app.local': '本地运行',
    'app.footer': 'Local-first · 数据留在你的设备上',
    'nav.tasks': '任务',
    'nav.templates': '定时任务',
    'nav.runs': '执行记录',
    'nav.system': '系统',
    'page.tasks.title': '任务队列',
    'page.tasks.description': '查看优先级、执行状态与重试情况，快速处理需要关注的任务。',
    'page.templates.title': '定时任务',
    'page.templates.description': '在网页创建和编辑 Cron、固定间隔及一次性任务，包括模型、Agent 和提示词。',
    'page.runs.title': '执行记录',
    'page.runs.description': '追踪每次 Agent 执行的状态、耗时、心跳与输出。',
    'page.system.title': '系统设置',
    'page.system.description': '调整 Gateway 运行参数，检查实时任务并管理本地数据。',
    'action.refresh': '刷新',
    'action.details': '详情',
    'action.retry': '重试',
    'action.cancel': '取消',
    'action.delete': '删除',
    'action.edit': '编辑',
    'action.enable': '启用',
    'action.disable': '禁用',
    'action.trigger': '立即运行一次',
    'action.continueSession': '继续会话',
    'action.logs': '查看日志',
    'action.hideLogs': '收起日志',
    'action.save': '保存设置',
    'action.saveAndRestart': '保存并重启',
    'action.copy': '复制原始数据',
    'action.close': '关闭',
    'action.confirm': '确认',
    'action.clearDatabase': '清空数据库',
    'action.createTask': '新建任务',
    'action.saveTask': '加入队列',
    'action.updateTask': '保存修改',
    'action.createTemplate': '新建定时任务',
    'action.saveTemplate': '保存定时任务',
    'action.chooseFolder': '选择文件夹',
    'action.chooseThisFolder': '选择当前文件夹',
    'action.home': '主目录',
    'action.up': '上一级',
    'action.copyCommand': '复制命令',
    'action.showHidden': '显示隐藏文件夹',
    'action.hideHidden': '隐藏隐藏文件夹',
    'status.pending': '待执行',
    'status.running': '运行中',
    'status.done': '已完成',
    'status.failed': '等待重试',
    'status.dead_letter': '已停止',
    'status.deadLetterHint': '系统不会再自动运行。可能是重试次数已用完，或依赖任务无法继续；请查看失败原因，确认后手动重试。',
    'status.deadLetterAction': '需检查原因后手动重试',
    'status.cancelled': '已取消',
    'status.executionStillActive': '执行进程仍在退出，暂时占用并发',
    'status.unknown': '未知',
    'runStatus.running': '运行中',
    'runStatus.done': '成功',
    'runStatus.failed': '失败',
    'stats.total': '总任务',
    'stats.pending': '待执行',
    'stats.running': '运行中',
    'stats.done': '已完成',
    'stats.failedDead': '等待重试与已停止',
    'stats.templates': '定时任务总数',
    'stats.enabled': '已启用',
    'stats.disabled': '已禁用',
    'stats.records': '执行总数',
    'stats.pageDone': '本页成功',
    'stats.pageFailed': '本页失败',
    'stats.pageRunning': '本页运行中',
    'filter.all': '全部',
    'filter.searchTasks': '搜索当前页的任务、项目、批次、Agent 或提示词',
    'filter.noResults': '没有符合当前搜索条件的任务',
    'table.id': 'ID',
    'table.task': '任务',
    'table.name': '名称',
    'table.agent': 'Agent',
    'table.status': '状态',
    'table.duration': '耗时',
    'table.retries': '重试',
    'table.actions': '操作',
    'table.type': '类型',
    'table.rule': '规则',
    'table.lastRun': '上次执行',
    'table.nextRun': '下次执行',
    'table.run': 'Run',
    'table.heartbeat': '心跳',
    'table.session': '会话',
    'table.model': '模型',
    'table.startedAt': '启动时间',
    'table.pid': 'PID',
    'pagination.previous': '上一页',
    'pagination.next': '下一页',
    'pagination.summary': '第 {page} 页，共 {pages} 页 · {total} 条',
    'empty.tasks': '队列里还没有任务',
    'empty.tasksHint': '点击“新建任务”，或通过 OpenCode 插件和 supertask add 创建第一个任务。',
    'empty.templates': '还没有定时任务',
    'empty.templatesHint': '点击右上角“新建定时任务”开始创建。',
    'empty.runs': '还没有执行记录',
    'empty.running': '当前没有运行中的任务',
    'schedule.cron': 'Cron',
    'schedule.recurring': '固定间隔',
    'schedule.delayed': '一次性',
    'schedule.unknown': '未知',
    'schedule.enabled': '已启用',
    'schedule.disabled': '已禁用',
    'schedule.minutes': '{count} 分钟',
    'schedule.seconds': '{count} 秒',
    'schedule.hours': '{count} 小时',
    'schedule.days': '{count} 天',
    'schedule.overdue': '已到期',
    'duration.unit': '时间单位',
    'duration.seconds': '秒',
    'duration.minutes': '分钟',
    'duration.hours': '小时',
    'duration.days': '天',
    'duration.systemDefault': '使用 Gateway 默认超时',
    'duration.immediate': '立即重试',
    'duration.custom': '自定义…',
    'duration.every': '每 {duration}',
    'system.worker': '任务执行',
    'system.scheduler': '定时任务服务',
    'system.watchdog': '运行监控',
    'system.maxConcurrency': '最大并发',
    'system.pollInterval': '轮询间隔',
    'system.heartbeatInterval': '心跳间隔',
    'system.taskTimeout': '任务超时',
    'system.schedulerEnabled': '启用定时任务',
    'system.checkInterval': '检查间隔',
    'system.heartbeatTimeout': '心跳超时',
    'system.cleanupInterval': '清理间隔',
    'system.retentionDays': '数据保留',
    'system.milliseconds': '毫秒',
    'system.seconds': '秒',
    'system.minutes': '分钟',
    'system.hours': '小时',
    'system.days': '天',
    'system.activeTemplates': '已启用定时任务',
    'system.saveHint': '设置保存后需要重启 Gateway 才能生效。',
    'system.configApplied': '页面中的设置正在生效。',
    'system.configPending': '设置已保存，但当前 Gateway 仍在使用上次启动时的设置。',
    'system.configForeground': '此页面未连接到 Gateway 的运行配置；保存后请重启 Gateway。',
    'system.configRestartManually': '设置已保存但尚未生效。请回到启动 Gateway 的终端，按 Ctrl-C 后重新运行 supertask gateway。',
    'system.runningTasks': '当前运行任务（{running} / {limit} 并发）',
    'system.taskStats': '任务概览',
    'system.configFile': '配置文件',
    'system.path': '路径',
    'system.fileExists': '文件存在',
    'system.yes': '是',
    'system.noDefault': '否，当前使用默认值',
    'system.danger': '危险操作',
    'system.dangerDescription': '系统会先创建可校验备份，再事务性清空任务、执行记录和定时任务；存在运行任务时会拒绝操作。',
    'template.createTitle': '新建定时任务',
    'template.editTitle': '编辑定时任务',
    'template.formSubtitle': '设置何时运行，以及 OpenCode 要使用的项目、模型和提示词。',
    'template.name': '名称',
    'template.cwd': '项目目录',
    'template.cwdHint': 'OpenCode 会在这个目录中执行任务。',
    'template.agent': 'Agent',
    'template.model': '模型',
    'template.variant': '模型 Variant',
    'template.prompt': '提示词',
    'template.scheduleType': '执行方式',
    'template.cronExpr': 'Cron 表达式',
    'template.cronHint': '例如：0 9 * * *（每天 09:00）',
    'template.interval': '执行间隔',
    'template.runAt': '执行时间',
    'template.durationHint': '支持 30s、5min、1h、2d',
    'template.intervalHint': '直接选择常用频率；只有特殊需求才需要自定义。',
    'template.retryBackoffHint': '一次失败后，等待多久再重试。',
    'template.timeoutHint': '留空表示使用 Gateway 的默认任务超时。',
    'template.advanced': '更多执行设置',
    'template.category': '分类',
    'template.batchId': '批次 ID',
    'template.importance': '重要程度（1-5）',
    'template.urgency': '紧急程度（1-5）',
    'template.maxInstances': '自动调度上限',
    'template.maxInstancesHint': '仅限制自动调度；手动“立即运行一次”始终加入队列。活跃任务包含待执行、运行中和等待重试。',
    'template.maxRetries': '失败重试次数',
    'template.retryBackoff': '重试等待',
    'template.timeout': '单次超时',
    'template.optional': '可选',
    'template.futureOnly': '保存后的设置用于以后生成的任务；编辑不会改变已经进入队列或正在执行的任务。',
    'projects.title': '项目分组',
    'projects.description': '项目目录是隔离键；先看每个项目有没有运行中或排队任务，再决定是否继续添加。',
    'projects.all': '全部项目',
    'projects.legacy': '未分组',
    'projects.legacyHint': '旧版本中没有项目目录的任务；可查看、取消或删除，需要修改时请在正确项目目录下重新创建。',
    'projects.counts': '运行 {running} · 排队 {pending} · 异常 {failed}',
    'task.createTitle': '新建任务',
    'task.editTitle': '编辑任务',
    'task.formSubtitle': '任务会立即加入持久队列；并发已满时会自动等待。',
    'task.batchHint': '相同非空批次 ID 的任务严格串行；留空则不受批次串行限制，但仍受全局并发和依赖约束。',
    'task.projectExisting': '此项目现有 {total} 个任务：运行 {running}，排队 {pending}，异常 {failed}。',
    'task.projectNew': '这是一个新项目分组；创建后会出现在项目列表中。',
    'catalog.chooseProject': '请先选择项目目录',
    'catalog.defaultModel': '跟随 Agent / OpenCode 默认模型',
    'catalog.defaultProvider': '默认模型',
    'catalog.defaultVariant': '跟随 Agent / 模型默认设置',
    'catalog.provider': '模型提供商',
    'catalog.model': '具体模型',
    'catalog.modelHint': '先选提供商，再选本项目 opencode models --verbose 返回的模型；默认选项不会传入 -m。',
    'catalog.variantHint': '仅显示所选模型声明支持的 variants；默认选项不会传入 --variant。',
    'catalog.agentHint': '来自当前项目的 opencode agent list。',
    'catalog.loading': '正在读取此项目可用的 Agent 和模型…',
    'catalog.loaded': '已从本机 OpenCode 读取 {agents} 个 Agent、{models} 个模型。',
    'catalog.failed': '无法读取此项目的 OpenCode 配置：{error}',
    'catalog.primary': '主 Agent',
    'catalog.subagent': '子 Agent',
    'catalog.all': '通用 Agent',
    'directory.title': '选择项目目录',
    'directory.subtitle': '选择后，系统会在该目录运行 OpenCode，并读取该项目可用的 Agent 和模型。',
    'directory.empty': '这个文件夹中没有子文件夹',
    'logs.command': '实际执行命令',
    'logs.output': 'Agent 输出',
    'logs.error': '失败原因',
    'logs.tools': '工具调用',
    'logs.raw': '查看原始执行日志',
    'logs.noText': '这次执行没有产生可展示的文本输出，请查看原始日志。',
    'theme.label': '主题',
    'theme.system': '跟随系统',
    'theme.light': '浅色',
    'theme.dark': '深色',
    'language.label': '语言',
    'details.title': '详情',
    'details.subtitle': '重点信息已整理；原始数据仅用于排障。',
    'details.taskTitle': '任务详情',
    'details.runTitle': '执行详情',
    'details.templateTitle': '定时任务详情',
    'details.raw': '查看原始数据（JSON）',
    'details.copySuccess': '原始数据已复制',
    'details.id': '编号',
    'details.project': '项目目录',
    'details.variant': '模型 Variant',
    'details.prompt': '提示词',
    'details.result': '执行结果 / 失败原因',
    'details.category': '分类',
    'details.batch': '批次',
    'details.dependency': '依赖任务',
    'details.importance': '重要程度',
    'details.urgency': '紧急程度',
    'details.retryCount': '已重试 / 最多重试',
    'details.retryBackoff': '重试等待',
    'details.timeout': '执行超时',
    'details.createdAt': '创建时间',
    'details.updatedAt': '更新时间',
    'details.startedAt': '开始时间',
    'details.finishedAt': '结束时间',
    'details.scheduledAt': '计划时间',
    'details.enabled': '自动运行',
    'details.scheduleRule': '运行规则',
    'details.maxInstances': '自动调度上限',
    'details.maxRetries': '失败重试次数',
    'details.lastRun': '上次运行',
    'details.nextRun': '下次运行',
    'details.taskId': '所属任务',
    'details.session': 'OpenCode 会话',
    'details.heartbeat': '最近心跳',
    'details.process': '进程',
    'details.history': '执行历史',
    'details.noHistory': '还没有执行记录',
    'details.none': '无',
    'details.default': '跟随系统默认',
    'details.enabledYes': '已启用',
    'details.enabledNo': '已停用',
    'dialog.cancelTask': '取消任务 #{id}？',
    'dialog.cancelTaskBody': '运行中的任务会在下一个轮询周期终止对应的受管进程组。',
    'dialog.retryTask': '重试任务 #{id}？',
    'dialog.retryTaskBody': '任务将回到待执行状态，并重置自动重试预算。',
    'dialog.deleteTask': '删除任务 #{id}？',
    'dialog.deleteTaskBody': '任务及关联执行记录将永久删除，此操作无法撤销。',
    'dialog.disableTemplate': '禁用这个定时任务？',
    'dialog.disableTemplateBody': '它将停止自动创建新任务，已有任务不受影响。',
    'dialog.deleteTemplate': '删除这个定时任务？',
    'dialog.deleteTemplateBody': '定时任务配置将永久删除，此操作无法撤销。',
    'dialog.triggerTemplate': '立即运行一次？',
    'dialog.triggerTemplateBody': '系统会按当前设置立即创建一个任务并加入队列；若全局并发已满，任务会等待执行。',
    'dialog.clearTitle': '确认清空数据库',
    'dialog.clearBody': '这会删除全部任务、执行记录和定时任务。系统会先自动备份。',
    'dialog.clearInstruction': '输入 CLEAR 以确认',
    'dialog.restartGateway': '重启并应用设置？',
    'dialog.restartGatewayBody': 'Gateway 会短暂离线，通常数秒后由 PM2 自动恢复。',
    'dialog.restartGatewayRunningBody': '当前有 {count} 个任务在运行。系统会先等待它们完成；超时后，未完成任务会被安全停止并放回队列，然后 Gateway 由 PM2 自动恢复。',
    'feedback.retryFailed': '重试失败',
    'feedback.cancelFailed': '取消失败',
    'feedback.deleteFailed': '删除失败',
    'feedback.requestFailed': '请求失败',
    'feedback.triggered': '已创建任务 #{id}',
    'feedback.taskCreated': '任务 #{id} 已加入队列',
    'feedback.taskUpdated': '任务 #{id} 已更新',
    'feedback.templateCreated': '定时任务已创建',
    'feedback.templateUpdated': '定时任务已更新',
    'feedback.configSaved': '设置已保存',
    'feedback.sessionCommandCopied': '会话命令已复制，可直接粘贴到终端运行',
    'feedback.commandCopied': '执行命令已复制',
    'feedback.restarting': 'Gateway 正在重启，请稍候…',
    'feedback.restartTimeout': 'Gateway 尚未恢复，请稍后刷新或检查 PM2 状态',
    'feedback.databaseCleared': '数据库已清空，备份位于：{path}',
    'feedback.copyFailed': '复制失败，请手动选择内容',
    'a11y.skip': '跳到主要内容',
    'a11y.refreshing': '正在刷新',
} as const;

type MessageKey = keyof typeof ZH;

const EN: Record<MessageKey, string> = {
    'app.name': 'SuperTask',
    'app.dashboard': 'Dashboard',
    'app.tagline': 'Reliable local agent orchestration',
    'app.local': 'Running locally',
    'app.footer': 'Local-first · Your data stays on this device',
    'nav.tasks': 'Tasks',
    'nav.templates': 'Scheduled tasks',
    'nav.runs': 'Runs',
    'nav.system': 'System',
    'page.tasks.title': 'Task queue',
    'page.tasks.description': 'Track priority, execution state, and retries, then act on tasks that need attention.',
    'page.templates.title': 'Scheduled tasks',
    'page.templates.description': 'Create and edit cron, fixed-interval, and one-time tasks, including their model, agent, and prompt.',
    'page.runs.title': 'Execution history',
    'page.runs.description': 'Inspect the status, duration, heartbeat, and output of every agent run.',
    'page.system.title': 'System settings',
    'page.system.description': 'Tune Gateway behavior, inspect active work, and manage local data.',
    'action.refresh': 'Refresh',
    'action.details': 'Details',
    'action.retry': 'Retry',
    'action.cancel': 'Cancel',
    'action.delete': 'Delete',
    'action.edit': 'Edit',
    'action.enable': 'Enable',
    'action.disable': 'Disable',
    'action.trigger': 'Run now',
    'action.continueSession': 'Continue session',
    'action.logs': 'View log',
    'action.hideLogs': 'Hide log',
    'action.save': 'Save settings',
    'action.saveAndRestart': 'Save and restart',
    'action.copy': 'Copy raw data',
    'action.close': 'Close',
    'action.confirm': 'Confirm',
    'action.clearDatabase': 'Clear database',
    'action.createTask': 'New task',
    'action.saveTask': 'Add to queue',
    'action.updateTask': 'Save changes',
    'action.createTemplate': 'New scheduled task',
    'action.saveTemplate': 'Save scheduled task',
    'action.chooseFolder': 'Choose folder',
    'action.chooseThisFolder': 'Choose this folder',
    'action.home': 'Home',
    'action.up': 'Up',
    'action.copyCommand': 'Copy command',
    'action.showHidden': 'Show hidden folders',
    'action.hideHidden': 'Hide hidden folders',
    'status.pending': 'Pending',
    'status.running': 'Running',
    'status.done': 'Done',
    'status.failed': 'Waiting to retry',
    'status.dead_letter': 'Stopped',
    'status.deadLetterHint': 'The system will not run this task automatically again. Its retries may be exhausted or a dependency cannot continue; inspect the error, then retry manually if appropriate.',
    'status.deadLetterAction': 'Inspect the error, then retry manually',
    'status.cancelled': 'Cancelled',
    'status.executionStillActive': 'The execution process is still stopping and temporarily occupies a slot',
    'status.unknown': 'Unknown',
    'runStatus.running': 'Running',
    'runStatus.done': 'Succeeded',
    'runStatus.failed': 'Failed',
    'stats.total': 'Total tasks',
    'stats.pending': 'Pending',
    'stats.running': 'Running',
    'stats.done': 'Completed',
    'stats.failedDead': 'Waiting to retry & stopped',
    'stats.templates': 'Scheduled tasks',
    'stats.enabled': 'Enabled',
    'stats.disabled': 'Disabled',
    'stats.records': 'Total runs',
    'stats.pageDone': 'Succeeded here',
    'stats.pageFailed': 'Failed here',
    'stats.pageRunning': 'Running here',
    'filter.all': 'All',
    'filter.searchTasks': 'Search tasks, projects, batches, agents, or prompts on this page',
    'filter.noResults': 'No tasks match this search',
    'table.id': 'ID',
    'table.task': 'Task',
    'table.name': 'Name',
    'table.agent': 'Agent',
    'table.status': 'Status',
    'table.duration': 'Duration',
    'table.retries': 'Retries',
    'table.actions': 'Actions',
    'table.type': 'Type',
    'table.rule': 'Rule',
    'table.lastRun': 'Last run',
    'table.nextRun': 'Next run',
    'table.run': 'Run',
    'table.heartbeat': 'Heartbeat',
    'table.session': 'Session',
    'table.model': 'Model',
    'table.startedAt': 'Started',
    'table.pid': 'PID',
    'pagination.previous': 'Previous',
    'pagination.next': 'Next',
    'pagination.summary': 'Page {page} of {pages} · {total} items',
    'empty.tasks': 'Your queue is empty',
    'empty.tasksHint': 'Select “New task”, or use the OpenCode plugin or supertask add.',
    'empty.templates': 'No scheduled tasks yet',
    'empty.templatesHint': 'Select “New scheduled task” to create one.',
    'empty.runs': 'No execution history yet',
    'empty.running': 'No tasks are running right now',
    'schedule.cron': 'Cron',
    'schedule.recurring': 'Fixed interval',
    'schedule.delayed': 'One-time',
    'schedule.unknown': 'Unknown',
    'schedule.enabled': 'Enabled',
    'schedule.disabled': 'Disabled',
    'schedule.minutes': '{count} min',
    'schedule.seconds': '{count} sec',
    'schedule.hours': '{count} hr',
    'schedule.days': '{count} days',
    'schedule.overdue': 'Overdue',
    'duration.unit': 'Time unit',
    'duration.seconds': 'seconds',
    'duration.minutes': 'minutes',
    'duration.hours': 'hours',
    'duration.days': 'days',
    'duration.systemDefault': 'Use Gateway default timeout',
    'duration.immediate': 'Retry immediately',
    'duration.custom': 'Custom…',
    'duration.every': 'Every {duration}',
    'system.worker': 'Task execution',
    'system.scheduler': 'Scheduled task service',
    'system.watchdog': 'Runtime monitor',
    'system.maxConcurrency': 'Max concurrency',
    'system.pollInterval': 'Poll interval',
    'system.heartbeatInterval': 'Heartbeat interval',
    'system.taskTimeout': 'Task timeout',
    'system.schedulerEnabled': 'Enable scheduled tasks',
    'system.checkInterval': 'Check interval',
    'system.heartbeatTimeout': 'Heartbeat timeout',
    'system.cleanupInterval': 'Cleanup interval',
    'system.retentionDays': 'Data retention',
    'system.milliseconds': 'ms',
    'system.seconds': 'seconds',
    'system.minutes': 'minutes',
    'system.hours': 'hours',
    'system.days': 'days',
    'system.activeTemplates': 'Enabled scheduled tasks',
    'system.saveHint': 'Restart Gateway to apply saved settings.',
    'system.configApplied': 'The settings shown here are active.',
    'system.configPending': 'Settings are saved, but this Gateway is still using the values from its last start.',
    'system.configForeground': 'This page is not connected to Gateway runtime settings. Restart Gateway after saving.',
    'system.configRestartManually': 'Settings are saved but not active. Return to the terminal that launched Gateway, press Ctrl-C, then run supertask gateway again.',
    'system.runningTasks': 'Active tasks ({running} / {limit} concurrent)',
    'system.taskStats': 'Task overview',
    'system.configFile': 'Configuration file',
    'system.path': 'Path',
    'system.fileExists': 'File exists',
    'system.yes': 'Yes',
    'system.noDefault': 'No, using defaults',
    'system.danger': 'Danger zone',
    'system.dangerDescription': 'A verified backup is created first, then tasks, runs, and templates are cleared transactionally. Active work blocks this operation.',
    'template.createTitle': 'New scheduled task',
    'template.editTitle': 'Edit scheduled task',
    'template.formSubtitle': 'Choose when to run and which project, model, and prompt OpenCode should use.',
    'template.name': 'Name',
    'template.cwd': 'Project directory',
    'template.cwdHint': 'OpenCode runs the task in this directory.',
    'template.agent': 'Agent',
    'template.model': 'Model',
    'template.variant': 'Model variant',
    'template.prompt': 'Prompt',
    'template.scheduleType': 'Schedule',
    'template.cronExpr': 'Cron expression',
    'template.cronHint': 'Example: 0 9 * * * (daily at 09:00)',
    'template.interval': 'Interval',
    'template.runAt': 'Run at',
    'template.durationHint': 'Supports 30s, 5min, 1h, 2d',
    'template.intervalHint': 'Choose a common frequency directly; customize only when necessary.',
    'template.retryBackoffHint': 'How long to wait after a failure before retrying.',
    'template.timeoutHint': 'Leave blank to use the Gateway default task timeout.',
    'template.advanced': 'More execution settings',
    'template.category': 'Category',
    'template.batchId': 'Batch ID',
    'template.importance': 'Importance (1-5)',
    'template.urgency': 'Urgency (1-5)',
    'template.maxInstances': 'Automatic scheduling limit',
    'template.maxInstancesHint': 'Limits automatic scheduling only. “Run now” always queues a task. Active instances include pending, running, and retry-waiting tasks.',
    'template.maxRetries': 'Failure retries',
    'template.retryBackoff': 'Retry delay',
    'template.timeout': 'Run timeout',
    'template.optional': 'Optional',
    'template.futureOnly': 'Saved settings apply to tasks created in the future. Editing does not change queued or running tasks.',
    'projects.title': 'Projects',
    'projects.description': 'The project directory is the isolation key. Check active and queued work before adding more.',
    'projects.all': 'All projects',
    'projects.legacy': 'Ungrouped',
    'projects.legacyHint': 'Legacy tasks without a project directory. View, cancel, or delete them; recreate under the correct project to make changes.',
    'projects.counts': 'Running {running} · queued {pending} · issues {failed}',
    'task.createTitle': 'New task',
    'task.editTitle': 'Edit task',
    'task.formSubtitle': 'The task enters the durable queue immediately and waits automatically when concurrency is full.',
    'task.batchHint': 'Tasks with the same non-empty batch ID run serially. Blank removes the batch constraint; global concurrency and dependencies still apply.',
    'task.projectExisting': 'This project has {total} tasks: {running} running, {pending} queued, and {failed} with issues.',
    'task.projectNew': 'This is a new project group. It appears in the project list after creation.',
    'catalog.chooseProject': 'Choose a project directory first',
    'catalog.defaultModel': 'Use the Agent / OpenCode default model',
    'catalog.defaultProvider': 'Default model',
    'catalog.defaultVariant': 'Use the Agent / model default',
    'catalog.provider': 'Model provider',
    'catalog.model': 'Model',
    'catalog.modelHint': 'Choose a provider, then a model returned by opencode models --verbose for this project. Default does not pass -m.',
    'catalog.variantHint': 'Only variants declared by the selected model are shown. Default does not pass --variant.',
    'catalog.agentHint': 'Loaded from opencode agent list for this project.',
    'catalog.loading': 'Loading Agents and models available to this project…',
    'catalog.loaded': 'Loaded {agents} Agents and {models} models from local OpenCode.',
    'catalog.failed': 'Could not load this project’s OpenCode configuration: {error}',
    'catalog.primary': 'primary Agent',
    'catalog.subagent': 'subagent',
    'catalog.all': 'general Agent',
    'directory.title': 'Choose project directory',
    'directory.subtitle': 'OpenCode runs in this directory, and its project-specific Agents and models are loaded.',
    'directory.empty': 'This folder has no subfolders',
    'logs.command': 'Executed command',
    'logs.output': 'Agent output',
    'logs.error': 'Failure reason',
    'logs.tools': 'Tool calls',
    'logs.raw': 'View raw execution log',
    'logs.noText': 'This run produced no displayable text. Inspect the raw log for details.',
    'theme.label': 'Theme',
    'theme.system': 'System',
    'theme.light': 'Light',
    'theme.dark': 'Dark',
    'language.label': 'Language',
    'details.title': 'Details',
    'details.subtitle': 'Key information is organized below; raw data is only for troubleshooting.',
    'details.taskTitle': 'Task details',
    'details.runTitle': 'Run details',
    'details.templateTitle': 'Scheduled task details',
    'details.raw': 'View raw data (JSON)',
    'details.copySuccess': 'Raw data copied',
    'details.id': 'ID',
    'details.project': 'Project directory',
    'details.variant': 'Model variant',
    'details.prompt': 'Prompt',
    'details.result': 'Result / failure reason',
    'details.category': 'Category',
    'details.batch': 'Batch',
    'details.dependency': 'Dependency',
    'details.importance': 'Importance',
    'details.urgency': 'Urgency',
    'details.retryCount': 'Retries used / allowed',
    'details.retryBackoff': 'Retry delay',
    'details.timeout': 'Run timeout',
    'details.createdAt': 'Created',
    'details.updatedAt': 'Updated',
    'details.startedAt': 'Started',
    'details.finishedAt': 'Finished',
    'details.scheduledAt': 'Scheduled for',
    'details.enabled': 'Automatic runs',
    'details.scheduleRule': 'Schedule rule',
    'details.maxInstances': 'Automatic scheduling limit',
    'details.maxRetries': 'Failure retries',
    'details.lastRun': 'Last run',
    'details.nextRun': 'Next run',
    'details.taskId': 'Task',
    'details.session': 'OpenCode session',
    'details.heartbeat': 'Latest heartbeat',
    'details.process': 'Processes',
    'details.history': 'Run history',
    'details.noHistory': 'No runs yet',
    'details.none': 'None',
    'details.default': 'Use system default',
    'details.enabledYes': 'Enabled',
    'details.enabledNo': 'Disabled',
    'dialog.cancelTask': 'Cancel task #{id}?',
    'dialog.cancelTaskBody': 'A running task will terminate its managed process group on the next worker poll.',
    'dialog.retryTask': 'Retry task #{id}?',
    'dialog.retryTaskBody': 'The task returns to pending and its automatic retry budget is reset.',
    'dialog.deleteTask': 'Delete task #{id}?',
    'dialog.deleteTaskBody': 'The task and its execution history will be permanently deleted.',
    'dialog.disableTemplate': 'Disable this schedule?',
    'dialog.disableTemplateBody': 'It will stop creating new tasks automatically. Existing tasks are unchanged.',
    'dialog.deleteTemplate': 'Delete this schedule?',
    'dialog.deleteTemplateBody': 'This scheduled task configuration will be permanently deleted.',
    'dialog.triggerTemplate': 'Run this schedule now?',
    'dialog.triggerTemplateBody': 'A task is queued immediately using the current settings. If global concurrency is full, it waits to run.',
    'dialog.clearTitle': 'Confirm database clear',
    'dialog.clearBody': 'This deletes every task, run, and scheduled task after creating a backup.',
    'dialog.clearInstruction': 'Type CLEAR to confirm',
    'dialog.restartGateway': 'Restart and apply settings?',
    'dialog.restartGatewayBody': 'Gateway will be briefly unavailable and should recover through PM2 within a few seconds.',
    'dialog.restartGatewayRunningBody': '{count} tasks are running. The system waits for them first; after the grace period, unfinished tasks are stopped safely and returned to the queue before PM2 restores Gateway.',
    'feedback.retryFailed': 'Retry failed',
    'feedback.cancelFailed': 'Cancellation failed',
    'feedback.deleteFailed': 'Delete failed',
    'feedback.requestFailed': 'Request failed',
    'feedback.triggered': 'Task #{id} created',
    'feedback.taskCreated': 'Task #{id} added to the queue',
    'feedback.taskUpdated': 'Task #{id} updated',
    'feedback.templateCreated': 'Scheduled task created',
    'feedback.templateUpdated': 'Scheduled task updated',
    'feedback.configSaved': 'Settings saved',
    'feedback.sessionCommandCopied': 'Session command copied. Paste it into a terminal to continue.',
    'feedback.commandCopied': 'Execution command copied',
    'feedback.restarting': 'Gateway is restarting…',
    'feedback.restartTimeout': 'Gateway has not recovered yet. Refresh later or check PM2 status.',
    'feedback.databaseCleared': 'Database cleared. Backup: {path}',
    'feedback.copyFailed': 'Copy failed. Select the content manually.',
    'a11y.skip': 'Skip to main content',
    'a11y.refreshing': 'Refreshing',
};

const ES: Record<MessageKey, string> = {
    'app.name': 'SuperTask',
    'app.dashboard': 'Panel',
    'app.tagline': 'Orquestación local fiable de agentes',
    'app.local': 'Ejecutándose en local',
    'app.footer': 'Local-first · Tus datos permanecen en este dispositivo',
    'nav.tasks': 'Tareas',
    'nav.templates': 'Tareas programadas',
    'nav.runs': 'Ejecuciones',
    'nav.system': 'Sistema',
    'page.tasks.title': 'Cola de tareas',
    'page.tasks.description': 'Sigue la prioridad, el estado de ejecución y los reintentos, y actúa sobre las tareas que requieren atención.',
    'page.templates.title': 'Tareas programadas',
    'page.templates.description': 'Crea y edita tareas cron, de intervalo fijo y de una sola vez, incluyendo modelo, agente y prompt.',
    'page.runs.title': 'Historial de ejecución',
    'page.runs.description': 'Inspecciona el estado, la duración, el heartbeat y la salida de cada ejecución del agente.',
    'page.system.title': 'Ajustes del sistema',
    'page.system.description': 'Ajusta el comportamiento del Gateway, inspecciona el trabajo activo y gestiona los datos locales.',
    'action.refresh': 'Actualizar',
    'action.details': 'Detalles',
    'action.retry': 'Reintentar',
    'action.cancel': 'Cancelar',
    'action.delete': 'Eliminar',
    'action.edit': 'Editar',
    'action.enable': 'Activar',
    'action.disable': 'Desactivar',
    'action.trigger': 'Ejecutar ahora',
    'action.continueSession': 'Continuar sesión',
    'action.logs': 'Ver registro',
    'action.hideLogs': 'Ocultar registro',
    'action.save': 'Guardar ajustes',
    'action.saveAndRestart': 'Guardar y reiniciar',
    'action.copy': 'Copiar datos en bruto',
    'action.close': 'Cerrar',
    'action.confirm': 'Confirmar',
    'action.clearDatabase': 'Vaciar base de datos',
    'action.createTask': 'Nueva tarea',
    'action.saveTask': 'Añadir a la cola',
    'action.updateTask': 'Guardar cambios',
    'action.createTemplate': 'Nueva tarea programada',
    'action.saveTemplate': 'Guardar tarea programada',
    'action.chooseFolder': 'Elegir carpeta',
    'action.chooseThisFolder': 'Elegir esta carpeta',
    'action.home': 'Inicio',
    'action.up': 'Subir',
    'action.copyCommand': 'Copiar comando',
    'action.showHidden': 'Mostrar carpetas ocultas',
    'action.hideHidden': 'Ocultar carpetas ocultas',
    'status.pending': 'Pendiente',
    'status.running': 'En ejecución',
    'status.done': 'Completada',
    'status.failed': 'Esperando reintento',
    'status.dead_letter': 'Detenida',
    'status.deadLetterHint': 'El sistema no volverá a ejecutar esta tarea automáticamente. Puede haber agotado los reintentos o una dependencia no puede continuar; revisa el error y reintenta manualmente si procede.',
    'status.deadLetterAction': 'Revisa el error y reintenta manualmente',
    'status.cancelled': 'Cancelada',
    'status.executionStillActive': 'El proceso de ejecución aún se está deteniendo y ocupa temporalmente un hueco',
    'status.unknown': 'Desconocido',
    'runStatus.running': 'En ejecución',
    'runStatus.done': 'Correcta',
    'runStatus.failed': 'Fallida',
    'stats.total': 'Total de tareas',
    'stats.pending': 'Pendientes',
    'stats.running': 'En ejecución',
    'stats.done': 'Completadas',
    'stats.failedDead': 'Esperando reintento y detenidas',
    'stats.templates': 'Tareas programadas',
    'stats.enabled': 'Activadas',
    'stats.disabled': 'Desactivadas',
    'stats.records': 'Total de ejecuciones',
    'stats.pageDone': 'Correctas en esta página',
    'stats.pageFailed': 'Fallidas en esta página',
    'stats.pageRunning': 'En ejecución aquí',
    'filter.all': 'Todas',
    'filter.searchTasks': 'Buscar tareas, proyectos, lotes, agentes o prompts en esta página',
    'filter.noResults': 'Ninguna tarea coincide con esta búsqueda',
    'table.id': 'ID',
    'table.task': 'Tarea',
    'table.name': 'Nombre',
    'table.agent': 'Agente',
    'table.status': 'Estado',
    'table.duration': 'Duración',
    'table.retries': 'Reintentos',
    'table.actions': 'Acciones',
    'table.type': 'Tipo',
    'table.rule': 'Regla',
    'table.lastRun': 'Última ejecución',
    'table.nextRun': 'Próxima ejecución',
    'table.run': 'Ejecución',
    'table.heartbeat': 'Heartbeat',
    'table.session': 'Sesión',
    'table.model': 'Modelo',
    'table.startedAt': 'Inicio',
    'table.pid': 'PID',
    'pagination.previous': 'Anterior',
    'pagination.next': 'Siguiente',
    'pagination.summary': 'Página {page} de {pages} · {total} elementos',
    'empty.tasks': 'Tu cola está vacía',
    'empty.tasksHint': 'Elige «Nueva tarea», o usa el plugin de OpenCode o supertask add.',
    'empty.templates': 'Aún no hay tareas programadas',
    'empty.templatesHint': 'Elige «Nueva tarea programada» para crear una.',
    'empty.runs': 'Aún no hay historial de ejecución',
    'empty.running': 'No hay tareas en ejecución ahora mismo',
    'schedule.cron': 'Cron',
    'schedule.recurring': 'Intervalo fijo',
    'schedule.delayed': 'Una sola vez',
    'schedule.unknown': 'Desconocido',
    'schedule.enabled': 'Activada',
    'schedule.disabled': 'Desactivada',
    'schedule.minutes': '{count} min',
    'schedule.seconds': '{count} s',
    'schedule.hours': '{count} h',
    'schedule.days': '{count} días',
    'schedule.overdue': 'Vencida',
    'duration.unit': 'Unidad de tiempo',
    'duration.seconds': 'segundos',
    'duration.minutes': 'minutos',
    'duration.hours': 'horas',
    'duration.days': 'días',
    'duration.systemDefault': 'Usar el timeout predeterminado del Gateway',
    'duration.immediate': 'Reintentar de inmediato',
    'duration.custom': 'Personalizado…',
    'duration.every': 'Cada {duration}',
    'system.worker': 'Ejecución de tareas',
    'system.scheduler': 'Servicio de tareas programadas',
    'system.watchdog': 'Monitor en tiempo de ejecución',
    'system.maxConcurrency': 'Concurrencia máxima',
    'system.pollInterval': 'Intervalo de sondeo',
    'system.heartbeatInterval': 'Intervalo de heartbeat',
    'system.taskTimeout': 'Timeout de tarea',
    'system.schedulerEnabled': 'Activar tareas programadas',
    'system.checkInterval': 'Intervalo de comprobación',
    'system.heartbeatTimeout': 'Timeout de heartbeat',
    'system.cleanupInterval': 'Intervalo de limpieza',
    'system.retentionDays': 'Retención de datos',
    'system.milliseconds': 'ms',
    'system.seconds': 'segundos',
    'system.minutes': 'minutos',
    'system.hours': 'horas',
    'system.days': 'días',
    'system.activeTemplates': 'Tareas programadas activas',
    'system.saveHint': 'Reinicia el Gateway para aplicar los ajustes guardados.',
    'system.configApplied': 'Los ajustes mostrados aquí están activos.',
    'system.configPending': 'Los ajustes están guardados, pero este Gateway sigue usando los valores de su último arranque.',
    'system.configForeground': 'Esta página no está conectada a la configuración en ejecución del Gateway. Reinicia el Gateway tras guardar.',
    'system.configRestartManually': 'Los ajustes están guardados pero no activos. Vuelve al terminal que lanzó el Gateway, pulsa Ctrl-C y vuelve a ejecutar supertask gateway.',
    'system.runningTasks': 'Tareas activas ({running} / {limit} concurrentes)',
    'system.taskStats': 'Resumen de tareas',
    'system.configFile': 'Archivo de configuración',
    'system.path': 'Ruta',
    'system.fileExists': 'El archivo existe',
    'system.yes': 'Sí',
    'system.noDefault': 'No, usando valores predeterminados',
    'system.danger': 'Zona de peligro',
    'system.dangerDescription': 'Primero se crea una copia de seguridad verificada; después se vacían de forma transaccional las tareas, ejecuciones y plantillas. El trabajo activo bloquea esta operación.',
    'template.createTitle': 'Nueva tarea programada',
    'template.editTitle': 'Editar tarea programada',
    'template.formSubtitle': 'Elige cuándo ejecutar y qué proyecto, modelo y prompt debe usar OpenCode.',
    'template.name': 'Nombre',
    'template.cwd': 'Directorio del proyecto',
    'template.cwdHint': 'OpenCode ejecuta la tarea en este directorio.',
    'template.agent': 'Agente',
    'template.model': 'Modelo',
    'template.variant': 'Variante del modelo',
    'template.prompt': 'Prompt',
    'template.scheduleType': 'Programación',
    'template.cronExpr': 'Expresión cron',
    'template.cronHint': 'Ejemplo: 0 9 * * * (cada día a las 09:00)',
    'template.interval': 'Intervalo',
    'template.runAt': 'Ejecutar a las',
    'template.durationHint': 'Admite 30s, 5min, 1h, 2d',
    'template.intervalHint': 'Elige una frecuencia habitual; personaliza solo si es necesario.',
    'template.retryBackoffHint': 'Cuánto esperar tras un fallo antes de reintentar.',
    'template.timeoutHint': 'Déjalo en blanco para usar el timeout predeterminado de tarea del Gateway.',
    'template.advanced': 'Más ajustes de ejecución',
    'template.category': 'Categoría',
    'template.batchId': 'ID de lote',
    'template.importance': 'Importancia (1-5)',
    'template.urgency': 'Urgencia (1-5)',
    'template.maxInstances': 'Límite de programación automática',
    'template.maxInstancesHint': 'Solo limita la programación automática. «Ejecutar ahora» siempre encola una tarea. Las instancias activas incluyen pendientes, en ejecución y en espera de reintento.',
    'template.maxRetries': 'Reintentos ante fallo',
    'template.retryBackoff': 'Espera entre reintentos',
    'template.timeout': 'Timeout de ejecución',
    'template.optional': 'Opcional',
    'template.futureOnly': 'Los ajustes guardados se aplican a las tareas creadas en el futuro. Editar no cambia las tareas en cola o en ejecución.',
    'projects.title': 'Proyectos',
    'projects.description': 'El directorio del proyecto es la clave de aislamiento. Revisa el trabajo activo y en cola antes de añadir más.',
    'projects.all': 'Todos los proyectos',
    'projects.legacy': 'Sin agrupar',
    'projects.legacyHint': 'Tareas antiguas sin directorio de proyecto. Puedes verlas, cancelarlas o eliminarlas; recrea bajo el proyecto correcto para modificarlas.',
    'projects.counts': 'En ejecución {running} · en cola {pending} · con problemas {failed}',
    'task.createTitle': 'Nueva tarea',
    'task.editTitle': 'Editar tarea',
    'task.formSubtitle': 'La tarea entra de inmediato en la cola persistente y espera automáticamente si la concurrencia está llena.',
    'task.batchHint': 'Las tareas con el mismo ID de lote no vacío se ejecutan en serie. En blanco elimina la restricción de lote; la concurrencia global y las dependencias siguen aplicándose.',
    'task.projectExisting': 'Este proyecto tiene {total} tareas: {running} en ejecución, {pending} en cola y {failed} con problemas.',
    'task.projectNew': 'Este es un grupo de proyecto nuevo. Aparecerá en la lista de proyectos tras crearlo.',
    'catalog.chooseProject': 'Elige primero un directorio de proyecto',
    'catalog.defaultModel': 'Usar el modelo predeterminado del agente / OpenCode',
    'catalog.defaultProvider': 'Modelo predeterminado',
    'catalog.defaultVariant': 'Usar el predeterminado del agente / modelo',
    'catalog.provider': 'Proveedor del modelo',
    'catalog.model': 'Modelo',
    'catalog.modelHint': 'Elige un proveedor y luego un modelo devuelto por opencode models --verbose para este proyecto. El valor predeterminado no pasa -m.',
    'catalog.variantHint': 'Solo se muestran las variantes declaradas por el modelo seleccionado. El valor predeterminado no pasa --variant.',
    'catalog.agentHint': 'Cargado desde opencode agent list de este proyecto.',
    'catalog.loading': 'Cargando agentes y modelos disponibles para este proyecto…',
    'catalog.loaded': 'Se cargaron {agents} agentes y {models} modelos desde OpenCode local.',
    'catalog.failed': 'No se pudo cargar la configuración de OpenCode de este proyecto: {error}',
    'catalog.primary': 'agente principal',
    'catalog.subagent': 'subagente',
    'catalog.all': 'agente general',
    'directory.title': 'Elegir directorio del proyecto',
    'directory.subtitle': 'OpenCode se ejecuta en este directorio y se cargan sus agentes y modelos específicos del proyecto.',
    'directory.empty': 'Esta carpeta no tiene subcarpetas',
    'logs.command': 'Comando ejecutado',
    'logs.output': 'Salida del agente',
    'logs.error': 'Motivo del fallo',
    'logs.tools': 'Llamadas a herramientas',
    'logs.raw': 'Ver registro de ejecución en bruto',
    'logs.noText': 'Esta ejecución no produjo texto visible. Revisa el registro en bruto para más detalles.',
    'theme.label': 'Tema',
    'theme.system': 'Sistema',
    'theme.light': 'Claro',
    'theme.dark': 'Oscuro',
    'language.label': 'Idioma',
    'details.title': 'Detalles',
    'details.subtitle': 'La información clave está organizada abajo; los datos en bruto solo sirven para diagnóstico.',
    'details.taskTitle': 'Detalles de la tarea',
    'details.runTitle': 'Detalles de la ejecución',
    'details.templateTitle': 'Detalles de la tarea programada',
    'details.raw': 'Ver datos en bruto (JSON)',
    'details.copySuccess': 'Datos en bruto copiados',
    'details.id': 'ID',
    'details.project': 'Directorio del proyecto',
    'details.variant': 'Variante del modelo',
    'details.prompt': 'Prompt',
    'details.result': 'Resultado / motivo del fallo',
    'details.category': 'Categoría',
    'details.batch': 'Lote',
    'details.dependency': 'Dependencia',
    'details.importance': 'Importancia',
    'details.urgency': 'Urgencia',
    'details.retryCount': 'Reintentos usados / permitidos',
    'details.retryBackoff': 'Espera entre reintentos',
    'details.timeout': 'Timeout de ejecución',
    'details.createdAt': 'Creada',
    'details.updatedAt': 'Actualizada',
    'details.startedAt': 'Iniciada',
    'details.finishedAt': 'Finalizada',
    'details.scheduledAt': 'Programada para',
    'details.enabled': 'Ejecuciones automáticas',
    'details.scheduleRule': 'Regla de programación',
    'details.maxInstances': 'Límite de programación automática',
    'details.maxRetries': 'Reintentos ante fallo',
    'details.lastRun': 'Última ejecución',
    'details.nextRun': 'Próxima ejecución',
    'details.taskId': 'Tarea',
    'details.session': 'Sesión de OpenCode',
    'details.heartbeat': 'Último heartbeat',
    'details.process': 'Procesos',
    'details.history': 'Historial de ejecuciones',
    'details.noHistory': 'Aún no hay ejecuciones',
    'details.none': 'Ninguno',
    'details.default': 'Usar el predeterminado del sistema',
    'details.enabledYes': 'Activada',
    'details.enabledNo': 'Desactivada',
    'dialog.cancelTask': '¿Cancelar la tarea #{id}?',
    'dialog.cancelTaskBody': 'Una tarea en ejecución terminará su grupo de procesos gestionado en el siguiente sondeo del worker.',
    'dialog.retryTask': '¿Reintentar la tarea #{id}?',
    'dialog.retryTaskBody': 'La tarea vuelve a pendiente y se restablece su presupuesto de reintentos automáticos.',
    'dialog.deleteTask': '¿Eliminar la tarea #{id}?',
    'dialog.deleteTaskBody': 'La tarea y su historial de ejecución se eliminarán de forma permanente.',
    'dialog.disableTemplate': '¿Desactivar esta programación?',
    'dialog.disableTemplateBody': 'Dejará de crear tareas nuevas automáticamente. Las tareas existentes no cambian.',
    'dialog.deleteTemplate': '¿Eliminar esta programación?',
    'dialog.deleteTemplateBody': 'Esta configuración de tarea programada se eliminará de forma permanente.',
    'dialog.triggerTemplate': '¿Ejecutar esta programación ahora?',
    'dialog.triggerTemplateBody': 'Se encola de inmediato una tarea con los ajustes actuales. Si la concurrencia global está llena, esperará a ejecutarse.',
    'dialog.clearTitle': 'Confirmar vaciado de la base de datos',
    'dialog.clearBody': 'Esto elimina todas las tareas, ejecuciones y tareas programadas tras crear una copia de seguridad.',
    'dialog.clearInstruction': 'Escribe CLEAR para confirmar',
    'dialog.restartGateway': '¿Reiniciar y aplicar los ajustes?',
    'dialog.restartGatewayBody': 'El Gateway no estará disponible brevemente y debería recuperarse con PM2 en unos segundos.',
    'dialog.restartGatewayRunningBody': 'Hay {count} tareas en ejecución. El sistema espera primero; tras el periodo de gracia, las tareas incompletas se detienen de forma segura y vuelven a la cola antes de que PM2 restaure el Gateway.',
    'feedback.retryFailed': 'El reintento falló',
    'feedback.cancelFailed': 'La cancelación falló',
    'feedback.deleteFailed': 'La eliminación falló',
    'feedback.requestFailed': 'La solicitud falló',
    'feedback.triggered': 'Tarea #{id} creada',
    'feedback.taskCreated': 'Tarea #{id} añadida a la cola',
    'feedback.taskUpdated': 'Tarea #{id} actualizada',
    'feedback.templateCreated': 'Tarea programada creada',
    'feedback.templateUpdated': 'Tarea programada actualizada',
    'feedback.configSaved': 'Ajustes guardados',
    'feedback.sessionCommandCopied': 'Comando de sesión copiado. Pégalo en un terminal para continuar.',
    'feedback.commandCopied': 'Comando de ejecución copiado',
    'feedback.restarting': 'El Gateway se está reiniciando…',
    'feedback.restartTimeout': 'El Gateway aún no se ha recuperado. Actualiza más tarde o comprueba el estado de PM2.',
    'feedback.databaseCleared': 'Base de datos vaciada. Copia de seguridad: {path}',
    'feedback.copyFailed': 'La copia falló. Selecciona el contenido manualmente.',
    'a11y.skip': 'Saltar al contenido principal',
    'a11y.refreshing': 'Actualizando',
};

const MESSAGES: Record<Locale, Record<MessageKey, string>> = {
    'zh-CN': ZH,
    en: EN,
    es: ES,
};

export function t(
    locale: Locale,
    key: MessageKey,
    values: Record<string, string | number> = {},
): string {
    const template = MESSAGES[locale][key];
    return template.replace(/\{([a-zA-Z]+)\}/g, (_, name: string) => String(values[name] ?? `{${name}}`));
}

export function intlLocale(locale: Locale): string {
    if (locale === 'en') return 'en-US';
    if (locale === 'es') return 'es-ES';
    return 'zh-CN';
}

export function nextLocale(locale: Locale): Locale {
    if (locale === 'en') return 'es';
    if (locale === 'es') return 'zh-CN';
    return 'en';
}

export function statusText(locale: Locale, status: string): string {
    const key = `status.${status}` as MessageKey;
    return key in ZH ? t(locale, key) : t(locale, 'status.unknown');
}

export function runStatusText(locale: Locale, status: string): string {
    const key = `runStatus.${status}` as MessageKey;
    return key in ZH ? t(locale, key) : t(locale, 'status.unknown');
}

export function resolveEditedRunAt(
    originalEpoch: number | null,
    originalLocal: string,
    currentLocal: string,
): number {
    if (originalEpoch !== null && originalLocal === currentLocal) return originalEpoch;
    return new Date(currentLocal).getTime();
}

export function formatRelative(timestamp: number | null, locale: Locale): string {
    if (!timestamp) return '—';
    const deltaMs = timestamp - Date.now();
    const abs = Math.abs(deltaMs);
    const formatter = new Intl.RelativeTimeFormat(intlLocale(locale), { numeric: 'auto' });
    if (abs < 60_000) return formatter.format(Math.round(deltaMs / 1000), 'second');
    if (abs < 3_600_000) return formatter.format(Math.round(deltaMs / 60_000), 'minute');
    if (abs < 86_400_000) return formatter.format(Math.round(deltaMs / 3_600_000), 'hour');
    return formatter.format(Math.round(deltaMs / 86_400_000), 'day');
}

export function formatFuture(timestamp: number | null, locale: Locale): string {
    if (!timestamp) return '—';
    if (timestamp < Date.now()) return t(locale, 'schedule.overdue');
    return formatRelative(timestamp, locale);
}

export function formatDateTime(value: Date | number | null, locale: Locale): string {
    if (!value) return '—';
    const date = value instanceof Date ? value : new Date(value);
    return new Intl.DateTimeFormat(intlLocale(locale), {
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    }).format(date);
}

type IconName = 'brand' | 'tasks' | 'templates' | 'runs' | 'system' | 'refresh'
    | 'search' | 'sun' | 'globe' | 'chevronLeft' | 'chevronRight' | 'copy'
    | 'close' | 'inbox' | 'activity' | 'check' | 'alert' | 'clock' | 'database' | 'folder';

export function icon(name: IconName, className = 'icon'): string {
    const paths: Record<IconName, string> = {
        brand: '<path d="M7 4.5h10a2.5 2.5 0 0 1 2.5 2.5v10a2.5 2.5 0 0 1-2.5 2.5H7A2.5 2.5 0 0 1 4.5 17V7A2.5 2.5 0 0 1 7 4.5Z"/><path d="m8 12 2.4 2.4L16.5 8.5"/>',
        tasks: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>',
        templates: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/><path d="M12 14v3l2 1"/>',
        runs: '<path d="M4 19.5V4.5M4 19.5h16"/><path d="m7 15 3-4 3 2 5-6"/>',
        system: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-1.42 1.42-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V20h-2v-.48a1.7 1.7 0 0 0-1.03-1.56 1.7 1.7 0 0 0-1.88.34l-.06.06-1.42-1.42.06-.06A1.7 1.7 0 0 0 9.4 15a1.7 1.7 0 0 0-1.56-1.03H7.5v-2h.34A1.7 1.7 0 0 0 9.4 10a1.7 1.7 0 0 0-.34-1.88L9 8.06l1.42-1.42.06.06a1.7 1.7 0 0 0 1.88.34A1.7 1.7 0 0 0 13.4 5.5V5h2v.5a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06 1.42 1.42-.06.06A1.7 1.7 0 0 0 19.4 10a1.7 1.7 0 0 0 1.56 1.03h.54v2h-.54A1.7 1.7 0 0 0 19.4 15Z"/>',
        refresh: '<path d="M20 6v5h-5"/><path d="M18.5 15a7 7 0 1 1-.8-7.8L20 11"/>',
        search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
        sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41"/>',
        globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
        chevronLeft: '<path d="m15 18-6-6 6-6"/>',
        chevronRight: '<path d="m9 18 6-6-6-6"/>',
        copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
        close: '<path d="m6 6 12 12M18 6 6 18"/>',
        inbox: '<path d="M4 4h16l2 12h-6l-2 3h-4l-2-3H2L4 4Z"/><path d="M8 9h8"/>',
        activity: '<path d="M3 12h4l2-6 4 12 2-6h6"/>',
        check: '<path d="m5 12 4 4L19 6"/>',
        alert: '<path d="M12 3 2.8 19h18.4L12 3Z"/><path d="M12 9v4M12 17h.01"/>',
        clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
        database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5M4 11v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6"/>',
        folder: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2h6.5A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5v-9Z"/>',
    };
    return `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`;
}

const STYLES = `
<style>
  :root {
    color-scheme: light;
    --bg:#f5f7fb; --bg-glow:rgba(99,102,241,.12); --surface:#ffffff; --surface-2:#f8fafc;
    --surface-3:#eef2f7; --text:#172033; --text-2:#58657a; --text-3:#8792a5;
    --border:#dfe5ee; --border-strong:#cbd4e1; --primary:#5957d9; --primary-hover:#4846c7;
    --primary-soft:#eeedff; --green:#15805d; --green-soft:#e7f7f0; --red:#c63f4f; --red-soft:#fdecef;
    --yellow:#a66608; --yellow-soft:#fff4d9; --blue:#2563b8; --blue-soft:#e8f1ff; --purple:#7552c8;
    --shadow-sm:0 1px 2px rgba(16,24,40,.04); --shadow-md:0 12px 30px rgba(30,41,59,.08);
    --shadow-lg:0 24px 60px rgba(30,41,59,.18); --radius:14px; --radius-sm:9px;
    --focus:0 0 0 3px rgba(89,87,217,.22);
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --bg:#090d15; --bg-glow:rgba(99,102,241,.18); --surface:#111722; --surface-2:#151d2a;
    --surface-3:#1c2635; --text:#edf2f8; --text-2:#a6b1c2; --text-3:#738095;
    --border:#273244; --border-strong:#344258; --primary:#8b87ff; --primary-hover:#a19eff;
    --primary-soft:#242347; --green:#48c78e; --green-soft:#16362b; --red:#ff7180; --red-soft:#3b1e27;
    --yellow:#f0b34b; --yellow-soft:#392d18; --blue:#6ea8ff; --blue-soft:#192d4b; --purple:#b89cff;
    --shadow-sm:0 1px 2px rgba(0,0,0,.25); --shadow-md:0 16px 36px rgba(0,0,0,.28);
    --shadow-lg:0 28px 70px rgba(0,0,0,.45); --focus:0 0 0 3px rgba(139,135,255,.25);
  }
  * { box-sizing:border-box; }
  html { min-height:100%; background:var(--bg); }
  body { min-height:100vh; margin:0; color:var(--text); background:
    radial-gradient(circle at 10% -10%,var(--bg-glow),transparent 34rem),var(--bg);
    font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
    font-size:14px; line-height:1.5; -webkit-font-smoothing:antialiased; }
  button,input,select,textarea { font:inherit; }
  button,a,select,input,textarea { -webkit-tap-highlight-color:transparent; }
  a { color:inherit; }
  code,.mono,.m { font-family:"SFMono-Regular",Consolas,"Liberation Mono",monospace; }
  .skip-link { position:fixed; left:16px; top:-60px; z-index:200; padding:10px 14px; border-radius:8px;
    color:#fff; background:var(--primary); transition:top .2s ease; }
  .skip-link:focus { top:16px; }
  .app-shell { width:min(1440px,100%); margin:0 auto; padding:0 28px 28px; }
  .topbar { min-height:80px; display:flex; align-items:center; justify-content:space-between; gap:20px;
    border-bottom:1px solid var(--border); }
  .brand { display:flex; align-items:center; gap:12px; min-width:0; }
  .brand-mark { width:38px; height:38px; display:grid; place-items:center; color:#fff; border-radius:11px;
    background:linear-gradient(145deg,#7773ff,#514ec8); box-shadow:0 9px 22px rgba(89,87,217,.28); }
  .brand-mark .icon { width:23px; height:23px; }
  .brand-name { display:flex; align-items:baseline; gap:7px; font-size:17px; font-weight:760; letter-spacing:-.025em; }
  .brand-name span { color:var(--text-3); font-size:12px; font-weight:650; letter-spacing:.02em; text-transform:uppercase; }
  .brand-tagline { color:var(--text-2); font-size:12px; margin-top:1px; }
  .top-actions { display:flex; align-items:center; justify-content:flex-end; gap:8px; }
  .local-chip { display:inline-flex; align-items:center; gap:7px; color:var(--text-2); font-size:12px; padding:7px 10px;
    border:1px solid var(--border); border-radius:999px; background:color-mix(in srgb,var(--surface) 78%,transparent); }
  .live-dot { width:7px; height:7px; border-radius:50%; background:var(--green); box-shadow:0 0 0 4px var(--green-soft); }
  .control { height:36px; border:1px solid var(--border); border-radius:9px; background:var(--surface);
    color:var(--text-2); box-shadow:var(--shadow-sm); }
  .select-wrap { position:relative; display:flex; align-items:center; }
  .select-wrap>.icon { width:15px; height:15px; position:absolute; left:10px; pointer-events:none; color:var(--text-3); }
  .select-wrap select { appearance:none; padding:0 29px 0 31px; cursor:pointer; outline:none; }
  .select-wrap::after { content:""; position:absolute; right:11px; width:6px; height:6px; border-right:1.5px solid currentColor;
    border-bottom:1.5px solid currentColor; transform:rotate(45deg) translateY(-2px); pointer-events:none; color:var(--text-3); }
  .language-switch { display:flex; padding:3px; gap:2px; }
  .language-switch button { height:28px; min-width:34px; padding:0 8px; border:0; border-radius:6px; color:var(--text-3);
    background:transparent; cursor:pointer; font-size:12px; font-weight:650; }
  .language-switch button.active { background:var(--surface-3); color:var(--text); }
  .icon-button { width:36px; height:36px; display:grid; place-items:center; border:1px solid var(--border); border-radius:9px;
    color:var(--text-2); background:var(--surface); box-shadow:var(--shadow-sm); cursor:pointer; }
  .icon-button .icon { width:17px; height:17px; }
  .icon-button:hover,.control:hover { border-color:var(--border-strong); color:var(--text); }
  .icon-button.refreshing .icon { animation:spin .7s linear infinite; }
  .tabs { display:flex; gap:6px; margin:18px 0 30px; padding:5px; width:max-content; max-width:100%; overflow-x:auto;
    border:1px solid var(--border); border-radius:12px; background:color-mix(in srgb,var(--surface) 82%,transparent); box-shadow:var(--shadow-sm); }
  .tabs a { display:flex; align-items:center; gap:8px; min-height:36px; padding:0 14px; border-radius:8px; color:var(--text-2);
    font-weight:650; font-size:13px; text-decoration:none; white-space:nowrap; transition:background .16s ease,color .16s ease,box-shadow .16s ease; }
  .tabs a .icon { width:16px; height:16px; }
  .tabs a:hover { color:var(--text); background:var(--surface-2); }
  .tabs a.active { color:var(--primary); background:var(--surface); box-shadow:0 1px 4px rgba(16,24,40,.08); }
  main { outline:none; }
  .page-heading { display:flex; justify-content:space-between; align-items:flex-end; gap:20px; margin-bottom:22px; }
  .page-heading h1 { margin:0; font-size:28px; line-height:1.2; letter-spacing:-.035em; }
  .page-heading p { margin:7px 0 0; color:var(--text-2); max-width:720px; }
  .stats-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:14px; margin-bottom:20px; }
  .stats-grid.three { grid-template-columns:repeat(3,minmax(0,1fr)); }
  .stat-card { position:relative; min-height:118px; padding:19px; overflow:hidden; border:1px solid var(--border); border-radius:var(--radius);
    background:linear-gradient(145deg,var(--surface),color-mix(in srgb,var(--surface-2) 72%,var(--surface)));
    box-shadow:var(--shadow-sm); transition:transform .18s ease,border-color .18s ease,box-shadow .18s ease; }
  .stat-card:hover { transform:translateY(-2px); border-color:var(--border-strong); box-shadow:var(--shadow-md); }
  .stat-card::after { content:""; position:absolute; width:90px; height:90px; right:-38px; top:-45px; border-radius:50%; background:var(--tone-soft); }
  .stat-top { display:flex; justify-content:space-between; align-items:center; }
  .stat-icon { width:32px; height:32px; display:grid; place-items:center; border-radius:9px; color:var(--tone); background:var(--tone-soft); }
  .stat-icon .icon { width:17px; height:17px; }
  .stat-value { margin-top:13px; font-size:28px; font-weight:760; line-height:1; letter-spacing:-.04em; color:var(--tone); }
  .stat-label { margin-top:7px; color:var(--text-2); font-size:12px; font-weight:650; }
  .tone-neutral { --tone:var(--text-2); --tone-soft:var(--surface-3); }
  .tone-blue { --tone:var(--blue); --tone-soft:var(--blue-soft); }
  .tone-green { --tone:var(--green); --tone-soft:var(--green-soft); }
  .tone-red { --tone:var(--red); --tone-soft:var(--red-soft); }
  .tone-purple { --tone:var(--purple); --tone-soft:var(--primary-soft); }
  .toolbar { display:flex; justify-content:space-between; align-items:center; gap:14px; margin:0 0 12px; }
  .filters { display:flex; gap:6px; overflow-x:auto; padding:2px; }
  .filter-chip { display:inline-flex; align-items:center; min-height:34px; padding:0 12px; border:1px solid var(--border); border-radius:9px;
    color:var(--text-2); background:var(--surface); text-decoration:none; font-size:12px; font-weight:650; white-space:nowrap; }
  .filter-chip:hover { border-color:var(--border-strong); color:var(--text); }
  .filter-chip.active { border-color:color-mix(in srgb,var(--primary) 38%,var(--border)); color:var(--primary); background:var(--primary-soft); }
  .search-box { position:relative; width:min(320px,100%); flex:0 1 320px; }
  .search-box .icon { position:absolute; left:11px; top:50%; width:16px; height:16px; color:var(--text-3); transform:translateY(-50%); }
  .search-box input { width:100%; height:36px; padding:0 12px 0 36px; border:1px solid var(--border); border-radius:9px;
    outline:none; color:var(--text); background:var(--surface); box-shadow:var(--shadow-sm); }
  .search-box input::placeholder { color:var(--text-3); }
  .search-box input:focus { border-color:var(--primary); box-shadow:var(--focus); }
  .panel,.card { border:1px solid var(--border); border-radius:var(--radius); background:var(--surface); box-shadow:var(--shadow-sm); }
  .panel { overflow:hidden; margin-bottom:16px; }
  .panel-head { min-height:52px; display:flex; align-items:center; justify-content:space-between; gap:12px; padding:0 18px;
    border-bottom:1px solid var(--border); }
  .panel-head h2,.panel-head h3 { margin:0; font-size:14px; letter-spacing:-.01em; }
  .panel-head p { margin:3px 0 0; color:var(--text-2); font-size:11px; }
  .project-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(230px,1fr)); gap:10px; padding:14px; }
  .project-card { min-width:0; padding:12px; border:1px solid var(--border); border-radius:10px; color:var(--text); background:var(--surface-2); text-decoration:none; }
  .project-card:hover { border-color:var(--border-strong); background:var(--surface-3); }
  .project-card.active { border-color:color-mix(in srgb,var(--primary) 45%,var(--border)); background:var(--primary-soft); }
  .project-card-head { display:flex; align-items:center; justify-content:space-between; gap:10px; }
  .project-card-head strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .project-card-head span { color:var(--text-3); font-size:11px; }
  .project-path { margin-top:4px; overflow:hidden; color:var(--text-3); font-family:"SFMono-Regular",Consolas,monospace; font-size:10px; text-overflow:ellipsis; white-space:nowrap; }
  .project-counts { margin-top:8px; color:var(--text-2); font-size:11px; }
  .table-wrap { width:100%; overflow-x:auto; }
  table { width:100%; border-collapse:separate; border-spacing:0; font-size:13px; }
  th { height:42px; padding:0 13px; color:var(--text-3); background:var(--surface-2); border-bottom:1px solid var(--border);
    font-size:11px; font-weight:730; letter-spacing:.045em; text-align:left; text-transform:uppercase; white-space:nowrap; }
  td { padding:12px 13px; border-bottom:1px solid var(--border); vertical-align:middle; }
  tbody tr:last-child td { border-bottom:0; }
  tbody tr { transition:background .14s ease; }
  tbody tr:hover { background:color-mix(in srgb,var(--primary-soft) 30%,transparent); }
  .task-name { font-weight:680; color:var(--text); }
  .task-prompt { max-width:520px; margin-top:3px; color:var(--text-2); font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .task-context { margin-top:6px; }
  .muted,.mu { color:var(--text-2); }
  .faint { color:var(--text-3); }
  .small,.sm { font-size:12px; }
  .tag { display:inline-flex; align-items:center; min-height:23px; max-width:180px; padding:0 8px; border:1px solid var(--border);
    border-radius:7px; color:var(--text-2); background:var(--surface-2); font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .badge { display:inline-flex; align-items:center; gap:6px; min-height:24px; padding:0 9px; border-radius:999px; font-size:11px; font-weight:720; white-space:nowrap; }
  .badge::before { content:""; width:6px; height:6px; border-radius:50%; background:currentColor; }
  .b-pending { color:var(--text-2); background:var(--surface-3); }
  .b-running { color:var(--blue); background:var(--blue-soft); }
  .b-running::before { animation:pulse 1.7s ease-in-out infinite; }
  .b-done { color:var(--green); background:var(--green-soft); }
  .b-failed { color:var(--red); background:var(--red-soft); }
  .b-dead_letter { color:var(--yellow); background:var(--yellow-soft); }
  .b-cancelled,.b-unknown { color:var(--text-3); background:var(--surface-3); }
  .t-cron { color:var(--purple); } .t-recurring { color:var(--blue); } .t-delayed { color:var(--yellow); }
  .actions { display:flex; align-items:center; flex-wrap:wrap; gap:5px; }
  .btn { min-height:32px; display:inline-flex; align-items:center; justify-content:center; gap:6px; padding:0 11px; border:1px solid var(--border);
    border-radius:8px; color:var(--text-2); background:var(--surface); text-decoration:none; cursor:pointer; font-size:12px; font-weight:650;
    transition:transform .12s ease,background .15s ease,border-color .15s ease,color .15s ease,box-shadow .15s ease; }
  .btn:hover { color:var(--text); border-color:var(--border-strong); background:var(--surface-2); }
  .btn:active { transform:scale(.97); }
  .btn:disabled { opacity:.5; cursor:not-allowed; transform:none; }
  .btn-primary { color:#fff; border-color:var(--primary); background:var(--primary); }
  .btn-primary:hover { color:#fff; border-color:var(--primary-hover); background:var(--primary-hover); }
  .btn-danger { color:var(--red); }
  .btn-danger:hover { color:var(--red); border-color:color-mix(in srgb,var(--red) 55%,var(--border)); background:var(--red-soft); }
  .btn-warning:hover { color:var(--yellow); border-color:color-mix(in srgb,var(--yellow) 55%,var(--border)); background:var(--yellow-soft); }
  .btn .icon { width:14px; height:14px; }
  .pagination { display:flex; justify-content:center; align-items:center; gap:10px; margin:18px 0 4px; }
  .pagination .summary { color:var(--text-2); font-size:12px; }
  .empty-state { display:grid; place-items:center; min-height:230px; padding:36px; text-align:center; }
  .empty-icon { width:48px; height:48px; display:grid; place-items:center; border-radius:14px; color:var(--primary); background:var(--primary-soft); }
  .empty-icon .icon { width:23px; height:23px; }
  .empty-state h3 { margin:13px 0 4px; font-size:15px; }
  .empty-state p { margin:0; color:var(--text-2); font-size:12px; }
  .empty-state code { display:inline-block; margin-top:10px; padding:5px 8px; border-radius:6px; background:var(--surface-3); }
  .settings-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:14px; margin-bottom:16px; }
  .settings-card { padding:18px; }
  .settings-title { display:flex; align-items:center; justify-content:space-between; margin:0 0 16px; font-size:14px; }
  .settings-title span:first-child { display:flex; align-items:center; gap:8px; }
  .settings-title .icon { width:17px; height:17px; color:var(--primary); }
  .field { display:grid; grid-template-columns:minmax(0,1fr) 112px; align-items:center; gap:12px; margin:11px 0; }
  .field label { color:var(--text-2); font-size:12px; }
  .input-unit { position:relative; }
  .input-unit input { width:100%; height:36px; padding:0 47px 0 10px; border:1px solid var(--border); border-radius:8px; outline:none;
    color:var(--text); background:var(--surface-2); }
  .input-unit span { position:absolute; right:9px; top:50%; transform:translateY(-50%); color:var(--text-3); font-size:10px; pointer-events:none; }
  .input-unit input:focus { border-color:var(--primary); box-shadow:var(--focus); background:var(--surface); }
  .switch-field { display:flex; align-items:center; justify-content:space-between; gap:12px; margin:11px 0; color:var(--text-2); font-size:12px; }
  .switch { position:relative; width:42px; height:24px; flex:0 0 auto; }
  .switch input { position:absolute; opacity:0; }
  .switch span { position:absolute; inset:0; border-radius:999px; background:var(--surface-3); border:1px solid var(--border-strong); cursor:pointer; transition:.2s ease; }
  .switch span::after { content:""; position:absolute; width:17px; height:17px; left:2px; top:2px; border-radius:50%; background:var(--surface);
    box-shadow:0 1px 3px rgba(0,0,0,.22); transition:transform .2s ease; }
  .switch input:checked+span { background:var(--primary); border-color:var(--primary); }
  .switch input:checked+span::after { transform:translateX(18px); }
  .save-row { display:flex; align-items:center; justify-content:flex-end; gap:12px; margin:0 0 24px; }
  .info-list { padding:4px 18px; }
  .info-row { display:flex; align-items:flex-start; justify-content:space-between; gap:20px; padding:13px 0; border-bottom:1px solid var(--border); }
  .info-row:last-child { border-bottom:0; }
  .info-key { color:var(--text-2); }
  .info-value { font-weight:650; text-align:right; overflow-wrap:anywhere; }
  .overview-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; padding:18px; }
  .overview-item { padding:13px; border-radius:10px; background:var(--surface-2); }
  .overview-item span { color:var(--text-2); font-size:11px; }
  .overview-item strong { display:block; margin-top:5px; font-size:19px; }
  .danger-card { margin-top:16px; padding:18px; border-color:color-mix(in srgb,var(--red) 40%,var(--border)); background:linear-gradient(145deg,var(--surface),var(--red-soft)); }
  .danger-card h2 { display:flex; align-items:center; gap:8px; margin:0 0 5px; color:var(--red); font-size:14px; }
  .danger-card h2 .icon { width:17px; height:17px; }
  .danger-card p { max-width:800px; margin:0 0 14px; color:var(--text-2); font-size:12px; }
  .log-panel { margin:12px 0; animation:reveal .18s ease both; }
  .run-log-row td { padding:0 16px 16px; background:color-mix(in srgb,var(--surface-2) 64%,var(--surface)); }
  .run-log-row .log-panel { margin:0; box-shadow:none; }
  .log-content { display:grid; gap:14px; padding:16px; }
  .log-section-head { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:7px; }
  .run-command,.run-output,.run-error,.run-tools { min-width:0; }
  .run-command strong,.run-output>strong,.run-error>strong,.run-tools>strong { display:block; margin-bottom:7px; font-size:12px; }
  .command-cwd { margin-bottom:6px; color:var(--text-3); font-family:"SFMono-Regular",Consolas,monospace; font-size:10px; overflow-wrap:anywhere; }
  .run-command pre,.run-output pre,.run-error pre { margin:0; padding:12px; overflow:auto; border:1px solid var(--border); border-radius:9px;
    color:var(--text-2); background:var(--surface-2); font-family:"SFMono-Regular",Consolas,monospace; font-size:11px; white-space:pre-wrap; overflow-wrap:anywhere; }
  .run-output pre { color:var(--text); font-family:inherit; font-size:13px; line-height:1.65; }
  .run-error pre { color:var(--red); border-color:color-mix(in srgb,var(--red) 28%,var(--border)); background:var(--red-soft); }
  .raw-log { padding-top:12px; border-top:1px solid var(--border); }
  .raw-log summary { color:var(--text-2); cursor:pointer; font-size:12px; font-weight:650; }
  .raw-log .log-box { margin-top:10px; border-radius:9px; }
  .log-box { max-height:360px; overflow:auto; padding:16px; color:var(--text-2); background:#0b1018; font-family:"SFMono-Regular",Consolas,monospace;
    font-size:12px; white-space:pre-wrap; overflow-wrap:anywhere; }
  :root[data-theme="light"] .log-box { color:#dbe5f3; }
  dialog { width:min(760px,calc(100% - 32px)); padding:0; border:1px solid var(--border); border-radius:16px; color:var(--text);
    background:var(--surface); box-shadow:var(--shadow-lg); }
  dialog[open] { animation:dialog-in .18s ease both; }
  dialog::backdrop { background:rgba(8,12,20,.62); backdrop-filter:blur(3px); animation:fade-in .18s ease both; }
  .dialog-head { display:flex; align-items:center; justify-content:space-between; gap:14px; padding:17px 18px; border-bottom:1px solid var(--border); }
  .dialog-head h2 { margin:0; font-size:15px; }
  .dialog-head p { margin:3px 0 0; color:var(--text-2); font-size:11px; }
  .dialog-body { max-height:70vh; overflow:auto; padding:18px; }
  .dialog-actions { display:flex; align-items:center; justify-content:flex-end; gap:8px; padding:14px 18px; border-top:1px solid var(--border); }
  .template-dialog { width:min(880px,calc(100% - 32px)); }
  .template-form-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:15px; }
  .form-field { display:flex; min-width:0; flex-direction:column; gap:6px; color:var(--text-2); font-size:12px; font-weight:650; }
  .form-field-wide { grid-column:1 / -1; }
  .form-field input,.form-field select,.form-field textarea { width:100%; min-height:39px; padding:8px 10px; border:1px solid var(--border); border-radius:9px;
    outline:none; color:var(--text); background:var(--surface-2); font-weight:450; }
  .field-action { display:flex; align-items:stretch; gap:7px; }
  .field-action input { min-width:0; flex:1; }
  .field-action .btn { flex:0 0 auto; white-space:nowrap; }
  .model-selector { display:grid; grid-template-columns:minmax(120px,.75fr) minmax(0,1.25fr); gap:7px; }
  .duration-picker { display:grid; gap:7px; }
  .duration-control { display:grid; grid-template-columns:minmax(0,1fr) 112px; gap:7px; }
  .duration-control input,.duration-control select { min-width:0; }
  .form-field textarea { resize:vertical; line-height:1.5; }
  .form-field input:focus,.form-field select:focus,.form-field textarea:focus { border-color:var(--primary); box-shadow:var(--focus); background:var(--surface); }
  .form-field small { color:var(--text-3); font-size:10px; font-weight:450; }
  .advanced-fields { margin-top:18px; padding-top:14px; border-top:1px solid var(--border); }
  .advanced-fields summary { margin-bottom:14px; color:var(--text-2); cursor:pointer; font-size:12px; font-weight:700; }
  .form-note { margin:16px 0 0; color:var(--text-3); font-size:11px; }
  .catalog-status[data-state="loading"] { color:var(--blue); }
  .catalog-status[data-state="ready"] { color:var(--green); }
  .catalog-status[data-state="error"] { color:var(--red); }
  .directory-dialog { width:min(720px,calc(100% - 32px)); }
  .directory-toolbar { display:flex; align-items:center; gap:8px; margin-bottom:12px; }
  .directory-path { min-width:0; flex:1; padding:9px 11px; overflow:hidden; border:1px solid var(--border); border-radius:9px;
    color:var(--text-2); background:var(--surface-2); font-family:"SFMono-Regular",Consolas,monospace; font-size:11px; text-overflow:ellipsis; white-space:nowrap; }
  .directory-list { min-height:260px; max-height:48vh; display:grid; align-content:start; gap:6px; overflow:auto; }
  .directory-item { width:100%; min-height:40px; display:flex; align-items:center; gap:9px; padding:0 11px; border:1px solid transparent; border-radius:9px;
    color:var(--text-2); background:transparent; cursor:pointer; text-align:left; transition:background-color .15s ease,border-color .15s ease,color .15s ease,transform .12s ease; }
  .directory-item:hover { color:var(--text); border-color:var(--border); background:var(--surface-2); }
  .directory-item:active { transform:scale(.99); }
  .directory-item .icon { width:17px; height:17px; color:var(--primary); flex:0 0 auto; }
  .directory-empty { min-height:220px; display:grid; place-items:center; color:var(--text-3); }
  .detail-view { display:grid; gap:16px; }
  .detail-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; }
  .detail-item { min-width:0; padding:12px 13px; border:1px solid var(--border); border-radius:10px; background:var(--surface-2); }
  .detail-item.wide { grid-column:1 / -1; }
  .detail-label { margin-bottom:5px; color:var(--text-3); font-size:10px; font-weight:750; letter-spacing:.045em; text-transform:uppercase; }
  .detail-value { color:var(--text); font-size:13px; line-height:1.55; overflow-wrap:anywhere; }
  .detail-value.mono { font-family:"SFMono-Regular",Consolas,monospace; font-size:11px; }
  .detail-value.long { max-height:240px; margin:0; overflow:auto; white-space:pre-wrap; }
  .detail-history h3 { margin:0 0 8px; font-size:13px; }
  .detail-history-list { display:grid; gap:7px; }
  .detail-history-item { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:9px 11px; border:1px solid var(--border); border-radius:9px; background:var(--surface-2); font-size:11px; }
  .detail-raw { padding-top:12px; border-top:1px solid var(--border); }
  .detail-raw summary { color:var(--text-2); cursor:pointer; font-size:12px; font-weight:650; }
  .json-view { max-height:320px; margin:10px 0 0; padding:15px; overflow:auto; border:1px solid var(--border); border-radius:10px; color:var(--text-2);
    background:var(--surface-2); font-family:"SFMono-Regular",Consolas,monospace; font-size:11px; white-space:pre-wrap; overflow-wrap:anywhere; }
  .confirm-copy { color:var(--text-2); margin:0; }
  .confirm-copy strong { display:block; margin-bottom:5px; color:var(--text); font-size:15px; }
  .danger-input { width:100%; height:40px; margin-top:14px; padding:0 12px; border:1px solid var(--border); border-radius:9px; outline:none;
    color:var(--text); background:var(--surface-2); font-family:"SFMono-Regular",Consolas,monospace; text-transform:uppercase; }
  .danger-input:focus { border-color:var(--red); box-shadow:0 0 0 3px color-mix(in srgb,var(--red) 22%,transparent); }
  .toast-region { position:fixed; top:18px; right:18px; z-index:300; display:grid; gap:8px; pointer-events:none; }
  .toast { min-width:260px; max-width:min(420px,calc(100vw - 36px)); display:flex; align-items:flex-start; gap:10px; padding:12px 14px;
    border:1px solid var(--border); border-radius:11px; color:var(--text); background:var(--surface); box-shadow:var(--shadow-lg); animation:toast-in .22s ease both; }
  .toast .icon { width:18px; height:18px; flex:0 0 auto; margin-top:1px; }
  .toast.ok .icon { color:var(--green); } .toast.error .icon { color:var(--red); }
  .toast.leaving { animation:toast-out .18s ease both; }
  footer { display:flex; justify-content:center; padding:24px 0 4px; color:var(--text-3); font-size:11px; }
  [hidden] { display:none!important; }
  :focus-visible { outline:none; box-shadow:var(--focus); }
  .ui-ready,.ui-ready * { transition-property:background-color,border-color,color,box-shadow; transition-duration:.16s; transition-timing-function:ease; }
  .reveal { animation:reveal .28s ease both; }
  .reveal-delay-1 { animation-delay:.04s; } .reveal-delay-2 { animation-delay:.08s; }
  @keyframes spin { to { transform:rotate(360deg); } }
  @keyframes pulse { 0%,100% { opacity:1; box-shadow:0 0 0 0 currentColor; } 50% { opacity:.7; box-shadow:0 0 0 4px transparent; } }
  @keyframes reveal { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:none; } }
  @keyframes dialog-in { from { opacity:0; transform:translateY(8px) scale(.985); } to { opacity:1; transform:none; } }
  @keyframes fade-in { from { opacity:0; } to { opacity:1; } }
  @keyframes toast-in { from { opacity:0; transform:translateY(-8px) scale(.98); } to { opacity:1; transform:none; } }
  @keyframes toast-out { to { opacity:0; transform:translateY(-6px) scale(.98); } }
  @media (max-width:1000px) {
    .stats-grid { grid-template-columns:repeat(2,minmax(0,1fr)); }
    .settings-grid { grid-template-columns:1fr; }
    .local-chip { display:none; }
  }
  @media (max-width:720px) {
    .app-shell { padding:0 16px 20px; }
    .topbar { min-height:72px; }
    .brand-tagline,.brand-name span { display:none; }
    .top-actions { gap:5px; }
    .select-wrap select { width:42px; color:transparent; padding:0; }
    .select-wrap>.icon { left:12px; color:var(--text-2); }
    .select-wrap::after { display:none; }
    .language-switch { display:none; }
    .mobile-language { display:grid!important; }
    .tabs { width:100%; margin:14px 0 24px; }
    .tabs a { flex:1; justify-content:center; padding:0 10px; }
    .tabs a span { display:none; }
    .page-heading { align-items:flex-start; }
    .page-heading h1 { font-size:24px; }
    .page-heading p { font-size:13px; }
    .stats-grid,.stats-grid.three { grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; }
    .stat-card { min-height:105px; padding:15px; }
    .toolbar { align-items:stretch; flex-direction:column; }
    .search-box { width:100%; flex-basis:auto; }
    .filters { order:2; }
    .overview-grid { grid-template-columns:repeat(2,minmax(0,1fr)); }
    .save-row { align-items:flex-end; flex-direction:column-reverse; }
    .save-row .btn { width:100%; }
    .responsive-table { display:block; padding:10px; }
    .responsive-table thead { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
    .responsive-table tbody { display:grid; gap:10px; }
    .responsive-table tr { display:grid; gap:0; padding:10px 12px; border:1px solid var(--border); border-radius:11px; background:var(--surface-2); }
    .responsive-table td { min-width:0; display:grid; grid-template-columns:88px minmax(0,1fr); align-items:start; gap:10px; padding:6px 0; border:0; }
    .responsive-table td::before { content:attr(data-label); color:var(--text-3); font-size:10px; font-weight:730; letter-spacing:.045em; text-transform:uppercase; }
    .responsive-table td[data-primary] { display:block; padding-bottom:10px; margin-bottom:4px; border-bottom:1px solid var(--border); }
    .responsive-table td[data-primary]::before { display:none; }
    .responsive-table .task-prompt { max-width:100%; }
    .responsive-table .actions { justify-content:flex-start; }
    .responsive-table .run-log-row { padding:0; overflow:hidden; }
    .responsive-table .run-log-cell { display:block; padding:0; }
    .responsive-table .run-log-cell::before { display:none; }
    .project-grid { grid-template-columns:1fr; }
    .template-form-grid { grid-template-columns:1fr; }
    .detail-grid { grid-template-columns:1fr; }
    .detail-item.wide { grid-column:auto; }
    .form-field-wide { grid-column:auto; }
    .field-action { align-items:stretch; flex-direction:column; }
    .field-action .btn { width:100%; }
    .model-selector { grid-template-columns:1fr; }
  }
  @media (max-width:520px) {
    .stats-grid,.stats-grid.three { grid-template-columns:1fr 1fr; }
    .stat-card { min-height:98px; }
    .stat-value { font-size:24px; }
    .page-heading p { max-width:95%; }
    .field { grid-template-columns:minmax(0,1fr) 105px; }
    .overview-grid { grid-template-columns:1fr 1fr; padding:12px; }
    .pagination .summary { max-width:150px; text-align:center; }
  }
  @media (prefers-reduced-motion:reduce) {
    *,*::before,*::after { scroll-behavior:auto!important; animation-duration:.01ms!important; animation-iteration-count:1!important; transition-duration:.01ms!important; }
  }
</style>`;

const PAGE_KEYS: Record<ActiveTab, { title: MessageKey; description: MessageKey }> = {
    tasks: { title: 'page.tasks.title', description: 'page.tasks.description' },
    templates: { title: 'page.templates.title', description: 'page.templates.description' },
    runs: { title: 'page.runs.title', description: 'page.runs.description' },
    system: { title: 'page.system.title', description: 'page.system.description' },
};

function clientMessages(locale: Locale) {
    const keys = [
        'action.cancel', 'action.confirm', 'action.copy', 'action.delete', 'action.refresh',
        'action.logs', 'action.hideLogs', 'details.title', 'details.subtitle',
        'details.taskTitle', 'details.runTitle', 'details.templateTitle', 'details.raw',
        'details.copySuccess', 'details.id', 'details.project', 'details.variant', 'details.prompt', 'details.result',
        'details.category', 'details.batch', 'details.dependency', 'details.importance',
        'details.urgency', 'details.retryCount', 'details.retryBackoff', 'details.timeout',
        'details.createdAt', 'details.updatedAt', 'details.startedAt', 'details.finishedAt',
        'details.scheduledAt', 'details.enabled', 'details.scheduleRule', 'details.maxInstances',
        'details.maxRetries',
        'details.lastRun', 'details.nextRun', 'details.taskId', 'details.session',
        'details.heartbeat', 'details.process', 'details.history', 'details.noHistory',
        'details.none', 'details.default', 'details.enabledYes', 'details.enabledNo',
        'table.name', 'table.agent', 'table.model', 'table.status', 'table.duration',
        'template.scheduleType', 'status.pending', 'status.running', 'status.done',
        'status.failed', 'status.dead_letter', 'status.cancelled', 'status.unknown',
        'runStatus.running', 'runStatus.done', 'runStatus.failed',
        'schedule.cron', 'schedule.recurring', 'schedule.delayed', 'schedule.unknown',
        'duration.seconds', 'duration.minutes', 'duration.hours', 'duration.days',
        'feedback.copyFailed',
        'dialog.cancelTask', 'dialog.cancelTaskBody', 'dialog.retryTask', 'dialog.retryTaskBody',
        'dialog.deleteTask', 'dialog.deleteTaskBody', 'dialog.disableTemplate', 'dialog.disableTemplateBody',
        'dialog.deleteTemplate', 'dialog.deleteTemplateBody', 'dialog.triggerTemplate', 'dialog.triggerTemplateBody',
        'dialog.clearTitle', 'dialog.clearBody', 'dialog.clearInstruction', 'dialog.restartGateway',
        'dialog.restartGatewayBody', 'dialog.restartGatewayRunningBody', 'feedback.retryFailed',
        'feedback.cancelFailed', 'feedback.deleteFailed', 'feedback.requestFailed', 'feedback.triggered',
        'feedback.taskCreated', 'feedback.taskUpdated', 'task.projectExisting', 'task.projectNew',
        'task.createTitle', 'task.editTitle', 'action.saveTask', 'action.updateTask',
        'feedback.configSaved', 'feedback.databaseCleared', 'feedback.templateCreated',
        'feedback.templateUpdated', 'feedback.sessionCommandCopied', 'feedback.restarting',
        'feedback.restartTimeout', 'template.createTitle', 'template.editTitle', 'filter.noResults',
        'catalog.chooseProject', 'catalog.defaultModel', 'catalog.defaultProvider', 'catalog.defaultVariant', 'catalog.loading', 'catalog.loaded',
        'catalog.failed', 'catalog.primary', 'catalog.subagent', 'catalog.all',
        'directory.empty', 'feedback.commandCopied', 'action.showHidden', 'action.hideHidden',
    ] as const;
    return Object.fromEntries(keys.map((key) => [key, t(locale, key)]));
}

export function renderLayout(options: {
    locale: Locale;
    activeTab: ActiveTab;
    body: string;
}): string {
    const { locale, activeTab, body } = options;
    const page = PAGE_KEYS[activeTab];
    const nav = [
        { id: 'tasks' as const, href: '/', icon: 'tasks' as const },
        { id: 'templates' as const, href: '/templates', icon: 'templates' as const },
        { id: 'runs' as const, href: '/runs', icon: 'runs' as const },
        { id: 'system' as const, href: '/system', icon: 'system' as const },
    ];
    const ui = JSON.stringify(clientMessages(locale)).replace(/</g, '\\u003c');
    return `<!DOCTYPE html>
<html lang="${intlLocale(locale)}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="color-scheme" content="light dark">
  <meta name="theme-color" content="#f5f7fb">
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Crect x='2' y='2' width='20' height='20' rx='6' fill='%235957d9'/%3E%3Cpath d='m7 12 3 3 7-7' fill='none' stroke='white' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E">
  <title>${t(locale, page.title)} · SuperTask</title>
  <script>(function(){try{var p=localStorage.getItem('supertask-theme')||'system';var d=p==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):p;document.documentElement.dataset.theme=d;document.documentElement.dataset.themePreference=p}catch(e){}})();</script>
  ${STYLES}
</head>
<body>
  <a class="skip-link" href="#main">${t(locale, 'a11y.skip')}</a>
  <div class="app-shell">
    <header class="topbar">
      <div class="brand">
        <div class="brand-mark">${icon('brand')}</div>
        <div>
          <div class="brand-name">${t(locale, 'app.name')} <span>${t(locale, 'app.dashboard')}</span></div>
          <div class="brand-tagline">${t(locale, 'app.tagline')}</div>
        </div>
      </div>
      <div class="top-actions">
        <div class="local-chip"><span class="live-dot"></span>${t(locale, 'app.local')}</div>
        <div class="control language-switch" role="group" aria-label="${t(locale, 'language.label')}">
          <button type="button" class="${locale === 'zh-CN' ? 'active' : ''}" onclick="setLocale('zh-CN')" aria-pressed="${locale === 'zh-CN'}">中</button>
          <button type="button" class="${locale === 'en' ? 'active' : ''}" onclick="setLocale('en')" aria-pressed="${locale === 'en'}">EN</button>
          <button type="button" class="${locale === 'es' ? 'active' : ''}" onclick="setLocale('es')" aria-pressed="${locale === 'es'}">ES</button>
        </div>
        <button type="button" class="icon-button mobile-language" style="display:none" onclick="setLocale('${nextLocale(locale)}')" aria-label="${t(locale, 'language.label')}" title="${t(locale, 'language.label')}">${icon('globe')}</button>
        <label class="select-wrap" aria-label="${t(locale, 'theme.label')}">
          ${icon('sun')}
          <select id="theme-select" class="control" onchange="setTheme(this.value)" title="${t(locale, 'theme.label')}">
            <option value="system">${t(locale, 'theme.system')}</option>
            <option value="light">${t(locale, 'theme.light')}</option>
            <option value="dark">${t(locale, 'theme.dark')}</option>
          </select>
        </label>
        <button type="button" class="icon-button" onclick="refreshPage(this)" aria-label="${t(locale, 'action.refresh')}" title="${t(locale, 'action.refresh')}">${icon('refresh')}</button>
      </div>
    </header>
    <nav class="tabs" aria-label="Primary">
      ${nav.map((item) => `<a href="${item.href}" class="${activeTab === item.id ? 'active' : ''}" ${activeTab === item.id ? 'aria-current="page"' : ''}>${icon(item.icon)}<span>${t(locale, `nav.${item.id}` as MessageKey)}</span></a>`).join('')}
    </nav>
    <main id="main" tabindex="-1">
      <div class="page-heading reveal">
        <div><h1>${t(locale, page.title)}</h1><p>${t(locale, page.description)}</p></div>
      </div>
      ${body}
    </main>
    <footer>${t(locale, 'app.footer')}</footer>
  </div>
  <div id="toast-region" class="toast-region" role="status" aria-live="polite"></div>
  <dialog id="directory-dialog" class="directory-dialog">
    <div class="dialog-head"><div><h2>${t(locale, 'directory.title')}</h2><p>${t(locale, 'directory.subtitle')}</p></div><button type="button" class="icon-button" onclick="document.getElementById('directory-dialog').close()" aria-label="${t(locale, 'action.close')}">${icon('close')}</button></div>
    <div class="dialog-body"><div class="directory-toolbar"><button id="directory-home" type="button" class="btn">${t(locale, 'action.home')}</button><button id="directory-up" type="button" class="btn">${t(locale, 'action.up')}</button><button id="directory-hidden" type="button" class="btn">${t(locale, 'action.showHidden')}</button><div id="directory-path" class="directory-path"></div></div><div id="directory-list" class="directory-list"></div></div>
    <div class="dialog-actions"><button type="button" class="btn" onclick="document.getElementById('directory-dialog').close()">${t(locale, 'action.cancel')}</button><button id="directory-choose" type="button" class="btn btn-primary">${icon('folder')}${t(locale, 'action.chooseThisFolder')}</button></div>
  </dialog>
  <dialog id="detail-dialog">
    <div class="dialog-head"><div><h2 id="detail-title">${t(locale, 'details.title')}</h2><p>${t(locale, 'details.subtitle')}</p></div><button class="icon-button" onclick="document.getElementById('detail-dialog').close()" aria-label="${t(locale, 'action.close')}">${icon('close')}</button></div>
    <div class="dialog-body"><div id="detail-content" class="detail-view"></div><details class="detail-raw"><summary>${t(locale, 'details.raw')}</summary><pre id="detail-raw" class="json-view"></pre></details></div>
    <div class="dialog-actions"><button class="btn" onclick="copyDetails()">${icon('copy')}${t(locale, 'action.copy')}</button><button class="btn btn-primary" onclick="document.getElementById('detail-dialog').close()">${t(locale, 'action.close')}</button></div>
  </dialog>
  <dialog id="confirm-dialog">
    <div class="dialog-head"><div><h2 id="confirm-title"></h2></div><button class="icon-button" onclick="document.getElementById('confirm-dialog').close('cancel')" aria-label="${t(locale, 'action.close')}">${icon('close')}</button></div>
    <div class="dialog-body"><p id="confirm-body" class="confirm-copy"></p></div>
    <div class="dialog-actions"><button class="btn" onclick="document.getElementById('confirm-dialog').close('cancel')">${t(locale, 'action.cancel')}</button><button id="confirm-ok" class="btn btn-primary" onclick="document.getElementById('confirm-dialog').close('confirm')">${t(locale, 'action.confirm')}</button></div>
  </dialog>
  <dialog id="danger-dialog">
    <div class="dialog-head"><div><h2>${t(locale, 'dialog.clearTitle')}</h2></div><button class="icon-button" onclick="document.getElementById('danger-dialog').close('cancel')" aria-label="${t(locale, 'action.close')}">${icon('close')}</button></div>
    <div class="dialog-body"><p class="confirm-copy"><strong>${t(locale, 'dialog.clearBody')}</strong>${t(locale, 'dialog.clearInstruction')}</p><input id="danger-confirmation" class="danger-input" autocomplete="off" spellcheck="false" placeholder="CLEAR" oninput="document.getElementById('danger-ok').disabled=this.value!=='CLEAR'"></div>
    <div class="dialog-actions"><button class="btn" onclick="document.getElementById('danger-dialog').close('cancel')">${t(locale, 'action.cancel')}</button><button id="danger-ok" class="btn btn-danger" disabled onclick="document.getElementById('danger-dialog').close('confirm')">${t(locale, 'action.clearDatabase')}</button></div>
  </dialog>
  <script>
    const UI=${ui};
    const text=(key,values={})=>(UI[key]||key).replace(/\{([a-zA-Z]+)\}/g,(_,name)=>String(values[name]??'{'+name+'}'));
    const themeMedia=matchMedia('(prefers-color-scheme: dark)');
    function applyTheme(preference){const resolved=preference==='system'?(themeMedia.matches?'dark':'light'):preference;document.documentElement.dataset.theme=resolved;document.documentElement.dataset.themePreference=preference;const select=document.getElementById('theme-select');if(select)select.value=preference;document.querySelector('meta[name="theme-color"]').content=resolved==='dark'?'#090d15':'#f5f7fb';}
    function setTheme(preference){localStorage.setItem('supertask-theme',preference);applyTheme(preference);}
    function setLocale(value){document.cookie='supertask_locale='+encodeURIComponent(value)+'; Path=/; Max-Age=31536000; SameSite=Lax';location.reload();}
    themeMedia.addEventListener?.('change',()=>{if((localStorage.getItem('supertask-theme')||'system')==='system')applyTheme('system');});
    applyTheme(localStorage.getItem('supertask-theme')||'system');
    requestAnimationFrame(()=>document.documentElement.classList.add('ui-ready'));
    ${resolveEditedRunAt.toString()}
    function refreshPage(button){button.classList.add('refreshing');button.setAttribute('aria-label','${t(locale, 'a11y.refreshing')}');location.reload();}
    function showToast(message,type='ok'){const region=document.getElementById('toast-region');const node=document.createElement('div');node.className='toast '+type;node.innerHTML=(type==='error'?'${icon('alert')}':'${icon('check')}')+'<span></span>';node.querySelector('span').textContent=message;region.appendChild(node);setTimeout(()=>{node.classList.add('leaving');setTimeout(()=>node.remove(),220)},3600);}
    async function readJson(response){const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error||text('feedback.requestFailed'));return data;}
    async function ask(title,body,danger=false){const dialog=document.getElementById('confirm-dialog');document.getElementById('confirm-title').textContent=title;document.getElementById('confirm-body').textContent=body;document.getElementById('confirm-ok').className='btn '+(danger?'btn-danger':'btn-primary');return new Promise(resolve=>{dialog.addEventListener('close',()=>resolve(dialog.returnValue==='confirm'),{once:true});dialog.showModal();});}
    async function askDanger(){const dialog=document.getElementById('danger-dialog');const input=document.getElementById('danger-confirmation');input.value='';document.getElementById('danger-ok').disabled=true;return new Promise(resolve=>{dialog.addEventListener('close',()=>resolve(dialog.returnValue==='confirm'),{once:true});dialog.showModal();setTimeout(()=>input.focus(),50);});}
    async function retryTask(id){if(!await ask(text('dialog.retryTask',{id}),text('dialog.retryTaskBody')))return;try{await readJson(await fetch('/api/tasks/'+id+'/retry',{method:'POST'}));location.reload()}catch(error){showToast(text('feedback.retryFailed')+': '+error.message,'error')}}
    async function cancelTask(id){if(!await ask(text('dialog.cancelTask',{id}),text('dialog.cancelTaskBody'),true))return;try{await readJson(await fetch('/api/tasks/'+id+'/cancel',{method:'POST'}));location.reload()}catch(error){showToast(text('feedback.cancelFailed')+': '+error.message,'error')}}
    async function deleteTask(id){if(!await ask(text('dialog.deleteTask',{id}),text('dialog.deleteTaskBody'),true))return;try{await readJson(await fetch('/api/tasks/'+id,{method:'DELETE'}));location.reload()}catch(error){showToast(text('feedback.deleteFailed')+': '+error.message,'error')}}
    function detailDate(value){if(value===null||value===undefined||value==='')return text('details.none');const epoch=typeof value==='number'&&value<100000000000?value*1000:value;const date=new Date(epoch);return Number.isNaN(date.getTime())?String(value):date.toLocaleString(document.documentElement.lang)}
    function detailDuration(value){if(value===null||value===undefined)return text('details.default');const milliseconds=Number(value);if(!Number.isFinite(milliseconds))return String(value);if(milliseconds===0)return '0 ms';const units=[[86400000,text('duration.days')],[3600000,text('duration.hours')],[60000,text('duration.minutes')],[1000,text('duration.seconds')]];for(const [size,label] of units){if(milliseconds>=size&&milliseconds%size===0)return String(milliseconds/size)+' '+label}return String(milliseconds)+' ms'}
    function detailStatus(type,value){const prefix=type==='run'?'runStatus.':'status.';const key=prefix+String(value||'unknown');return Object.prototype.hasOwnProperty.call(UI,key)?text(key):text('status.unknown')}
    function detailScheduleType(value){const key='schedule.'+String(value||'unknown');return Object.prototype.hasOwnProperty.call(UI,key)?text(key):text('schedule.unknown')}
    function detailModel(value){return !value||value==='default'?text('details.default'):String(value)}
    function detailSession(value){if(!value)return text('details.none');const session=String(value);return session.length<=10?session:session.slice(0,6)+'***'+session.slice(-4)}
    function detailTaskResult(data){const presentation=data._resultPresentation;if(!presentation)return text('details.none');const parts=[];if(Array.isArray(presentation.errors)&&presentation.errors.length)parts.push(presentation.errors.join('\\n'));if(presentation.text)parts.push(presentation.text);return parts.join('\\n\\n')||text('details.none')}
    function detailField(label,value,options={}){const item=document.createElement('div');item.className='detail-item'+(options.wide?' wide':'');const name=document.createElement('div');name.className='detail-label';name.textContent=label;const content=options.long?document.createElement('pre'):document.createElement('div');content.className='detail-value'+(options.mono?' mono':'')+(options.long?' long':'');content.textContent=value===null||value===undefined||value===''?text('details.none'):String(value);item.append(name,content);return item}
    function renderDetailHistory(runs){const section=document.createElement('section');section.className='detail-history';const title=document.createElement('h3');title.textContent=text('details.history');section.appendChild(title);if(!Array.isArray(runs)||runs.length===0){const empty=document.createElement('div');empty.className='muted small';empty.textContent=text('details.noHistory');section.appendChild(empty);return section}const list=document.createElement('div');list.className='detail-history-list';for(const run of runs){const item=document.createElement('div');item.className='detail-history-item';const primary=document.createElement('strong');primary.textContent='Run #'+run.id+' · '+detailStatus('run',run.status);const secondary=document.createElement('span');secondary.className='muted';secondary.textContent=detailDate(run.startedAt)+(run.model?' · '+detailModel(run.model):'')+(run.variant?' · '+run.variant:'');item.append(primary,secondary);list.appendChild(item)}section.appendChild(list);return section}
    function detailFields(type,data){if(type==='task')return [
        [text('details.id'),'#'+data.id],[text('table.name'),data.name],[text('table.status'),detailStatus('task',data.status)],[text('details.project'),data.cwd,{wide:true,mono:true}],
        [text('table.agent'),data.agent],[text('table.model'),detailModel(data.model)],[text('details.variant'),data.variant||text('details.default')],[text('details.prompt'),data.prompt,{wide:true,long:true}],
        [text('details.category'),data.category],[text('details.batch'),data.batchId],[text('details.dependency'),data.dependsOn?'#'+data.dependsOn:text('details.none')],
        [text('details.importance'),data.importance],[text('details.urgency'),data.urgency],[text('details.retryCount'),String(data.retryCount??0)+' / '+String(data.maxRetries??0)],
        [text('details.retryBackoff'),detailDuration(data.retryBackoffMs)],[text('details.timeout'),detailDuration(data.timeoutMs)],[text('details.scheduledAt'),detailDate(data.scheduledAt)],
        [text('details.createdAt'),detailDate(data.createdAt)],[text('details.startedAt'),detailDate(data.startedAt)],[text('details.finishedAt'),detailDate(data.finishedAt)],
        [text('details.result'),detailTaskResult(data),{wide:true,long:true}]
    ];if(type==='run'){const started=data.startedAt?new Date(data.startedAt).getTime():null;const finished=data.finishedAt?new Date(data.finishedAt).getTime():null;return [
        [text('details.id'),'Run #'+data.id],[text('details.taskId'),'#'+data.taskId],[text('table.status'),detailStatus('run',data.status)],[text('table.model'),detailModel(data.model)],[text('details.variant'),data.variant||text('details.default')],
        [text('details.session'),detailSession(data.sessionId)],[text('details.startedAt'),detailDate(data.startedAt)],[text('details.finishedAt'),detailDate(data.finishedAt)],
        [text('table.duration'),started!==null?detailDuration((finished??Date.now())-started):text('details.none')],[text('details.heartbeat'),detailDate(data.heartbeatAt)],
        [text('details.process'),'Worker PID '+String(data.workerPid??'—')+' · OpenCode PID '+String(data.childPid??'—'),{wide:true,mono:true}]
    ];}const scheduleRule=data.scheduleType==='cron'?data.cronExpr:data.scheduleType==='recurring'?detailDuration(data.intervalMs):detailDate(data.runAt);return [
        [text('details.id'),'#'+data.id],[text('table.name'),data.name],[text('details.enabled'),data.enabled?text('details.enabledYes'):text('details.enabledNo')],[text('details.project'),data.cwd,{wide:true,mono:true}],
        [text('table.agent'),data.agent],[text('table.model'),detailModel(data.model)],[text('details.variant'),data.variant||text('details.default')],[text('details.prompt'),data.prompt,{wide:true,long:true}],
        [text('template.scheduleType'),detailScheduleType(data.scheduleType)],[text('details.scheduleRule'),scheduleRule],[text('details.category'),data.category],[text('details.batch'),data.batchId],
        [text('details.importance'),data.importance],[text('details.urgency'),data.urgency],[text('details.maxInstances'),data.maxInstances],[text('details.maxRetries'),data.maxRetries??0],
        [text('details.retryBackoff'),detailDuration(data.retryBackoffMs)],[text('details.timeout'),detailDuration(data.timeoutMs)],[text('details.lastRun'),detailDate(data.lastRunAt)],[text('details.nextRun'),detailDate(data.nextRunAt)],
        [text('details.createdAt'),detailDate(data.createdAt)],[text('details.updatedAt'),detailDate(data.updatedAt)]
    ]}
    async function showRecord(url,type){try{const data=await readJson(await fetch(url));const content=document.getElementById('detail-content');content.replaceChildren();const grid=document.createElement('div');grid.className='detail-grid';for(const [label,value,options] of detailFields(type,data))grid.appendChild(detailField(label,value,options));content.appendChild(grid);if(type==='task')content.appendChild(renderDetailHistory(data._runs));document.getElementById('detail-title').textContent=text(type==='task'?'details.taskTitle':type==='run'?'details.runTitle':'details.templateTitle');document.getElementById('detail-raw').textContent=JSON.stringify(data,null,2);document.querySelector('#detail-dialog .detail-raw').open=false;document.getElementById('detail-dialog').showModal()}catch(error){showToast(error.message,'error')}}
    const showDetail=id=>showRecord('/api/tasks/'+id,'task');const showRunDetail=id=>showRecord('/api/runs/'+id,'run');const showTemplateDetail=id=>showRecord('/api/templates/'+id,'template');
    async function copyDetails(){try{await navigator.clipboard.writeText(document.getElementById('detail-raw').textContent);showToast(text('details.copySuccess'))}catch{showToast(text('feedback.copyFailed'),'error')}}
    async function copySessionCommand(id){try{const data=await readJson(await fetch('/api/runs/'+id+'/session-command'));await navigator.clipboard.writeText(data.command);showToast(text('feedback.sessionCommandCopied'))}catch(error){showToast(error.message||text('feedback.copyFailed'),'error')}}
    async function copyRunCommand(id){try{await navigator.clipboard.writeText(document.getElementById('command-'+id).textContent);showToast(text('feedback.commandCopied'))}catch{showToast(text('feedback.copyFailed'),'error')}}
    function taskField(name){return document.getElementById('task-'+name)}
    function templateField(name){return document.getElementById('template-'+name)}
    function taskProjects(){const node=document.getElementById('task-project-data');if(!node)return {};try{return JSON.parse(node.textContent||'{}')}catch{return {}}}
    function updateTaskProjectStatus(){const node=taskField('project-status');if(!node)return;const cwd=taskField('cwd').value.trim();if(!cwd){node.textContent='';return}const project=taskProjects()[cwd];node.textContent=project?text('task.projectExisting',project):text('task.projectNew')}
    const catalogTimers={};const catalogRequests={};const catalogModels={};
    function catalogField(prefix,name){return document.getElementById(prefix+'-'+name)}
    function resetCatalog(prefix){const agent=catalogField(prefix,'agent');const provider=catalogField(prefix,'model-provider');const model=catalogField(prefix,'model');const variant=catalogField(prefix,'variant');if(!agent||!provider||!model||!variant)return;const preferredVariant=variant.dataset.preferred||'';catalogModels[prefix]=[];agent.replaceChildren(new Option(text('catalog.chooseProject'),''));provider.replaceChildren(new Option(text('catalog.defaultProvider'),''));model.replaceChildren(new Option(text('catalog.defaultModel'),'default'));variant.replaceChildren(new Option(text('catalog.defaultVariant'),''));if(preferredVariant)appendCurrentOption(variant,preferredVariant);variant.value=preferredVariant;agent.disabled=false;provider.disabled=true;model.disabled=true;variant.disabled=!preferredVariant;catalogField(prefix,'catalog-status').textContent='';}
    function appendCurrentOption(select,value){if(!value||[...select.options].some(option=>option.value===value))return;select.appendChild(new Option(value,value));}
    function setPreferredVariant(prefix,modelValue,variantValue){const variant=catalogField(prefix,'variant');if(!variant)return;const preferred=variantValue||'';variant.dataset.preferred=preferred;variant.dataset.preferredModel=modelValue||'default';variant.replaceChildren(new Option(text('catalog.defaultVariant'),''));if(preferred)appendCurrentOption(variant,preferred);variant.value=preferred;variant.disabled=!preferred}
    function invalidateVariantRequest(prefix){const key=prefix+'-variant';catalogRequests[key]=(catalogRequests[key]||0)+1}
    function invalidateCatalogRequests(prefix){clearTimeout(catalogTimers[prefix]);catalogRequests[prefix]=(catalogRequests[prefix]||0)+1;invalidateVariantRequest(prefix)}
    function clearVariantPreference(prefix){const variant=catalogField(prefix,'variant');if(!variant)return;invalidateVariantRequest(prefix);variant.dataset.preferred='';variant.dataset.preferredModel='';variant.replaceChildren(new Option(text('catalog.defaultVariant'),''));variant.value='';variant.disabled=true}
    function handleProviderChange(prefix){clearVariantPreference(prefix);populateModelOptions(prefix)}
    function handleModelChange(prefix){clearVariantPreference(prefix);populateVariantOptions(prefix)}
    function handleVariantChange(prefix){const variant=catalogField(prefix,'variant');if(!variant)return;invalidateVariantRequest(prefix);variant.dataset.preferred='';variant.dataset.preferredModel=''}
    function modelProvider(value){const slash=value.indexOf('/');return slash>0?value.slice(0,slash):''}
    function populateModelOptions(prefix,preferredModel=''){const provider=catalogField(prefix,'model-provider');const model=catalogField(prefix,'model');if(!provider||!model)return;const selectedProvider=provider.value;model.replaceChildren();if(!selectedProvider){model.appendChild(new Option(text('catalog.defaultModel'),'default'));model.disabled=true;populateVariantOptions(prefix);return}const available=(catalogModels[prefix]||[]).filter(value=>modelProvider(value)===selectedProvider);for(const value of available)model.appendChild(new Option(value,value));if(preferredModel&&available.includes(preferredModel))model.value=preferredModel;model.disabled=available.length===0;populateVariantOptions(prefix)}
    async function populateVariantOptions(prefix,preferredVariant=''){const cwd=catalogField(prefix,'cwd')?.value.trim()||'';const model=catalogField(prefix,'model');const variant=catalogField(prefix,'variant');if(!model||!variant)return;const selectedModel=model.value;const preferred=preferredVariant||(variant.dataset.preferredModel===selectedModel?variant.dataset.preferred||'':'');if(!cwd||!selectedModel||selectedModel==='default'){variant.replaceChildren(new Option(text('catalog.defaultVariant'),''));if(preferred)appendCurrentOption(variant,preferred);variant.value=preferred;variant.dataset.preferred='';variant.dataset.preferredModel='';variant.disabled=!preferred;return}if(!preferred){variant.replaceChildren(new Option(text('catalog.defaultVariant'),''));variant.value=''}const requestKey=prefix+'-variant';const request=(catalogRequests[requestKey]||0)+1;catalogRequests[requestKey]=request;variant.disabled=true;try{const data=await readJson(await fetch('/api/opencode/catalog?cwd='+encodeURIComponent(cwd)));if(catalogRequests[requestKey]!==request||catalogField(prefix,'cwd')?.value.trim()!==cwd||model.value!==selectedModel)return;const available=Array.isArray(data.variantsByModel?.[selectedModel])?data.variantsByModel[selectedModel]:[];variant.replaceChildren(new Option(text('catalog.defaultVariant'),''));for(const value of available)variant.appendChild(new Option(value,value));if(preferred)appendCurrentOption(variant,preferred);variant.value=[...variant.options].some(option=>option.value===preferred)?preferred:'';variant.dataset.preferred='';variant.dataset.preferredModel='';variant.disabled=available.length===0&&!preferred}catch(error){if(catalogRequests[requestKey]!==request||catalogField(prefix,'cwd')?.value.trim()!==cwd||model.value!==selectedModel)return;if(preferred)appendCurrentOption(variant,preferred);variant.value=preferred;variant.dataset.preferred=preferred;variant.dataset.preferredModel=selectedModel;variant.disabled=!preferred}}
    async function loadCatalog(prefix,preferredAgent='',preferredModel='default',preserveUnavailable=false){const cwd=catalogField(prefix,'cwd')?.value.trim()||'';const status=catalogField(prefix,'catalog-status');const agent=catalogField(prefix,'agent');const provider=catalogField(prefix,'model-provider');const model=catalogField(prefix,'model');if(!cwd||!status||!agent||!provider||!model){if(!cwd)resetCatalog(prefix);return}const request=(catalogRequests[prefix]||0)+1;catalogRequests[prefix]=request;status.dataset.state='loading';status.textContent=text('catalog.loading');agent.disabled=true;provider.disabled=true;model.disabled=true;try{const data=await readJson(await fetch('/api/opencode/catalog?cwd='+encodeURIComponent(cwd)));if(catalogRequests[prefix]!==request||catalogField(prefix,'cwd').value.trim()!==cwd)return;agent.replaceChildren();for(const item of data.agents){const label=item.name+' — '+text('catalog.'+item.mode);agent.appendChild(new Option(label,item.name))}if(preserveUnavailable)appendCurrentOption(agent,preferredAgent);const defaultAgent=preferredAgent||data.agents.find(item=>item.name==='build')?.name||data.agents.find(item=>item.mode==='primary')?.name||data.agents[0]?.name||'';agent.value=[...agent.options].some(option=>option.value===defaultAgent)?defaultAgent:(agent.options[0]?.value||'');catalogModels[prefix]=[...data.models];if(preserveUnavailable&&preferredModel&&preferredModel!=='default'&&!catalogModels[prefix].includes(preferredModel))catalogModels[prefix].push(preferredModel);provider.replaceChildren(new Option(text('catalog.defaultProvider'),''));for(const name of [...new Set(catalogModels[prefix].map(modelProvider).filter(Boolean))].sort())provider.appendChild(new Option(name,name));const preferredProvider=preferredModel==='default'?'':modelProvider(preferredModel);provider.value=[...provider.options].some(option=>option.value===preferredProvider)?preferredProvider:'';populateModelOptions(prefix,preferredModel);status.dataset.state='ready';status.textContent=text('catalog.loaded',{agents:data.agents.length,models:data.models.length})}catch(error){if(catalogRequests[prefix]!==request)return;resetCatalog(prefix);if(preserveUnavailable){appendCurrentOption(agent,preferredAgent);if(preferredModel&&preferredModel!=='default'){catalogModels[prefix]=[preferredModel];appendCurrentOption(provider,modelProvider(preferredModel));provider.value=modelProvider(preferredModel);populateModelOptions(prefix,preferredModel)}}status.dataset.state='error';status.textContent=text('catalog.failed',{error:error.message})}finally{if(catalogRequests[prefix]===request){agent.disabled=false;provider.disabled=false;if(provider.value)model.disabled=false}}}
    function scheduleCatalogLoad(prefix){invalidateCatalogRequests(prefix);resetCatalog(prefix);catalogTimers[prefix]=setTimeout(()=>loadCatalog(prefix),450)}
    let directoryTargetId='';let directoryCurrent='';let directoryEntries=[];let directoryShowHidden=false;
    function renderDirectoryEntries(){const list=document.getElementById('directory-list');list.replaceChildren();const entries=directoryEntries.filter(entry=>directoryShowHidden||!entry.hidden);const hidden=document.getElementById('directory-hidden');hidden.textContent=text(directoryShowHidden?'action.hideHidden':'action.showHidden');if(entries.length===0){const empty=document.createElement('div');empty.className='directory-empty';empty.textContent=text('directory.empty');list.appendChild(empty);return}for(const entry of entries){const button=document.createElement('button');button.type='button';button.className='directory-item';button.innerHTML='${icon('folder')}<span></span>';button.querySelector('span').textContent=entry.name;button.onclick=()=>browseDirectory(entry.path);list.appendChild(button)}}
    async function browseDirectory(path=''){const choose=document.getElementById('directory-choose');choose.disabled=true;try{const suffix=path?'?path='+encodeURIComponent(path):'';const data=await readJson(await fetch('/api/filesystem/directories'+suffix));directoryCurrent=data.path;directoryEntries=data.directories;document.getElementById('directory-path').textContent=data.path;document.getElementById('directory-up').disabled=data.parent===data.path;document.getElementById('directory-up').onclick=()=>browseDirectory(data.parent);document.getElementById('directory-home').onclick=()=>browseDirectory(data.home);renderDirectoryEntries();choose.disabled=false;return true}catch(error){directoryCurrent='';directoryEntries=[];document.getElementById('directory-path').textContent='';renderDirectoryEntries();showToast(error.message,'error');return false}}
    document.getElementById('directory-hidden').onclick=()=>{directoryShowHidden=!directoryShowHidden;renderDirectoryEntries()};
    async function openDirectoryPicker(targetId){const input=document.getElementById(targetId);if(!input||input.readOnly)return;directoryTargetId=targetId;directoryShowHidden=false;document.getElementById('directory-dialog').showModal();if(!await browseDirectory(input.value.trim()||''))await browseDirectory('')}
    document.getElementById('directory-choose').onclick=()=>{const input=document.getElementById(directoryTargetId);if(!input||!directoryCurrent)return;input.value=directoryCurrent;input.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('directory-dialog').close();const prefix=directoryTargetId.startsWith('task-')?'task':'template';loadCatalog(prefix)};
    function updateDurationControl(id){const preset=document.getElementById(id+'-preset');const custom=document.getElementById(id+'-custom');const input=document.getElementById(id+'-value');const visible=preset.value==='custom';custom.hidden=!visible;input.required=visible;if(visible&&!input.value)input.value='1'}
    function readDuration(id){const preset=document.getElementById(id+'-preset').value;if(preset==='')return '';if(preset!=='custom')return preset==='0'?'0':preset+'ms';const value=document.getElementById(id+'-value').value.trim();return value===''?'':value+document.getElementById(id+'-unit').value}
    function setDuration(id,milliseconds){const preset=document.getElementById(id+'-preset');const exact=milliseconds==null?'':String(milliseconds);if([...preset.options].some(option=>option.value===exact)){preset.value=exact;updateDurationControl(id);return}preset.value='custom';const input=document.getElementById(id+'-value');const unit=document.getElementById(id+'-unit');const units=[['d',86400000],['h',3600000],['min',60000],['s',1000]];let matched=false;for(const [name,factor] of units){if(milliseconds!=null&&(milliseconds===0||milliseconds%factor===0)){input.value=String(milliseconds/factor);unit.value=name;matched=true;break}}if(!matched){input.value=String((milliseconds??60000)/1000);unit.value='s'}updateDurationControl(id)}
    function openTaskCreator(){invalidateCatalogRequests('task');const form=document.getElementById('task-form');form.reset();taskField('id').value='';setPreferredVariant('task','default','');taskField('cwd').readOnly=false;taskField('cwd-picker').hidden=false;taskField('cwd').value=form.dataset.defaultCwd||'';setDuration('task-retry-backoff',30000);setDuration('task-timeout',null);taskField('dialog-title').textContent=text('task.createTitle');taskField('save').textContent=text('action.saveTask');updateTaskProjectStatus();resetCatalog('task');document.getElementById('task-dialog').showModal();if(taskField('cwd').value)loadCatalog('task');setTimeout(()=>taskField('name').focus(),50)}
    async function openTaskEditor(id){invalidateCatalogRequests('task');try{const data=await readJson(await fetch('/api/tasks/'+id));document.getElementById('task-form').reset();taskField('id').value=String(id);taskField('cwd').value=data.cwd||'';taskField('cwd').readOnly=true;taskField('cwd-picker').hidden=true;taskField('name').value=data.name||'';taskField('prompt').value=data.prompt||'';taskField('category').value=data.category||'general';taskField('batch').value=data.batchId||'';taskField('importance').value=String(data.importance??3);taskField('urgency').value=String(data.urgency??3);taskField('max-retries').value=String(data.maxRetries??3);setDuration('task-retry-backoff',data.retryBackoffMs??30000);setDuration('task-timeout',data.timeoutMs);taskField('dialog-title').textContent=text('task.editTitle');taskField('save').textContent=text('action.updateTask');updateTaskProjectStatus();setPreferredVariant('task',data.model||'default',data.variant||'');resetCatalog('task');document.getElementById('task-dialog').showModal();loadCatalog('task',data.agent||'',data.model||'default',true);setTimeout(()=>taskField('name').focus(),50)}catch(error){showToast(error.message,'error')}}
    async function saveTask(event){event.preventDefault();const form=document.getElementById('task-form');if(!form.reportValidity())return;const id=taskField('id').value;const body={name:taskField('name').value,cwd:taskField('cwd').value,agent:taskField('agent').value,model:taskField('model').value,variant:taskField('variant').value,prompt:taskField('prompt').value,category:taskField('category').value,batchId:taskField('batch').value,importance:Number(taskField('importance').value),urgency:Number(taskField('urgency').value),maxRetries:Number(taskField('max-retries').value),retryBackoff:readDuration('task-retry-backoff'),timeout:readDuration('task-timeout')};const button=taskField('save');button.disabled=true;try{const data=await readJson(await fetch(id?'/api/tasks/'+id:'/api/tasks',{method:id?'PUT':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}));showToast(text(id?'feedback.taskUpdated':'feedback.taskCreated',{id:data.task.id}));document.getElementById('task-dialog').close();setTimeout(()=>location.assign(id?location.href:'/?cwd='+encodeURIComponent(data.task.cwd||'')),450)}catch(error){showToast(error.message,'error')}finally{button.disabled=false}}
    function localDateTime(milliseconds){const date=new Date(milliseconds);const local=new Date(milliseconds-date.getTimezoneOffset()*60000);return local.toISOString().slice(0,23)}
    function updateTemplateScheduleFields(){const type=templateField('schedule-type').value;const fields={cron:templateField('cron-field'),recurring:templateField('interval-field'),delayed:templateField('run-at-field')};for(const [name,node] of Object.entries(fields)){node.hidden=name!==type;for(const control of node.querySelectorAll('input,select'))control.required=false;const required=name==='recurring'?node.querySelector('[id$="-preset"]'):node.querySelector('input');if(required)required.required=name===type;if(name==='recurring'&&name===type)updateDurationControl('template-interval')}}
    function setOriginalRunAt(epoch){const input=templateField('run-at');const local=epoch?localDateTime(epoch):'';input.value=local;input.dataset.originalEpoch=epoch?String(epoch):'';input.dataset.originalLocal=local}
    function selectedRunAt(){const input=templateField('run-at');return resolveEditedRunAt(input.dataset.originalEpoch?Number(input.dataset.originalEpoch):null,input.dataset.originalLocal||'',input.value)}
    function openTemplateCreator(){invalidateCatalogRequests('template');const form=document.getElementById('template-form');form.reset();templateField('id').value='';setPreferredVariant('template','default','');templateField('dialog-title').textContent=text('template.createTitle');setDuration('template-interval',3600000);setDuration('template-retry-backoff',30000);setDuration('template-timeout',null);setOriginalRunAt(null);templateField('run-at').value=localDateTime(Date.now()+3600000);updateTemplateScheduleFields();resetCatalog('template');document.getElementById('template-dialog').showModal();if(templateField('cwd').value)loadCatalog('template');setTimeout(()=>templateField('name').focus(),50)}
    async function openTemplateEditor(id){invalidateCatalogRequests('template');try{const data=await readJson(await fetch('/api/templates/'+id));document.getElementById('template-form').reset();templateField('id').value=String(id);templateField('dialog-title').textContent=text('template.editTitle');templateField('name').value=data.name||'';templateField('cwd').value=data.cwd||'';templateField('prompt').value=data.prompt||'';templateField('schedule-type').value=data.scheduleType;templateField('cron').value=data.cronExpr||'';setDuration('template-interval',data.intervalMs);setOriginalRunAt(data.runAt||null);if(!data.runAt)templateField('run-at').value=localDateTime(Date.now()+3600000);templateField('category').value=data.category||'general';templateField('batch').value=data.batchId||'';templateField('importance').value=String(data.importance??3);templateField('urgency').value=String(data.urgency??3);templateField('max-instances').value=String(data.maxInstances??1);templateField('max-retries').value=String(data.maxRetries??3);setDuration('template-retry-backoff',data.retryBackoffMs??30000);setDuration('template-timeout',data.timeoutMs);updateTemplateScheduleFields();setPreferredVariant('template',data.model||'default',data.variant||'');resetCatalog('template');document.getElementById('template-dialog').showModal();loadCatalog('template',data.agent||'',data.model||'default',true);setTimeout(()=>templateField('name').focus(),50)}catch(error){showToast(error.message,'error')}}
    async function saveTemplate(event){event.preventDefault();const form=document.getElementById('template-form');if(!form.reportValidity())return;const id=templateField('id').value;const type=templateField('schedule-type').value;const body={name:templateField('name').value,cwd:templateField('cwd').value,agent:templateField('agent').value,model:templateField('model').value,variant:templateField('variant').value,prompt:templateField('prompt').value,scheduleType:type,cronExpr:templateField('cron').value,interval:readDuration('template-interval'),runAt:type==='delayed'?selectedRunAt():null,category:templateField('category').value,batchId:templateField('batch').value,importance:Number(templateField('importance').value),urgency:Number(templateField('urgency').value),maxInstances:Number(templateField('max-instances').value),maxRetries:Number(templateField('max-retries').value),retryBackoff:readDuration('template-retry-backoff'),timeout:readDuration('template-timeout')};const button=templateField('save');button.disabled=true;try{await readJson(await fetch(id?'/api/templates/'+id:'/api/templates',{method:id?'PUT':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}));showToast(text(id?'feedback.templateUpdated':'feedback.templateCreated'));document.getElementById('template-dialog').close();setTimeout(()=>location.assign(id?location.href:'/templates'),450)}catch(error){showToast(error.message,'error')}finally{button.disabled=false}}
    async function enableTmpl(id){try{await readJson(await fetch('/api/templates/'+id+'/enable',{method:'POST'}));location.reload()}catch(error){showToast(error.message,'error')}}
    async function disableTmpl(id){if(!await ask(text('dialog.disableTemplate'),text('dialog.disableTemplateBody')))return;try{await readJson(await fetch('/api/templates/'+id+'/disable',{method:'POST'}));location.reload()}catch(error){showToast(error.message,'error')}}
    async function deleteTmpl(id){if(!await ask(text('dialog.deleteTemplate'),text('dialog.deleteTemplateBody'),true))return;try{await readJson(await fetch('/api/templates/'+id,{method:'DELETE'}));location.reload()}catch(error){showToast(error.message,'error')}}
    async function triggerTmpl(id){if(!await ask(text('dialog.triggerTemplate'),text('dialog.triggerTemplateBody')))return;try{const data=await readJson(await fetch('/api/templates/'+id+'/trigger',{method:'POST'}));showToast(text('feedback.triggered',{id:data.taskId}));setTimeout(()=>location.reload(),550)}catch(error){showToast(error.message,'error')}}
    function toggleLog(id,button){const panel=document.getElementById('log-'+id);const hidden=!panel.hidden;panel.hidden=hidden;button.setAttribute('aria-expanded',String(!hidden));button.textContent=text(hidden?'action.logs':'action.hideLogs');if(!hidden)requestAnimationFrame(()=>panel.scrollIntoView({block:'nearest',behavior:'smooth'}));}
    function filterTasks(value){const query=value.trim().toLocaleLowerCase();let visible=0;document.querySelectorAll('[data-task-row]').forEach(row=>{const match=!query||row.dataset.search.toLocaleLowerCase().includes(query);row.hidden=!match;if(match)visible++});const empty=document.getElementById('search-empty');if(empty)empty.hidden=visible!==0;}
    async function clearDatabase(){if(!await askDanger())return;try{const data=await readJson(await fetch('/api/database/clear',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirmation:'CLEAR'})}));showToast(text('feedback.databaseCleared',{path:data.backupPath}));setTimeout(()=>location.reload(),1000)}catch(error){showToast(error.message,'error')}}
    async function confirmGatewayRestart(runningCount=0){const body=runningCount>0?text('dialog.restartGatewayRunningBody',{count:runningCount}):text('dialog.restartGatewayBody');return await ask(text('dialog.restartGateway'),body)}
    async function restartGateway(){try{const data=await readJson(await fetch('/api/gateway/restart',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirmation:'RESTART'})}));showToast(text('feedback.restarting'));for(let attempt=0;attempt<120;attempt++){await new Promise(resolve=>setTimeout(resolve,500));try{const status=await readJson(await fetch('/api/gateway/status',{cache:'no-store'}));if(status.pid!==data.previousPid&&status.managed&&status.ready&&!status.restartRequired){location.reload();return true}}catch{}}showToast(text('feedback.restartTimeout'),'error');return false}catch(error){showToast(error.message,'error');return false}}
    async function saveConfig(restartAfterSave=false,runningCount=0){if(restartAfterSave&&!await confirmGatewayRestart(runningCount))return;const form=document.getElementById('config-form');const data={worker:{maxConcurrency:Number(form.mc.value),pollIntervalMs:Number(form.pi.value),heartbeatIntervalMs:Number(form.hi.value)*1000,taskTimeoutMs:Number(form.to.value)*60000},scheduler:{enabled:form.se.checked,checkIntervalMs:Number(form.si.value)},watchdog:{heartbeatTimeoutMs:Number(form.wt.value)*1000,checkIntervalMs:Number(form.wci.value)*1000,cleanupIntervalMs:Number(form.wcl.value)*3600000,retentionDays:Number(form.rd.value)}};try{await readJson(await fetch('/api/config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}));showToast(text('feedback.configSaved'));if(restartAfterSave){const restarted=await restartGateway();if(!restarted)setTimeout(()=>location.reload(),500)}else{setTimeout(()=>location.reload(),500)}}catch(error){showToast(error.message,'error')}}
  </script>
</body>
</html>`;
}
