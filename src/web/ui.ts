export type Locale = 'zh-CN' | 'en';
export type ActiveTab = 'tasks' | 'templates' | 'runs' | 'system';

const ZH = {
    'app.name': 'SuperTask',
    'app.dashboard': '控制台',
    'app.tagline': '可靠的本地 Agent 调度中心',
    'app.local': '本地运行',
    'app.footer': 'Local-first · 数据留在你的设备上',
    'nav.tasks': '任务',
    'nav.templates': '调度',
    'nav.runs': '执行记录',
    'nav.system': '系统',
    'page.tasks.title': '任务队列',
    'page.tasks.description': '查看优先级、执行状态与重试情况，快速处理需要关注的任务。',
    'page.templates.title': '调度模板',
    'page.templates.description': '管理 Cron、延迟和循环任务，让重复工作按计划自动运行。',
    'page.runs.title': '执行记录',
    'page.runs.description': '追踪每次 Agent 执行的状态、耗时、心跳与输出。',
    'page.system.title': '系统设置',
    'page.system.description': '调整 Gateway 运行参数，检查实时任务并管理本地数据。',
    'action.refresh': '刷新',
    'action.details': '详情',
    'action.retry': '重试',
    'action.cancel': '取消',
    'action.delete': '删除',
    'action.enable': '启用',
    'action.disable': '禁用',
    'action.trigger': '立即触发',
    'action.logs': '查看日志',
    'action.hideLogs': '收起日志',
    'action.save': '保存设置',
    'action.copy': '复制 JSON',
    'action.close': '关闭',
    'action.confirm': '确认',
    'action.clearDatabase': '清空数据库',
    'status.pending': '待执行',
    'status.running': '运行中',
    'status.done': '已完成',
    'status.failed': '失败',
    'status.dead_letter': '死信',
    'status.cancelled': '已取消',
    'status.unknown': '未知',
    'stats.total': '总任务',
    'stats.pending': '待执行',
    'stats.running': '运行中',
    'stats.done': '已完成',
    'stats.failedDead': '失败与死信',
    'stats.templates': '模板总数',
    'stats.enabled': '已启用',
    'stats.disabled': '已禁用',
    'stats.records': '执行总数',
    'stats.pageDone': '本页成功',
    'stats.pageFailed': '本页失败',
    'stats.pageRunning': '本页运行中',
    'filter.all': '全部',
    'filter.searchTasks': '搜索当前页的任务、Agent 或提示词',
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
    'table.session': 'Session',
    'table.model': '模型',
    'table.startedAt': '启动时间',
    'table.pid': 'PID',
    'pagination.previous': '上一页',
    'pagination.next': '下一页',
    'pagination.summary': '第 {page} 页，共 {pages} 页 · {total} 条',
    'empty.tasks': '队列里还没有任务',
    'empty.tasksHint': '通过 OpenCode 插件或 supertask add 创建第一个任务。',
    'empty.templates': '还没有调度模板',
    'empty.templatesHint': '使用 CLI 创建：supertask template add',
    'empty.runs': '还没有执行记录',
    'empty.running': '当前没有运行中的任务',
    'schedule.cron': 'Cron',
    'schedule.recurring': '循环',
    'schedule.delayed': '延迟',
    'schedule.unknown': '未知',
    'schedule.enabled': '已启用',
    'schedule.disabled': '已禁用',
    'schedule.minutes': '{count} 分钟',
    'schedule.seconds': '{count} 秒',
    'schedule.hours': '{count} 小时',
    'schedule.days': '{count} 天',
    'schedule.overdue': '已到期',
    'system.worker': 'Worker',
    'system.scheduler': 'Scheduler',
    'system.watchdog': 'Watchdog',
    'system.maxConcurrency': '最大并发',
    'system.pollInterval': '轮询间隔',
    'system.heartbeatInterval': '心跳间隔',
    'system.taskTimeout': '任务超时',
    'system.schedulerEnabled': '启用调度',
    'system.checkInterval': '检查间隔',
    'system.heartbeatTimeout': '心跳超时',
    'system.cleanupInterval': '清理间隔',
    'system.retentionDays': '数据保留',
    'system.milliseconds': '毫秒',
    'system.seconds': '秒',
    'system.minutes': '分钟',
    'system.hours': '小时',
    'system.days': '天',
    'system.activeTemplates': '活跃模板',
    'system.saveHint': '保存后需重启 Gateway 生效',
    'system.runningTasks': '当前运行任务（{running} / {limit} 并发）',
    'system.taskStats': '任务概览',
    'system.configFile': '配置文件',
    'system.path': '路径',
    'system.fileExists': '文件存在',
    'system.yes': '是',
    'system.noDefault': '否，当前使用默认值',
    'system.danger': '危险操作',
    'system.dangerDescription': '系统会先创建可校验备份，再事务性清空任务、执行记录和调度模板；存在运行任务时会拒绝操作。',
    'theme.label': '主题',
    'theme.system': '跟随系统',
    'theme.light': '浅色',
    'theme.dark': '深色',
    'language.label': '语言',
    'details.title': '数据详情',
    'details.subtitle': '原始记录（JSON）',
    'details.copySuccess': 'JSON 已复制',
    'dialog.cancelTask': '取消任务 #{id}？',
    'dialog.cancelTaskBody': '运行中的任务会在下一个轮询周期终止对应进程树。',
    'dialog.retryTask': '重试任务 #{id}？',
    'dialog.retryTaskBody': '任务将回到待执行状态，并重置自动重试预算。',
    'dialog.deleteTask': '删除任务 #{id}？',
    'dialog.deleteTaskBody': '任务及关联执行记录将永久删除，此操作无法撤销。',
    'dialog.disableTemplate': '禁用这个调度模板？',
    'dialog.disableTemplateBody': '模板将停止自动创建新任务，已有任务不受影响。',
    'dialog.deleteTemplate': '删除这个调度模板？',
    'dialog.deleteTemplateBody': '模板配置将永久删除，此操作无法撤销。',
    'dialog.triggerTemplate': '立即触发一次？',
    'dialog.triggerTemplateBody': '系统会按当前模板创建一个新任务，并遵守最大实例限制。',
    'dialog.clearTitle': '确认清空数据库',
    'dialog.clearBody': '这会删除全部任务、执行记录和调度模板。系统会先自动备份。',
    'dialog.clearInstruction': '输入 CLEAR 以确认',
    'feedback.retryFailed': '重试失败',
    'feedback.cancelFailed': '取消失败',
    'feedback.deleteFailed': '删除失败',
    'feedback.requestFailed': '请求失败',
    'feedback.triggered': '已创建任务 #{id}',
    'feedback.configSaved': '设置已保存，重启 Gateway 后生效',
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
    'nav.templates': 'Schedules',
    'nav.runs': 'Runs',
    'nav.system': 'System',
    'page.tasks.title': 'Task queue',
    'page.tasks.description': 'Track priority, execution state, and retries, then act on tasks that need attention.',
    'page.templates.title': 'Schedule templates',
    'page.templates.description': 'Manage cron, delayed, and recurring work so repeated tasks run on time.',
    'page.runs.title': 'Execution history',
    'page.runs.description': 'Inspect the status, duration, heartbeat, and output of every agent run.',
    'page.system.title': 'System settings',
    'page.system.description': 'Tune Gateway behavior, inspect active work, and manage local data.',
    'action.refresh': 'Refresh',
    'action.details': 'Details',
    'action.retry': 'Retry',
    'action.cancel': 'Cancel',
    'action.delete': 'Delete',
    'action.enable': 'Enable',
    'action.disable': 'Disable',
    'action.trigger': 'Run now',
    'action.logs': 'View log',
    'action.hideLogs': 'Hide log',
    'action.save': 'Save settings',
    'action.copy': 'Copy JSON',
    'action.close': 'Close',
    'action.confirm': 'Confirm',
    'action.clearDatabase': 'Clear database',
    'status.pending': 'Pending',
    'status.running': 'Running',
    'status.done': 'Done',
    'status.failed': 'Failed',
    'status.dead_letter': 'Dead letter',
    'status.cancelled': 'Cancelled',
    'status.unknown': 'Unknown',
    'stats.total': 'Total tasks',
    'stats.pending': 'Pending',
    'stats.running': 'Running',
    'stats.done': 'Completed',
    'stats.failedDead': 'Failed & dead',
    'stats.templates': 'Templates',
    'stats.enabled': 'Enabled',
    'stats.disabled': 'Disabled',
    'stats.records': 'Total runs',
    'stats.pageDone': 'Succeeded here',
    'stats.pageFailed': 'Failed here',
    'stats.pageRunning': 'Running here',
    'filter.all': 'All',
    'filter.searchTasks': 'Search tasks, agents, or prompts on this page',
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
    'empty.tasksHint': 'Create the first task with the OpenCode plugin or supertask add.',
    'empty.templates': 'No schedule templates yet',
    'empty.templatesHint': 'Create one with: supertask template add',
    'empty.runs': 'No execution history yet',
    'empty.running': 'No tasks are running right now',
    'schedule.cron': 'Cron',
    'schedule.recurring': 'Recurring',
    'schedule.delayed': 'Delayed',
    'schedule.unknown': 'Unknown',
    'schedule.enabled': 'Enabled',
    'schedule.disabled': 'Disabled',
    'schedule.minutes': '{count} min',
    'schedule.seconds': '{count} sec',
    'schedule.hours': '{count} hr',
    'schedule.days': '{count} days',
    'schedule.overdue': 'Overdue',
    'system.worker': 'Worker',
    'system.scheduler': 'Scheduler',
    'system.watchdog': 'Watchdog',
    'system.maxConcurrency': 'Max concurrency',
    'system.pollInterval': 'Poll interval',
    'system.heartbeatInterval': 'Heartbeat interval',
    'system.taskTimeout': 'Task timeout',
    'system.schedulerEnabled': 'Enable scheduler',
    'system.checkInterval': 'Check interval',
    'system.heartbeatTimeout': 'Heartbeat timeout',
    'system.cleanupInterval': 'Cleanup interval',
    'system.retentionDays': 'Data retention',
    'system.milliseconds': 'ms',
    'system.seconds': 'seconds',
    'system.minutes': 'minutes',
    'system.hours': 'hours',
    'system.days': 'days',
    'system.activeTemplates': 'Active templates',
    'system.saveHint': 'Restart Gateway to apply saved settings',
    'system.runningTasks': 'Active tasks ({running} / {limit} concurrent)',
    'system.taskStats': 'Task overview',
    'system.configFile': 'Configuration file',
    'system.path': 'Path',
    'system.fileExists': 'File exists',
    'system.yes': 'Yes',
    'system.noDefault': 'No, using defaults',
    'system.danger': 'Danger zone',
    'system.dangerDescription': 'A verified backup is created first, then tasks, runs, and templates are cleared transactionally. Active work blocks this operation.',
    'theme.label': 'Theme',
    'theme.system': 'System',
    'theme.light': 'Light',
    'theme.dark': 'Dark',
    'language.label': 'Language',
    'details.title': 'Data details',
    'details.subtitle': 'Raw record (JSON)',
    'details.copySuccess': 'JSON copied',
    'dialog.cancelTask': 'Cancel task #{id}?',
    'dialog.cancelTaskBody': 'A running task will terminate its process tree on the next worker poll.',
    'dialog.retryTask': 'Retry task #{id}?',
    'dialog.retryTaskBody': 'The task returns to pending and its automatic retry budget is reset.',
    'dialog.deleteTask': 'Delete task #{id}?',
    'dialog.deleteTaskBody': 'The task and its execution history will be permanently deleted.',
    'dialog.disableTemplate': 'Disable this schedule?',
    'dialog.disableTemplateBody': 'It will stop creating new tasks automatically. Existing tasks are unchanged.',
    'dialog.deleteTemplate': 'Delete this schedule?',
    'dialog.deleteTemplateBody': 'This template configuration will be permanently deleted.',
    'dialog.triggerTemplate': 'Run this schedule now?',
    'dialog.triggerTemplateBody': 'A new task is created from the template, subject to its instance limit.',
    'dialog.clearTitle': 'Confirm database clear',
    'dialog.clearBody': 'This deletes every task, run, and schedule template after creating a backup.',
    'dialog.clearInstruction': 'Type CLEAR to confirm',
    'feedback.retryFailed': 'Retry failed',
    'feedback.cancelFailed': 'Cancellation failed',
    'feedback.deleteFailed': 'Delete failed',
    'feedback.requestFailed': 'Request failed',
    'feedback.triggered': 'Task #{id} created',
    'feedback.configSaved': 'Settings saved. Restart Gateway to apply them.',
    'feedback.databaseCleared': 'Database cleared. Backup: {path}',
    'feedback.copyFailed': 'Copy failed. Select the content manually.',
    'a11y.skip': 'Skip to main content',
    'a11y.refreshing': 'Refreshing',
};

export function t(
    locale: Locale,
    key: MessageKey,
    values: Record<string, string | number> = {},
): string {
    const template = (locale === 'en' ? EN : ZH)[key];
    return template.replace(/\{([a-zA-Z]+)\}/g, (_, name: string) => String(values[name] ?? `{${name}}`));
}

export function statusText(locale: Locale, status: string): string {
    const key = `status.${status}` as MessageKey;
    return key in ZH ? t(locale, key) : t(locale, 'status.unknown');
}

export function formatRelative(timestamp: number | null, locale: Locale): string {
    if (!timestamp) return '—';
    const deltaMs = timestamp - Date.now();
    const abs = Math.abs(deltaMs);
    const language = locale === 'en' ? 'en' : 'zh-CN';
    const formatter = new Intl.RelativeTimeFormat(language, { numeric: 'auto' });
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
    return new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'zh-CN', {
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    }).format(date);
}

type IconName = 'brand' | 'tasks' | 'templates' | 'runs' | 'system' | 'refresh'
    | 'search' | 'sun' | 'globe' | 'chevronLeft' | 'chevronRight' | 'copy'
    | 'close' | 'inbox' | 'activity' | 'check' | 'alert' | 'clock' | 'database';

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
  button,input,select { font:inherit; }
  button,a,select,input { -webkit-tap-highlight-color:transparent; }
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
  .json-view { min-height:160px; margin:0; padding:15px; overflow:auto; border:1px solid var(--border); border-radius:10px; color:var(--text-2);
    background:var(--surface-2); font-size:12px; white-space:pre-wrap; overflow-wrap:anywhere; }
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
        'action.logs', 'action.hideLogs', 'details.copySuccess', 'feedback.copyFailed',
        'dialog.cancelTask', 'dialog.cancelTaskBody', 'dialog.retryTask', 'dialog.retryTaskBody',
        'dialog.deleteTask', 'dialog.deleteTaskBody', 'dialog.disableTemplate', 'dialog.disableTemplateBody',
        'dialog.deleteTemplate', 'dialog.deleteTemplateBody', 'dialog.triggerTemplate', 'dialog.triggerTemplateBody',
        'dialog.clearTitle', 'dialog.clearBody', 'dialog.clearInstruction', 'feedback.retryFailed',
        'feedback.cancelFailed', 'feedback.deleteFailed', 'feedback.requestFailed', 'feedback.triggered',
        'feedback.configSaved', 'feedback.databaseCleared', 'filter.noResults',
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
    const language = locale === 'en' ? 'en' : 'zh-CN';
    return `<!DOCTYPE html>
<html lang="${language}">
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
        </div>
        <button type="button" class="icon-button mobile-language" style="display:none" onclick="setLocale('${locale === 'en' ? 'zh-CN' : 'en'}')" aria-label="${t(locale, 'language.label')}" title="${t(locale, 'language.label')}">${icon('globe')}</button>
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
  <dialog id="detail-dialog">
    <div class="dialog-head"><div><h2>${t(locale, 'details.title')}</h2><p>${t(locale, 'details.subtitle')}</p></div><button class="icon-button" onclick="document.getElementById('detail-dialog').close()" aria-label="${t(locale, 'action.close')}">${icon('close')}</button></div>
    <div class="dialog-body"><pre id="detail-content" class="json-view"></pre></div>
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
    function refreshPage(button){button.classList.add('refreshing');button.setAttribute('aria-label','${t(locale, 'a11y.refreshing')}');location.reload();}
    function showToast(message,type='ok'){const region=document.getElementById('toast-region');const node=document.createElement('div');node.className='toast '+type;node.innerHTML=(type==='error'?'${icon('alert')}':'${icon('check')}')+'<span></span>';node.querySelector('span').textContent=message;region.appendChild(node);setTimeout(()=>{node.classList.add('leaving');setTimeout(()=>node.remove(),220)},3600);}
    async function readJson(response){const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error||text('feedback.requestFailed'));return data;}
    async function ask(title,body,danger=false){const dialog=document.getElementById('confirm-dialog');document.getElementById('confirm-title').textContent=title;document.getElementById('confirm-body').textContent=body;document.getElementById('confirm-ok').className='btn '+(danger?'btn-danger':'btn-primary');return new Promise(resolve=>{dialog.addEventListener('close',()=>resolve(dialog.returnValue==='confirm'),{once:true});dialog.showModal();});}
    async function askDanger(){const dialog=document.getElementById('danger-dialog');const input=document.getElementById('danger-confirmation');input.value='';document.getElementById('danger-ok').disabled=true;return new Promise(resolve=>{dialog.addEventListener('close',()=>resolve(dialog.returnValue==='confirm'),{once:true});dialog.showModal();setTimeout(()=>input.focus(),50);});}
    async function retryTask(id){if(!await ask(text('dialog.retryTask',{id}),text('dialog.retryTaskBody')))return;try{await readJson(await fetch('/api/tasks/'+id+'/retry',{method:'POST'}));location.reload()}catch(error){showToast(text('feedback.retryFailed')+': '+error.message,'error')}}
    async function cancelTask(id){if(!await ask(text('dialog.cancelTask',{id}),text('dialog.cancelTaskBody'),true))return;try{await readJson(await fetch('/api/tasks/'+id+'/cancel',{method:'POST'}));location.reload()}catch(error){showToast(text('feedback.cancelFailed')+': '+error.message,'error')}}
    async function deleteTask(id){if(!await ask(text('dialog.deleteTask',{id}),text('dialog.deleteTaskBody'),true))return;try{await readJson(await fetch('/api/tasks/'+id,{method:'DELETE'}));location.reload()}catch(error){showToast(text('feedback.deleteFailed')+': '+error.message,'error')}}
    async function showRecord(url){try{const data=await readJson(await fetch(url));document.getElementById('detail-content').textContent=JSON.stringify(data,null,2);document.getElementById('detail-dialog').showModal()}catch(error){showToast(error.message,'error')}}
    const showDetail=id=>showRecord('/api/tasks/'+id);const showRunDetail=id=>showRecord('/api/runs/'+id);const showTemplateDetail=id=>showRecord('/api/templates/'+id);
    async function copyDetails(){try{await navigator.clipboard.writeText(document.getElementById('detail-content').textContent);showToast(text('details.copySuccess'))}catch{showToast(text('feedback.copyFailed'),'error')}}
    async function enableTmpl(id){try{await readJson(await fetch('/api/templates/'+id+'/enable',{method:'POST'}));location.reload()}catch(error){showToast(error.message,'error')}}
    async function disableTmpl(id){if(!await ask(text('dialog.disableTemplate'),text('dialog.disableTemplateBody')))return;try{await readJson(await fetch('/api/templates/'+id+'/disable',{method:'POST'}));location.reload()}catch(error){showToast(error.message,'error')}}
    async function deleteTmpl(id){if(!await ask(text('dialog.deleteTemplate'),text('dialog.deleteTemplateBody'),true))return;try{await readJson(await fetch('/api/templates/'+id,{method:'DELETE'}));location.reload()}catch(error){showToast(error.message,'error')}}
    async function triggerTmpl(id){if(!await ask(text('dialog.triggerTemplate'),text('dialog.triggerTemplateBody')))return;try{const data=await readJson(await fetch('/api/templates/'+id+'/trigger',{method:'POST'}));showToast(text('feedback.triggered',{id:data.taskId}));setTimeout(()=>location.reload(),550)}catch(error){showToast(error.message,'error')}}
    function toggleLog(id,button){const panel=document.getElementById('log-'+id);const hidden=!panel.hidden;panel.hidden=hidden;button.setAttribute('aria-expanded',String(!hidden));button.textContent=text(hidden?'action.logs':'action.hideLogs');}
    function filterTasks(value){const query=value.trim().toLocaleLowerCase();let visible=0;document.querySelectorAll('[data-task-row]').forEach(row=>{const match=!query||row.dataset.search.toLocaleLowerCase().includes(query);row.hidden=!match;if(match)visible++});const empty=document.getElementById('search-empty');if(empty)empty.hidden=visible!==0;}
    async function clearDatabase(){if(!await askDanger())return;try{const data=await readJson(await fetch('/api/database/clear',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirmation:'CLEAR'})}));showToast(text('feedback.databaseCleared',{path:data.backupPath}));setTimeout(()=>location.reload(),1000)}catch(error){showToast(error.message,'error')}}
    async function saveConfig(){const form=document.getElementById('config-form');const data={worker:{maxConcurrency:Number(form.mc.value),pollIntervalMs:Number(form.pi.value),heartbeatIntervalMs:Number(form.hi.value)*1000,taskTimeoutMs:Number(form.to.value)*60000},scheduler:{enabled:form.se.checked,checkIntervalMs:Number(form.si.value)},watchdog:{heartbeatTimeoutMs:Number(form.wt.value)*1000,checkIntervalMs:Number(form.wci.value)*1000,cleanupIntervalMs:Number(form.wcl.value)*3600000,retentionDays:Number(form.rd.value)}};try{await readJson(await fetch('/api/config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}));showToast(text('feedback.configSaved'))}catch(error){showToast(error.message,'error')}}
  </script>
</body>
</html>`;
}
