import type { GatewayDiagnostic } from '../daemon/pm2';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const CACHE_TTL_MS = 5_000;
const DIAGNOSTIC_TIMEOUT_MS = 20_000;

let cached: { expiresAt: number; diagnostic: GatewayDiagnostic } | null = null;
let pending: Promise<GatewayDiagnostic> | null = null;
const activeProcessGroups = new Set<number>();

function killDiagnosticGroup(pid: number): void {
    if (process.platform !== 'win32') {
        try {
            process.kill(-pid, 'SIGKILL');
            return;
        } catch {}
    }
    try {
        process.kill(pid, 'SIGKILL');
    } catch {}
}

process.once('exit', () => {
    for (const pid of activeProcessGroups) killDiagnosticGroup(pid);
});

function diagnosticEntry(): string {
    const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const candidates = [
        join(moduleDir, `../daemon/gateway-diagnostic-runner.${extension}`),
        join(moduleDir, `../../src/daemon/gateway-diagnostic-runner.${extension}`),
    ];
    const entry = candidates.find((candidate) => existsSync(candidate));
    if (!entry) throw new Error(`Gateway diagnostic runner 不存在：${candidates.join(', ')}`);
    return entry;
}

async function runGatewayDiagnostic(): Promise<GatewayDiagnostic> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [diagnosticEntry()], {
            cwd: process.cwd(),
            env: process.env,
            detached: process.platform !== 'win32',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        if (child.pid) activeProcessGroups.add(child.pid);
        child.stdout?.on('data', (chunk: Buffer) => {
            stdout += chunk.toString();
        });
        child.stderr?.on('data', (chunk: Buffer) => {
            stderr += chunk.toString();
        });
        child.once('error', reject);
        child.once('close', (exitCode) => {
            clearTimeout(timer);
            if (child.pid) {
                killDiagnosticGroup(child.pid);
                activeProcessGroups.delete(child.pid);
            }
            if (timedOut) {
                reject(new Error(`Gateway diagnostic runner 超过 ${DIAGNOSTIC_TIMEOUT_MS}ms 未完成`));
                return;
            }
            if (exitCode !== 0) {
                reject(new Error(stderr.trim() || `Gateway diagnostic runner 退出码 ${exitCode}`));
                return;
            }
            try {
                resolve(JSON.parse(stdout) as GatewayDiagnostic);
            } catch (error) {
                reject(error);
            }
        });
        const timer = setTimeout(() => {
            timedOut = true;
            if (child.pid) killDiagnosticGroup(child.pid);
            else child.kill('SIGKILL');
        }, DIAGNOSTIC_TIMEOUT_MS);
    });
}

export async function getDashboardGatewayDiagnostic(
    options: { fresh?: boolean } = {},
): Promise<GatewayDiagnostic> {
    if (!options.fresh && cached && cached.expiresAt > Date.now()) return cached.diagnostic;
    if (!options.fresh && pending) return pending;

    const operation = runGatewayDiagnostic().then((diagnostic) => {
        cached = { expiresAt: Date.now() + CACHE_TTL_MS, diagnostic };
        return diagnostic;
    });
    if (options.fresh) return operation;
    pending = operation.finally(() => {
        pending = null;
    });
    return pending;
}

export function clearDashboardGatewayDiagnosticCache(): void {
    cached = null;
}
