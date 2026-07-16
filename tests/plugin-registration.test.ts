import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { shouldAttemptGatewayReplacement, SuperTaskPlugin } from '../plugin/supertask';
import { setupTestDb } from './helpers/mock-db';
import { TaskService } from '../src/core/services/task.service';
import { MANAGED_RUN_ENV, MANAGED_RUN_ENV_VALUE } from '../src/core/launch-protocol';

const originalPm2Bin = process.env.SUPERTASK_PM2_BIN;

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

    test('任务作用域使用 OpenCode 工具上下文目录，忽略调用者伪造的 cwd', async () => {
        const hooks = await SuperTaskPlugin({} as Parameters<typeof SuperTaskPlugin>[0]);
        const add = hooks.tool?.supertask_add;
        if (!add) throw new Error('supertask_add 未注册');
        const context = {
            directory: '/actual/project',
        } as Parameters<typeof add.execute>[1];

        const output = JSON.parse(await add.execute({
            name: '上下文隔离',
            agent: 'build',
            prompt: '验证 cwd',
            cwd: '/forged/project',
        }, context)) as { id: number };

        expect((await TaskService.getById(output.id))?.cwd).toBe('/actual/project');
    });

    test('Gateway 管理的队列任务拒绝在自身进程树内升级', async () => {
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
