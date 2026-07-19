import { spawn } from 'child_process';
import { validateTaskWorkingDirectory } from './task-working-directory';

const CATALOG_CACHE_MS = 30_000;
const COMMAND_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const ANSI_PATTERN = /\x1B(?:[@-_][0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;

class OpenCodeCommandExitError extends Error {}

export type OpenCodeAgentMode = 'primary' | 'subagent' | 'all';

export interface OpenCodeAgentOption {
    name: string;
    mode: OpenCodeAgentMode;
}

export interface OpenCodeCatalog {
    cwd: string;
    models: string[];
    variantsByModel: Record<string, string[]>;
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
            detached: process.platform !== 'win32',
        });
        let stdout = '';
        let stderr = '';
        let failure: Error | null = null;
        let settled = false;
        let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
        let finalRejectTimer: ReturnType<typeof setTimeout> | null = null;
        let timer: ReturnType<typeof setTimeout>;

        const signalProcessTree = (signal: NodeJS.Signals): void => {
            if (process.platform !== 'win32' && child.pid) {
                try {
                    process.kill(-child.pid, signal);
                    return;
                } catch {}
            }
            child.kill(signal);
        };

        const rejectOnce = (error: Error): void => {
            failure ??= error;
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (forceKillTimer) clearTimeout(forceKillTimer);
            if (finalRejectTimer) clearTimeout(finalRejectTimer);
            reject(failure);
        };

        const terminate = (error: Error): void => {
            if (failure) return;
            failure = error;
            signalProcessTree('SIGTERM');
            forceKillTimer = setTimeout(() => {
                signalProcessTree('SIGKILL');
                rejectOnce(error);
            }, 1_000);
            finalRejectTimer = setTimeout(() => rejectOnce(error), 2_000);
        };

        const append = (current: string, chunk: Buffer): string => {
            const next = current + chunk.toString();
            if (Buffer.byteLength(next) > MAX_OUTPUT_BYTES && failure === null) {
                terminate(new Error(`OpenCode 输出超过 ${MAX_OUTPUT_BYTES} bytes`));
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
            if (forceKillTimer) return;
            rejectOnce(error);
        });

        timer = setTimeout(() => {
            terminate(new Error(`OpenCode 命令超过 ${timeoutMs}ms 未完成`));
        }, timeoutMs);

        child.once('close', (code) => {
            clearTimeout(timer);
            if (forceKillTimer) return;
            if (finalRejectTimer) clearTimeout(finalRejectTimer);
            if (settled) return;
            settled = true;
            if (failure) {
                reject(failure);
                return;
            }
            if (code !== 0) {
                const detail = cleanOutput(stderr).trim() || `退出码 ${code ?? 'null'}`;
                reject(new OpenCodeCommandExitError(`OpenCode ${args.join(' ')} 失败：${detail}`));
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

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function findJsonObjectEnd(value: string, start: number): number | null {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < value.length; index += 1) {
        const character = value[index];
        if (inString) {
            if (escaped) escaped = false;
            else if (character === '\\') escaped = true;
            else if (character === '"') inString = false;
            continue;
        }
        if (character === '"') inString = true;
        else if (character === '{') depth += 1;
        else if (character === '}' && --depth === 0) return index + 1;
    }
    return null;
}

export function parseOpenCodeModelMetadata(output: string): {
    models: string[];
    variantsByModel: Record<string, string[]>;
} {
    const cleaned = cleanOutput(output);
    const models = new Set<string>();
    const variantsByModel: Record<string, string[]> = {};
    const headingPattern = /^([^\s/]+\/[^\r\n]+)\r?\n\s*(?=\{)/gm;
    for (const match of cleaned.matchAll(headingPattern)) {
        const model = match[1].trim();
        models.add(model);
        let objectStart = (match.index ?? 0) + match[0].length;
        while (/\s/.test(cleaned[objectStart] ?? '')) objectStart += 1;
        if (cleaned[objectStart] !== '{') continue;
        const objectEnd = findJsonObjectEnd(cleaned, objectStart);
        if (objectEnd === null) continue;
        try {
            const metadata: unknown = JSON.parse(cleaned.slice(objectStart, objectEnd));
            if (!isRecord(metadata) || !isRecord(metadata.variants)) continue;
            variantsByModel[model] = Object.keys(metadata.variants)
                .filter((variant) => variant.trim().length > 0)
                .sort((left, right) => left.localeCompare(right));
        } catch {
            // Keep the model visible even when one provider emits malformed metadata.
        }
    }
    return {
        models: [...models].sort((left, right) => left.localeCompare(right)),
        variantsByModel,
    };
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
        runOpenCode(executable, ['models', '--verbose'], cwd, timeoutMs)
            .catch((error: unknown) => {
                if (!(error instanceof OpenCodeCommandExitError)) throw error;
                return runOpenCode(executable, ['models'], cwd, timeoutMs);
            }),
        runOpenCode(executable, ['agent', 'list'], cwd, timeoutMs),
    ]).then(([modelsOutput, agentsOutput]) => {
        const metadata = parseOpenCodeModelMetadata(modelsOutput);
        const models = metadata.models.length > 0
            ? metadata.models
            : parseOpenCodeModels(modelsOutput);
        const agents = parseOpenCodeAgents(agentsOutput)
            .filter((agent) => agent.mode !== 'subagent');
        if (models.length === 0) throw new Error('OpenCode 没有返回可用模型');
        if (agents.length === 0) throw new Error('OpenCode 没有返回可直接运行的主 Agent');
        return { cwd, models, variantsByModel: metadata.variantsByModel, agents };
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
