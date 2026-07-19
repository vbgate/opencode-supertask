import { fileURLToPath } from 'url';
import { basename, dirname, resolve } from 'path';
import {
    isLaunchIdentity,
    LAUNCH_IDENTITY_ARGUMENT,
    TOKEN_GUARDIAN_LAUNCH_PROTOCOL,
} from '@core/launch-protocol';

interface ProcessInfo {
    processGroupId: number;
    command: string;
}

const OS_COMMAND_TIMEOUT_MS = 2_000;
const OS_COMMAND_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const OS_COMMAND_RESULT_MARKER = '\n\0supertask-os-command-result:';
const BOUNDED_OS_COMMAND_RUNNER = `
const { writeSync } = await import('fs');
let child;
try {
    child = Bun.spawn(process.argv.slice(2), {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'ignore',
    });
} catch {
    process.exit(127);
}
const terminateGroup = () => {
    if (process.platform !== 'win32') {
        try {
            process.kill(-process.pid, 'SIGKILL');
        } catch {
        }
    }
    try {
        child.kill('SIGKILL');
    } catch {
    }
    process.exit(1);
};
const timer = setTimeout(terminateGroup, ${OS_COMMAND_TIMEOUT_MS});
try {
    const chunks = [];
    let outputBytes = 0;
    const readOutput = async () => {
        const reader = child.stdout.getReader();
        while (true) {
            const { done, value } = await reader.read();
            if (done) return;
            outputBytes += value.byteLength;
            if (outputBytes > ${OS_COMMAND_MAX_OUTPUT_BYTES}) terminateGroup();
            chunks.push(value);
        }
    };
    const [exitCode] = await Promise.all([child.exited, readOutput()]);
    clearTimeout(timer);
    for (const chunk of chunks) writeSync(1, chunk);
    writeSync(1, ${JSON.stringify(OS_COMMAND_RESULT_MARKER)} + String(exitCode));
    if (process.platform !== 'win32') terminateGroup();
    process.exit(0);
} catch {
    clearTimeout(timer);
    terminateGroup();
}
`;

export type RecordedProcessSignalResult =
    | 'signalled'
    | 'not-running'
    | 'identity-mismatch'
    | 'inspect-failed'
    | 'signal-failed';

export type GatewayProcessIdentity = 'match' | 'mismatch' | 'unknown' | 'not-running';
export type SpawnedProcessTreePresence = 'running' | 'not-running' | 'unknown';

function runBoundedOsCommand(
    command: string,
    args: string[],
    captureOutput = true,
): { status: number | null; stdout: string } {
    // Bun 1.1.45 ignores child_process.spawnSync timeouts. The helper remains
    // synchronous to callers while enforcing the deadline with Bun.spawn.
    const result = Bun.spawnSync({
        cmd: [
            process.execPath,
            '-e',
            BOUNDED_OS_COMMAND_RUNNER,
            'supertask-os-command',
            command,
            ...args,
        ],
        detached: process.platform !== 'win32',
        maxBuffer: OS_COMMAND_MAX_OUTPUT_BYTES + 1024,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'ignore',
    });
    const output = new TextDecoder().decode(result.stdout);
    const markerIndex = output.lastIndexOf(OS_COMMAND_RESULT_MARKER);
    if (markerIndex < 0) return { status: null, stdout: '' };
    const statusText = output.slice(markerIndex + OS_COMMAND_RESULT_MARKER.length);
    if (!/^\d+$/.test(statusText)) return { status: null, stdout: '' };
    return {
        status: Number(statusText),
        stdout: captureOutput ? output.slice(0, markerIndex) : '',
    };
}

function isSafePid(pid: number): boolean {
    return Number.isInteger(pid) && pid > 1 && pid !== process.pid;
}

function absentLeaderResult(pid: number): RecordedProcessSignalResult {
    return inspectSpawnedProcessTreePresence(pid) === 'not-running'
        ? 'not-running'
        : 'inspect-failed';
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

export function isSpawnedProcessTreeAlive(pid: number): boolean {
    return inspectSpawnedProcessTreePresence(pid) === 'running';
}

export function inspectSpawnedProcessTreePresence(pid: number): SpawnedProcessTreePresence {
    if (!Number.isInteger(pid) || pid <= 0) return 'unknown';
    if (process.platform === 'win32') {
        const processIds = inspectWindowsProcessTree(pid);
        if (processIds == null) return 'unknown';
        return processIds.length > 0 ? 'running' : 'not-running';
    }
    try {
        process.kill(-pid, 0);
        return 'running';
    } catch (error) {
        if (!(error instanceof Error) || !('code' in error)) return 'unknown';
        if (error.code === 'EPERM') return 'running';
        if (error.code === 'ESRCH') return 'not-running';
        return 'unknown';
    }
}

function inspectUnixProcess(pid: number): ProcessInfo | null {
    const result = runBoundedOsCommand(
        'ps',
        ['-o', 'pgid=', '-o', 'command=', '-p', String(pid)],
    );
    if (result.status !== 0) return null;
    const match = result.stdout.trim().match(/^(\d+)\s+(.+)$/s);
    if (!match) return null;
    return { processGroupId: Number(match[1]), command: match[2] };
}

function inspectWindowsCommand(pid: number): string | null {
    const script = `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`;
    const result = runBoundedOsCommand(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
    );
    if (result.status !== 0) return null;
    return result.stdout.trim() || null;
}

function inspectWindowsProcessTree(rootPid: number): number[] | null {
    const script = `$root=${rootPid}; $all=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId); $ids=New-Object 'System.Collections.Generic.HashSet[int]'; [void]$ids.Add($root); do { $added=$false; foreach($p in $all) { if($ids.Contains([int]$p.ParentProcessId) -and $ids.Add([int]$p.ProcessId)) { $added=$true } } } while($added); $all | Where-Object { $ids.Contains([int]$_.ProcessId) } | Select-Object -ExpandProperty ProcessId`;
    const result = runBoundedOsCommand(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
    );
    if (result.status !== 0) return null;
    return result.stdout
        .split(/\s+/)
        .filter(Boolean)
        .map(Number)
        .filter((pid) => Number.isInteger(pid) && pid > 0);
}

function executableName(value: string): string {
    return basename(value).trim().toLowerCase().replace(/\.(?:exe|cmd|bat)$/i, '');
}

function commandTokens(command: string): string[] {
    return command
        .trim()
        .split(/\s+/)
        .map((token) => token.replace(/^["']|["']$/g, ''));
}

function openCodeArgsMatch(args: string[]): boolean {
    const agentIndex = args.indexOf('--agent');
    const formatIndex = args.indexOf('--format');
    return args[0] === 'run'
        && agentIndex >= 0
        && Boolean(args[agentIndex + 1])
        && formatIndex >= 0
        && args[formatIndex + 1] === 'json';
}

function guardianLauncherPath(): string {
    const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
    return resolve(dirname(fileURLToPath(import.meta.url)), `../worker/launcher.${extension}`)
        .replaceAll('\\', '/');
}

function commandMatches(
    command: string,
    expectedExecutable: string,
    launchProtocol: string | null,
    expectedLaunchIdentity: string | null,
): boolean {
    const expectedName = executableName(expectedExecutable);
    if (!expectedName) return false;
    const tokens = commandTokens(command);

    if (launchProtocol === TOKEN_GUARDIAN_LAUNCH_PROTOCOL) {
        if (!isLaunchIdentity(expectedLaunchIdentity)) return false;
        const expectedLauncher = guardianLauncherPath();
        const launcherIndex = tokens.findIndex((token, index) => (
            index > 0
            && index <= 3
            && token.replaceAll('\\', '/') === expectedLauncher
        ));
        if (launcherIndex < 0) return false;

        const runtimeName = executableName(process.execPath);
        const hasRuntime = tokens.slice(0, launcherIndex).some((token) => (
            executableName(token) === runtimeName || executableName(token) === 'bun'
        ));
        const identityArgumentIndex = launcherIndex + 1;
        const launchIdentityIndex = launcherIndex + 2;
        const executableIndex = launcherIndex + 3;
        return hasRuntime
            && tokens[identityArgumentIndex] === LAUNCH_IDENTITY_ARGUMENT
            && tokens[launchIdentityIndex] === expectedLaunchIdentity
            && executableName(tokens[executableIndex] ?? '') === expectedName
            && openCodeArgsMatch(tokens.slice(executableIndex + 1));
    }
    if (launchProtocol != null) return false;

    const executableIndex = tokens.findIndex((token, index) => (
        index <= 3 && executableName(token) === expectedName
    ));
    if (executableIndex < 0) return false;
    return openCodeArgsMatch(tokens.slice(executableIndex + 1, executableIndex + 12));
}

export function identifyGatewayProcess(pid: number): GatewayProcessIdentity {
    if (!isProcessAlive(pid)) return 'not-running';
    const command = process.platform === 'win32'
        ? inspectWindowsCommand(pid)
        : inspectUnixProcess(pid)?.command ?? null;
    if (!command) return 'unknown';

    const tokens = command
        .trim()
        .split(/\s+/)
        .map((token) => token.replace(/^['"]|['"]$/g, '').replaceAll('\\', '/'));
    const runtimeName = executableName(process.execPath);
    const hasRuntime = tokens.slice(0, 4).some((token) => (
        executableName(token) === runtimeName || executableName(token) === 'bun'
    ));
    const hasGatewayEntry = tokens.some((token) => /(?:^|\/)gateway\/index\.(?:js|ts)$/.test(token));
    const cliEntryIndex = tokens.findIndex((token) => /(?:^|\/)cli\/index\.(?:js|ts)$/.test(token));
    const hasCliGatewayCommand = cliEntryIndex >= 0
        && tokens.slice(cliEntryIndex + 1).includes('gateway');
    const supertaskIndex = tokens.findIndex((token, index) => (
        index <= 3 && executableName(token) === 'supertask'
    ));
    const hasBinGatewayCommand = supertaskIndex >= 0 && tokens[supertaskIndex + 1] === 'gateway';
    return hasRuntime && (hasGatewayEntry || hasCliGatewayCommand || hasBinGatewayCommand)
        ? 'match'
        : 'mismatch';
}

export function signalSpawnedProcessTree(pid: number, signal: NodeJS.Signals): boolean {
    if (!isSafePid(pid)) return false;

    if (process.platform === 'win32') {
        const args = ['/PID', String(pid), '/T'];
        if (signal === 'SIGKILL') args.push('/F');
        const status = runBoundedOsCommand('taskkill', args, false).status;
        return status === 0 || !isSpawnedProcessTreeAlive(pid);
    }

    try {
        process.kill(-pid, signal);
        return true;
    } catch {
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
    launchProtocol: string | null = null,
    expectedLaunchIdentity: string | null = null,
): boolean {
    return signalRecordedProcessTreeWithResult(
        pid,
        signal,
        expectedExecutable,
        launchProtocol,
        expectedLaunchIdentity,
    ) === 'signalled';
}

export function signalRecordedProcessTreeWithResult(
    pid: number,
    signal: NodeJS.Signals,
    expectedExecutable: string,
    launchProtocol: string | null = null,
    expectedLaunchIdentity: string | null = null,
): RecordedProcessSignalResult {
    if (!isSafePid(pid)) return 'identity-mismatch';
    if (!isProcessAlive(pid)) return absentLeaderResult(pid);

    if (process.platform === 'win32') {
        const command = inspectWindowsCommand(pid);
        if (!command) return isProcessAlive(pid) ? 'inspect-failed' : absentLeaderResult(pid);
        if (!commandMatches(
            command,
            expectedExecutable,
            launchProtocol,
            expectedLaunchIdentity,
        )) {
            return 'identity-mismatch';
        }
        const args = ['/PID', String(pid), '/T'];
        if (signal === 'SIGKILL') args.push('/F');
        const status = runBoundedOsCommand('taskkill', args, false).status;
        if (status === 0) return 'signalled';
        return isProcessAlive(pid) ? 'signal-failed' : absentLeaderResult(pid);
    }

    const info = inspectUnixProcess(pid);
    if (!info) return isProcessAlive(pid) ? 'inspect-failed' : absentLeaderResult(pid);
    if (!commandMatches(
        info.command,
        expectedExecutable,
        launchProtocol,
        expectedLaunchIdentity,
    )) {
        return 'identity-mismatch';
    }

    try {
        if (info.processGroupId === pid) process.kill(-pid, signal);
        else process.kill(pid, signal);
        return 'signalled';
    } catch {
        return isProcessAlive(pid) ? 'signal-failed' : absentLeaderResult(pid);
    }
}

export async function waitForProcessExit(pid: number, timeoutMs = 5_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (isProcessAlive(pid) && Date.now() < deadline) {
        await Bun.sleep(Math.min(50, deadline - Date.now()));
    }
    return !isProcessAlive(pid);
}

export async function waitForSpawnedProcessTreeExit(
    pid: number,
    timeoutMs = 5_000,
): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (inspectSpawnedProcessTreePresence(pid) !== 'not-running' && Date.now() < deadline) {
        await Bun.sleep(Math.min(50, deadline - Date.now()));
    }
    return inspectSpawnedProcessTreePresence(pid) === 'not-running';
}
