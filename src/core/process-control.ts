import { spawnSync } from 'child_process';
import { basename } from 'path';

interface ProcessInfo {
    processGroupId: number;
    command: string;
}

export type RecordedProcessSignalResult =
    | 'signalled'
    | 'not-running'
    | 'identity-mismatch'
    | 'inspect-failed'
    | 'signal-failed';

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

function inspectWindowsCommand(pid: number): string | null {
    const script = `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`;
    const result = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    if (result.status !== 0) return null;
    return result.stdout.trim() || null;
}

function executableName(value: string): string {
    return basename(value).trim().toLowerCase().replace(/\.(?:exe|cmd|bat)$/i, '');
}

function commandMatches(command: string, expectedExecutable: string): boolean {
    const expectedName = executableName(expectedExecutable);
    if (!expectedName) return false;
    const tokens = command
        .trim()
        .split(/\s+/)
        .map((token) => token.replace(/^["']|["']$/g, ''));
    const executableIndex = tokens.findIndex((token, index) => (
        index <= 3 && executableName(token) === expectedName
    ));
    if (executableIndex < 0) return false;
    const args = tokens.slice(executableIndex + 1, executableIndex + 12);
    const formatIndex = args.indexOf('--format');
    return args[0] === 'run'
        && args.includes('--agent')
        && formatIndex >= 0
        && args[formatIndex + 1] === 'json';
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
    return signalRecordedProcessTreeWithResult(pid, signal, expectedExecutable) === 'signalled';
}

export function signalRecordedProcessTreeWithResult(
    pid: number,
    signal: NodeJS.Signals,
    expectedExecutable: string,
): RecordedProcessSignalResult {
    if (!isSafePid(pid)) return 'identity-mismatch';
    if (!isProcessAlive(pid)) return 'not-running';

    if (process.platform === 'win32') {
        const command = inspectWindowsCommand(pid);
        if (!command) return isProcessAlive(pid) ? 'inspect-failed' : 'not-running';
        if (!commandMatches(command, expectedExecutable)) return 'identity-mismatch';
        const args = ['/PID', String(pid), '/T'];
        if (signal === 'SIGKILL') args.push('/F');
        const status = spawnSync('taskkill', args, { stdio: 'ignore' }).status;
        if (status === 0) return 'signalled';
        return isProcessAlive(pid) ? 'signal-failed' : 'not-running';
    }

    const info = inspectUnixProcess(pid);
    if (!info) return isProcessAlive(pid) ? 'inspect-failed' : 'not-running';
    if (!commandMatches(info.command, expectedExecutable)) return 'identity-mismatch';

    try {
        if (info.processGroupId === pid) process.kill(-pid, signal);
        else process.kill(pid, signal);
        return 'signalled';
    } catch {
        return isProcessAlive(pid) ? 'signal-failed' : 'not-running';
    }
}

export async function waitForProcessExit(pid: number, timeoutMs = 5_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (isProcessAlive(pid) && Date.now() < deadline) {
        await Bun.sleep(Math.min(50, deadline - Date.now()));
    }
    return !isProcessAlive(pid);
}
