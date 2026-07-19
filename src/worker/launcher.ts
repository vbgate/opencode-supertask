import { spawn } from 'child_process';
import {
    drainProofForIdentity,
    isLaunchIdentity,
    isMatchingDrainProofAck,
    LAUNCH_IDENTITY_ARGUMENT,
} from '@core/launch-protocol';

const RELEASE_MESSAGE = 'START';
const INITIAL_GROUP_PROBE_DELAY_MS = 1_000;
const MAX_GROUP_PROBE_DELAY_MS = 5_000;
const GROUP_PROBE_TIMEOUT_MS = 2_000;
const MAX_PS_OUTPUT_CHARS = 4 * 1024 * 1024;
const DRAIN_PROOF_ACK_TIMEOUT_MS = 10_000;

function waitForRelease(): Promise<boolean> {
    return new Promise((resolve) => {
        let settled = false;
        let input = '';
        const finish = (released: boolean) => {
            if (settled) return;
            settled = true;
            process.stdin.removeAllListeners();
            resolve(released);
        };

        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (chunk: string) => {
            input += chunk;
            const newline = input.indexOf('\n');
            if (newline >= 0) finish(input.slice(0, newline).trim() === RELEASE_MESSAGE);
        });
        process.stdin.once('end', () => finish(false));
        process.stdin.once('error', () => finish(false));
        process.stdin.resume();
    });
}

async function hasOtherProcessGroupMembers(): Promise<boolean | null> {
    return new Promise((resolve) => {
        const inspection = spawn('ps', ['-axo', 'pid=,pgid='], {
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        let output = '';
        let settled = false;
        const finish = (result: boolean | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            resolve(result);
        };
        const timeout = setTimeout(() => {
            inspection.kill('SIGKILL');
            finish(null);
        }, GROUP_PROBE_TIMEOUT_MS);

        inspection.stdout.setEncoding('utf8');
        inspection.stdout.on('data', (chunk: string) => {
            output += chunk;
            if (output.length <= MAX_PS_OUTPUT_CHARS) return;
            inspection.kill('SIGKILL');
            finish(null);
        });
        inspection.once('error', () => finish(null));
        inspection.once('close', (code) => {
            if (code !== 0) {
                finish(null);
                return;
            }
            const hasMembers = output.split('\n').some((line) => {
                const match = line.trim().match(/^(\d+)\s+(\d+)$/);
                if (!match) return false;
                const pid = Number(match[1]);
                const processGroupId = Number(match[2]);
                return pid !== process.pid
                    && pid !== inspection.pid
                    && processGroupId === process.pid;
            });
            finish(hasMembers);
        });
    });
}

export interface ProcessGroupDrainOptions {
    probe?: () => Promise<boolean | null>;
    delay?: (milliseconds: number) => Promise<void>;
    initialDelayMs?: number;
    maxDelayMs?: number;
}

export async function waitForProcessGroupDrain(
    options: ProcessGroupDrainOptions = {},
): Promise<void> {
    if (process.platform === 'win32') return;

    const probe = options.probe ?? hasOtherProcessGroupMembers;
    const delay = options.delay ?? Bun.sleep;
    const maxDelayMs = options.maxDelayMs ?? MAX_GROUP_PROBE_DELAY_MS;
    let probeDelayMs = options.initialDelayMs ?? INITIAL_GROUP_PROBE_DELAY_MS;
    while (true) {
        const hasMembers = await probe();
        if (hasMembers === false) return;
        await delay(probeDelayMs);
        probeDelayMs = Math.min(maxDelayMs, probeDelayMs * 2);
    }
}

async function sendDrainProof(launchIdentity: string): Promise<void> {
    if (!process.send) throw new Error('supertask launcher: drain proof IPC unavailable');

    await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            process.off('message', onMessage);
            process.off('disconnect', onDisconnect);
            if (error) reject(error);
            else resolve();
        };
        const onMessage = (message: unknown) => {
            if (isMatchingDrainProofAck(message, launchIdentity)) finish();
        };
        const onDisconnect = () => finish(
            new Error('supertask launcher: drain proof IPC disconnected before acknowledgment'),
        );
        const timeout = setTimeout(() => finish(
            new Error('supertask launcher: drain proof acknowledgment timed out'),
        ), DRAIN_PROOF_ACK_TIMEOUT_MS);

        process.on('message', onMessage);
        process.once('disconnect', onDisconnect);
        try {
            // Bun 1.1 can deliver IPC messages but does not reliably invoke
            // the Node-compatible process.send callback. A bound acknowledgment
            // proves delivery without depending on that callback.
            process.send!(drainProofForIdentity(launchIdentity));
        } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
        }
    });
}

async function main(): Promise<void> {
    const launcherArgs = Bun.argv.slice(2);
    let launchIdentity: string | null = null;
    if (launcherArgs[0] === LAUNCH_IDENTITY_ARGUMENT) {
        if (!isLaunchIdentity(launcherArgs[1])) {
            console.error('supertask launcher: missing launch identity');
            process.exitCode = 127;
            return;
        }
        launchIdentity = launcherArgs[1];
        launcherArgs.splice(0, 2);
    }
    const [executable, ...args] = launcherArgs;
    if (!executable) {
        console.error('supertask launcher: missing OpenCode executable');
        process.exitCode = 127;
        return;
    }

    if (!await waitForRelease()) {
        process.exitCode = 125;
        return;
    }

    const preserveGroupLeader = () => {};
    process.on('SIGTERM', preserveGroupLeader);
    process.on('SIGINT', preserveGroupLeader);
    let result: { code: number | null; signal: NodeJS.Signals | null };
    try {
        const child = spawn(executable, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stdout?.pipe(process.stdout, { end: false });
        child.stderr?.pipe(process.stderr, { end: false });
        result = await new Promise((resolve) => {
            child.once('error', (error) => {
                console.error(`supertask launcher: ${error.message}`);
                resolve({ code: 127, signal: null });
            });
            // 使用独立 pipe 转发输出；exit 只等 OpenCode 主进程结束，
            // 后续的进程组排空才是 guardian 退出的最终条件。
            child.once('exit', (code, signal) => resolve({ code, signal }));
        });

        // 保持进程组长存活，直到仍属于该受管进程组的进程全部退出。
        // Watchdog 因而始终可以通过 launcher 命令验证进程组归属，避免 PID/PGID 复用误杀。
        await waitForProcessGroupDrain();
        if (launchIdentity) {
            // IPC 不传递给 OpenCode；只有持有该次随机身份的 guardian
            // 可在整个进程组排空后向 Worker 发出绑定证明。
            await sendDrainProof(launchIdentity);
        }
    } finally {
        process.off('SIGTERM', preserveGroupLeader);
        process.off('SIGINT', preserveGroupLeader);
    }

    if (result.signal) {
        try {
            process.kill(process.pid, result.signal);
            return;
        } catch {
            process.exitCode = 128;
            return;
        }
    }
    process.exitCode = result.code ?? 1;
}

if (import.meta.main) await main();
