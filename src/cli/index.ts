import { Command, Option } from 'commander';
import { TaskService, type EditableTaskUpdate } from '@core/services/task.service';
import { TaskRunService } from '@core/services/task-run.service';
import { TaskTemplateService } from '@core/services/task-template.service';
import { DatabaseMaintenanceService } from '@core/services/database-maintenance.service';
import { closeDb } from '@core/db';
import { parseDuration } from '@core/duration';
import type { ScheduleType } from '@core/db/schema';
import {
    diagnoseOpenCodeRuntime,
    getGatewayDiagnostic,
    getPackageVersion,
    withGatewayMaintenance,
} from '../daemon/pm2';
import { getConfigPath, loadConfig } from '@gateway/config';
import {
    renderDatabaseError,
    renderDatabaseResult,
    type GatewayMaintenanceReport,
} from './database-output';
import {
    parseBoundedInteger,
    parsePositiveInteger,
    parseTaskStatus,
} from './validation';
import { getOpenCodePluginDiagnostic } from '../daemon/update';
import { cliText, resolveCliLocale } from './i18n';
import { runDoctorSmoke, type DoctorSmokeResult } from './doctor-smoke';

const cliLocale = resolveCliLocale();
const t = (zh: string, en: string, es?: string): string => cliText(cliLocale, zh, en, es);

async function withDb<T>(
    fn: () => Promise<T>,
    formatError = (error: unknown) => JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
    }),
): Promise<T> {
    try {
        return await fn();
    } catch (error) {
        console.error(formatError(error));
        closeDb();
        process.exit(1);
    } finally {
        closeDb();
    }
}

function runDestructiveDatabaseMaintenance<T extends object>(
    keepStopped: boolean,
    operation: () => T,
): T & { gateway: GatewayMaintenanceReport } {
    const maintenance = withGatewayMaintenance(keepStopped, operation);

    return {
        ...maintenance.result,
        gateway: {
            wasRunning: maintenance.wasRunning,
            restarted: maintenance.restarted,
            keptStopped: maintenance.keptStopped,
        },
    };
}

const program = new Command();

program
    .name('supertask')
    .description(t('面向 OpenCode Agent 的持久化任务队列与定时任务系统', 'Durable task queue and scheduler for OpenCode agents', 'Cola de tareas durable y programador para agentes de OpenCode'))
    .addOption(new Option('--lang <language>', t('CLI 语言：auto / zh-CN / en / es', 'CLI language: auto / zh-CN / en / es', 'idioma de la CLI: auto / zh-CN / en / es'))
        .choices(['auto', 'zh-CN', 'en', 'es'])
        .default('auto'))
    .helpOption('-h, --help', t('显示帮助', 'display help for command', 'mostrar la ayuda del comando'))
    .addHelpCommand('help [command]', t('显示命令帮助', 'display help for command', 'mostrar la ayuda del comando'))
    .version(getPackageVersion(), '-V, --version', t('显示版本号', 'output the version number', 'mostrar el número de versión'));

if (cliLocale === 'zh-CN') {
    program.configureOutput({
        writeOut: (value) => process.stdout.write(value
            .replace(/^Usage:/gm, '用法：')
            .replace(/^Options:/gm, '选项：')
            .replace(/^Commands:/gm, '命令：')
            .replace(/^Arguments:/gm, '参数：')),
    });
}

program
    .command('add')
    .description(t('创建新任务', 'create a queued task', 'crear una tarea en cola'))
    .requiredOption('-n, --name <name>', t('任务名称', 'task name', 'nombre de la tarea'))
    .requiredOption('-a, --agent <agent>', t('主 Agent 名称', 'primary agent name', 'nombre del agente principal'))
    .requiredOption('-p, --prompt <prompt>', t('提示词', 'prompt', 'prompt'))
    .option('-m, --model <model>', t('模型', 'model', 'modelo'))
    .option('--variant <variant>', t('模型 variant，如 high / xhigh', 'model variant, e.g. high / xhigh', 'variante del modelo, p. ej. high / xhigh'))
    .option('-c, --category <category>', t('分类', 'category', 'categoría'), 'general')
    .option('-i, --importance <number>', t('重要程度 (1-5)', 'importance (1-5)', 'importancia (1-5)'), '3')
    .option('-u, --urgency <number>', t('紧急程度 (1-5)', 'urgency (1-5)', 'urgencia (1-5)'), '3')
    .option('-b, --batch <batchId>', t('批次 ID', 'batch ID', 'ID de lote'))
    .option('-d, --depends <taskId>', t('依赖的任务 ID', 'dependency task ID', 'ID de la tarea dependiente'))
    .option('--max-retries <number>', t('首次执行之外允许的重试次数', 'retries allowed after the first attempt', 'reintentos permitidos tras el primer intento'), '3')
    .option('--retry-backoff <duration>', t('重试退避基础间隔，如 30s / 5min', 'retry backoff base, e.g. 30s / 5min', 'base de espera entre reintentos, p. ej. 30s / 5min'), '30s')
    .option('--timeout <duration>', t('任务硬超时，如 30min / 2h', 'hard timeout, e.g. 30min / 2h', 'timeout estricto, p. ej. 30min / 2h'))
    .option('-w, --cwd <path>', t('(已废弃) 系统会自动记录提交时的当前目录', '(deprecated) the submission directory is recorded automatically', '(obsoleto) el directorio de envío se registra automáticamente'))
    .action(async (options) => withDb(async () => {
        const submitCwd = process.cwd();
        const retryBackoffMs = parseDuration(options.retryBackoff);
        const timeoutMs = options.timeout ? parseDuration(options.timeout) : null;
        if (retryBackoffMs === null || (options.timeout && timeoutMs === null)) {
            throw new Error('retry-backoff 或 timeout 格式无效');
        }
        const task = await TaskService.add({
            name: options.name,
            agent: options.agent,
            prompt: options.prompt,
            model: options.model,
            variant: options.variant,
            category: options.category,
            importance: parseBoundedInteger(options.importance, 'importance', 1, 5),
            urgency: parseBoundedInteger(options.urgency, 'urgency', 1, 5),
            batchId: options.batch,
            dependsOn: options.depends ? parsePositiveInteger(options.depends, 'depends') : undefined,
            cwd: submitCwd,
            maxRetries: parseBoundedInteger(options.maxRetries, 'max-retries', 0, 1000),
            retryBackoffMs,
            timeoutMs,
        });
        console.log(JSON.stringify({ id: task.id, status: 'created' }, null, 2));
    }));

program
    .command('edit')
    .description(t('修改当前项目中尚未完成的任务', 'edit an unfinished task in the current project', 'editar una tarea no finalizada del proyecto actual'))
    .requiredOption('--id <id>', t('任务 ID', 'task ID', 'ID de la tarea'))
    .option('-n, --name <name>', t('任务名称', 'task name', 'nombre de la tarea'))
    .option('-a, --agent <agent>', t('Agent 名称', 'agent name', 'nombre del agente'))
    .option('-m, --model <model>', t('模型', 'model', 'modelo'))
    .option('--variant <variant>', t('模型 variant，如 high / xhigh', 'model variant, e.g. high / xhigh', 'variante del modelo, p. ej. high / xhigh'))
    .option('--clear-variant', t('清空任务级 variant，跟随 Agent / 模型默认值', 'clear the task variant and use the Agent / model default', 'borrar la variante de la tarea y usar el valor predeterminado del agente / modelo'))
    .option('-p, --prompt <prompt>', t('提示词', 'prompt', 'prompt'))
    .option('-c, --category <category>', t('分类', 'category', 'categoría'))
    .option('-i, --importance <number>', t('重要程度 (1-5)', 'importance (1-5)', 'importancia (1-5)'))
    .option('-u, --urgency <number>', t('紧急程度 (1-5)', 'urgency (1-5)', 'urgencia (1-5)'))
    .option('-b, --batch <batchId>', t('批次 ID', 'batch ID', 'ID de lote'))
    .option('--clear-batch', t('清空批次 ID', 'clear the batch ID', 'borrar el ID de lote'))
    .option('--max-retries <number>', t('首次执行之外允许的重试次数', 'retries allowed after the first attempt', 'reintentos permitidos tras el primer intento'))
    .option('--retry-backoff <duration>', t('重试退避基础间隔，如 30s / 5min', 'retry backoff base, e.g. 30s / 5min', 'base de espera entre reintentos, p. ej. 30s / 5min'))
    .option('--timeout <duration>', t('任务硬超时，如 30min / 2h', 'hard timeout, e.g. 30min / 2h', 'timeout estricto, p. ej. 30min / 2h'))
    .option('--clear-timeout', t('清空任务级超时，改用 Gateway 默认值', 'clear the task timeout and use the Gateway default', 'borrar el timeout de la tarea y usar el predeterminado del Gateway'))
    .action(async (options) => withDb(async () => {
        if (options.batch !== undefined && options.clearBatch) {
            throw new Error('batch 和 clear-batch 不能同时使用');
        }
        if (options.timeout !== undefined && options.clearTimeout) {
            throw new Error('timeout 和 clear-timeout 不能同时使用');
        }
        if (options.variant !== undefined && options.clearVariant) {
            throw new Error('variant 和 clear-variant 不能同时使用');
        }
        const update: EditableTaskUpdate = {};
        for (const field of ['name', 'agent', 'model', 'prompt', 'category'] as const) {
            if (options[field] !== undefined) update[field] = options[field];
        }
        if (options.variant !== undefined || options.clearVariant) {
            update.variant = options.clearVariant ? null : options.variant;
        }
        if (options.importance !== undefined) {
            update.importance = parseBoundedInteger(options.importance, 'importance', 1, 5);
        }
        if (options.urgency !== undefined) {
            update.urgency = parseBoundedInteger(options.urgency, 'urgency', 1, 5);
        }
        if (options.maxRetries !== undefined) {
            update.maxRetries = parseBoundedInteger(options.maxRetries, 'max-retries', 0, 1000);
        }
        if (options.batch !== undefined || options.clearBatch) {
            update.batchId = options.clearBatch ? null : options.batch;
        }
        if (options.retryBackoff !== undefined) {
            const retryBackoffMs = parseDuration(options.retryBackoff);
            if (retryBackoffMs === null) throw new Error('retry-backoff 格式无效');
            update.retryBackoffMs = retryBackoffMs;
        }
        if (options.timeout !== undefined || options.clearTimeout) {
            const timeoutMs = options.clearTimeout ? null : parseDuration(options.timeout);
            if (timeoutMs === null && !options.clearTimeout) throw new Error('timeout 格式无效');
            update.timeoutMs = timeoutMs;
        }
        const id = parsePositiveInteger(options.id, 'id');
        const task = await TaskService.update(id, update, { cwd: process.cwd() });
        if (!task) throw new Error(`任务 #${id} 不存在于当前项目，或其状态不允许编辑`);
        console.log(JSON.stringify({ id: task.id, status: task.status, updated: true }, null, 2));
    }));

program
    .command('next')
    .description(t('获取下一个待执行的任务', 'show the next runnable task', 'mostrar la siguiente tarea ejecutable'))
    .action(async () => withDb(async () => {
        const task = await TaskService.next({ cwd: process.cwd() });
        if (task) {
            console.log(JSON.stringify({
                id: task.id,
                name: task.name,
                agent: task.agent,
                model: task.model,
                variant: task.variant,
                prompt: task.prompt,
                cwd: task.cwd,
                category: task.category,
                importance: task.importance,
                urgency: task.urgency,
            }, null, 2));
        } else {
            console.log(JSON.stringify({ id: null, message: 'No executable tasks' }));
        }
    }));

program
    .command('cancel')
    .description(t('取消任务', 'cancel a task', 'cancelar una tarea'))
    .requiredOption('--id <id>', t('任务 ID', 'task ID', 'ID de la tarea'))
    .action(async (options) => withDb(async () => {
        const task = await TaskService.cancel(parsePositiveInteger(options.id, 'id'), { cwd: process.cwd() });
        if (task) {
            console.log(JSON.stringify({ id: task.id, status: task.status }));
        } else {
            console.log(JSON.stringify({ error: 'Task not found' }));
            process.exit(1);
        }
    }));

const runCommand = new Command('run')
    .description(t('管理隔离的执行记录', 'manage quarantined task runs', 'gestionar ejecuciones de tareas en cuarentena'));

runCommand
    .command('abandon')
    .description(t('人工关闭已确认不存在遗留进程的旧版无 PID 隔离记录', 'close a legacy no-PID quarantine after confirming no process remains', 'cerrar una cuarentena legacy sin PID tras confirmar que no queda ningún proceso'))
    .requiredOption('--id <id>', t('执行记录 run ID', 'run ID', 'ID de la ejecución'))
    .option('--confirm <word>', t('危险操作确认，必须填写 ABANDON', 'confirmation word; must be ABANDON', 'palabra de confirmación; debe ser ABANDON'))
    .action(async (options: { id: string; confirm?: string }) => withDb(async () => {
        if (options.confirm !== 'ABANDON') {
            throw new Error('关闭旧版隔离 run 必须显式传入 --confirm ABANDON');
        }
        const runId = parsePositiveInteger(options.id, 'id');
        const result = await TaskRunService.abandonLegacyRun(runId);
        if (!result) throw new Error(`run #${runId} 不存在`);
        console.log(JSON.stringify(result, null, 2));
    }));

program.addCommand(runCommand);

program
    .command('retry')
    .description(t('重试失败的任务', 'retry failed tasks', 'reintentar tareas fallidas'))
    .option('--id <id>', t('任务 ID', 'task ID', 'ID de la tarea'))
    .option('-b, --batch <batchId>', t('批次 ID（批量重试）', 'batch ID for bulk retry', 'ID de lote para reintento masivo'))
    .action(async (options) => withDb(async () => {
        if (options.id) {
            const task = await TaskService.retry(parsePositiveInteger(options.id, 'id'), { cwd: process.cwd() });
            if (task) {
                console.log(JSON.stringify({ id: task.id, status: task.status }));
            } else {
                console.log(JSON.stringify({ error: 'Task not found or not failed' }));
                process.exit(1);
            }
        } else if (options.batch) {
            const count = await TaskService.retryBatch(options.batch, { cwd: process.cwd() });
            console.log(JSON.stringify({ retried: count, batchId: options.batch }));
        } else {
            console.log(JSON.stringify({ error: 'Please specify --id or --batch' }));
            process.exit(1);
        }
    }));

program
    .command('status')
    .description(t('查看任务统计', 'show task counts', 'mostrar recuentos de tareas'))
    .option('-b, --batch <batchId>', t('按批次统计', 'filter counts by batch', 'filtrar recuentos por lote'))
    .action(async (options) => withDb(async () => {
        const stats = await TaskService.stats({ batchId: options.batch, cwd: process.cwd() });
        console.log(JSON.stringify(stats, null, 2));
    }));

program
    .command('list')
    .description(t('列出任务', 'list tasks', 'listar tareas'))
    .option('-s, --status <status>', t('按状态筛选', 'filter by status', 'filtrar por estado'))
    .option('-b, --batch <batchId>', t('按批次筛选', 'filter by batch', 'filtrar por lote'))
    .option('-c, --category <category>', t('按分类筛选', 'filter by category', 'filtrar por categoría'))
    .option('-l, --limit <number>', t('限制数量', 'maximum rows', 'filas máximas'), '20')
    .action(async (options) => withDb(async () => {
        const tasks = await TaskService.list({
            status: parseTaskStatus(options.status),
            batchId: options.batch,
            category: options.category,
            cwd: process.cwd(),
            limit: parsePositiveInteger(options.limit, 'limit'),
        });
        console.log(JSON.stringify(tasks, null, 2));
    }));

program
    .command('get')
    .description(t('获取单个任务详情', 'show one task', 'mostrar una tarea'))
    .requiredOption('--id <id>', t('任务 ID', 'task ID', 'ID de la tarea'))
    .action(async (options) => withDb(async () => {
        const task = await TaskService.getById(parsePositiveInteger(options.id, 'id'), { cwd: process.cwd() });
        if (task) {
            console.log(JSON.stringify(task, null, 2));
        } else {
            console.log(JSON.stringify({ error: 'Task not found' }));
            process.exit(1);
        }
    }));

program
    .command('delete')
    .description(t('删除任务', 'delete a task', 'eliminar una tarea'))
    .requiredOption('--id <id>', t('任务 ID', 'task ID', 'ID de la tarea'))
    .action(async (options) => withDb(async () => {
        const id = parsePositiveInteger(options.id, 'id');
        const deleted = await TaskService.delete(id, { cwd: process.cwd() });
        console.log(JSON.stringify({ deleted, id }));
    }));

program
    .command('template')
    .description(t('管理定时任务模板', 'manage scheduled task templates', 'gestionar plantillas de tareas programadas'))
    .addCommand(
        new Command('add')
            .description(t('创建定时任务模板', 'create a scheduled task template', 'crear una plantilla de tarea programada'))
            .requiredOption('-n, --name <name>', t('模板名称', 'template name', 'nombre de la plantilla'))
            .requiredOption('-a, --agent <agent>', t('Agent 名称', 'agent name', 'nombre del agente'))
            .requiredOption('-p, --prompt <prompt>', t('提示词', 'prompt', 'prompt'))
            .requiredOption('-t, --type <type>', t('定时类型：cron/delayed/recurring', 'schedule type: cron/delayed/recurring', 'tipo de programación: cron/delayed/recurring'))
            .option('--cron <expr>', t('cron 表达式（cron 类型必填）', 'cron expression (required for cron)', 'expresión cron (obligatoria para cron)'))
            .option('--delay <duration>', t('延迟时间（delayed 必填），如 30s / 5min / 1h / 2d', 'delay (required for delayed), e.g. 30s / 5min / 1h / 2d', 'retraso (obligatorio para delayed), p. ej. 30s / 5min / 1h / 2d'))
            .option('--interval <duration>', t('循环间隔（recurring 必填），如 1h / 30min / 5s', 'interval (required for recurring), e.g. 1h / 30min / 5s', 'intervalo (obligatorio para recurring), p. ej. 1h / 30min / 5s'))
            .option('-m, --model <model>', t('模型', 'model', 'modelo'))
            .option('--variant <variant>', t('模型 variant，如 high / xhigh', 'model variant, e.g. high / xhigh', 'variante del modelo, p. ej. high / xhigh'))
            .option('-c, --category <category>', t('分类', 'category', 'categoría'), 'general')
            .option('-i, --importance <number>', t('重要程度 1-5', 'importance 1-5', 'importancia 1-5'), '3')
            .option('-u, --urgency <number>', t('紧急程度 1-5', 'urgency 1-5', 'urgencia 1-5'), '3')
            .option('-b, --batch <batchId>', t('模板生成任务的批次 ID', 'batch ID for generated tasks', 'ID de lote para las tareas generadas'))
            .option('--max-instances <number>', t('自动定时任务的活跃实例上限（立即触发不受限）', 'active instance limit for automatic scheduling (Run now is unrestricted)', 'límite de instancias activas para la programación automática (Ejecutar ahora no tiene límite)'), '1')
            .option('--max-retries <number>', t('最大重试次数', 'maximum retries', 'reintentos máximos'), '3')
            .option('--retry-backoff <duration>', t('退避基础间隔，如 30s / 5min', 'retry backoff base, e.g. 30s / 5min', 'base de espera entre reintentos, p. ej. 30s / 5min'), '30s')
            .option('--timeout <duration>', t('每次任务硬超时，如 30min / 2h', 'hard timeout per task, e.g. 30min / 2h', 'timeout estricto por tarea, p. ej. 30min / 2h'))
            .action(async (options) => withDb(async () => {
                let intervalMs: number | null = null;
                let runAt: number | null = null;
                const retryBackoffMs = parseDuration(options.retryBackoff);
                const timeoutMs = options.timeout ? parseDuration(options.timeout) : null;

                if (retryBackoffMs === null || (options.timeout && timeoutMs === null)) {
                    throw new Error('retry-backoff 或 timeout 格式无效');
                }

                if (options.interval) {
                    intervalMs = parseDuration(options.interval);
                    if (intervalMs === null) {
                        console.error(JSON.stringify({ error: `Invalid interval: "${options.interval}". Use 30s / 5min / 1h / 2d` }));
                        process.exit(1);
                    }
                }
                if (options.delay) {
                    const delayMs = parseDuration(options.delay);
                    if (delayMs === null) {
                        console.error(JSON.stringify({ error: `Invalid delay: "${options.delay}". Use 30s / 5min / 1h / 2d` }));
                        process.exit(1);
                    }
                    runAt = Date.now() + delayMs;
                }

                const tmpl = await TaskTemplateService.create({
                    name: options.name,
                    agent: options.agent,
                    prompt: options.prompt,
                    model: options.model,
                    variant: options.variant,
                    category: options.category,
                    importance: parseBoundedInteger(options.importance, 'importance', 1, 5),
                    urgency: parseBoundedInteger(options.urgency, 'urgency', 1, 5),
                    cwd: process.cwd(),
                    batchId: options.batch,
                    scheduleType: options.type as ScheduleType,
                    cronExpr: options.cron,
                    intervalMs,
                    runAt,
                    maxInstances: parseBoundedInteger(options.maxInstances, 'max-instances', 1, 1000),
                    maxRetries: parseBoundedInteger(options.maxRetries, 'max-retries', 0, 1000),
                    retryBackoffMs,
                    timeoutMs,
                });
                console.log(JSON.stringify({ id: tmpl.id, status: 'created', nextRunAt: tmpl.nextRunAt }, null, 2));
            })),
    )
    .addCommand(
        new Command('list')
            .description(t('列出定时任务模板', 'list scheduled task templates', 'listar plantillas de tareas programadas'))
            .action(async () => withDb(async () => {
                const templates = await TaskTemplateService.list();
                console.log(JSON.stringify(templates, null, 2));
            })),
    )
    .addCommand(
        new Command('enable')
            .description(t('启用模板', 'enable a template', 'activar una plantilla'))
            .requiredOption('--id <id>', t('模板 ID', 'template ID', 'ID de la plantilla'))
            .action(async (options) => withDb(async () => {
                const tmpl = await TaskTemplateService.enable(parsePositiveInteger(options.id, 'id'));
                if (tmpl) {
                    console.log(JSON.stringify({ id: tmpl.id, enabled: true }));
                } else {
                    console.log(JSON.stringify({ error: 'Template not found' }));
                    process.exit(1);
                }
            })),
    )
    .addCommand(
        new Command('disable')
            .description(t('禁用模板', 'disable a template', 'desactivar una plantilla'))
            .requiredOption('--id <id>', t('模板 ID', 'template ID', 'ID de la plantilla'))
            .action(async (options) => withDb(async () => {
                const tmpl = await TaskTemplateService.disable(parsePositiveInteger(options.id, 'id'));
                if (tmpl) {
                    console.log(JSON.stringify({ id: tmpl.id, enabled: false }));
                } else {
                    console.log(JSON.stringify({ error: 'Template not found' }));
                    process.exit(1);
                }
            })),
    )
    .addCommand(
        new Command('delete')
            .description(t('删除模板', 'delete a template', 'eliminar una plantilla'))
            .requiredOption('--id <id>', t('模板 ID', 'template ID', 'ID de la plantilla'))
            .action(async (options) => withDb(async () => {
                const id = parsePositiveInteger(options.id, 'id');
                const deleted = await TaskTemplateService.delete(id);
                console.log(JSON.stringify({ deleted, id }));
            })),
    );

const databaseCommand = new Command('db')
    .description(t('数据库检查、备份、清空与恢复', 'check, back up, clear, and restore the database', 'comprobar, respaldar, vaciar y restaurar la base de datos'));

databaseCommand
    .command('check')
    .description(t('检查数据库完整性、外键和业务表统计', 'check integrity, foreign keys, and table counts', 'comprobar integridad, claves foráneas y recuentos de tablas'))
    .option('--json', t('强制输出 JSON（非交互调用默认已输出 JSON）', 'force JSON output (already the default when non-interactive)', 'forzar salida JSON (ya es el valor predeterminado fuera de modo interactivo)'))
    .action(async (options: { json?: boolean }) => withDb(async () => {
        const result = DatabaseMaintenanceService.check();
        console.log(renderDatabaseResult('check', result, { forceJson: options.json, locale: cliLocale }));
        if (!result.ok) process.exitCode = 1;
    }, (error) => renderDatabaseError(error, { forceJson: options.json })));

databaseCommand
    .command('backup')
    .description(t('创建经过完整性校验的一致性备份', 'create a consistent, integrity-checked backup', 'crear una copia de seguridad coherente y verificada'))
    .option('-o, --output <path>', t('备份文件路径（默认写入数据库目录）', 'backup path (defaults to the database directory)', 'ruta de la copia de seguridad (por defecto el directorio de la base de datos)'))
    .option('--json', t('强制输出 JSON（非交互调用默认已输出 JSON）', 'force JSON output (already the default when non-interactive)', 'forzar salida JSON (ya es el valor predeterminado fuera de modo interactivo)'))
    .action(async (options: { output?: string; json?: boolean }) => withDb(async () => {
        const result = DatabaseMaintenanceService.backup(options.output);
        console.log(renderDatabaseResult('backup', result, { forceJson: options.json, locale: cliLocale }));
    }, (error) => renderDatabaseError(error, { forceJson: options.json })));

databaseCommand
    .command('clear')
    .description(t('备份后事务性清空任务、执行记录和定时任务模板', 'back up, then transactionally clear tasks, runs, and scheduled templates', 'hacer copia de seguridad y vaciar de forma transaccional tareas, ejecuciones y plantillas programadas'))
    .option('--confirm <word>', t('危险操作确认，必须填写 CLEAR', 'confirmation word; must be CLEAR', 'palabra de confirmación; debe ser CLEAR'))
    .option('--keep-stopped', t('维护结束后不重启原本由 PM2 管理的 Gateway', 'leave a previously managed Gateway stopped', 'dejar detenido un Gateway gestionado previamente'))
    .option('--json', t('强制输出 JSON（非交互调用默认已输出 JSON）', 'force JSON output (already the default when non-interactive)', 'forzar salida JSON (ya es el valor predeterminado fuera de modo interactivo)'))
    .action(async (options: { confirm?: string; keepStopped?: boolean; json?: boolean }) => withDb(async () => {
        if (options.confirm !== 'CLEAR') {
            throw new Error('清空数据库必须显式传入 --confirm CLEAR');
        }
        const result = runDestructiveDatabaseMaintenance(
            options.keepStopped ?? false,
            () => DatabaseMaintenanceService.clear(),
        );
        console.log(renderDatabaseResult('clear', result, { forceJson: options.json, locale: cliLocale }));
    }, (error) => renderDatabaseError(error, { forceJson: options.json })));

databaseCommand
    .command('restore')
    .description(t('自动备份当前库后，从指定备份恢复数据库', 'back up the live database, then restore from a backup', 'hacer copia de seguridad de la base en vivo y restaurar desde una copia'))
    .requiredOption('--from <path>', t('要恢复的 SQLite 备份文件', 'SQLite backup to restore', 'copia de seguridad SQLite a restaurar'))
    .option('--confirm <word>', t('危险操作确认，必须填写 RESTORE', 'confirmation word; must be RESTORE', 'palabra de confirmación; debe ser RESTORE'))
    .option('--keep-stopped', t('维护结束后不重启原本由 PM2 管理的 Gateway', 'leave a previously managed Gateway stopped', 'dejar detenido un Gateway gestionado previamente'))
    .option('--json', t('强制输出 JSON（非交互调用默认已输出 JSON）', 'force JSON output (already the default when non-interactive)', 'forzar salida JSON (ya es el valor predeterminado fuera de modo interactivo)'))
    .action(async (options: { from: string; confirm?: string; keepStopped?: boolean; json?: boolean }) => withDb(async () => {
        if (options.confirm !== 'RESTORE') {
            throw new Error('恢复数据库必须显式传入 --confirm RESTORE');
        }
        const result = runDestructiveDatabaseMaintenance(
            options.keepStopped ?? false,
            () => DatabaseMaintenanceService.restore(options.from),
        );
        console.log(renderDatabaseResult('restore', result, { forceJson: options.json, locale: cliLocale }));
    }, (error) => renderDatabaseError(error, { forceJson: options.json })));

program.addCommand(databaseCommand);

program
    .command('init')
    .description(t('初始化 SuperTask（创建配置并执行迁移）', 'initialize SuperTask (create config and run migrations)', 'inicializar SuperTask (crear configuración y ejecutar migraciones)'))
    .action(async () => withDb(async () => {
        const { existsSync, mkdirSync, writeFileSync } = await import('fs');
        const { dirname } = await import('path');
        const { getConfigPath } = await import('@gateway/config');
        const configPath = getConfigPath();

        if (!existsSync(configPath)) {
            const dir = dirname(configPath);
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
            writeFileSync(configPath, JSON.stringify({
                configVersion: 2,
                worker: { maxConcurrency: 2 },
                scheduler: { enabled: true },
            }, null, 2) + '\n');
            console.log(JSON.stringify({ created: configPath }));
        } else {
            console.log(JSON.stringify({ exists: configPath }));
        }

        const { getDb } = await import('@core/db');
        getDb();
        console.log(JSON.stringify({ migrated: true }));
    }));

program
    .command('migrate')
    .description(t('执行数据库迁移', 'run database migrations', 'ejecutar migraciones de la base de datos'))
    .action(async () => withDb(async () => {
        const { getDb } = await import('@core/db');
        getDb();
        console.log(JSON.stringify({ migrated: true }));
    }));

program
    .command('gateway')
    .description(t('在前台启动 Gateway', 'start the Gateway in the foreground', 'iniciar el Gateway en primer plano'))
    .action(async () => {
        const { main } = await import('@gateway/index');
        await main();
    });

program
    .command('ui')
    .description(t('打开 Gateway 内置的 Web 管理界面', 'open the Web Dashboard embedded in the Gateway', 'abrir el panel web integrado en el Gateway'))
    .action(async () => {
        const { loadConfig } = await import('@gateway/config');
        const cfg = loadConfig();
        const url = `http://localhost:${cfg.dashboard.port}`;
        console.log(`Dashboard: ${url}`);
        try {
            const { execSync } = await import('child_process');
            const cmd = process.platform === 'win32' ? `start ${url}` : process.platform === 'darwin' ? `open ${url}` : `xdg-open ${url}`;
            execSync(cmd, { stdio: 'ignore' });
        } catch {}
    });

program
    .command('config')
    .description(t('显示当前配置', 'show the current configuration', 'mostrar la configuración actual'))
    .action(async () => {
        const { loadConfig } = await import('@gateway/config');
        const cfg = loadConfig();
        console.log(JSON.stringify(cfg, null, 2));
    });

program
    .command('doctor')
    .description(t('检查 OpenCode、数据库、Gateway、Web 界面和日志轮转', 'diagnose OpenCode, database, Gateway, Dashboard, and log rotation', 'diagnosticar OpenCode, la base de datos, el Gateway, el panel y la rotación de logs'))
    .option('--json', t('强制输出 JSON', 'force JSON output', 'forzar salida JSON'))
    .option('--smoke', t('通过 Gateway 提交一个真实 OpenCode 任务并验证输出', 'queue a real OpenCode task through Gateway and verify its output', 'encolar una tarea real de OpenCode a través del Gateway y verificar su salida'))
    .option('--smoke-agent <agent>', t('真实冒烟任务使用的 Agent', 'Agent used by the real smoke task', 'Agente usado por la tarea smoke real'), 'build')
    .option('--smoke-model <model>', t('真实冒烟任务使用的模型；默认跟随 Agent 配置', 'model used by the real smoke task; defaults to the Agent configuration', 'modelo usado por la tarea smoke real; por defecto la configuración del agente'))
    .option('--smoke-variant <variant>', t('真实冒烟任务使用的模型 variant', 'model variant used by the real smoke task', 'variante del modelo usada por la tarea smoke real'))
    .option('--smoke-cwd <path>', t('真实冒烟任务的项目目录；默认为当前目录', 'project directory for the real smoke task; defaults to the current directory', 'directorio del proyecto para la tarea smoke real; por defecto el directorio actual'))
    .option('--smoke-timeout <duration>', t('真实冒烟任务等待上限，如 2min / 5min', 'real smoke task timeout, e.g. 2min / 5min', 'timeout de la tarea smoke real, p. ej. 2min / 5min'), '3min')
    .action(async (options: {
        json?: boolean;
        smoke?: boolean;
        smokeAgent: string;
        smokeModel?: string;
        smokeVariant?: string;
        smokeCwd?: string;
        smokeTimeout: string;
    }) => withDb(async () => {
        const config = loadConfig();
        const database = DatabaseMaintenanceService.check();
        const legacyQuarantinedRuns = await TaskRunService.listLegacyQuarantinedRuns(
            config.watchdog.heartbeatTimeoutMs,
        );
        const gateway = getGatewayDiagnostic({ probeOpenCode: true });
        const packageVersion = getPackageVersion();
        const opencode = diagnoseOpenCodeRuntime();
        const plugin = getOpenCodePluginDiagnostic();

        let dashboard: { enabled: boolean; ok: boolean; url: string; status: number | null; error: string | null } = {
            enabled: config.dashboard.enabled,
            ok: !config.dashboard.enabled,
            url: `http://127.0.0.1:${config.dashboard.port}/health`,
            status: null,
            error: null,
        };
        if (config.dashboard.enabled) {
            try {
                const response = await fetch(dashboard.url, { signal: AbortSignal.timeout(2000) });
                dashboard = { ...dashboard, ok: response.ok, status: response.status };
            } catch (error) {
                dashboard = {
                    ...dashboard,
                    error: error instanceof Error ? error.message : String(error),
                };
            }
        }

        const warnings: string[] = [];
        const gatewayEntryPinned = gateway.gatewayEntry === null
            || !/[\\/]opencode-supertask@(latest|next)[\\/]/.test(gateway.gatewayEntry);
        const gatewayVersionMatchesPackage = gateway.gatewayPackageVersion !== null
            && gateway.runningVersion === gateway.gatewayPackageVersion;
        const configuredVersionsMatch = plugin.ok
            && plugin.version === gateway.gatewayPackageVersion;
        const cliVersionMatchesPlugin = plugin.ok
            && plugin.version === packageVersion;
        if (!plugin.ok && plugin.error) {
            warnings.push(plugin.error);
        }
        if (plugin.version !== null && plugin.version !== packageVersion) {
            warnings.push(t(
                `当前 CLI v${packageVersion} 与 OpenCode 插件 v${plugin.version} 不一致；执行 supertask upgrade 让 CLI、插件和 Gateway 收敛到同一精确版本`,
                `CLI v${packageVersion} does not match OpenCode plugin v${plugin.version}; run supertask upgrade to converge the CLI, plugin, and Gateway on one exact version`,
            ));
        }
        if (!gatewayEntryPinned) {
            warnings.push(t(
                `PM2 Gateway 仍从浮动缓存路径启动：${gateway.gatewayEntry}`,
                `The PM2 Gateway still starts from a floating cache path: ${gateway.gatewayEntry}`,
            ));
        }
        if (gateway.processFound && gateway.gatewayPackageVersion === null) {
            warnings.push(t(
                `无法从 PM2 Gateway 入口确认 opencode-supertask 包版本：${gateway.gatewayEntry ?? 'unknown'}`,
                `Could not determine the opencode-supertask package version from the PM2 Gateway entry: ${gateway.gatewayEntry ?? 'unknown'}`,
            ));
        } else if (gateway.processFound && !gatewayVersionMatchesPackage) {
            warnings.push(t(
                `Gateway ready 锁版本 ${gateway.runningVersion ?? 'unknown'} 与入口包版本 ${gateway.gatewayPackageVersion ?? 'unknown'} 不一致`,
                `Gateway ready-lock version ${gateway.runningVersion ?? 'unknown'} does not match entry package version ${gateway.gatewayPackageVersion ?? 'unknown'}`,
            ));
        }
        if (plugin.version !== null && gateway.gatewayPackageVersion !== null
            && plugin.version !== gateway.gatewayPackageVersion) {
            warnings.push(t(
                `OpenCode 插件 v${plugin.version} 与 PM2 Gateway v${gateway.gatewayPackageVersion} 不一致；执行 supertask upgrade`,
                `OpenCode plugin v${plugin.version} does not match PM2 Gateway v${gateway.gatewayPackageVersion}; run supertask upgrade`,
            ));
        }
        if (gateway.pm2Installed && !gateway.logRotationInstalled) {
            warnings.push(t(
                '未检测到 pm2-logrotate；长期运行前建议安装并限制日志保留量',
                'pm2-logrotate was not detected; install it and limit log retention before long-running use',
            ));
        }
        if (gateway.startupConfigured === false) {
            warnings.push(process.platform === 'linux'
                ? t('未检测到已启用且包含可恢复 PM2 dump 的 systemd 自启服务', 'No enabled systemd startup service with a recoverable PM2 dump was detected', 'No se detectó un servicio de arranque systemd habilitado con un dump PM2 recuperable')
                : t('未检测到正在运行且包含可恢复 PM2 dump 的 macOS LaunchAgent', 'No running macOS LaunchAgent with a recoverable PM2 dump was detected', 'No se detectó un LaunchAgent de macOS en ejecución con un dump PM2 recuperable'));
        }
        if (gateway.processFound && !gateway.scopeMatches) {
            warnings.push(t(
                '当前 CLI/OpenCode 与 PM2 Gateway 的数据库、配置或 OpenCode 可执行文件作用域不一致',
                'The current CLI/OpenCode database, config, or OpenCode executable scope does not match the PM2 Gateway',
            ));
        }
        if (gateway.processFound && gateway.gatewayOpenCode?.ok !== true) {
            warnings.push(t(
                `PM2 保存的 Gateway 环境无法执行 OpenCode：${gateway.gatewayOpenCode?.error ?? '无法读取运行环境'}`,
                `The Gateway environment saved by PM2 cannot execute OpenCode: ${gateway.gatewayOpenCode?.error ?? 'runtime unavailable'}`,
            ));
        }
        for (const run of legacyQuarantinedRuns) {
            const cwdHint = run.taskCwd == null
                ? t('（旧任务没有 cwd，请先在 Dashboard 取消）', ' (the legacy task has no cwd; cancel it in the Dashboard first)', ' (la tarea legacy no tiene cwd; cancélala primero en el panel)')
                : t(`（在 ${run.taskCwd} 执行）`, ` (run in ${run.taskCwd})`, ` (ejecutar en ${run.taskCwd})`);
            const cancel = run.taskStatus === 'cancelled'
                ? ''
                : t(`先${cwdHint} supertask cancel --id ${run.taskId}；`, `first${cwdHint}: supertask cancel --id ${run.taskId}; `, `primero${cwdHint}: supertask cancel --id ${run.taskId}; `);
            const owner = run.ownerAlive
                ? t(`owner PID ${run.workerPid} 仍存活，先确认并停止对应进程；`, `owner PID ${run.workerPid} is still alive; confirm and stop it first; `, `el PID propietario ${run.workerPid} sigue activo; confírmalo y detenlo primero; `)
                : '';
            warnings.push(t(
                `旧版隔离 run #${run.runId}：${owner}${cancel}确认没有遗留 OpenCode 进程后执行 supertask run abandon --id ${run.runId} --confirm ABANDON`,
                `Legacy quarantined run #${run.runId}: ${owner}${cancel}after confirming no OpenCode process remains, run supertask run abandon --id ${run.runId} --confirm ABANDON`,
            ));
        }
        let smoke: DoctorSmokeResult | {
            ok: false;
            skipped: true;
            error: string;
        } | null = null;
        if (options.smoke) {
            const gatewayCanExecute = gateway.status === 'online'
                && gateway.ready
                && gateway.scopeMatches
                && gateway.gatewayOpenCode?.ok === true;
            if (!gatewayCanExecute) {
                smoke = {
                    ok: false,
                    skipped: true,
                    error: t(
                        'Gateway 尚未就绪，或其 PM2 环境无法执行 OpenCode；已跳过真实任务',
                        'Gateway is not ready or its PM2 environment cannot execute OpenCode; the real task was skipped',
                    ),
                };
            } else {
                const smokeTimeoutMs = parseDuration(options.smokeTimeout);
                if (smokeTimeoutMs === null) throw new Error('smoke-timeout 格式无效');
                smoke = await runDoctorSmoke({
                    agent: options.smokeAgent,
                    model: options.smokeModel,
                    variant: options.smokeVariant,
                    cwd: options.smokeCwd ?? process.cwd(),
                    timeoutMs: smokeTimeoutMs,
                });
            }
            if (!smoke.ok) warnings.push(smoke.error ?? t('真实冒烟任务失败', 'Real smoke task failed', 'La tarea smoke real falló'));
        }
        const ok = opencode.ok
            && plugin.ok
            && database.ok
            && legacyQuarantinedRuns.length === 0
            && gateway.pm2Installed
            && gateway.status === 'online'
            && gateway.ready
            && gatewayEntryPinned
            && gatewayVersionMatchesPackage
            && configuredVersionsMatch
            && cliVersionMatchesPlugin
            && gateway.scopeMatches
            && gateway.gatewayOpenCode?.ok === true
            && gateway.logRotationInstalled
            && gateway.startupConfigured !== false
            && dashboard.ok
            && (!options.smoke || smoke?.ok === true);
        const report = {
            ok,
            packageVersion,
            cliVersionMatchesPlugin,
            configPath: getConfigPath(),
            opencode,
            plugin,
            database,
            legacyQuarantinedRuns,
            gateway,
            dashboard,
            smoke,
            warnings,
        };

        const json = options.json || !process.stdout.isTTY;
        if (json) {
            console.log(JSON.stringify(report, null, 2));
        } else {
            const mark = (value: boolean) => value ? '✓' : '✗';
            console.log(`SuperTask doctor: ${ok ? t('正常', 'healthy', 'saludable') : t('异常', 'unhealthy', 'no saludable')}`);
            console.log(`${mark(opencode.ok)} OpenCode ${opencode.version ?? opencode.error ?? t('不可用', 'unavailable', 'no disponible')}`);
            console.log(`${mark(gateway.gatewayOpenCode?.ok === true)} ${t('Gateway 环境中的 OpenCode', 'OpenCode in Gateway environment', 'OpenCode en el entorno del Gateway')} ${gateway.gatewayOpenCode?.version ?? gateway.gatewayOpenCode?.error ?? t('不可用', 'unavailable', 'no disponible')}${gateway.gatewayOpenCode?.executable ? `，${gateway.gatewayOpenCode.executable}` : ''}`);
            console.log(`${mark(plugin.ok)} ${t('OpenCode 插件', 'OpenCode plugin', 'plugin de OpenCode')} ${plugin.spec || plugin.error || t('未配置', 'not configured', 'no configurado')}${plugin.cachedVersion ? t(`（缓存 v${plugin.cachedVersion}）`, ` (cached v${plugin.cachedVersion})`, ` (en caché v${plugin.cachedVersion})`) : ''}`);
            console.log(`${mark(database.ok)} ${t('数据库', 'Database', 'Base de datos')} ${database.path}${t(`（任务 ${database.counts.tasks}，运行中 ${database.runningTasks}）`, ` (tasks ${database.counts.tasks}, running ${database.runningTasks})`, ` (tareas ${database.counts.tasks}, en ejecución ${database.runningTasks})`)}`);
            console.log(`${mark(gateway.status === 'online' && gateway.ready && gatewayEntryPinned && gatewayVersionMatchesPackage)} Gateway ${gateway.status ?? 'missing'}${gateway.pid ? `，PID ${gateway.pid}` : ''}${gateway.runningVersion ? `，v${gateway.runningVersion}` : ''}${gateway.gatewayEntry ? `，${gateway.gatewayEntry}` : ''}`);
            console.log(`${mark(dashboard.ok)} Dashboard ${dashboard.enabled ? dashboard.url : t('已禁用', 'disabled', 'desactivado')}`);
            if (options.smoke) {
                const smokeSummary = smoke && 'taskId' in smoke
                    ? `task #${smoke.taskId}${smoke.runId ? ` / run #${smoke.runId}` : ''}，${smoke.durationMs}ms`
                    : smoke?.error ?? t('未执行', 'not run', 'no ejecutado');
                console.log(`${mark(smoke?.ok === true)} ${t('真实 Gateway 冒烟任务', 'Real Gateway smoke task', 'Tarea smoke real del Gateway')} ${smokeSummary}`);
            }
            for (const warning of warnings) console.log(`! ${warning}`);
        }
        if (!ok) process.exitCode = 1;
    }));

program
    .command('install')
    .description(t('用 PM2 安装 Gateway（开机启动、崩溃恢复、日志轮转）', 'install the Gateway with PM2 (startup, crash recovery, log rotation)', 'instalar el Gateway con PM2 (arranque, recuperación ante fallos y rotación de logs)'))
    .action(async () => {
        try {
            const { install: pm2Install } = await import('../daemon/pm2');
            pm2Install();
        } catch (err) {
            console.error(err instanceof Error ? err.message : String(err));
            process.exit(1);
        }
    });

program
    .command('uninstall')
    .description(t('停止并移除 PM2 Gateway', 'stop and remove the PM2 Gateway', 'detener y eliminar el Gateway de PM2'))
    .action(async () => {
        try {
            const { uninstall: pm2Uninstall } = await import('../daemon/pm2');
            pm2Uninstall();
        } catch (err) {
            console.error(err instanceof Error ? err.message : String(err));
            process.exit(1);
        }
    });

program
    .command('upgrade')
    .description(t('更新 OpenCode 插件、CLI 和 Gateway；已是最新版本时不重启', 'update the OpenCode plugin, CLI, and Gateway without restarting when already current', 'actualizar el plugin de OpenCode, la CLI y el Gateway sin reiniciar si ya están al día'))
    .option('--force', t('即使已是最新版本也重新安装并重启 Gateway', 'reinstall and restart the Gateway even when already current', 'reinstalar y reiniciar el Gateway aunque ya esté al día'))
    .action(async (options: { force?: boolean }) => {
        console.log(t('正在检查 opencode-supertask 更新...', 'Checking for opencode-supertask updates...', 'Comprobando actualizaciones de opencode-supertask...'));
        let installed: { gatewayEntry: string; version: string };
        let previousVersion: string;
        let targetVersion: string;
        let updater: typeof import('../daemon/update');
        try {
            updater = await import('../daemon/update');
            const { getGatewayDiagnostic } = await import('../daemon/pm2');
            targetVersion = updater.getLatestVersion();
            const plugin = updater.getOpenCodePluginDiagnostic();
            const cli = updater.getGlobalCliDiagnostic();
            const gateway = getGatewayDiagnostic();
            if (!options.force && updater.isVersionConverged(targetVersion, {
                packageVersion: getPackageVersion(),
                plugin,
                cli,
                gateway,
            })) {
                console.log(t(
                    `SuperTask 已是最新版本 v${targetVersion}，无需升级；Gateway 未重启。`,
                    `SuperTask is already up to date at v${targetVersion}; the Gateway was not restarted.`,
                ));
                return;
            }
            previousVersion = plugin.version ?? updater.resolveInstalledPlugin().version;
        } catch (error) {
            console.error(t('无法检查当前版本，已取消升级：', 'Could not check the current version; upgrade cancelled: ', 'No se pudo comprobar la versión actual; actualización cancelada: ')
                + (error instanceof Error ? error.message : String(error)));
            process.exit(1);
        }
        console.log(t('正在更新 opencode-supertask...', 'Updating opencode-supertask...', 'Actualizando opencode-supertask...'));
        try {
            installed = updater.installPluginVersion(targetVersion);
        } catch (err) {
            let detail = err instanceof Error ? err.message : String(err);
            try {
                updater.installPluginVersion(previousVersion);
            } catch (rollbackError) {
                detail += `; OpenCode 插件回滚失败: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`;
            }
            console.error(detail);
            console.error(t(
                '可人工查询 npm dist-tags.latest，再用 opencode plugin 安装该精确版本。',
                'Try manually: query npm dist-tags.latest, then install that exact version with opencode plugin.',
            ));
            process.exit(1);
        }

        try {
            const { upgrade: pm2Upgrade } = await import('../daemon/pm2');
            const result = pm2Upgrade(installed);
            console.log(t(
                `\nSuperTask 已升级：${result.before ?? 'unknown'} → ${result.after}`,
                `\nSuperTask upgraded: ${result.before ?? 'unknown'} → ${result.after}`,
            ));
            console.log(t('Gateway 已重启。请重启 OpenCode 加载新插件。', 'Gateway restarted. Restart OpenCode to load the new plugin.', 'Gateway reiniciado. Reinicia OpenCode para cargar el plugin nuevo.'));
            try {
                const { updateGlobalCli } = await import('../daemon/update');
                const cli = updateGlobalCli(installed.version);
                if (cli.action === 'updated') {
                    console.log(t(
                        `已使用 ${cli.packageManager} 将全局 CLI 更新到 v${installed.version}。`,
                        `Global CLI updated to v${installed.version} with ${cli.packageManager}.`,
                    ));
                } else if (cli.action === 'not-installed') {
                    console.log(t('未找到全局 CLI；插件和 Gateway 升级已完成。', 'No global CLI installation was found; plugin and Gateway upgrade is complete.', 'No se encontró una instalación global de la CLI; la actualización del plugin y del Gateway ha terminado.'));
                }
            } catch (cliError) {
                console.error(t('插件和 Gateway 已升级，但全局 CLI 未更新：', 'Plugin and Gateway were upgraded, but the global CLI was not: ', 'Se actualizaron el plugin y el Gateway, pero no la CLI global: ')
                    + (cliError instanceof Error ? cliError.message : String(cliError)));
                console.error(t(
                    `执行 npm install -g opencode-supertask@${installed.version} 或 bun add -g opencode-supertask@${installed.version}，再运行 supertask doctor。`,
                    `Run npm install -g opencode-supertask@${installed.version} or bun add -g opencode-supertask@${installed.version}, then run supertask doctor.`,
                ));
                process.exit(1);
            }
        } catch (err) {
            let detail = err instanceof Error ? err.message : String(err);
            try {
                if (previousVersion !== installed.version) {
                    updater.installPluginVersion(previousVersion);
                }
            } catch (rollbackError) {
                detail += `; Gateway 已回滚，但 OpenCode 插件回滚失败: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`;
            }
            console.error(t('Gateway 重启失败：', 'Gateway restart failed:', 'Falló el reinicio del Gateway:'), detail);
            process.exit(1);
        }
    });

program.parse();
