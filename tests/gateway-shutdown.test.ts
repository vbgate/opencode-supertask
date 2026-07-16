import { describe, expect, test } from 'bun:test';
import {
    resolveGatewayShutdownExitCode,
    runGatewayShutdownStep,
    type GatewayShutdownFailure,
} from '../src/gateway';

describe('Gateway shutdown convergence', () => {
    test('单个步骤抛错时记录失败并继续执行后续清理', async () => {
        const failures: GatewayShutdownFailure[] = [];
        const executed: string[] = [];

        await runGatewayShutdownStep(failures, 'worker.stop', () => {
            executed.push('worker.stop');
            throw new Error('模拟 Worker 停机失败');
        });
        await runGatewayShutdownStep(failures, 'lock.release', () => {
            executed.push('lock.release');
        });
        await runGatewayShutdownStep(failures, 'database.close', () => {
            executed.push('database.close');
        });

        expect(executed).toEqual(['worker.stop', 'lock.release', 'database.close']);
        expect(failures).toEqual([{
            step: 'worker.stop',
            error: '模拟 Worker 停机失败',
        }]);
        expect(resolveGatewayShutdownExitCode(0, failures)).toBe(1);
        expect(resolveGatewayShutdownExitCode(1, [])).toBe(1);
        expect(resolveGatewayShutdownExitCode(0, [])).toBe(0);
    });
});
