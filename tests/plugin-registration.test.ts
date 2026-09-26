import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import SuperTaskDefault, { setupSuperTaskV2, shouldAttemptGatewayReplacement, SuperTaskPlugin, type V2PluginContext } from '../plugin/supertask';
import { setupTestDb } from './helpers/mock-db';
import { TaskService } from '../src/core/services/task.service';
import { MANAGED_RUN_ENV, MANAGED_RUN_ENV_VALUE } from '../src/core/launch-protocol';

const originalPm2Bin = process.env.SUPERTASK_PM2_BIN;

interface RuntimeSchema {
    description?: string;
    safeParse(value: unknown): { success: boolean };
}

describe('OpenCode 插件注册', () => {
    beforeEach(() => {
        setupTestDb();
        process.env.SUPERTASK_PM2_BIN = '/definitely/missing/supertask-test-pm2';
    });

    afterAll(() => {
        if (originalPm2Bin === undefined) delete process.env.SUPERTASK_PM2_BIN;
        else process.env.SUPERTASK_PM2_BIN = originalPm2Bin;
    });

    test('只注册不会绕过 Gateway 执行所有权的 8 个工具并注入系统说明', async () => {
        const hooks = await SuperTaskPlugin({} as Parameters<typeof SuperTaskPlugin>[0]);
        expect(Object.keys(hooks.tool ?? {}).sort()).toEqual([
            'supertask_add',
            'supertask_get',
            'supertask_list',
            'supertask_next',
            'supertask_retry',
            'supertask_schedule',
            'supertask_status',
            'supertask_upgrade',
        ]);

        const output = { system: [] as string[] };
        await hooks['experimental.chat.system.transform']?.(
            {} as Parameters<NonNullable<typeof hooks['experimental.chat.system.transform']>>[0],
            output,
        );
        expect(output.system).toHaveLength(1);
        expect(output.system[0]).toContain('supertask_schedule');
        expect(output.system[0]).toContain('所有具有相同非空 `batchId` 的任务也不会同时执行');
        expect(output.system[0]).toContain('即使任务属于不同项目目录');
        expect(output.system[0]).toContain('`globalBatch.activeRunning`');
        expect(output.system[0]).toContain('若任务 B 必须等待任务 A 完成');

        const add = hooks.tool?.supertask_add;
        const schedule = hooks.tool?.supertask_schedule;
        if (!add || !schedule) throw new Error('任务创建工具未注册');
        const addArgs = add.args as unknown as { batchId: RuntimeSchema; variant: RuntimeSchema };
        const scheduleArgs = schedule.args as unknown as {
            batchId: RuntimeSchema;
            variant: RuntimeSchema;
            max_instances: RuntimeSchema;
        };
        expect(add.description).toContain('跨项目的相同非空 batchId 任务全局严格串行');
        expect(scheduleArgs.batchId.description).toContain('不会同时执行');
        expect(scheduleArgs.max_instances.description).toContain('自动调度');
        expect(scheduleArgs.max_instances.description).toContain('排队');
        expect(scheduleArgs.max_instances.description).toContain('手动立即运行不受此限制');
        expect(addArgs.batchId.safeParse(undefined).success).toBe(true);
        expect(addArgs.batchId.safeParse('').success).toBe(false);
        expect(addArgs.variant.safeParse('xhigh').success).toBe(true);
        expect(addArgs.variant.safeParse('   ').success).toBe(false);
        expect(scheduleArgs.variant.safeParse('high').success).toBe(true);
        expect(scheduleArgs.batchId.safeParse('   ').success).toBe(false);
    });

    test('默认导出同时满足 1.x server 与 2.x setup 加载器', () => {
        expect(SuperTaskDefault.id).toBe('opencode-supertask');
        expect(SuperTaskDefault.server).toBe(SuperTaskPlugin);
        expect(SuperTaskDefault.setup).toBe(setupSuperTaskV2);
    });

    test('OpenCode 2.x 每个项目位置各自注册工具并按该位置限定 cwd、注入系统说明', async () => {
        const locations = [process.cwd(), tmpdir()];
        const registered: Array<{ directory: string; tools: Map<string, (input: unknown) => Promise<{ content: string }>> }> = [];
        const systems: string[][] = [];
        for (const directory of locations) {
            const tools = new Map<string, (input: unknown) => Promise<{ content: string }>>();
            const context: V2PluginContext = {
                location: { directory },
                tool: {
                    transform: async (callback) => {
                        callback({ add: (tool) => {
                            expect(tool.input).toMatchObject({ type: 'object' });
                            expect(tool.input).not.toHaveProperty('$schema');
                            tools.set(tool.name, tool.execute);
                        } });
                    },
                },
                session: {
                    hook: async (_name, callback) => {
                        const event = { system: [] as Array<{ type: 'text'; text: string }> };
                        callback(event);
                        systems.push(event.system.map((part) => part.text));
                    },
                },
            };
            await setupSuperTaskV2(context);
            registered.push({ directory, tools });
        }

        for (const { directory, tools } of registered) {
            expect([...tools.keys()].sort()).toEqual([
                'supertask_add', 'supertask_get', 'supertask_list', 'supertask_next',
                'supertask_retry', 'supertask_schedule', 'supertask_status', 'supertask_upgrade',
            ]);
            const added = JSON.parse((await tools.get('supertask_add')!({ name: '  v2  ', agent: 'build', prompt: 'p' })).content) as { id: number };
            expect(await TaskService.getById(added.id)).toMatchObject({ name: 'v2', cwd: directory });
            const invalid = JSON.parse((await tools.get('supertask_add')!({ name: '', agent: 'build', prompt: 'p' })).content) as { error?: string };
            expect(invalid.error).toBeTruthy();
        }
        expect(systems).toHaveLength(2);
        expect(systems[0][0]).toContain('supertask_schedule');
    });

    test('按 batchId 查询时同时返回当前项目和跨项目占用状态', async () => {
        const otherProjectTask = await TaskService.add({
            name: '其他项目批次任务',
            agent: 'build',
            prompt: '占用全局批次',
            cwd: '/tmp',
            batchId: 'shared-batch',
        });
        await TaskService.start(otherProjectTask.id);

        const hooks = await SuperTaskPlugin({} as Parameters<typeof SuperTaskPlugin>[0]);
        const status = hooks.tool?.supertask_status;
        if (!status) throw new Error('supertask_status 未注册');
        const result = JSON.parse(await status.execute(
            { batchId: 'shared-batch' },
            { directory: process.cwd() } as Parameters<typeof status.execute>[1],
        )) as {
            total: number;
            activeRunning: number;
            blockedByOtherProject: boolean;
            globalBatch: { total: number; activeRunning: number };
        };

        expect(result.total).toBe(0);
        expect(result.activeRunning).toBe(0);
        expect(result.globalBatch).toMatchObject({ total: 1, activeRunning: 1 });
        expect(result.blockedByOtherProject).toBe(true);
    });

    test('新插件可自动替换旧 Gateway，旧 OpenCode 进程不会反向降级新 Gateway', () => {
        expect(shouldAttemptGatewayReplacement('0.1.28', '0.1.27')).toBe(true);
        expect(shouldAttemptGatewayReplacement('0.1.27', '0.1.28')).toBe(false);
        expect(shouldAttemptGatewayReplacement('0.2.0-beta.1', '0.2.0')).toBe(false);
        expect(shouldAttemptGatewayReplacement('0.2.0', '0.2.0-beta.2')).toBe(true);
        expect(shouldAttemptGatewayReplacement('0.2.0-beta.2', '0.2.0-beta.1')).toBe(true);
        expect(shouldAttemptGatewayReplacement('0.2.0-beta.1', '0.2.0-beta.2')).toBe(false);
        expect(shouldAttemptGatewayReplacement('0.1.28', null)).toBe(true);
        expect(shouldAttemptGatewayReplacement('invalid', '0.1.27')).toBe(false);
    });

    test('锁中记录更新版本的 Gateway 即使暂未就绪，旧插件也不会调用 PM2 替换它', () => {
        const dir = mkdtempSync(join(tmpdir(), 'supertask-plugin-downgrade-'));
        try {
            const pm2Log = join(dir, 'pm2.log');
            const fakePm2 = join(dir, 'pm2');
            writeFileSync(fakePm2, `#!/bin/sh\necho "$@" >> ${JSON.stringify(pm2Log)}\necho '[]'\n`, { mode: 0o755 });
            const script = `
const { sqlite } = await import(${JSON.stringify(join(process.cwd(), 'src/core/db/index.ts'))});
sqlite.query('INSERT OR REPLACE INTO gateway_lock (id, pid, acquired_at, heartbeat_at, ready_at, version) VALUES (1, 999999, 1, 1, 1, ?)').run('999.0.0');
const { SuperTaskPlugin } = await import(${JSON.stringify(join(process.cwd(), 'plugin/supertask.ts'))});
const hooks = await SuperTaskPlugin({});
const output = await hooks.tool.supertask_add.execute({ name: 'n', agent: 'build', prompt: 'p' }, { directory: process.cwd() });
console.log(output);
`;
            const result = spawnSync(process.execPath, ['-e', script], {
                cwd: process.cwd(),
                encoding: 'utf8',
                timeout: 30_000,
                env: { ...process.env, SUPERTASK_DB_PATH: join(dir, 'tasks.db'), SUPERTASK_PM2_BIN: fakePm2 },
            });
            expect(result.status).toBe(0);
            expect(JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}').error).toContain('999.0.0');
            expect(existsSync(pm2Log)).toBe(false);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('任务作用域使用 OpenCode 工具上下文目录，忽略调用者伪造的 cwd', async () => {
        const hooks = await SuperTaskPlugin({} as Parameters<typeof SuperTaskPlugin>[0]);
        const add = hooks.tool?.supertask_add;
        if (!add) throw new Error('supertask_add 未注册');
        const context = {
            directory: process.cwd(),
        } as Parameters<typeof add.execute>[1];

        const output = JSON.parse(await add.execute({
            name: '上下文隔离',
            agent: 'build',
            prompt: '验证 cwd',
            model: 'openai/gpt-5.6-sol',
            variant: 'xhigh',
            cwd: `${process.cwd()}/package.json`,
        }, context)) as { id: number };

        expect(await TaskService.getById(output.id)).toMatchObject({
            cwd: process.cwd(),
            model: 'openai/gpt-5.6-sol',
            variant: 'xhigh',
        });
    });

    test('Gateway 管理的队列任务拒绝在自身受管执行上下文内升级', async () => {
        const originalManagedRun = process.env[MANAGED_RUN_ENV];
        process.env[MANAGED_RUN_ENV] = MANAGED_RUN_ENV_VALUE;
        try {
            const hooks = await SuperTaskPlugin({} as Parameters<typeof SuperTaskPlugin>[0]);
            const upgrade = hooks.tool?.supertask_upgrade;
            if (!upgrade) throw new Error('supertask_upgrade 未注册');

            const output = JSON.parse(await upgrade.execute(
                {},
                {} as Parameters<typeof upgrade.execute>[1],
            )) as { success: boolean; error: string; hint: string };

            expect(output.success).toBe(false);
            expect(output.error).toContain('不能升级');
            expect(output.hint).toContain('supertask upgrade');
        } finally {
            if (originalManagedRun === undefined) delete process.env[MANAGED_RUN_ENV];
            else process.env[MANAGED_RUN_ENV] = originalManagedRun;
        }
    });
});
