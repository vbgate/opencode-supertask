import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { basename, join } from 'path';
import { tmpdir } from 'os';
import { spawn, type ChildProcess } from 'child_process';
import { signalRecordedProcessTree, signalSpawnedProcessTree } from '../src/core/process-control';

const dirs: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
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
    const leader = spawn(executable, [], { detached: true, stdio: 'ignore' });
    children.push(leader);
    return { executable, childPidFile, leader };
}

describe('进程树终止', () => {
    test('命令不匹配时拒绝终止记录的 PID', async () => {
        const tree = createProcessTree();
        await waitForFile(tree.childPidFile);

        expect(signalRecordedProcessTree(tree.leader.pid!, 'SIGKILL', '另一个程序')).toBe(false);
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
});
