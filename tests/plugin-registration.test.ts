import { describe, expect, test } from 'bun:test';
import { SuperTaskPlugin } from '../plugin/supertask';

describe('OpenCode 插件注册', () => {
    test('注册完整的 11 个 supertask 工具并注入系统说明', async () => {
        const hooks = await SuperTaskPlugin({} as Parameters<typeof SuperTaskPlugin>[0]);
        expect(Object.keys(hooks.tool ?? {}).sort()).toEqual([
            'supertask_add',
            'supertask_done',
            'supertask_fail',
            'supertask_get',
            'supertask_list',
            'supertask_next',
            'supertask_retry',
            'supertask_schedule',
            'supertask_start',
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
});
