import { spawnSync } from 'child_process';
import { basename } from 'path';

interface ProcessInfo {
    processGroupId: number;
    command: string;
}

function isSafePid(pid: number): boolean {
    return Number.isInteger(pid) && pid > 1 && pid !== process.pid;
}

export function isProcessAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error instanceof Error && 'code' in error && error.code === 'EPERM';
    }
}

function inspectUnixProcess(pid: number): ProcessInfo | null {
    const result = spawnSync('ps', ['-o', 'pgid=', '-o', 'command=', '-p', String(pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.status !== 0) return null;
    const match = result.stdout.trim().match(/^(\d+)\s+(.+)$/s);
    if (!match) return null;
    return { processGroupId: Number(match[1]), command: match[2] };
}

function commandMatches(command: string, expectedExecutable: string): boolean {
    const expectedName = basename(expectedExecutable).trim().toLowerCase();
    if (!expectedName) return false;
    return command.toLowerCase().includes(expectedName);
}

export function signalSpawnedProcessTree(pid: number, signal: NodeJS.Signals): boolean {
    if (!isSafePid(pid)) return false;

    if (process.platform !== 'win32') {
        try {
            process.kill(-pid, signal);
            return true;
        } catch {
        }
    }

    try {
        process.kill(pid, signal);
        return true;
    } catch {
        return false;
    }
}

export function signalRecordedProcessTree(
    pid: number,
    signal: NodeJS.Signals,
    expectedExecutable: string,
): boolean {
    if (!isSafePid(pid)) return false;

    if (process.platform === 'win32') {
        const list = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        if (list.status !== 0 || !commandMatches(list.stdout, expectedExecutable)) return false;
        const args = ['/PID', String(pid), '/T'];
        if (signal === 'SIGKILL') args.push('/F');
        return spawnSync('taskkill', args, { stdio: 'ignore' }).status === 0;
    }

    const info = inspectUnixProcess(pid);
    if (!info || !commandMatches(info.command, expectedExecutable)) return false;

    try {
        if (info.processGroupId === pid) process.kill(-pid, signal);
        else process.kill(pid, signal);
        return true;
    } catch {
        return false;
    }
}
