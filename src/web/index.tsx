import { Hono, type Context } from 'hono';
import { desc, eq, sql } from 'drizzle-orm';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { db, schema } from '@core/db';
import type { TaskStatus } from '@core/db/schema';
import {
    DatabaseMaintenanceConflictError,
    DatabaseMaintenanceService,
} from '@core/services/database-maintenance.service';
import { TaskRunService } from '@core/services/task-run.service';
import { TaskDeletionConflictError, TaskService } from '@core/services/task.service';
import { TaskTemplateService } from '@core/services/task-template.service';
import { getConfigPath, loadConfig, validateConfig, type GatewayConfig } from '@gateway/config';
import { getGatewayHealth } from '@gateway/health';
import { triggerTaskFromTemplate } from '@gateway/scheduler/job-templates';
import {
    formatDateTime,
    formatFuture,
    formatRelative,
    icon,
    renderLayout,
    statusText,
    t,
    type Locale,
} from './ui';

const app = new Hono();
const TASK_STATUSES = new Set<TaskStatus>([
    'pending', 'running', 'done', 'failed', 'dead_letter', 'cancelled',
]);

function parsePositiveInteger(value: string): number | null {
    if (!/^\d+$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseTaskStatus(value: string): TaskStatus | null {
    return TASK_STATUSES.has(value as TaskStatus) ? value as TaskStatus : null;
}

function safeStatus(value: string | null): TaskStatus | 'unknown' {
    return value && TASK_STATUSES.has(value as TaskStatus) ? value as TaskStatus : 'unknown';
}

function resolveLocale(c: Context): Locale {
    const requested = c.req.query('lang');
    if (requested === 'en' || requested === 'zh-CN') return requested;

    const cookie = c.req.header('Cookie') ?? '';
    const match = /(?:^|;\s*)supertask_locale=([^;]+)/.exec(cookie);
    if (match) {
        try {
            const saved = decodeURIComponent(match[1]);
            if (saved === 'en' || saved === 'zh-CN') return saved;
        } catch {
            // Ignore malformed client cookies and continue with browser negotiation.
        }
    }

    const accepted = c.req.header('Accept-Language')?.toLowerCase() ?? '';
    return accepted.startsWith('en') ? 'en' : 'zh-CN';
}

app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'no-referrer');
});

app.use('/api/*', async (c, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) return next();

    const fetchSite = c.req.header('Sec-Fetch-Site');
    if (fetchSite && !['same-origin', 'none'].includes(fetchSite)) {
        return c.json({ error: 'cross-site request rejected' }, 403);
    }

    const origin = c.req.header('Origin');
    if (origin) {
        try {
            const originUrl = new URL(origin);
            const requestUrl = new URL(c.req.url);
            const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(originUrl.hostname);
            if (!loopback || originUrl.origin !== requestUrl.origin) {
                return c.json({ error: 'cross-site request rejected' }, 403);
            }
        } catch {
            return c.json({ error: 'invalid origin' }, 403);
        }
    }

    return next();
});

app.get('/health', (c) => {
    const health = getGatewayHealth();
    return c.json(health, health.status === 'ok' ? 200 : 503);
});

function formatDuration(startAt: Date | null, endAt: Date | null): string {
    if (!startAt) return '—';
    const start = new Date(startAt).getTime();
    const end = endAt ? new Date(endAt).getTime() : Date.now();
    const seconds = Math.floor((end - start) / 1000);
    if (seconds < 0) return '0s';
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function esc(value: string | null | undefined): string {
    if (!value) return '';
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function readCurrentConfig(): Record<string, unknown> {
    const configPath = getConfigPath();
    if (!existsSync(configPath)) return {};
    try {
        return JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {
        return {};
    }
}

function writeConfig(cfg: GatewayConfig): void {
    const configPath = getConfigPath();
    const dir = dirname(configPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tempPath = `${configPath}.${process.pid}.tmp`;
    writeFileSync(tempPath, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
    renameSync(tempPath, configPath);
}

function statCard(value: number, label: string, tone: string, cardIcon: string, delay = ''): string {
    return `<div class="stat-card ${tone} reveal ${delay}">
      <div class="stat-top"><div class="stat-icon">${cardIcon}</div></div>
      <div class="stat-value">${value}</div><div class="stat-label">${label}</div>
    </div>`;
}

function emptyState(title: string, hint: string, code = ''): string {
    return `<div class="empty-state"><div><div class="empty-icon">${icon('inbox')}</div>
      <h3>${title}</h3><p>${hint}</p>${code ? `<code>${code}</code>` : ''}</div></div>`;
}

function formatInterval(milliseconds: number, locale: Locale): string {
    const formatter = new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'zh-CN', {
        maximumFractionDigits: 1,
    });
    if (milliseconds < 60_000) {
        return t(locale, 'schedule.seconds', { count: formatter.format(milliseconds / 1_000) });
    }
    if (milliseconds < 3_600_000) {
        return t(locale, 'schedule.minutes', { count: formatter.format(milliseconds / 60_000) });
    }
    if (milliseconds < 86_400_000) {
        return t(locale, 'schedule.hours', { count: formatter.format(milliseconds / 3_600_000) });
    }
    return t(locale, 'schedule.days', { count: formatter.format(milliseconds / 86_400_000) });
}

function pagination(locale: Locale, basePath: string, page: number, pages: number, total: number, suffix = ''): string {
    const previous = page > 1
        ? `<a class="btn" href="${basePath}?page=${page - 1}${suffix}">${icon('chevronLeft')}${t(locale, 'pagination.previous')}</a>`
        : '';
    const next = page < pages
        ? `<a class="btn" href="${basePath}?page=${page + 1}${suffix}">${t(locale, 'pagination.next')}${icon('chevronRight')}</a>`
        : '';
    return `<div class="pagination">${previous}<span class="summary">${t(locale, 'pagination.summary', { page, pages, total })}</span>${next}</div>`;
}

app.get('/', async (c) => {
    const locale = resolveLocale(c);
    const page = parsePositiveInteger(c.req.query('page') || '1');
    if (page === null) return c.text('invalid page', 400);
    const statusFilter = c.req.query('status') || '';
    const parsedStatus = statusFilter ? parseTaskStatus(statusFilter) : null;
    if (statusFilter && !parsedStatus) return c.text('invalid status', 400);
    const limit = 50;
    const offset = (page - 1) * limit;

    const [tasks, statsData] = await Promise.all([
        TaskService.list({ limit, offset, ...(parsedStatus ? { status: parsedStatus } : {}) }),
        TaskService.stats({}),
    ]);
    const latestRuns = await TaskRunService.getLatestByTaskIds(tasks.map((task) => task.id));
    const counts = {
        pending: statsData.pending || 0,
        running: statsData.running || 0,
        done: statsData.done || 0,
        failed: (statsData.failed || 0) + (statsData.dead_letter || 0),
        total: statsData.total || 0,
    };
    const filteredTotal = parsedStatus ? Number(statsData[parsedStatus] ?? 0) : counts.total;
    const totalPages = Math.max(1, Math.ceil(filteredTotal / limit));

    const filterItems: Array<{ status: '' | TaskStatus; label: string }> = [
        { status: '', label: t(locale, 'filter.all') },
        { status: 'pending', label: statusText(locale, 'pending') },
        { status: 'running', label: statusText(locale, 'running') },
        { status: 'done', label: statusText(locale, 'done') },
        { status: 'failed', label: statusText(locale, 'failed') },
        { status: 'dead_letter', label: statusText(locale, 'dead_letter') },
        { status: 'cancelled', label: statusText(locale, 'cancelled') },
    ];
    const filters = filterItems.map(({ status, label }) => {
        const href = status ? `/?status=${status}` : '/';
        return `<a href="${href}" class="filter-chip ${statusFilter === status ? 'active' : ''}">${label}</a>`;
    }).join('');

    const rows = tasks.map((task) => {
        const status = safeStatus(task.status);
        const executionActive = latestRuns.get(task.id)?.status === 'running';
        const searchable = esc(`${task.name} ${task.agent} ${task.prompt}`);
        return `<tr data-task-row data-search="${searchable}">
          <td class="faint" data-label="${t(locale, 'table.id')}">#${task.id}</td>
          <td data-primary data-label="${t(locale, 'table.task')}"><div class="task-name">${esc(task.name)}</div><div class="task-prompt" title="${esc(task.prompt)}">${esc(task.prompt.substring(0, 160))}</div></td>
          <td data-label="${t(locale, 'table.agent')}"><span class="tag">${esc(task.agent)}</span></td>
          <td data-label="${t(locale, 'table.status')}"><span class="badge b-${status}">${statusText(locale, status)}</span></td>
          <td data-label="${t(locale, 'table.duration')}" class="small ${task.status === 'running' ? '' : 'muted'}">${formatDuration(task.startedAt, task.finishedAt)}</td>
          <td data-label="${t(locale, 'table.retries')}" class="muted small">${(task.retryCount ?? 0) > 0 ? task.retryCount : '—'}</td>
          <td data-label="${t(locale, 'table.actions')}"><div class="actions">
            <button type="button" class="btn" onclick="showDetail(${task.id})">${t(locale, 'action.details')}</button>
            ${task.status === 'failed' || task.status === 'dead_letter' ? `<button type="button" class="btn btn-warning" onclick="retryTask(${task.id})">${t(locale, 'action.retry')}</button>` : ''}
            ${['pending', 'running', 'failed'].includes(task.status ?? '') ? `<button type="button" class="btn btn-warning" onclick="cancelTask(${task.id})">${t(locale, 'action.cancel')}</button>` : ''}
            ${task.status === 'running' || executionActive ? '' : `<button type="button" class="btn btn-danger" onclick="deleteTask(${task.id})">${t(locale, 'action.delete')}</button>`}
          </div></td>
        </tr>`;
    }).join('');

    const table = tasks.length === 0
        ? emptyState(t(locale, 'empty.tasks'), t(locale, 'empty.tasksHint'))
        : `<div class="table-wrap"><table class="responsive-table">
            <thead><tr><th>ID</th><th>${t(locale, 'table.task')}</th><th>${t(locale, 'table.agent')}</th><th>${t(locale, 'table.status')}</th><th>${t(locale, 'table.duration')}</th><th>${t(locale, 'table.retries')}</th><th>${t(locale, 'table.actions')}</th></tr></thead>
            <tbody>${rows}</tbody>
          </table></div>
          <div id="search-empty" hidden>${emptyState(t(locale, 'filter.noResults'), '')}</div>`;
    const suffix = statusFilter ? `&status=${statusFilter}` : '';
    const body = `
      <div class="stats-grid">
        ${statCard(counts.pending, t(locale, 'stats.pending'), 'tone-neutral', icon('clock'))}
        ${statCard(counts.running, t(locale, 'stats.running'), 'tone-blue', icon('activity'), 'reveal-delay-1')}
        ${statCard(counts.done, t(locale, 'stats.done'), 'tone-green', icon('check'), 'reveal-delay-1')}
        ${statCard(counts.failed, t(locale, 'stats.failedDead'), 'tone-red', icon('alert'), 'reveal-delay-2')}
      </div>
      <div class="toolbar reveal reveal-delay-1">
        <div class="filters">${filters}</div>
        <label class="search-box">${icon('search')}<input type="search" oninput="filterTasks(this.value)" placeholder="${t(locale, 'filter.searchTasks')}" aria-label="${t(locale, 'filter.searchTasks')}"></label>
      </div>
      <section class="panel reveal reveal-delay-2">${table}</section>
      ${pagination(locale, '/', page, totalPages, filteredTotal, suffix)}`;

    return c.html(renderLayout({ locale, activeTab: 'tasks', body }));
});

app.get('/templates', async (c) => {
    const locale = resolveLocale(c);
    const templates = await TaskTemplateService.list(100);
    const enabled = templates.filter((template) => template.enabled).length;
    const disabled = templates.length - enabled;

    const rows = templates.map((template) => {
        const scheduleType = ['cron', 'recurring', 'delayed'].includes(template.scheduleType)
            ? template.scheduleType as 'cron' | 'recurring' | 'delayed'
            : 'unknown';
        const typeLabel = scheduleType === 'cron' ? t(locale, 'schedule.cron')
            : scheduleType === 'recurring' ? t(locale, 'schedule.recurring')
            : scheduleType === 'delayed' ? t(locale, 'schedule.delayed')
            : t(locale, 'schedule.unknown');
        let rule = '—';
        if (template.scheduleType === 'cron') rule = template.cronExpr || '—';
        if (template.scheduleType === 'recurring' && template.intervalMs) rule = formatInterval(template.intervalMs, locale);
        if (template.scheduleType === 'delayed') rule = formatDateTime(template.runAt, locale);
        const toggle = template.enabled
            ? `<button type="button" class="btn btn-warning" onclick="disableTmpl(${template.id})">${t(locale, 'action.disable')}</button>`
            : `<button type="button" class="btn" onclick="enableTmpl(${template.id})">${t(locale, 'action.enable')}</button>`;
        return `<tr>
          <td class="faint" data-label="${t(locale, 'table.id')}">#${template.id}</td>
          <td data-primary data-label="${t(locale, 'table.name')}"><div class="task-name">${esc(template.name)}</div><div class="task-prompt" title="${esc(template.prompt)}">${esc(template.prompt.substring(0, 140))}</div>
            <div class="actions" style="margin-top:5px"><span class="tag">${esc(template.agent)}</span>${template.model && template.model !== 'default' ? `<span class="tag">${esc(template.model)}</span>` : ''}</div></td>
          <td data-label="${t(locale, 'table.type')}"><span class="tag t-${scheduleType}">${typeLabel}</span></td>
          <td data-label="${t(locale, 'table.rule')}" class="m small">${esc(rule)}</td>
          <td data-label="${t(locale, 'table.status')}"><span class="badge ${template.enabled ? 'b-done' : 'b-cancelled'}">${t(locale, template.enabled ? 'schedule.enabled' : 'schedule.disabled')}</span></td>
          <td data-label="${t(locale, 'table.lastRun')}" class="small muted">${formatRelative(template.lastRunAt, locale)}</td>
          <td data-label="${t(locale, 'table.nextRun')}" class="small">${formatFuture(template.nextRunAt, locale)}</td>
          <td data-label="${t(locale, 'table.actions')}"><div class="actions"><button type="button" class="btn" onclick="showTemplateDetail(${template.id})">${t(locale, 'action.details')}</button>
            <button type="button" class="btn btn-primary" onclick="triggerTmpl(${template.id})">${t(locale, 'action.trigger')}</button>${toggle}
            <button type="button" class="btn btn-danger" onclick="deleteTmpl(${template.id})">${t(locale, 'action.delete')}</button></div></td>
        </tr>`;
    }).join('');

    const body = `
      <div class="stats-grid three">
        ${statCard(templates.length, t(locale, 'stats.templates'), 'tone-purple', icon('templates'))}
        ${statCard(enabled, t(locale, 'stats.enabled'), 'tone-green', icon('check'), 'reveal-delay-1')}
        ${statCard(disabled, t(locale, 'stats.disabled'), 'tone-neutral', icon('clock'), 'reveal-delay-2')}
      </div>
      <section class="panel reveal reveal-delay-2">
        <div class="panel-head"><h2>${t(locale, 'page.templates.title')}</h2></div>
        ${templates.length === 0
            ? emptyState(t(locale, 'empty.templates'), t(locale, 'empty.templatesHint'), 'supertask template add')
            : `<div class="table-wrap"><table class="responsive-table"><thead><tr><th>ID</th><th>${t(locale, 'table.name')}</th><th>${t(locale, 'table.type')}</th><th>${t(locale, 'table.rule')}</th><th>${t(locale, 'table.status')}</th><th>${t(locale, 'table.lastRun')}</th><th>${t(locale, 'table.nextRun')}</th><th>${t(locale, 'table.actions')}</th></tr></thead><tbody>${rows}</tbody></table></div>`}
      </section>`;

    return c.html(renderLayout({ locale, activeTab: 'templates', body }));
});

app.get('/runs', async (c) => {
    const locale = resolveLocale(c);
    const page = parsePositiveInteger(c.req.query('page') || '1');
    if (page === null) return c.text('invalid page', 400);
    const limit = 50;
    const offset = (page - 1) * limit;
    const { taskRuns, tasks } = schema;
    const runs = await db.select({
        id: taskRuns.id, taskId: taskRuns.taskId, sessionId: taskRuns.sessionId,
        model: taskRuns.model, status: taskRuns.status, startedAt: taskRuns.startedAt,
        finishedAt: taskRuns.finishedAt, log: taskRuns.log, heartbeatAt: taskRuns.heartbeatAt,
        workerPid: taskRuns.workerPid, childPid: taskRuns.childPid,
        taskName: tasks.name, taskAgent: tasks.agent,
    }).from(taskRuns).innerJoin(tasks, eq(taskRuns.taskId, tasks.id))
        .orderBy(desc(taskRuns.startedAt), desc(taskRuns.id)).limit(limit).offset(offset);
    const totalResult = await db.select({ count: sql<number>`count(*)` }).from(taskRuns);
    const total = Number(totalResult[0]?.count ?? 0);
    const totalPages = Math.max(1, Math.ceil(total / limit));

    const logs: string[] = [];
    const rows = runs.map((run) => {
        const status = safeStatus(run.status);
        if (run.log) {
            logs.push(`<section id="log-${run.id}" class="panel log-panel" hidden><div class="panel-head"><h3>Run #${run.id} · ${esc(run.taskName)}</h3></div><div class="log-box">${esc(run.log)}</div></section>`);
        }
        return `<tr>
          <td class="faint" data-label="${t(locale, 'table.run')}">#${run.id}</td>
          <td data-primary data-label="${t(locale, 'table.task')}"><div class="task-name">${esc(run.taskName)} <span class="faint">#${run.taskId}</span></div>${run.model ? `<div style="margin-top:4px"><span class="tag">${esc(run.model)}</span></div>` : ''}</td>
          <td data-label="${t(locale, 'table.agent')}"><span class="tag">${esc(run.taskAgent)}</span></td>
          <td data-label="${t(locale, 'table.status')}"><span class="badge b-${status}">${statusText(locale, status)}</span></td>
          <td data-label="${t(locale, 'table.duration')}" class="small">${formatDuration(run.startedAt, run.finishedAt)}</td>
          <td data-label="${t(locale, 'table.heartbeat')}" class="small muted">${formatRelative(run.heartbeatAt, locale)}</td>
          <td data-label="${t(locale, 'table.actions')}"><div class="actions"><button type="button" class="btn" onclick="showRunDetail(${run.id})">${t(locale, 'action.details')}</button>
            ${run.log ? `<button type="button" class="btn" aria-expanded="false" onclick="toggleLog(${run.id},this)">${t(locale, 'action.logs')}</button>` : ''}</div></td>
        </tr>`;
    }).join('');

    const body = `
      <div class="stats-grid">
        ${statCard(total, t(locale, 'stats.records'), 'tone-purple', icon('runs'))}
        ${statCard(runs.filter((run) => run.status === 'done').length, t(locale, 'stats.pageDone'), 'tone-green', icon('check'), 'reveal-delay-1')}
        ${statCard(runs.filter((run) => run.status === 'failed').length, t(locale, 'stats.pageFailed'), 'tone-red', icon('alert'), 'reveal-delay-1')}
        ${statCard(runs.filter((run) => run.status === 'running').length, t(locale, 'stats.pageRunning'), 'tone-blue', icon('activity'), 'reveal-delay-2')}
      </div>
      <section class="panel reveal reveal-delay-2">${runs.length === 0
          ? emptyState(t(locale, 'empty.runs'), '')
          : `<div class="table-wrap"><table class="responsive-table"><thead><tr><th>${t(locale, 'table.run')}</th><th>${t(locale, 'table.task')}</th><th>${t(locale, 'table.agent')}</th><th>${t(locale, 'table.status')}</th><th>${t(locale, 'table.duration')}</th><th>${t(locale, 'table.heartbeat')}</th><th>${t(locale, 'table.actions')}</th></tr></thead><tbody>${rows}</tbody></table></div>`}</section>
      ${logs.join('')}${pagination(locale, '/runs', page, totalPages, total)}`;

    return c.html(renderLayout({ locale, activeTab: 'runs', body }));
});

app.get('/system', async (c) => {
    const locale = resolveLocale(c);
    const config = loadConfig();
    const configPath = getConfigPath();
    const [stats, runningRuns, templates] = await Promise.all([
        TaskService.stats({}), TaskRunService.getAllRunningRuns(), TaskTemplateService.list(100),
    ]);
    const configExists = existsSync(configPath);
    const runRows = runningRuns.map((run) => {
        const session = run.sessionId ? `${run.sessionId.slice(4, 7)}***${run.sessionId.slice(-3)}` : '—';
        return `<tr><td class="faint" data-label="${t(locale, 'table.run')}">#${run.id}</td><td data-primary data-label="${t(locale, 'table.task')}">#${run.taskId}</td><td data-label="${t(locale, 'table.session')}" class="m small">${esc(session)}</td>
          <td data-label="${t(locale, 'table.model')}" class="small">${esc(run.model) || '—'}</td><td data-label="${t(locale, 'table.startedAt')}" class="small">${formatDateTime(run.startedAt, locale)}</td>
          <td data-label="${t(locale, 'table.heartbeat')}" class="small muted">${formatRelative(run.heartbeatAt, locale)}</td><td data-label="${t(locale, 'table.pid')}" class="m small">W:${run.workerPid ?? '—'} C:${run.childPid ?? '—'}</td>
          <td data-label="${t(locale, 'table.duration')}" class="small">${formatDuration(run.startedAt, null)}</td></tr>`;
    }).join('');

    const unitInput = (name: string, value: number, min: number, unit: string, max?: number) =>
        `<div class="input-unit"><input id="${name}" type="number" name="${name}" value="${value}" min="${min}" ${max ? `max="${max}"` : ''}><span>${unit}</span></div>`;
    const body = `
      <form id="config-form" onsubmit="event.preventDefault();saveConfig()">
        <div class="settings-grid reveal">
          <section class="card settings-card"><h2 class="settings-title"><span>${icon('activity')}${t(locale, 'system.worker')}</span></h2>
            <div class="field"><label for="mc">${t(locale, 'system.maxConcurrency')}</label>${unitInput('mc', config.worker.maxConcurrency, 1, '×', 20)}</div>
            <div class="field"><label for="pi">${t(locale, 'system.pollInterval')}</label>${unitInput('pi', config.worker.pollIntervalMs, 100, t(locale, 'system.milliseconds'))}</div>
            <div class="field"><label for="hi">${t(locale, 'system.heartbeatInterval')}</label>${unitInput('hi', config.worker.heartbeatIntervalMs / 1000, 5, t(locale, 'system.seconds'))}</div>
            <div class="field"><label for="to">${t(locale, 'system.taskTimeout')}</label>${unitInput('to', config.worker.taskTimeoutMs / 60_000, 1, t(locale, 'system.minutes'))}</div>
          </section>
          <section class="card settings-card reveal-delay-1"><h2 class="settings-title"><span>${icon('templates')}${t(locale, 'system.scheduler')}</span><span class="badge ${config.scheduler.enabled ? 'b-done' : 'b-cancelled'}">${t(locale, config.scheduler.enabled ? 'schedule.enabled' : 'schedule.disabled')}</span></h2>
            <div class="switch-field"><label for="se">${t(locale, 'system.schedulerEnabled')}</label><label class="switch"><input id="se" type="checkbox" name="se" ${config.scheduler.enabled ? 'checked' : ''}><span></span></label></div>
            <div class="field"><label for="si">${t(locale, 'system.checkInterval')}</label>${unitInput('si', config.scheduler.checkIntervalMs, 100, t(locale, 'system.milliseconds'))}</div>
            <div class="info-row"><span class="info-key">${t(locale, 'system.activeTemplates')}</span><span class="info-value">${templates.filter((template) => template.enabled).length} / ${templates.length}</span></div>
          </section>
          <section class="card settings-card reveal-delay-2"><h2 class="settings-title"><span>${icon('system')}${t(locale, 'system.watchdog')}</span></h2>
            <div class="field"><label for="wt">${t(locale, 'system.heartbeatTimeout')}</label>${unitInput('wt', config.watchdog.heartbeatTimeoutMs / 1000, 10, t(locale, 'system.seconds'))}</div>
            <div class="field"><label for="wci">${t(locale, 'system.checkInterval')}</label>${unitInput('wci', config.watchdog.checkIntervalMs / 1000, 1, t(locale, 'system.seconds'))}</div>
            <div class="field"><label for="wcl">${t(locale, 'system.cleanupInterval')}</label>${unitInput('wcl', config.watchdog.cleanupIntervalMs / 3_600_000, 1, t(locale, 'system.hours'))}</div>
            <div class="field"><label for="rd">${t(locale, 'system.retentionDays')}</label>${unitInput('rd', config.watchdog.retentionDays, 1, t(locale, 'system.days'))}</div>
          </section>
        </div>
        <div class="save-row"><span class="muted small">${t(locale, 'system.saveHint')}</span><button type="submit" class="btn btn-primary">${t(locale, 'action.save')}</button></div>
      </form>
      <section class="panel reveal">
        <div class="panel-head"><h2>${t(locale, 'system.runningTasks', { running: runningRuns.length, limit: config.worker.maxConcurrency })}</h2></div>
        ${runningRuns.length === 0 ? emptyState(t(locale, 'empty.running'), '') : `<div class="table-wrap"><table class="responsive-table"><thead><tr><th>${t(locale, 'table.run')}</th><th>${t(locale, 'table.task')}</th><th>${t(locale, 'table.session')}</th><th>${t(locale, 'table.model')}</th><th>${t(locale, 'table.startedAt')}</th><th>${t(locale, 'table.heartbeat')}</th><th>${t(locale, 'table.pid')}</th><th>${t(locale, 'table.duration')}</th></tr></thead><tbody>${runRows}</tbody></table></div>`}
      </section>
      <section class="panel reveal reveal-delay-1"><div class="panel-head"><h2>${t(locale, 'system.taskStats')}</h2></div><div class="overview-grid">
        <div class="overview-item"><span>${statusText(locale, 'pending')}</span><strong>${stats.pending || 0}</strong></div>
        <div class="overview-item"><span>${statusText(locale, 'running')}</span><strong style="color:var(--blue)">${stats.running || 0}</strong></div>
        <div class="overview-item"><span>${statusText(locale, 'done')}</span><strong style="color:var(--green)">${stats.done || 0}</strong></div>
        <div class="overview-item"><span>${t(locale, 'stats.failedDead')}</span><strong style="color:var(--red)">${(stats.failed || 0) + (stats.dead_letter || 0)}</strong></div>
      </div></section>
      <section class="panel reveal reveal-delay-1"><div class="panel-head"><h2>${t(locale, 'system.configFile')}</h2></div><div class="info-list">
        <div class="info-row"><span class="info-key">${t(locale, 'system.path')}</span><span class="info-value m small">${esc(configPath)}</span></div>
        <div class="info-row"><span class="info-key">${t(locale, 'system.fileExists')}</span><span class="badge ${configExists ? 'b-done' : 'b-cancelled'}">${t(locale, configExists ? 'system.yes' : 'system.noDefault')}</span></div>
      </div></section>
      <section class="card danger-card reveal reveal-delay-2"><h2>${icon('alert')}${t(locale, 'system.danger')}</h2><p>${t(locale, 'system.dangerDescription')}</p>
        <button type="button" class="btn btn-danger" onclick="clearDatabase()">${icon('database')}${t(locale, 'action.clearDatabase')}</button></section>`;

    return c.html(renderLayout({ locale, activeTab: 'system', body }));
});

app.get('/api/tasks/:id', async (c) => {
    const id = parsePositiveInteger(c.req.param('id'));
    if (id === null) return c.json({ error: 'invalid id' }, 400);
    const task = await TaskService.getById(id);
    if (!task) return c.json({ error: 'not found' }, 404);
    const runs = await TaskRunService.listByTaskId(id);
    return c.json({ ...task, _runs: runs });
});

app.get('/api/runs/:id', async (c) => {
    const id = parsePositiveInteger(c.req.param('id'));
    if (id === null) return c.json({ error: 'invalid id' }, 400);
    const run = await TaskRunService.getById(id);
    if (!run) return c.json({ error: 'not found' }, 404);
    return c.json(run);
});

app.get('/api/templates/:id', async (c) => {
    const id = parsePositiveInteger(c.req.param('id'));
    if (id === null) return c.json({ error: 'invalid id' }, 400);
    const template = await TaskTemplateService.getById(id);
    if (!template) return c.json({ error: 'not found' }, 404);
    return c.json(template);
});

app.post('/api/tasks/:id/retry', async (c) => {
    const id = parsePositiveInteger(c.req.param('id'));
    if (id === null) return c.json({ error: 'invalid id' }, 400);
    const task = await TaskService.retry(id);
    if (task) return c.json({ success: true });
    return await TaskService.getById(id)
        ? c.json({ error: 'task status does not allow retry' }, 409)
        : c.json({ error: 'not found' }, 404);
});

app.post('/api/tasks/:id/cancel', async (c) => {
    const id = parsePositiveInteger(c.req.param('id'));
    if (id === null) return c.json({ error: 'invalid id' }, 400);
    const task = await TaskService.cancel(id);
    if (task) return c.json({ success: true });
    return await TaskService.getById(id)
        ? c.json({ error: 'task status does not allow cancellation' }, 409)
        : c.json({ error: 'not found' }, 404);
});

app.delete('/api/tasks/:id', async (c) => {
    const id = parsePositiveInteger(c.req.param('id'));
    if (id === null) return c.json({ error: 'invalid id' }, 400);
    try {
        const deleted = await TaskService.delete(id);
        return deleted ? c.json({ success: true }) : c.json({ error: 'not found' }, 404);
    } catch (error) {
        if (error instanceof TaskDeletionConflictError) {
            return c.json({ error: error.message }, 409);
        }
        throw error;
    }
});

app.post('/api/templates/:id/enable', async (c) => {
    const id = parsePositiveInteger(c.req.param('id'));
    if (id === null) return c.json({ error: 'invalid id' }, 400);
    const result = await TaskTemplateService.enable(id);
    return result ? c.json({ success: true }) : c.json({ error: 'not found' }, 404);
});

app.post('/api/templates/:id/disable', async (c) => {
    const id = parsePositiveInteger(c.req.param('id'));
    if (id === null) return c.json({ error: 'invalid id' }, 400);
    const result = await TaskTemplateService.disable(id);
    return result ? c.json({ success: true }) : c.json({ error: 'not found' }, 404);
});

app.delete('/api/templates/:id', async (c) => {
    const id = parsePositiveInteger(c.req.param('id'));
    if (id === null) return c.json({ error: 'invalid id' }, 400);
    const deleted = await TaskTemplateService.delete(id);
    return deleted ? c.json({ success: true }) : c.json({ error: 'not found' }, 404);
});

app.post('/api/templates/:id/trigger', async (c) => {
    const id = parsePositiveInteger(c.req.param('id'));
    if (id === null) return c.json({ error: 'invalid id' }, 400);
    const template = await TaskTemplateService.getById(id);
    if (!template) return c.json({ error: 'not found' }, 404);
    const task = await triggerTaskFromTemplate(id);
    if (!task) return c.json({ error: 'maxInstances reached' }, 409);
    return c.json({ success: true, taskId: task.id });
});

app.put('/api/config', async (c) => {
    try {
        const body = (await c.req.json()) as Record<string, unknown>;
        const current = readCurrentConfig();
        const currentWorker = (current.worker ?? {}) as Record<string, unknown>;
        const currentScheduler = (current.scheduler ?? {}) as Record<string, unknown>;
        const currentWatchdog = (current.watchdog ?? {}) as Record<string, unknown>;
        const bodyWorker = (body.worker ?? {}) as Record<string, unknown>;
        const bodyScheduler = (body.scheduler ?? {}) as Record<string, unknown>;
        const bodyWatchdog = (body.watchdog ?? {}) as Record<string, unknown>;
        const merged = {
            ...current,
            ...body,
            configVersion: 2,
            worker: { ...currentWorker, ...bodyWorker },
            scheduler: { ...currentScheduler, ...bodyScheduler },
            watchdog: { ...currentWatchdog, ...bodyWatchdog },
        };
        writeConfig(validateConfig(merged));
        return c.json({ success: true });
    } catch (error) {
        return c.json({
            success: false,
            error: error instanceof Error ? error.message : String(error),
        }, 400);
    }
});

app.post('/api/database/clear', async (c) => {
    const body = await c.req.json<{ confirmation?: string }>()
        .catch((): { confirmation?: string } => ({}));
    if (body.confirmation !== 'CLEAR') {
        return c.json({ success: false, error: 'confirmation must be CLEAR' }, 400);
    }
    try {
        const result = DatabaseMaintenanceService.clear({ allowCurrentGateway: true });
        return c.json({ success: true, ...result });
    } catch (error) {
        const status = error instanceof DatabaseMaintenanceConflictError ? 409 : 500;
        return c.json({
            success: false,
            error: error instanceof Error ? error.message : String(error),
        }, status);
    }
});

export const dashboardApp = app;

export default {
    hostname: '127.0.0.1',
    port: 4680,
    fetch: app.fetch,
};
