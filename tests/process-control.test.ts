import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { basename, join } from 'path';
import { tmpdir } from 'os';
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import {
    isProcessAlive,
    isSpawnedProcessTreeAlive,
    signalRecordedProcessTree,
    signalRecordedProcessTreeWithResult,
    signalSpawnedProcessTree,
    waitForSpawnedProcessTreeExit,
} from '../src/core/process-control';
import {
    LAUNCH_IDENTITY_ARGUMENT,
    LEGACY_GUARDIAN_LAUNCH_PROTOCOL,
    TOKEN_GUARDIAN_LAUNCH_PROTOCOL,
} from '../src/core/launch-protocol';

const dirs: string[] = [];
const children: ChildProcess[] = [];
const originalPath = process.env.PATH;

afterEach(async () => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    for (const child of children.splice(0)) {
        if (child.pid && isAlive(child.pid)) {
            signalSpawnedProcessTree(child.pid, 'SIGKILL');
        }
    }
    await Bun.sleep(20);
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function waitForFile(path: string): Promise<void> {
    const deadline = Date.now() + 3000;
    while (!existsSync(path) && Date.now() < deadline) await Bun.sleep(20);
    if (!existsSync(path)) throw new Error(`等待文件超时: ${path}`);
}

async function waitForExit(pid: number): Promise<void> {
    const deadline = Date.now() + 3000;
    while (isAlive(pid) && Date.now() < deadline) await Bun.sleep(20);
}

function createProcessTree() {
    const dir = mkdtempSync(join(tmpdir(), 'supertask-process-tree-'));
    dirs.push(dir);
    const executable = join(dir, 'fake-opencode');
    const childPidFile = join(dir, 'child.pid');
    writeFileSync(executable, `#!/usr/bin/env bun
import { spawn } from 'child_process';
import { writeFileSync } from 'fs';
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid));
setInterval(() => {}, 1000);
`);
    chmodSync(executable, 0o755);
    const leader = spawn(executable, [
        'run', '--agent', 'test-agent', '--format', 'json', '等待进程终止测试',
    ], { detached: true, stdio: 'ignore' });
    children.push(leader);
    return { executable, childPidFile, leader };
}

describe('进程树终止', () => {
    test('能区分当前进程与不存在的 PID', () => {
        expect(isProcessAlive(process.pid)).toBe(true);
        expect(isProcessAlive(2_147_483_647)).toBe(false);
    });

    test('命令不匹配时拒绝终止记录的 PID', async () => {
        const tree = createProcessTree();
        await waitForFile(tree.childPidFile);

        expect(signalRecordedProcessTree(tree.leader.pid!, 'SIGKILL', '另一个程序')).toBe(false);
        expect(isAlive(tree.leader.pid!)).toBe(true);
    });

    test('ps 探测挂起时有界返回并保持 fail-closed', async () => {
        const tree = createProcessTree();
        await waitForFile(tree.childPidFile);
        const fakeBin = mkdtempSync(join(tmpdir(), 'supertask-hanging-ps-'));
        dirs.push(fakeBin);
        const fakePs = join(fakeBin, 'ps');
        const runner = join(fakeBin, 'runner.ts');
        writeFileSync(fakePs, `#!${process.execPath}
await Bun.sleep(30_000);
`);
        writeFileSync(runner, `
import { signalRecordedProcessTreeWithResult } from ${JSON.stringify(join(process.cwd(), 'src/core/process-control.ts'))};
const startedAt = Date.now();
const result = signalRecordedProcessTreeWithResult(
    ${tree.leader.pid!},
    'SIGKILL',
    ${JSON.stringify(basename(tree.executable))},
);
console.log(JSON.stringify({ result, elapsedMs: Date.now() - startedAt }));
`);
        chmodSync(fakePs, 0o755);
        const output = execFileSync(process.execPath, [runner], {
            encoding: 'utf8',
            env: { ...process.env, PATH: `${fakeBin}:${originalPath ?? ''}` },
            timeout: 6_000,
        });
        const { result, elapsedMs } = JSON.parse(output) as {
            result: string;
            elapsedMs: number;
        };

        expect(result).toBe('inspect-failed');
        expect(elapsedMs).toBeLessThan(4_000);
        expect(isAlive(tree.leader.pid!)).toBe(true);
    });

    test('命令匹配时终止整个独立进程组', async () => {
        const tree = createProcessTree();
        await waitForFile(tree.childPidFile);
        const childPid = Number(readFileSync(tree.childPidFile, 'utf8'));

        expect(signalRecordedProcessTree(
            tree.leader.pid!,
            'SIGKILL',
            basename(tree.executable),
        )).toBe(true);

        await waitForExit(tree.leader.pid!);
        await waitForExit(childPid);
        expect(isAlive(tree.leader.pid!)).toBe(false);
        expect(isAlive(childPid)).toBe(false);
    });

    test('guardian 协议拒绝 PID 复用后的直接 OpenCode 命令', async () => {
        const tree = createProcessTree();
        await waitForFile(tree.childPidFile);

        expect(signalRecordedProcessTreeWithResult(
            tree.leader.pid!,
            'SIGKILL',
            basename(tree.executable),
            LEGACY_GUARDIAN_LAUNCH_PROTOCOL,
        )).toBe('identity-mismatch');
        expect(isAlive(tree.leader.pid!)).toBe(true);
    });

    test('guardian 协议验证真实 launcher 后终止整个进程组', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'supertask-guardian-identity-'));
        dirs.push(dir);
        const executable = join(dir, 'fake-opencode');
        const childPidFile = join(dir, 'child.pid');
        const launcher = join(process.cwd(), 'src/worker/launcher.ts');
        const actualIdentity = 'gateway-100:launch:11111111-1111-4111-8111-111111111111';
        const staleIdentity = 'gateway-99:launch:22222222-2222-4222-8222-222222222222';
        writeFileSync(executable, `#!/usr/bin/env bun
import { writeFileSync } from 'fs';
writeFileSync(${JSON.stringify(childPidFile)}, String(process.pid));
setInterval(() => {}, 1000);
`);
        chmodSync(executable, 0o755);
        const leader = spawn(process.execPath, [
            launcher,
            LAUNCH_IDENTITY_ARGUMENT,
            actualIdentity,
            executable,
            'run', '--agent', 'test-agent', '--format', 'json', 'guardian identity test',
        ], { detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
        children.push(leader);
        await new Promise<void>((resolve, reject) => {
            leader.once('spawn', resolve);
            leader.once('error', reject);
        });
        leader.stdin!.end('START\n');
        await waitForFile(childPidFile);
        const childPid = Number(readFileSync(childPidFile, 'utf8'));

        expect(signalRecordedProcessTreeWithResult(
            leader.pid!,
            'SIGKILL',
            basename(executable),
            TOKEN_GUARDIAN_LAUNCH_PROTOCOL,
            staleIdentity,
        )).toBe('identity-mismatch');
        expect(isAlive(leader.pid!)).toBe(true);

        expect(signalRecordedProcessTreeWithResult(
            leader.pid!,
            'SIGKILL',
            basename(executable),
            TOKEN_GUARDIAN_LAUNCH_PROTOCOL,
            actualIdentity,
        )).toBe('signalled');

        await waitForExit(leader.pid!);
        await waitForExit(childPid);
        expect(isAlive(leader.pid!)).toBe(false);
        expect(isAlive(childPid)).toBe(false);
    });

    test('组长先退出时仍把存活的后代视为未终止', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'supertask-orphan-group-'));
        dirs.push(dir);
        const descendant = join(dir, 'descendant');
        const leaderScript = join(dir, 'leader');
        const descendantPidFile = join(dir, 'descendant.pid');
        writeFileSync(descendant, `#!/usr/bin/env bun
import { writeFileSync } from 'fs';
writeFileSync(${JSON.stringify(descendantPidFile)}, String(process.pid));
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`);
        writeFileSync(leaderScript, `#!/usr/bin/env bun
import { spawn } from 'child_process';
const child = spawn(${JSON.stringify(descendant)}, [], { stdio: 'ignore' });
child.unref();
`);
        chmodSync(descendant, 0o755);
        chmodSync(leaderScript, 0o755);
        const leader = spawn(leaderScript, [], { detached: true, stdio: 'ignore' });
        children.push(leader);
        await waitForFile(descendantPidFile);
        if (leader.exitCode === null && leader.signalCode === null) {
            await new Promise<void>((resolve) => leader.once('close', () => resolve()));
        }

        expect(isProcessAlive(leader.pid!)).toBe(false);
        expect(isSpawnedProcessTreeAlive(leader.pid!)).toBe(true);
        expect(signalRecordedProcessTreeWithResult(
            leader.pid!,
            'SIGKILL',
            descendant,
        )).toBe('inspect-failed');
        expect(await waitForSpawnedProcessTreeExit(leader.pid!, 100)).toBe(false);

        signalSpawnedProcessTree(leader.pid!, 'SIGKILL');
        expect(await waitForSpawnedProcessTreeExit(leader.pid!, 3000)).toBe(true);
    });

    test('组长在命令检查期间退出时仍把存活后代保持隔离', async () => {
        const fakeBin = mkdtempSync(join(tmpdir(), 'supertask-inspect-race-'));
        dirs.push(fakeBin);
        const fakePs = join(fakeBin, 'ps');
        const executable = join(fakeBin, 'fake-opencode');
        const childPidFile = join(fakeBin, 'child.pid');
        const helper = join(fakeBin, 'start-detached.ts');
        const runner = join(fakeBin, 'runner.ts');
        writeFileSync(fakePs, `#!/bin/sh
for value in "$@"; do pid="$value"; done
kill -TERM "$pid"
count=0
while kill -0 "$pid" 2>/dev/null && [ "$count" -lt 100 ]; do
  sleep 0.01
  count=$((count + 1))
done
exit 1
`);
        writeFileSync(executable, `#!/usr/bin/env bun
import { spawn } from 'child_process';
import { writeFileSync } from 'fs';
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid));
setInterval(() => {}, 1000);
`);
        writeFileSync(helper, `import { spawn } from 'child_process';
const child = spawn(${JSON.stringify(executable)}, [
    'run', '--agent', 'test-agent', '--format', 'json', '检查竞态',
], { detached: true, stdio: 'ignore' });
child.unref();
console.log(child.pid);
`);
        writeFileSync(runner, `import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import {
    signalRecordedProcessTreeWithResult,
    signalSpawnedProcessTree,
    waitForSpawnedProcessTreeExit,
} from ${JSON.stringify(join(process.cwd(), 'src/core/process-control.ts'))};
const started = spawnSync(process.execPath, [${JSON.stringify(helper)}], { encoding: 'utf8' });
const pid = Number(started.stdout.trim());
const deadline = Date.now() + 3000;
while (!existsSync(${JSON.stringify(childPidFile)}) && Date.now() < deadline) await Bun.sleep(20);
const result = signalRecordedProcessTreeWithResult(pid, 'SIGKILL', ${JSON.stringify(basename(executable))});
signalSpawnedProcessTree(pid, 'SIGKILL');
const exited = await waitForSpawnedProcessTreeExit(pid, 3000);
console.log(JSON.stringify({ result, exited }));
if (result !== 'inspect-failed' || !exited) process.exit(1);
`);
        chmodSync(fakePs, 0o755);
        chmodSync(executable, 0o755);

        const output = execFileSync(process.execPath, [runner], {
            encoding: 'utf8',
            env: { ...process.env, PATH: `${fakeBin}:${originalPath ?? ''}` },
        });
        expect(JSON.parse(output.trim())).toEqual({ result: 'inspect-failed', exited: true });
    });
});
