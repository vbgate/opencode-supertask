import { rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const databasePath = join(tmpdir(), `supertask-browser-${process.pid}.db`);
const configPath = join(tmpdir(), `supertask-browser-${process.pid}.json`);
process.env.SUPERTASK_DB_PATH = databasePath;
// 隔离 Gateway 配置，并预置不能被旧表单单位/步长表达的合法值（1.5 分钟、0.5 小时）。
process.env.SUPERTASK_CONFIG_PATH = configPath;
writeFileSync(configPath, JSON.stringify({
    configVersion: 2,
    worker: { taskTimeoutMs: 90_000 },
    watchdog: { cleanupIntervalMs: 1_800_000 },
}));

const [{ dashboardApp }, { closeDb }, { TaskService }, { TaskRunService }] = await Promise.all([
    import('../../src/web/index'),
    import('../../src/core/db'),
    import('../../src/core/services/task.service'),
    import('../../src/core/services/task-run.service'),
]);

const seededTask = await TaskService.add({ name: 'Resumable run', agent: 'build', prompt: 'seed', cwd: tmpdir() });
await TaskService.start(seededTask.id);
const seededRun = await TaskRunService.create({ taskId: seededTask.id, status: 'running' });
await TaskRunService.updateSessionId(seededRun.id, 'ses_browserSeed1');
await TaskRunService.done(seededRun.id, JSON.stringify({
    type: 'supertask_command',
    executable: '/opt/opencode-v1/opencode',
    args: ['run', '--agent', 'build', '--format', 'json', 'seed'],
    cwd: '/tmp/browser project',
}));
await TaskService.done(seededTask.id, 'ok');
await TaskService.add({
    name: 'Odd durations', agent: 'build', prompt: 'edit me', cwd: tmpdir(), retryBackoffMs: 12_345, timeoutMs: 1_250,
});
const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 4780,
    fetch: dashboardApp.fetch,
});

const shutdown = () => {
    server.stop(true);
    closeDb();
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${databasePath}${suffix}`, { force: true });
    rmSync(configPath, { force: true });
    process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
