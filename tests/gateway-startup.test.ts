import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawn, spawnSync } from 'child_process';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const tempDirectories: string[] = [];

afterEach(() => {
    for (const directory of tempDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

describe('Gateway startup barrier', () => {
    test('Dashboard 绑定失败时 Worker 不会执行任务，且启动锁会释放', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'supertask-startup-'));
        tempDirectories.push(directory);
        const databasePath = join(directory, 'tasks.db');
        const configPath = join(directory, 'supertask.json');
        const executionMarker = join(directory, 'opencode-executed');
        const fakeOpencode = join(directory, 'opencode');
        writeFileSync(fakeOpencode, `#!/usr/bin/env bun\nawait Bun.write(${JSON.stringify(executionMarker)}, 'executed');\n`);
        chmodSync(fakeOpencode, 0o755);

        const blocker = Bun.serve({
            hostname: '127.0.0.1',
            port: 0,
            fetch: () => new Response('occupied'),
        });
        writeFileSync(configPath, JSON.stringify({
            configVersion: 2,
            worker: { pollIntervalMs: 50, heartbeatIntervalMs: 1_000 },
            scheduler: { enabled: false },
            watchdog: {
                heartbeatTimeoutMs: 10_000,
                checkIntervalMs: 1_000,
                cleanupIntervalMs: 60_000,
            },
            dashboard: { enabled: true, port: blocker.port },
        }));

        const environment = {
            ...process.env,
            SUPERTASK_DB_PATH: databasePath,
            SUPERTASK_CONFIG_PATH: configPath,
            SUPERTASK_OPENCODE_BIN: fakeOpencode,
        };
        const seed = spawnSync(process.execPath, ['-e', `
            import { TaskService } from ${JSON.stringify(join(projectRoot, 'src/core/services/task.service.ts'))};
            await TaskService.add({ name: '不得执行', agent: 'test-agent', prompt: 'startup barrier' });
        `], { cwd: projectRoot, env: environment, encoding: 'utf8' });
        expect(seed.status).toBe(0);

        try {
            const gateway = spawn(process.execPath, ['src/gateway/index.ts'], {
                cwd: projectRoot,
                env: environment,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            let output = '';
            gateway.stdout.on('data', (chunk) => { output += chunk.toString(); });
            gateway.stderr.on('data', (chunk) => { output += chunk.toString(); });
            const exitCode = await new Promise<number | null>((resolve, reject) => {
                const timeout = setTimeout(() => {
                    gateway.kill('SIGKILL');
                    reject(new Error(`Gateway 未按预期退出：${output}`));
                }, 5_000);
                gateway.once('close', (code) => {
                    clearTimeout(timeout);
                    resolve(code);
                });
            });

            expect(exitCode).toBe(1);
            expect(output).toContain('Gateway startup failed');
            expect(await Bun.file(executionMarker).exists()).toBe(false);

            const sqlite = new Database(databasePath, { readonly: true });
            try {
                const lock = sqlite.query('SELECT count(*) AS count FROM gateway_lock').get() as { count: number };
                const task = sqlite.query('SELECT status FROM tasks').get() as { status: string };
                const runs = sqlite.query('SELECT count(*) AS count FROM task_runs').get() as { count: number };
                expect(lock.count).toBe(0);
                expect(task.status).toBe('pending');
                expect(runs.count).toBe(0);
            } finally {
                sqlite.close();
            }
        } finally {
            blocker.stop(true);
        }
    });
});
