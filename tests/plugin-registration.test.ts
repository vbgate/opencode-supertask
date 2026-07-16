import { beforeEach, describe, expect, test } from 'bun:test';
import { SuperTaskPlugin } from '../plugin/supertask';
import { setupTestDb } from './helpers/mock-db';
import { TaskService } from '../src/core/services/task.service';

describe('OpenCode 插件注册', () => {
    beforeEach(() => {
        setupTestDb();
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
});
