import { spawn } from 'child_process';
import { validateTaskWorkingDirectory } from './task-working-directory';

const CATALOG_CACHE_MS = 30_000;
const COMMAND_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const ANSI_PATTERN = /\x1B(?:[@-_][0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;

export type OpenCodeAgentMode = 'primary' | 'subagent' | 'all';

export interface OpenCodeAgentOption {
    name: string;
    mode: OpenCodeAgentMode;
}

export interface OpenCodeCatalog {
    cwd: string;
    models: string[];
    agents: OpenCodeAgentOption[];
}

interface CatalogOptions {
    executable?: string;
    timeoutMs?: number;
    useCache?: boolean;
}

interface CatalogCacheEntry {
    expiresAt: number;
    result: Promise<OpenCodeCatalog>;
}

const catalogCache = new Map<string, CatalogCacheEntry>();

function cleanOutput(value: string): string {
    return value.replace(ANSI_PATTERN, '').replace(/\r/g, '');
}

function runOpenCode(
    executable: string,
    args: string[],
    cwd: string,
    timeoutMs: number,
): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, {
            cwd,
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let failure: Error | null = null;
        let finished = false;

        const append = (current: string, chunk: Buffer): string => {
            const next = current + chunk.toString();
            if (Buffer.byteLength(next) > MAX_OUTPUT_BYTES && failure === null) {
                failure = new Error(`OpenCode 输出超过 ${MAX_OUTPUT_BYTES} bytes`);
                child.kill('SIGTERM');
            }
            return next.slice(-MAX_OUTPUT_BYTES);
        };

        child.stdout?.on('data', (chunk: Buffer) => {
            stdout = append(stdout, chunk);
        });
        child.stderr?.on('data', (chunk: Buffer) => {
            stderr = append(stderr, chunk);
        });
        child.once('error', (error) => {
            failure ??= error;
        });

        const timer = setTimeout(() => {
            failure ??= new Error(`OpenCode 命令超过 ${timeoutMs}ms 未完成`);
            child.kill('SIGTERM');
        }, timeoutMs);

        child.once('close', (code) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            if (failure) {
                reject(failure);
                return;
            }
            if (code !== 0) {
                const detail = cleanOutput(stderr).trim() || `退出码 ${code ?? 'null'}`;
                reject(new Error(`OpenCode ${args.join(' ')} 失败：${detail}`));
                return;
            }
            resolve(cleanOutput(stdout));
        });
    });
}

export function parseOpenCodeModels(output: string): string[] {
    return [...new Set(cleanOutput(output).split('\n')
        .map((line) => line.trim())
        .filter((line) => /^[^\s/]+\/.+/.test(line)))]
        .sort((left, right) => left.localeCompare(right));
}

export function parseOpenCodeAgents(output: string): OpenCodeAgentOption[] {
    const agents = new Map<string, OpenCodeAgentOption>();
    for (const line of cleanOutput(output).split('\n')) {
        const match = /^([^\s()]+) \((primary|subagent|all)\)$/.exec(line.trim());
        if (!match) continue;
        const name = match[1];
        const mode = match[2] as OpenCodeAgentMode;
        if (name === 'supertask-runner') continue;
        agents.set(name, { name, mode });
    }
    const rank: Record<OpenCodeAgentMode, number> = { primary: 0, all: 1, subagent: 2 };
    return [...agents.values()].sort((left, right) => rank[left.mode] - rank[right.mode]
        || left.name.localeCompare(right.name));
}

export async function loadOpenCodeCatalog(
    cwd: string,
    options: CatalogOptions = {},
): Promise<OpenCodeCatalog> {
    validateTaskWorkingDirectory(cwd);
    const executable = options.executable ?? process.env.SUPERTASK_OPENCODE_BIN ?? 'opencode';
    const timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS;
    const cacheKey = `${executable}\0${cwd}`;
    const cached = catalogCache.get(cacheKey);
    if (options.useCache !== false && cached && cached.expiresAt > Date.now()) {
        return cached.result;
    }

    const result = Promise.all([
        runOpenCode(executable, ['models'], cwd, timeoutMs),
        runOpenCode(executable, ['agent', 'list'], cwd, timeoutMs),
    ]).then(([modelsOutput, agentsOutput]) => {
        const models = parseOpenCodeModels(modelsOutput);
        const agents = parseOpenCodeAgents(agentsOutput)
            .filter((agent) => agent.mode !== 'subagent');
        if (models.length === 0) throw new Error('OpenCode 没有返回可用模型');
        if (agents.length === 0) throw new Error('OpenCode 没有返回可直接运行的主 Agent');
        return { cwd, models, agents };
    });

    if (options.useCache !== false) {
        catalogCache.set(cacheKey, { expiresAt: Date.now() + CATALOG_CACHE_MS, result });
        result.catch(() => {
            if (catalogCache.get(cacheKey)?.result === result) catalogCache.delete(cacheKey);
        });
    }
    return result;
}

export function clearOpenCodeCatalogCache(): void {
    catalogCache.clear();
}
