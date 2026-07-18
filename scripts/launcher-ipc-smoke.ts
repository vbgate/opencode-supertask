import { spawn } from 'child_process';
import { resolve } from 'path';

const launcherArgument = process.argv[2];
if (!launcherArgument) throw new Error('launcher path is required');

const launcher = resolve(launcherArgument);
const identity = `gateway-${process.pid}:launch:123e4567-e89b-42d3-a456-426614174000`;
const child = spawn(process.execPath, [
    launcher,
    '--supertask-launch-identity',
    identity,
    '/usr/bin/true',
], {
    detached: true,
    stdio: ['pipe', 'ignore', 'pipe', 'ipc'],
});
if (!child.pid || !child.stdin) throw new Error('launcher IPC smoke test failed to spawn');

let stderr = '';
let proofReceived = false;
child.stderr?.on('data', (data: Buffer) => {
    stderr += data.toString();
});
child.on('message', (message: unknown) => {
    if (typeof message !== 'object' || message == null) return;
    const candidate = message as Record<string, unknown>;
    if (candidate.type !== 'supertask-drained' || candidate.identity !== identity) return;
    proofReceived = true;
    child.send({ type: 'supertask-drained-ack', identity });
});

child.stdin.end('START\n');
const timeout = setTimeout(() => {
    try {
        process.kill(-child.pid!, 'SIGKILL');
    } catch {
        child.kill('SIGKILL');
    }
}, 15_000);
const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveClose) => child.once('close', (code, signal) => resolveClose({ code, signal })),
);
clearTimeout(timeout);

if (!proofReceived || result.code !== 0 || result.signal !== null || stderr) {
    throw new Error(JSON.stringify({ proofReceived, ...result, stderr }));
}
console.log(`launcher IPC compatible with Bun ${Bun.version}`);
