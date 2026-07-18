import { Hono, type Context } from 'hono';
import { desc, eq, sql } from 'drizzle-orm';
import {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    statSync,
    writeFileSync,
} from 'fs';
import { homedir } from 'os';
import { basename, dirname, join } from 'path';
import { db, schema } from '@core/db';
import type { NewTask, TaskStatus } from '@core/db/schema';
import { parseDuration } from '@core/duration';
import { loadOpenCodeCatalog } from '@core/opencode-catalog';
import { validateTaskWorkingDirectory } from '@core/task-working-directory';
import {
    DatabaseMaintenanceConflictError,
    DatabaseMaintenanceService,
} from '@core/services/database-maintenance.service';
import { TaskRunService } from '@core/services/task-run.service';
import {
    TaskDeletionConflictError,
    TaskService,
    type EditableTaskUpdate,
} from '@core/services/task.service';
import {
    TaskTemplateService,
    type TaskTemplateUpdate,
} from '@core/services/task-template.service';
import { getConfigPath, loadConfig, validateConfig, type GatewayConfig } from '@gateway/config';
import { getGatewayHealth } from '@gateway/health';
import { triggerTaskFromTemplate } from '@gateway/scheduler/job-templates';
import { getGatewayDiagnostic, type GatewayDiagnostic } from '../daemon/pm2';
import {
    formatDateTime,
    formatFuture,
    formatRelative,
    icon,
    renderLayout,
    runStatusText,
    statusText,
    t,
    type Locale,
} from './ui';

const app = new Hono();
const LEGACY_PROJECT_FILTER = '__supertask_legacy__';
const TASK_STATUSES = new Set<TaskStatus>([
    'pending', 'running', 'done', 'failed', 'dead_letter', 'cancelled',
]);
const SESSION_ID_PATTERN = /^ses_[A-Za-z0-9_]+$/;
let runtimeConfig: GatewayConfig | null = null;
let restartScheduled = false;

export function setDashboardRuntimeConfig(config: GatewayConfig | null): void {
    runtimeConfig = config === null ? null : structuredClone(config);
}

function isValidSessionId(value: string | null | undefined): value is string {
    return typeof value === 'string' && SESSION_ID_PATTERN.test(value);
}

function maskSessionId(value: string | null | undefined): string {
    return isValidSessionId(value) ? `${value.slice(4, 7)}***${value.slice(-3)}` : '—';
}

function sessionCommand(value: string): string {
    if (!isValidSessionId(value)) throw new Error('session unavailable');
    return `opencode --session ${value}`;
}

function configsEqual(left: GatewayConfig, right: GatewayConfig): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

export function resolveDashboardConfigState(
    runtimeAvailable: boolean,
    restartRequired: boolean,
    managedRestart: boolean,
): 'foreground' | 'applied' | 'pending' | 'manual' {
    if (!runtimeAvailable) return 'foreground';
    if (!restartRequired) return 'applied';
    return managedRestart ? 'pending' : 'manual';
}

export function isSafeDashboardRestartTarget(
    diagnostic: GatewayDiagnostic,
    currentPid: number,
): boolean {
    return diagnostic.pm2Installed
        && diagnostic.processFound
        && diagnostic.status === 'online'
        && diagnostic.pid === currentPid
        && diagnostic.ready
        && diagnostic.scopeMatches;
}

function canRestartCurrentGateway(): boolean {
    if (runtimeConfig === null) return false;
    try {
        return isSafeDashboardRestartTarget(getGatewayDiagnostic(), process.pid);
    } catch {
        return false;
    }
}

function parsePositiveInteger(value: string): number | null {
    if (!/^\d+$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseTaskStatus(value: string): TaskStatus | null {
    return TASK_STATUSES.has(value as TaskStatus) ? value as TaskStatus : null;
}

function listChildDirectories(path: string): Array<{ name: string; path: string; hidden: boolean }> {
    return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
        const entryPath = join(path, entry.name);
        if (entry.isDirectory()) return [{ name: entry.name, path: entryPath, hidden: entry.name.startsWith('.') }];
        if (!entry.isSymbolicLink()) return [];
        try {
            return statSync(entryPath).isDirectory()
                ? [{ name: entry.name, path: entryPath, hidden: entry.name.startsWith('.') }]
                : [];
        } catch {
            return [];
        }
    }).sort((left, right) => {
        const leftHidden = left.name.startsWith('.');
        const rightHidden = right.name.startsWith('.');
        if (leftHidden !== rightHidden) return leftHidden ? 1 : -1;
        return left.name.localeCompare(right.name);
    });
}

function parseTaskPayload(value: unknown): NewTask {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('请求内容必须是对象');
    }
    const input = value as Record<string, unknown>;
    const requiredString = (name: string): string => {
        const field = input[name];
        if (typeof field !== 'string' || !field.trim()) throw new Error(`${name} 不能为空`);
        return field.trim();
    };
    const optionalString = (name: string, fallback: string | null = null): string | null => {
        const field = input[name];
        if (field === undefined || field === null || field === '') return fallback;
        if (typeof field !== 'string') throw new Error(`${name} 必须是字符串`);
        return field.trim() || fallback;
    };
    const integer = (name: string, fallback: number | null): number | null => {
        const field = input[name];
        if (field === undefined || field === null || field === '') return fallback;
        if (typeof field !== 'number' || !Number.isSafeInteger(field)) {
            throw new Error(`${name} 必须是整数`);
        }
        return field;
    };
    const duration = (name: string, fallback: string | null, allowZero = false): number | null => {
        const raw = optionalString(name, fallback);
        if (raw === null) return null;
        if (allowZero && raw === '0') return 0;
        if (Number.isFinite(Number(raw))) {
            throw new Error(`${name} 必须带时间单位，请使用 30s、5min、1h 或 2d`);
        }
        const milliseconds = parseDuration(raw);
        if (milliseconds === null || !Number.isSafeInteger(milliseconds)) {
            throw new Error(`${name} 格式无效，请使用 30s、5min、1h 或 2d`);
        }
        return milliseconds;
    };

    return {
        name: requiredString('name'),
        cwd: requiredString('cwd'),
        agent: requiredString('agent'),
        model: optionalString('model', 'default'),
        prompt: requiredString('prompt'),
        category: optionalString('category', 'general'),
        batchId: optionalString('batchId'),
        importance: integer('importance', 3),
        urgency: integer('urgency', 3),
        maxRetries: integer('maxRetries', 3),
        retryBackoffMs: duration('retryBackoff', '30s', true),
        timeoutMs: duration('timeout', null),
    };
}

function editableTaskPayload(input: NewTask): EditableTaskUpdate {
    return {
        name: input.name,
        agent: input.agent,
        model: input.model ?? 'default',
        prompt: input.prompt,
        category: input.category ?? 'general',
        batchId: input.batchId ?? null,
        importance: input.importance ?? 3,
        urgency: input.urgency ?? 3,
        maxRetries: input.maxRetries ?? 3,
        retryBackoffMs: input.retryBackoffMs ?? 30_000,
        timeoutMs: input.timeoutMs ?? null,
    };
}

function parseTemplatePayload(value: unknown): TaskTemplateUpdate {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('请求内容必须是对象');
    }
    const input = value as Record<string, unknown>;
    const requiredString = (name: string): string => {
        const field = input[name];
        if (typeof field !== 'string' || !field.trim()) throw new Error(`${name} 不能为空`);
        return field.trim();
    };
    const optionalString = (name: string, fallback: string | null = null): string | null => {
        const field = input[name];
        if (field === undefined || field === null || field === '') return fallback;
        if (typeof field !== 'string') throw new Error(`${name} 必须是字符串`);
        return field.trim() || fallback;
    };
    const integer = (name: string, fallback: number | null): number | null => {
        const field = input[name];
        if (field === undefined || field === null || field === '') return fallback;
        if (typeof field !== 'number' || !Number.isSafeInteger(field)) {
            throw new Error(`${name} 必须是整数`);
        }
        return field;
    };
    const duration = (name: string, fallback: string | null, allowZero = false): number | null => {
        const raw = optionalString(name, fallback);
        if (raw === null) return null;
        if (allowZero && raw === '0') return 0;
        if (Number.isFinite(Number(raw))) {
            throw new Error(`${name} 必须带时间单位，请使用 30s、5min、1h 或 2d`);
        }
        const milliseconds = parseDuration(raw);
        if (milliseconds === null || !Number.isSafeInteger(milliseconds)) {
            throw new Error(`${name} 格式无效，请使用 30s、5min、1h 或 2d`);
        }
        return milliseconds;
    };

    const scheduleType = requiredString('scheduleType');
    if (!['cron', 'delayed', 'recurring'].includes(scheduleType)) {
        throw new Error('scheduleType 必须是 cron、delayed 或 recurring');
    }

    return {
        name: requiredString('name'),
        agent: requiredString('agent'),
        model: optionalString('model', 'default'),
        prompt: requiredString('prompt'),
        cwd: requiredString('cwd'),
        category: optionalString('category', 'general'),
        importance: integer('importance', 3),
        urgency: integer('urgency', 3),
        batchId: optionalString('batchId'),
        scheduleType,
        cronExpr: scheduleType === 'cron' ? requiredString('cronExpr') : null,
        intervalMs: scheduleType === 'recurring' ? duration('interval', null) : null,
        runAt: scheduleType === 'delayed' ? integer('runAt', null) : null,
        maxInstances: integer('maxInstances', 1),
        maxRetries: integer('maxRetries', 3),
        retryBackoffMs: duration('retryBackoff', '30s', true),
        timeoutMs: duration('timeout', null),
    };
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

app.get('/api/filesystem/directories', (c) => {
    const requestedPath = c.req.query('path')?.trim() || homedir();
    try {
        validateTaskWorkingDirectory(requestedPath);
        return c.json({
            path: requestedPath,
            parent: dirname(requestedPath),
            home: homedir(),
            directories: listChildDirectories(requestedPath),
        });
    } catch (error) {
        return c.json({
            error: error instanceof Error ? error.message : String(error),
        }, 400);
    }
});

app.get('/api/opencode/catalog', async (c) => {
    const cwd = c.req.query('cwd')?.trim();
    if (!cwd) return c.json({ error: 'cwd 不能为空' }, 400);
    try {
        return c.json(await loadOpenCodeCatalog(cwd));
    } catch (error) {
        return c.json({
            error: error instanceof Error ? error.message : String(error),
        }, 400);
    }
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

interface RunCommandPresentation {
    cwd: string;
    command: string;
}

interface RunLogPresentation {
    command: RunCommandPresentation | null;
    text: string;
    errors: string[];
    tools: string[];
}

function recordValue(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function shellQuote(value: string): string {
    if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
    return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function presentRunLog(log: string): RunLogPresentation {
    let command: RunCommandPresentation | null = null;
    const textParts: string[] = [];
    const errors: string[] = [];
    const tools: string[] = [];

    for (const line of log.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let parsed: Record<string, unknown> | null = null;
        try {
            parsed = recordValue(JSON.parse(trimmed) as unknown);
        } catch {
            errors.push(line);
            continue;
        }
        if (!parsed) continue;

        if (parsed.type === 'supertask_command') {
            const executable = typeof parsed.executable === 'string' ? parsed.executable : null;
            const cwd = typeof parsed.cwd === 'string' ? parsed.cwd : null;
            const args = Array.isArray(parsed.args) && parsed.args.every((item) => typeof item === 'string')
                ? parsed.args as string[]
                : null;
            if (executable && cwd && args) {
                command = {
                    cwd,
                    command: `cd ${shellQuote(cwd)} && ${[executable, ...args].map(shellQuote).join(' ')}`,
                };
            }
            continue;
        }

        const part = recordValue(parsed.part);
        const eventType = typeof parsed.type === 'string' ? parsed.type : '';
        const partType = typeof part?.type === 'string' ? part.type : '';
        const text = typeof part?.text === 'string'
            ? part.text
            : typeof parsed.text === 'string' ? parsed.text : null;
        if (text && (eventType === 'text' || partType === 'text')) textParts.push(text);

        const tool = typeof part?.tool === 'string'
            ? part.tool
            : typeof parsed.tool === 'string' ? parsed.tool : null;
        if (tool && (eventType === 'tool_use' || partType === 'tool')) tools.push(tool);

        const error = typeof parsed.error === 'string'
            ? parsed.error
            : typeof part?.error === 'string' ? part.error : null;
        if (error) errors.push(error);
    }

    return {
        command,
        text: textParts.join('\n').trim(),
        errors: [...new Set(errors)],
        tools,
    };
}

function renderRunLog(runId: number, taskName: string, log: string, locale: Locale): string {
    const presentation = presentRunLog(log);
    const command = presentation.command
        ? `<div class="run-command"><div class="log-section-head"><strong>${t(locale, 'logs.command')}</strong><button type="button" class="btn" onclick="copyRunCommand(${runId})">${icon('copy')}${t(locale, 'action.copyCommand')}</button></div><div class="command-cwd">${esc(presentation.command.cwd)}</div><pre id="command-${runId}">${esc(presentation.command.command)}</pre></div>`
        : '';
    const errors = presentation.errors.length > 0
        ? `<div class="run-error"><strong>${t(locale, 'logs.error')}</strong><pre>${esc(presentation.errors.join('\n'))}</pre></div>`
        : '';
    const tools = presentation.tools.length > 0
        ? `<div class="run-tools"><strong>${t(locale, 'logs.tools')}</strong><div class="actions">${presentation.tools.map((tool) => `<span class="tag">${esc(tool)}</span>`).join('')}</div></div>`
        : '';
    const output = `<div class="run-output"><strong>${t(locale, 'logs.output')}</strong><pre>${esc(presentation.text || t(locale, 'logs.noText'))}</pre></div>`;
    return `<section id="log-${runId}" class="panel log-panel" hidden><div class="panel-head"><h3>Run #${runId} · ${esc(taskName)}</h3></div><div class="log-content">${command}${errors}${output}${tools}<details class="raw-log"><summary>${t(locale, 'logs.raw')}</summary><div class="log-box">${esc(log)}</div></details></div></section>`;
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

function durationControl(
    locale: Locale,
    id: string,
    value: number | null,
    kind: 'interval' | 'retry' | 'timeout',
): string {
    const units = [
        { value: 's', label: t(locale, 'duration.seconds') },
        { value: 'min', label: t(locale, 'duration.minutes') },
        { value: 'h', label: t(locale, 'duration.hours') },
        { value: 'd', label: t(locale, 'duration.days') },
    ];
    const values = kind === 'interval'
        ? [300_000, 900_000, 1_800_000, 3_600_000, 21_600_000, 43_200_000, 86_400_000]
        : kind === 'retry'
            ? [0, 10_000, 30_000, 60_000, 300_000]
            : [300_000, 900_000, 1_800_000, 3_600_000, 7_200_000, 14_400_000];
    const presets: Array<{ value: string; label: string }> = [
        ...(kind === 'timeout' ? [{ value: '', label: t(locale, 'duration.systemDefault') }] : []),
        ...values.map((milliseconds) => ({
            value: String(milliseconds),
            label: milliseconds === 0
                ? t(locale, 'duration.immediate')
                : kind === 'interval'
                    ? t(locale, 'duration.every', { duration: formatInterval(milliseconds, locale) })
                    : formatInterval(milliseconds, locale),
        })),
        { value: 'custom', label: t(locale, 'duration.custom') },
    ];
    const selected = value === null ? '' : String(value);
    return `<div class="duration-picker"><select id="${id}-preset" onchange="updateDurationControl('${id}')">${presets.map((item) => `<option value="${item.value}" ${item.value === selected ? 'selected' : ''}>${item.label}</option>`).join('')}</select><div id="${id}-custom" class="duration-control" hidden><input id="${id}-value" type="number" min="${kind === 'retry' ? 0 : 0.1}" step="0.1" inputmode="decimal"><select id="${id}-unit" aria-label="${t(locale, 'duration.unit')}">${units.map((item) => `<option value="${item.value}">${item.label}</option>`).join('')}</select></div></div>`;
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
    const requestedCwd = c.req.query('cwd') || '';
    const legacyProjectFilter = requestedCwd === LEGACY_PROJECT_FILTER;
    const cwdFilter = legacyProjectFilter ? '' : requestedCwd;
    const projectFilter = legacyProjectFilter ? LEGACY_PROJECT_FILTER : cwdFilter;
    const parsedStatus = statusFilter ? parseTaskStatus(statusFilter) : null;
    if (statusFilter && !parsedStatus) return c.text('invalid status', 400);
    const limit = 50;
    const offset = (page - 1) * limit;

    const [tasks, statsData, globalStats, projects, globalRunning, legacyStats, legacyRunning] = await Promise.all([
        TaskService.list({
            limit,
            offset,
            ...(parsedStatus === 'running'
                ? { activeExecution: true }
                : parsedStatus ? { status: parsedStatus } : {}),
            ...(legacyProjectFilter ? { legacyCwd: true } : cwdFilter ? { cwd: cwdFilter } : {}),
        }),
        TaskService.stats(legacyProjectFilter ? { legacyCwd: true } : cwdFilter ? { cwd: cwdFilter } : {}),
        TaskService.stats(),
        TaskService.projectSummaries(1000),
        TaskService.countRunning(),
        TaskService.stats({ legacyCwd: true }),
        TaskService.countRunning({ legacyCwd: true }),
    ]);
    const latestRuns = await TaskRunService.getLatestByTaskIds(tasks.map((task) => task.id));
    const selectedRunning = legacyProjectFilter
        ? legacyRunning
        : cwdFilter
            ? (projects.find((project) => project.cwd === cwdFilter)?.running ?? 0)
            : globalRunning;
    const counts = {
        pending: statsData.pending || 0,
        running: selectedRunning,
        done: statsData.done || 0,
        failed: (statsData.failed || 0) + (statsData.dead_letter || 0),
        total: statsData.total || 0,
    };
    const filteredTotal = parsedStatus === 'running'
        ? selectedRunning
        : parsedStatus ? Number(statsData[parsedStatus] ?? 0) : counts.total;
    const totalPages = Math.max(1, Math.ceil(filteredTotal / limit));
    if (page > totalPages) {
        const params = new URLSearchParams({ page: String(totalPages) });
        if (statusFilter) params.set('status', statusFilter);
        if (projectFilter) params.set('cwd', projectFilter);
        return c.redirect(`/?${params.toString()}`);
    }

    const taskListUrl = (status: string, cwd: string): string => {
        const params = new URLSearchParams();
        if (status) params.set('status', status);
        if (cwd) params.set('cwd', cwd);
        const query = params.toString();
        return query ? `/?${query}` : '/';
    };

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
        const href = taskListUrl(status, projectFilter);
        return `<a href="${esc(href)}" class="filter-chip ${statusFilter === status ? 'active' : ''}">${label}</a>`;
    }).join('');

    const rows = tasks.map((task) => {
        const status = safeStatus(task.status);
        const latestRun = latestRuns.get(task.id);
        const executionActive = latestRun?.status === 'running';
        const batchId = task.batchId?.trim() || null;
        const searchable = esc(`${task.name} ${task.agent} ${task.prompt} ${task.cwd ?? ''} ${task.batchId ?? ''} ${task.category ?? ''}`);
        return `<tr data-task-row data-search="${searchable}">
          <td class="faint" data-label="${t(locale, 'table.id')}">#${task.id}</td>
          <td data-primary data-label="${t(locale, 'table.task')}"><div class="task-name">${esc(task.name)}</div><div class="task-prompt" title="${esc(task.prompt)}">${esc(task.prompt.substring(0, 160))}</div>
            <div class="actions task-context"><span class="tag" title="${esc(task.cwd ?? '')}">${esc(task.cwd ? (basename(task.cwd) || task.cwd) : t(locale, 'projects.legacy'))}</span>${batchId ? `<span class="tag" title="${esc(t(locale, 'template.batchId'))}">${esc(batchId)}</span>` : ''}</div></td>
          <td data-label="${t(locale, 'table.agent')}"><span class="tag">${esc(task.agent)}</span></td>
          <td data-label="${t(locale, 'table.status')}"><span class="badge b-${status}" ${status === 'dead_letter' ? `title="${esc(t(locale, 'status.deadLetterHint'))}"` : ''}>${statusText(locale, status)}</span>${status === 'dead_letter' ? `<div class="muted small" style="margin-top:5px">${t(locale, 'status.deadLetterAction')}</div>` : ''}${executionActive && status !== 'running' ? `<div class="muted small" style="margin-top:5px">${t(locale, 'status.executionStillActive')}</div>` : ''}</td>
          <td data-label="${t(locale, 'table.duration')}" class="small ${executionActive || task.status === 'running' ? '' : 'muted'}">${formatDuration(task.startedAt, task.finishedAt)}</td>
          <td data-label="${t(locale, 'table.retries')}" class="muted small">${(task.retryCount ?? 0) > 0 ? task.retryCount : '—'}</td>
          <td data-label="${t(locale, 'table.actions')}"><div class="actions">
            ${task.cwd?.trim() && ['pending', 'failed', 'dead_letter'].includes(task.status ?? '') ? `<button type="button" class="btn" onclick="openTaskEditor(${task.id})">${t(locale, 'action.edit')}</button>` : ''}
            <button type="button" class="btn" onclick="showDetail(${task.id})">${t(locale, 'action.details')}</button>
            ${isValidSessionId(latestRun?.sessionId) ? `<button type="button" class="btn" onclick="copySessionCommand(${latestRun.id})">${icon('copy')}${t(locale, 'action.continueSession')}</button>` : ''}
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
    const paginationParts = [];
    if (statusFilter) paginationParts.push(`status=${encodeURIComponent(statusFilter)}`);
    if (projectFilter) paginationParts.push(`cwd=${encodeURIComponent(projectFilter)}`);
    const suffix = paginationParts.length > 0 ? `&${paginationParts.join('&')}` : '';
    const projectCards = [
        `<a class="project-card ${projectFilter ? '' : 'active'}" href="${esc(taskListUrl(statusFilter, ''))}">
          <div class="project-card-head"><strong>${t(locale, 'projects.all')}</strong><span>${globalStats.total || 0}</span></div>
          <div class="project-counts">${t(locale, 'projects.counts', { running: globalRunning, pending: globalStats.pending || 0, failed: (globalStats.failed || 0) + (globalStats.dead_letter || 0) })}</div>
        </a>`,
        ...(legacyStats.total > 0 ? [`<a class="project-card ${legacyProjectFilter ? 'active' : ''}" href="${esc(taskListUrl(statusFilter, LEGACY_PROJECT_FILTER))}">
          <div class="project-card-head"><strong>${t(locale, 'projects.legacy')}</strong><span>${legacyStats.total}</span></div>
          <div class="project-path">${t(locale, 'projects.legacyHint')}</div>
          <div class="project-counts">${t(locale, 'projects.counts', { running: legacyRunning, pending: legacyStats.pending || 0, failed: (legacyStats.failed || 0) + (legacyStats.dead_letter || 0) })}</div>
        </a>`] : []),
        ...projects.map((project) => `<a class="project-card ${cwdFilter === project.cwd ? 'active' : ''}" href="${esc(taskListUrl(statusFilter, project.cwd))}" title="${esc(project.cwd)}">
          <div class="project-card-head"><strong>${esc(basename(project.cwd) || project.cwd)}</strong><span>${project.total}</span></div>
          <div class="project-path">${esc(project.cwd)}</div>
          <div class="project-counts">${t(locale, 'projects.counts', { running: project.running, pending: project.pending, failed: project.failed })}</div>
        </a>`),
    ].join('');
    const projectData = JSON.stringify(Object.fromEntries(projects.map((project) => [project.cwd, {
        total: project.total,
        pending: project.pending,
        running: project.running,
        failed: project.failed,
    }]))).replace(/</g, '\\u003c');
    const body = `
      <div class="stats-grid">
        ${statCard(counts.pending, t(locale, 'stats.pending'), 'tone-neutral', icon('clock'))}
        ${statCard(counts.running, t(locale, 'stats.running'), 'tone-blue', icon('activity'), 'reveal-delay-1')}
        ${statCard(counts.done, t(locale, 'stats.done'), 'tone-green', icon('check'), 'reveal-delay-1')}
        ${statCard(counts.failed, t(locale, 'stats.failedDead'), 'tone-red', icon('alert'), 'reveal-delay-2')}
      </div>
      <section class="panel project-panel reveal reveal-delay-1">
        <div class="panel-head"><div><h2>${t(locale, 'projects.title')}</h2><p>${t(locale, 'projects.description')}</p></div><button type="button" class="btn btn-primary" onclick="openTaskCreator()">${t(locale, 'action.createTask')}</button></div>
        <div class="project-grid">${projectCards}</div>
      </section>
      <div class="toolbar reveal reveal-delay-1">
        <div class="filters">${filters}</div>
        <label class="search-box">${icon('search')}<input type="search" oninput="filterTasks(this.value)" placeholder="${t(locale, 'filter.searchTasks')}" aria-label="${t(locale, 'filter.searchTasks')}"></label>
      </div>
      <section class="panel reveal reveal-delay-2">${table}</section>
      ${pagination(locale, '/', page, totalPages, filteredTotal, suffix)}
      <script type="application/json" id="task-project-data">${projectData}</script>
      <dialog id="task-dialog" class="template-dialog">
        <form id="task-form" data-default-cwd="${esc(cwdFilter)}" onsubmit="saveTask(event)">
          <input id="task-id" type="hidden">
          <div class="dialog-head"><div><h2 id="task-dialog-title">${t(locale, 'task.createTitle')}</h2><p>${t(locale, 'task.formSubtitle')}</p></div><button type="button" class="icon-button" onclick="document.getElementById('task-dialog').close()" aria-label="${t(locale, 'action.close')}">${icon('close')}</button></div>
          <div class="dialog-body">
            <div class="template-form-grid">
              <label class="form-field"><span>${t(locale, 'template.name')}</span><input id="task-name" required maxlength="200" autocomplete="off"></label>
              <label class="form-field"><span>${t(locale, 'template.cwd')}</span><div class="field-action"><input id="task-cwd" required autocomplete="off" list="task-cwd-options" placeholder="/path/to/project" oninput="updateTaskProjectStatus();scheduleCatalogLoad('task')"><button id="task-cwd-picker" type="button" class="btn" onclick="openDirectoryPicker('task-cwd')">${icon('folder')}${t(locale, 'action.chooseFolder')}</button></div><small>${t(locale, 'template.cwdHint')}</small></label>
              <datalist id="task-cwd-options">${projects.map((project) => `<option value="${esc(project.cwd)}"></option>`).join('')}</datalist>
              <label class="form-field"><span>${t(locale, 'template.agent')}</span><select id="task-agent" required><option value="">${t(locale, 'catalog.chooseProject')}</option></select><small>${t(locale, 'catalog.agentHint')}</small></label>
              <label class="form-field"><span>${t(locale, 'template.model')}</span><div class="model-selector"><select id="task-model-provider" aria-label="${t(locale, 'catalog.provider')}" onchange="populateModelOptions('task')"><option value="">${t(locale, 'catalog.defaultProvider')}</option></select><select id="task-model" required aria-label="${t(locale, 'catalog.model')}" disabled><option value="default">${t(locale, 'catalog.defaultModel')}</option></select></div><small>${t(locale, 'catalog.modelHint')}</small></label>
              <label class="form-field form-field-wide"><span>${t(locale, 'template.prompt')}</span><textarea id="task-prompt" rows="6" required></textarea></label>
            </div>
            <p id="task-project-status" class="form-note"></p>
            <p id="task-catalog-status" class="form-note catalog-status"></p>
            <details class="advanced-fields">
              <summary>${t(locale, 'template.advanced')}</summary>
              <div class="template-form-grid">
                <label class="form-field"><span>${t(locale, 'template.category')}</span><input id="task-category" autocomplete="off" value="general"></label>
                <label class="form-field"><span>${t(locale, 'template.batchId')}</span><input id="task-batch" autocomplete="off"><small>${t(locale, 'task.batchHint')}</small></label>
                <label class="form-field"><span>${t(locale, 'template.importance')}</span><input id="task-importance" type="number" min="1" max="5" step="1" value="3" required></label>
                <label class="form-field"><span>${t(locale, 'template.urgency')}</span><input id="task-urgency" type="number" min="1" max="5" step="1" value="3" required></label>
                <label class="form-field"><span>${t(locale, 'template.maxRetries')}</span><input id="task-max-retries" type="number" min="0" max="1000" step="1" value="3" required></label>
                <label class="form-field"><span>${t(locale, 'template.retryBackoff')}</span>${durationControl(locale, 'task-retry-backoff', 30_000, 'retry')}<small>${t(locale, 'template.retryBackoffHint')}</small></label>
                <label class="form-field"><span>${t(locale, 'template.timeout')}</span>${durationControl(locale, 'task-timeout', null, 'timeout')}<small>${t(locale, 'template.timeoutHint')}</small></label>
              </div>
            </details>
          </div>
          <div class="dialog-actions"><button type="button" class="btn" onclick="document.getElementById('task-dialog').close()">${t(locale, 'action.cancel')}</button><button id="task-save" type="submit" class="btn btn-primary">${t(locale, 'action.saveTask')}</button></div>
        </form>
      </dialog>`;

    return c.html(renderLayout({ locale, activeTab: 'tasks', body }));
});

app.get('/templates', async (c) => {
    const locale = resolveLocale(c);
    const page = parsePositiveInteger(c.req.query('page') || '1');
    if (page === null) return c.text('invalid page', 400);
    const limit = 50;
    const offset = (page - 1) * limit;
    const [templates, templateStats] = await Promise.all([
        TaskTemplateService.list(limit, offset),
        TaskTemplateService.stats(),
    ]);
    const totalPages = Math.max(1, Math.ceil(templateStats.total / limit));
    if (page > totalPages) return c.redirect(`/templates?page=${totalPages}`);

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
          <td data-label="${t(locale, 'table.actions')}"><div class="actions"><button type="button" class="btn" onclick="openTemplateEditor(${template.id})">${t(locale, 'action.edit')}</button><button type="button" class="btn" onclick="showTemplateDetail(${template.id})">${t(locale, 'action.details')}</button>
            <button type="button" class="btn btn-primary" onclick="triggerTmpl(${template.id})">${t(locale, 'action.trigger')}</button>${toggle}
            <button type="button" class="btn btn-danger" onclick="deleteTmpl(${template.id})">${t(locale, 'action.delete')}</button></div></td>
        </tr>`;
    }).join('');

    const body = `
      <div class="stats-grid three">
        ${statCard(templateStats.total, t(locale, 'stats.templates'), 'tone-purple', icon('templates'))}
        ${statCard(templateStats.enabled, t(locale, 'stats.enabled'), 'tone-green', icon('check'), 'reveal-delay-1')}
        ${statCard(templateStats.disabled, t(locale, 'stats.disabled'), 'tone-neutral', icon('clock'), 'reveal-delay-2')}
      </div>
      <section class="panel reveal reveal-delay-2">
        <div class="panel-head"><h2>${t(locale, 'page.templates.title')}</h2><button type="button" class="btn btn-primary" onclick="openTemplateCreator()">${t(locale, 'action.createTemplate')}</button></div>
        ${templates.length === 0
            ? emptyState(t(locale, 'empty.templates'), t(locale, 'empty.templatesHint'))
            : `<div class="table-wrap"><table class="responsive-table"><thead><tr><th>ID</th><th>${t(locale, 'table.name')}</th><th>${t(locale, 'table.type')}</th><th>${t(locale, 'table.rule')}</th><th>${t(locale, 'table.status')}</th><th>${t(locale, 'table.lastRun')}</th><th>${t(locale, 'table.nextRun')}</th><th>${t(locale, 'table.actions')}</th></tr></thead><tbody>${rows}</tbody></table></div>`}
      </section>
      <dialog id="template-dialog" class="template-dialog">
        <form id="template-form" onsubmit="saveTemplate(event)">
          <input id="template-id" type="hidden">
          <div class="dialog-head"><div><h2 id="template-dialog-title">${t(locale, 'template.createTitle')}</h2><p>${t(locale, 'template.formSubtitle')}</p></div><button type="button" class="icon-button" onclick="document.getElementById('template-dialog').close()" aria-label="${t(locale, 'action.close')}">${icon('close')}</button></div>
          <div class="dialog-body">
            <div class="template-form-grid">
              <label class="form-field"><span>${t(locale, 'template.name')}</span><input id="template-name" required maxlength="200" autocomplete="off"></label>
              <label class="form-field"><span>${t(locale, 'template.cwd')}</span><div class="field-action"><input id="template-cwd" required autocomplete="off" placeholder="/path/to/project" oninput="scheduleCatalogLoad('template')"><button type="button" class="btn" onclick="openDirectoryPicker('template-cwd')">${icon('folder')}${t(locale, 'action.chooseFolder')}</button></div><small>${t(locale, 'template.cwdHint')}</small></label>
              <label class="form-field"><span>${t(locale, 'template.agent')}</span><select id="template-agent" required><option value="">${t(locale, 'catalog.chooseProject')}</option></select><small>${t(locale, 'catalog.agentHint')}</small></label>
              <label class="form-field"><span>${t(locale, 'template.model')}</span><div class="model-selector"><select id="template-model-provider" aria-label="${t(locale, 'catalog.provider')}" onchange="populateModelOptions('template')"><option value="">${t(locale, 'catalog.defaultProvider')}</option></select><select id="template-model" required aria-label="${t(locale, 'catalog.model')}" disabled><option value="default">${t(locale, 'catalog.defaultModel')}</option></select></div><small>${t(locale, 'catalog.modelHint')}</small></label>
              <label class="form-field form-field-wide"><span>${t(locale, 'template.prompt')}</span><textarea id="template-prompt" rows="6" required></textarea></label>
              <label class="form-field"><span>${t(locale, 'template.scheduleType')}</span><select id="template-schedule-type" onchange="updateTemplateScheduleFields()"><option value="recurring">${t(locale, 'schedule.recurring')}</option><option value="delayed">${t(locale, 'schedule.delayed')}</option><option value="cron">${t(locale, 'schedule.cron')}</option></select></label>
              <label id="template-cron-field" class="form-field" hidden><span>${t(locale, 'template.cronExpr')}</span><input id="template-cron" autocomplete="off" placeholder="0 9 * * *"><small>${t(locale, 'template.cronHint')}</small></label>
              <label id="template-interval-field" class="form-field"><span>${t(locale, 'template.interval')}</span>${durationControl(locale, 'template-interval', 3_600_000, 'interval')}<small>${t(locale, 'template.intervalHint')}</small></label>
              <label id="template-run-at-field" class="form-field" hidden><span>${t(locale, 'template.runAt')}</span><input id="template-run-at" type="datetime-local" step="0.001"></label>
            </div>
            <p id="template-catalog-status" class="form-note catalog-status"></p>
            <details class="advanced-fields">
              <summary>${t(locale, 'template.advanced')}</summary>
              <div class="template-form-grid">
                <label class="form-field"><span>${t(locale, 'template.category')}</span><input id="template-category" autocomplete="off" value="general"></label>
                <label class="form-field"><span>${t(locale, 'template.batchId')}</span><input id="template-batch" autocomplete="off"><small>${t(locale, 'template.optional')}</small></label>
                <label class="form-field"><span>${t(locale, 'template.importance')}</span><input id="template-importance" type="number" min="1" max="5" step="1" value="3" required></label>
                <label class="form-field"><span>${t(locale, 'template.urgency')}</span><input id="template-urgency" type="number" min="1" max="5" step="1" value="3" required></label>
                <label class="form-field"><span>${t(locale, 'template.maxInstances')}</span><input id="template-max-instances" type="number" min="1" max="1000" step="1" value="1" required><small>${t(locale, 'template.maxInstancesHint')}</small></label>
                <label class="form-field"><span>${t(locale, 'template.maxRetries')}</span><input id="template-max-retries" type="number" min="0" max="1000" step="1" value="3" required></label>
                <label class="form-field"><span>${t(locale, 'template.retryBackoff')}</span>${durationControl(locale, 'template-retry-backoff', 30_000, 'retry')}<small>${t(locale, 'template.retryBackoffHint')}</small></label>
                <label class="form-field"><span>${t(locale, 'template.timeout')}</span>${durationControl(locale, 'template-timeout', null, 'timeout')}<small>${t(locale, 'template.timeoutHint')}</small></label>
              </div>
            </details>
            <p class="form-note">${t(locale, 'template.futureOnly')}</p>
          </div>
          <div class="dialog-actions"><button type="button" class="btn" onclick="document.getElementById('template-dialog').close()">${t(locale, 'action.cancel')}</button><button id="template-save" type="submit" class="btn btn-primary">${t(locale, 'action.saveTemplate')}</button></div>
        </form>
      </dialog>
      ${pagination(locale, '/templates', page, totalPages, templateStats.total)}`;

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
    if (page > totalPages) return c.redirect(`/runs?page=${totalPages}`);

    const logs: string[] = [];
    const rows = runs.map((run) => {
        const status = safeStatus(run.status);
        const resumable = isValidSessionId(run.sessionId);
        if (run.log) {
            logs.push(renderRunLog(run.id, run.taskName, run.log, locale));
        }
        return `<tr>
          <td class="faint" data-label="${t(locale, 'table.run')}">#${run.id}</td>
          <td data-primary data-label="${t(locale, 'table.task')}"><div class="task-name">${esc(run.taskName)} <span class="faint">#${run.taskId}</span></div>${run.model ? `<div style="margin-top:4px"><span class="tag">${esc(run.model)}</span></div>` : ''}</td>
          <td data-label="${t(locale, 'table.agent')}"><span class="tag">${esc(run.taskAgent)}</span></td>
          <td data-label="${t(locale, 'table.session')}" class="m small">${esc(maskSessionId(run.sessionId))}</td>
          <td data-label="${t(locale, 'table.status')}"><span class="badge b-${status}">${runStatusText(locale, run.status ?? 'unknown')}</span></td>
          <td data-label="${t(locale, 'table.duration')}" class="small">${formatDuration(run.startedAt, run.finishedAt)}</td>
          <td data-label="${t(locale, 'table.heartbeat')}" class="small muted">${formatRelative(run.heartbeatAt, locale)}</td>
          <td data-label="${t(locale, 'table.actions')}"><div class="actions"><button type="button" class="btn" onclick="showRunDetail(${run.id})">${t(locale, 'action.details')}</button>
            ${resumable ? `<button type="button" class="btn" onclick="copySessionCommand(${run.id})">${icon('copy')}${t(locale, 'action.continueSession')}</button>` : ''}
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
          : `<div class="table-wrap"><table class="responsive-table"><thead><tr><th>${t(locale, 'table.run')}</th><th>${t(locale, 'table.task')}</th><th>${t(locale, 'table.agent')}</th><th>${t(locale, 'table.session')}</th><th>${t(locale, 'table.status')}</th><th>${t(locale, 'table.duration')}</th><th>${t(locale, 'table.heartbeat')}</th><th>${t(locale, 'table.actions')}</th></tr></thead><tbody>${rows}</tbody></table></div>`}</section>
      ${logs.join('')}${pagination(locale, '/runs', page, totalPages, total)}`;

    return c.html(renderLayout({ locale, activeTab: 'runs', body }));
});

app.get('/system', async (c) => {
    const locale = resolveLocale(c);
    const config = loadConfig();
    const activeConfig = runtimeConfig ?? config;
    const restartRequired = runtimeConfig !== null && !configsEqual(config, runtimeConfig);
    const managedRestart = canRestartCurrentGateway();
    const configState = resolveDashboardConfigState(
        runtimeConfig !== null,
        restartRequired,
        managedRestart,
    );
    const configStateKey = ({
        foreground: 'system.configForeground',
        applied: 'system.configApplied',
        pending: 'system.configPending',
        manual: 'system.configRestartManually',
    } as const)[configState];
    const configStateText = t(locale, configStateKey);
    const configPath = getConfigPath();
    const [stats, runningRuns, templateStats] = await Promise.all([
        TaskService.stats({}), TaskRunService.getAllRunningRuns(), TaskTemplateService.stats(),
    ]);
    const configExists = existsSync(configPath);
    const runRows = runningRuns.map((run) => {
        const session = maskSessionId(run.sessionId);
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
          <section class="card settings-card reveal-delay-1"><h2 class="settings-title"><span>${icon('templates')}${t(locale, 'system.scheduler')}</span><span class="badge ${activeConfig.scheduler.enabled ? 'b-done' : 'b-cancelled'}">${t(locale, activeConfig.scheduler.enabled ? 'schedule.enabled' : 'schedule.disabled')}</span></h2>
            <div class="switch-field"><label for="se">${t(locale, 'system.schedulerEnabled')}</label><label class="switch"><input id="se" type="checkbox" name="se" ${config.scheduler.enabled ? 'checked' : ''}><span></span></label></div>
            <div class="field"><label for="si">${t(locale, 'system.checkInterval')}</label>${unitInput('si', config.scheduler.checkIntervalMs, 100, t(locale, 'system.milliseconds'))}</div>
            <div class="info-row"><span class="info-key">${t(locale, 'system.activeTemplates')}</span><span class="info-value">${templateStats.enabled} / ${templateStats.total}</span></div>
          </section>
          <section class="card settings-card reveal-delay-2"><h2 class="settings-title"><span>${icon('system')}${t(locale, 'system.watchdog')}</span></h2>
            <div class="field"><label for="wt">${t(locale, 'system.heartbeatTimeout')}</label>${unitInput('wt', config.watchdog.heartbeatTimeoutMs / 1000, 10, t(locale, 'system.seconds'))}</div>
            <div class="field"><label for="wci">${t(locale, 'system.checkInterval')}</label>${unitInput('wci', config.watchdog.checkIntervalMs / 1000, 1, t(locale, 'system.seconds'))}</div>
            <div class="field"><label for="wcl">${t(locale, 'system.cleanupInterval')}</label>${unitInput('wcl', config.watchdog.cleanupIntervalMs / 3_600_000, 1, t(locale, 'system.hours'))}</div>
            <div class="field"><label for="rd">${t(locale, 'system.retentionDays')}</label>${unitInput('rd', config.watchdog.retentionDays, 1, t(locale, 'system.days'))}</div>
          </section>
        </div>
        <div class="save-row"><span class="muted small">${configStateText}</span><div class="actions"><button type="submit" class="btn">${t(locale, 'action.save')}</button>${managedRestart ? `<button type="button" class="btn btn-primary" onclick="saveConfig(true,${runningRuns.length})">${t(locale, 'action.saveAndRestart')}</button>` : ''}</div></div>
      </form>
      <section class="panel reveal">
        <div class="panel-head"><h2>${t(locale, 'system.runningTasks', { running: runningRuns.length, limit: activeConfig.worker.maxConcurrency })}</h2></div>
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

app.post('/api/tasks', async (c) => {
    try {
        const task = await TaskService.add(parseTaskPayload(await c.req.json()));
        return c.json({ success: true, task }, 201);
    } catch (error) {
        return c.json({
            error: error instanceof Error ? error.message : String(error),
        }, 400);
    }
});

app.put('/api/tasks/:id', async (c) => {
    const id = parsePositiveInteger(c.req.param('id'));
    if (id === null) return c.json({ error: 'invalid id' }, 400);
    try {
        const input = parseTaskPayload(await c.req.json());
        const task = await TaskService.update(id, editableTaskPayload(input));
        if (task) return c.json({ success: true, task });
        return await TaskService.getById(id)
            ? c.json({ error: 'task status does not allow editing' }, 409)
            : c.json({ error: 'not found' }, 404);
    } catch (error) {
        return c.json({
            error: error instanceof Error ? error.message : String(error),
        }, 400);
    }
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

app.get('/api/runs/:id/session-command', async (c) => {
    const id = parsePositiveInteger(c.req.param('id'));
    if (id === null) return c.json({ error: 'invalid id' }, 400);
    const run = await TaskRunService.getById(id);
    if (!run) return c.json({ error: 'not found' }, 404);
    if (!isValidSessionId(run.sessionId)) return c.json({ error: 'session unavailable' }, 409);
    return c.json({ command: sessionCommand(run.sessionId) });
});

app.get('/api/gateway/status', (c) => {
    const savedConfig = loadConfig();
    const managed = canRestartCurrentGateway();
    return c.json({
        pid: process.pid,
        managed,
        ready: managed && getGatewayHealth().status === 'ok',
        restartRequired: runtimeConfig === null || !configsEqual(savedConfig, runtimeConfig),
    });
});

app.get('/api/templates/:id', async (c) => {
    const id = parsePositiveInteger(c.req.param('id'));
    if (id === null) return c.json({ error: 'invalid id' }, 400);
    const template = await TaskTemplateService.getById(id);
    if (!template) return c.json({ error: 'not found' }, 404);
    return c.json(template);
});

app.post('/api/templates', async (c) => {
    try {
        const input = parseTemplatePayload(await c.req.json());
        const template = await TaskTemplateService.create(input);
        return c.json({ success: true, template }, 201);
    } catch (error) {
        return c.json({
            error: error instanceof Error ? error.message : String(error),
        }, 400);
    }
});

app.put('/api/templates/:id', async (c) => {
    const id = parsePositiveInteger(c.req.param('id'));
    if (id === null) return c.json({ error: 'invalid id' }, 400);
    try {
        const input = parseTemplatePayload(await c.req.json());
        const template = await TaskTemplateService.update(id, input);
        return template
            ? c.json({ success: true, template })
            : c.json({ error: 'not found' }, 404);
    } catch (error) {
        return c.json({
            error: error instanceof Error ? error.message : String(error),
        }, 400);
    }
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
    const task = await triggerTaskFromTemplate(id);
    return task
        ? c.json({ success: true, taskId: task.id })
        : c.json({ error: 'not found' }, 404);
});

app.put('/api/config', async (c) => {
    try {
        const rawBody: unknown = await c.req.json();
        if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
            throw new Error('请求内容必须是对象');
        }
        const body = rawBody as Record<string, unknown>;
        const section = (name: string): Record<string, unknown> => {
            const value = body[name];
            if (value === undefined) return {};
            if (!value || typeof value !== 'object' || Array.isArray(value)) {
                throw new Error(`${name} 必须是对象`);
            }
            return value as Record<string, unknown>;
        };
        const current = readCurrentConfig();
        const currentWorker = (current.worker ?? {}) as Record<string, unknown>;
        const currentScheduler = (current.scheduler ?? {}) as Record<string, unknown>;
        const currentWatchdog = (current.watchdog ?? {}) as Record<string, unknown>;
        const bodyWorker = section('worker');
        const bodyScheduler = section('scheduler');
        const bodyWatchdog = section('watchdog');
        const merged = {
            ...current,
            ...body,
            configVersion: 2,
            worker: { ...currentWorker, ...bodyWorker },
            scheduler: { ...currentScheduler, ...bodyScheduler },
            watchdog: { ...currentWatchdog, ...bodyWatchdog },
        };
        const savedConfig = validateConfig(merged);
        writeConfig(savedConfig);
        return c.json({
            success: true,
            restartRequired: runtimeConfig === null || !configsEqual(savedConfig, runtimeConfig),
            managed: canRestartCurrentGateway(),
        });
    } catch (error) {
        return c.json({
            success: false,
            error: error instanceof Error ? error.message : String(error),
        }, 400);
    }
});

app.post('/api/gateway/restart', async (c) => {
    const rawBody: unknown = await c.req.json().catch(() => null);
    const confirmation = rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody)
        ? (rawBody as Record<string, unknown>).confirmation
        : undefined;
    if (confirmation !== 'RESTART') {
        return c.json({ error: 'confirmation must be RESTART' }, 400);
    }
    if (restartScheduled) return c.json({ error: 'restart already scheduled' }, 409);
    if (!canRestartCurrentGateway()) {
        return c.json({ error: '当前 Gateway 不是由匹配运行作用域的 PM2 进程托管，无法从网页安全重启' }, 409);
    }

    restartScheduled = true;
    const previousPid = process.pid;
    setTimeout(() => {
        process.kill(previousPid, 'SIGTERM');
    }, 500);
    return c.json({ success: true, previousPid }, 202);
});

app.post('/api/database/clear', async (c) => {
    const rawBody: unknown = await c.req.json().catch(() => null);
    const confirmation = rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody)
        ? (rawBody as Record<string, unknown>).confirmation
        : undefined;
    if (confirmation !== 'CLEAR') {
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
