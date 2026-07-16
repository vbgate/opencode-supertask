import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { ManagementLockBusyError, withExclusiveManagementLock } from './management-lock';

const PROCESS_NAME = 'supertask-gateway';
const POLL_INTERVAL_MS = 5_000;

interface Pm2ProcessSnapshot {
    name?: unknown;
    pm2_env?: { status?: unknown };
}

function pm2Home(env: NodeJS.ProcessEnv): string {
    const home = resolve(env.HOME || homedir());
    return env.PM2_HOME ? resolve(env.PM2_HOME) : join(home, '.pm2');
}

function managementLockPaths(env: NodeJS.ProcessEnv): string[] {
    const canonical = join(pm2Home(env), 'supertask-gateway.manage.sqlite');
    const legacy = env.SUPERTASK_PM2_MANAGEMENT_LOCK
        ? resolve(env.SUPERTASK_PM2_MANAGEMENT_LOCK)
        : canonical;
    return [canonical, ...[legacy].filter((path) => path !== canonical).sort()];
}

function withManagementLocks<T>(
    paths: string[],
    timeoutMs: number,
    action: () => T,
    index = 0,
): T {
    const path = paths[index];
    if (!path) return action();
    return withExclusiveManagementLock(
        path,
        timeoutMs,
        () => withManagementLocks(paths, timeoutMs, action, index + 1),
    );
}

function commandTimeoutMs(env: NodeJS.ProcessEnv): number {
    const configured = Number(
        env.SUPERTASK_PM2_SUPERVISOR_COMMAND_TIMEOUT_MS
        ?? env.SUPERTASK_PM2_COMMAND_TIMEOUT_MS
        ?? 15_000,
    );
    return Number.isFinite(configured) && configured > 0 ? configured : 15_000;
}

function dumpContainsGateway(env: NodeJS.ProcessEnv): boolean | null {
    try {
        const parsed = JSON.parse(readFileSync(join(pm2Home(env), 'dump.pm2'), 'utf8')) as unknown;
        if (!Array.isArray(parsed)) return null;
        return (parsed as Pm2ProcessSnapshot[]).some((item) => item.name === PROCESS_NAME);
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT' ? false : null;
    }
}

function superviseUnlocked(pm2Path: string, env: NodeJS.ProcessEnv): boolean {
    const list = spawnSync(pm2Path, ['jlist'], {
        encoding: 'utf8',
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: commandTimeoutMs(env),
        killSignal: 'SIGKILL',
    });
    if (list.status !== 0 || list.error) return false;

    let parsed: unknown;
    try {
        parsed = JSON.parse(list.stdout) as unknown;
    } catch {
        return false;
    }
    if (!Array.isArray(parsed)) return false;

    const gateway = (parsed as Pm2ProcessSnapshot[]).find((item) => item.name === PROCESS_NAME);
    if (!gateway) {
        const savedGateway = dumpContainsGateway(env);
        if (savedGateway !== true) return savedGateway === false;
        const resurrect = spawnSync(pm2Path, ['resurrect'], {
            env,
            stdio: 'inherit',
            timeout: commandTimeoutMs(env),
            killSignal: 'SIGKILL',
        });
        return resurrect.status === 0 && !resurrect.error;
    }

    const status = gateway.pm2_env?.status;
    return status === 'online'
        || status === 'launching'
        || status === 'waiting restart'
        || status === 'stopping'
        || status === 'stopped'
        || status === 'errored';
}

export function superviseOnce(pm2Path: string, env: NodeJS.ProcessEnv = process.env): boolean {
    try {
        return withManagementLocks(
            managementLockPaths(env),
            0,
            () => superviseUnlocked(pm2Path, env),
        );
    } catch (error) {
        if (error instanceof ManagementLockBusyError) return true;
        return false;
    }
}

function run(): void {
    const pm2Path = Bun.argv[2];
    if (!pm2Path) throw new Error('pm2 supervisor requires an absolute pm2 executable path');

    superviseOnce(pm2Path);
    const timer = setInterval(() => superviseOnce(pm2Path), POLL_INTERVAL_MS);
    const shutdown = () => {
        clearInterval(timer);
        process.exit(0);
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
}

if (import.meta.main) run();
