import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
    clearDashboardGatewayDiagnosticCache,
    getDashboardGatewayDiagnostic,
} from '../src/web/gateway-diagnostic';

const originalPm2Bin = process.env.SUPERTASK_PM2_BIN;
const originalPm2Timeout = process.env.SUPERTASK_PM2_COMMAND_TIMEOUT_MS;
const directories: string[] = [];

afterEach(() => {
    clearDashboardGatewayDiagnosticCache();
    if (originalPm2Bin === undefined) delete process.env.SUPERTASK_PM2_BIN;
    else process.env.SUPERTASK_PM2_BIN = originalPm2Bin;
    if (originalPm2Timeout === undefined) delete process.env.SUPERTASK_PM2_COMMAND_TIMEOUT_MS;
    else process.env.SUPERTASK_PM2_COMMAND_TIMEOUT_MS = originalPm2Timeout;
    for (const directory of directories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

describe('Dashboard Gateway 诊断', () => {
    test('慢 PM2 探测不阻塞事件循环，并合并并发请求与缓存结果', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'supertask-dashboard-diagnostic-'));
        directories.push(directory);
        const executable = join(directory, 'pm2');
        const calls = join(directory, 'calls');
        writeFileSync(executable, `#!/bin/sh
printf x >> ${JSON.stringify(calls)}
sleep 1
exit 1
`);
        chmodSync(executable, 0o755);
        process.env.SUPERTASK_PM2_BIN = executable;
        process.env.SUPERTASK_PM2_COMMAND_TIMEOUT_MS = '100';

        const first = getDashboardGatewayDiagnostic();
        const second = getDashboardGatewayDiagnostic();
        const timerWon = await Promise.race([
            Bun.sleep(20).then(() => true),
            first.then(() => false),
        ]);
        expect(timerWon).toBe(true);

        const [firstResult, secondResult] = await Promise.all([first, second]);
        expect(firstResult.pm2Installed).toBe(false);
        expect(secondResult).toEqual(firstResult);
        expect(readFileSync(calls, 'utf8')).toBe('x');

        expect((await getDashboardGatewayDiagnostic()).pm2Installed).toBe(false);
        expect(readFileSync(calls, 'utf8')).toBe('x');

        expect((await getDashboardGatewayDiagnostic({ fresh: true })).pm2Installed).toBe(false);
        expect(readFileSync(calls, 'utf8')).toBe('xx');
    });
});
