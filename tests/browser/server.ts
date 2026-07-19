import { rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const databasePath = join(tmpdir(), `supertask-browser-${process.pid}.db`);
process.env.SUPERTASK_DB_PATH = databasePath;

const [{ dashboardApp }, { closeDb }] = await Promise.all([
    import('../../src/web/index'),
    import('../../src/core/db'),
]);
const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 4780,
    fetch: dashboardApp.fetch,
});

const shutdown = () => {
    server.stop(true);
    closeDb();
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${databasePath}${suffix}`, { force: true });
    process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
