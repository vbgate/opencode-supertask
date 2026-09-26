import { spawn } from 'child_process';
import { validateTaskWorkingDirectory } from './task-working-directory';
import { detectOpenCodeVersion, openCodeExecutable } from './opencode-cli';

const CATALOG_CACHE_MS = 30_000;
const COMMAND_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const V2_EMPTY_RETRY_DELAYS_MS = [300, 700, 1_500];
const ANSI_PATTERN = /\x1B(?:[@-_][0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;

class OpenCodeCommandExitError extends Error {}
class OpenCodeApiOutputError extends Error {}

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
            // OpenCode 以 PWD 优先解析项目目录（2.x run/api 与 1.x TUI 均如此），必须与 cwd 一致。
            env: { ...process.env, PWD: cwd },
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

/** OpenCode 1.x 的 `agent list` 不输出 hidden 标记；这些内置 Agent 在 1.x 中是 hidden，不能直接运行。 */
const HIDDEN_BUILTIN_AGENTS = new Set(['compaction', 'title', 'summary']);
const AGENT_MODES = new Set<string>(['primary', 'subagent', 'all']);

function sortAgents(agents: Iterable<OpenCodeAgentOption>): OpenCodeAgentOption[] {
    const rank: Record<OpenCodeAgentMode, number> = { primary: 0, all: 1, subagent: 2 };
    return [...agents].sort((left, right) => rank[left.mode] - rank[right.mode]
        || left.name.localeCompare(right.name));
}

export function parseOpenCodeAgents(output: string): OpenCodeAgentOption[] {
    const agents = new Map<string, OpenCodeAgentOption>();
    for (const line of cleanOutput(output).split('\n')) {
        const match = /^([^\s()]+) \((primary|subagent|all)\)$/.exec(line.trim());
        if (!match) continue;
        const name = match[1];
        const mode = match[2] as OpenCodeAgentMode;
        if (name === 'supertask-runner' || HIDDEN_BUILTIN_AGENTS.has(name)) continue;
        agents.set(name, { name, mode });
    }
    return sortAgents(agents.values());
}

function apiData(output: string, operation: string): unknown[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(cleanOutput(output));
    } catch {
        throw new OpenCodeApiOutputError(`OpenCode api ${operation} 没有返回完整 JSON`);
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.data)) {
        throw new OpenCodeApiOutputError(`OpenCode api ${operation} 返回格式无法识别`);
    }
    return parsed.data;
}

/** 解析 OpenCode 2.x `api agent.list`：过滤 hidden 与 supertask-runner。 */
export function parseOpenCodeV2Agents(output: string): OpenCodeAgentOption[] {
    const agents = new Map<string, OpenCodeAgentOption>();
    for (const item of apiData(output, 'agent.list')) {
        if (!isRecord(item) || typeof item.id !== 'string' || typeof item.mode !== 'string') continue;
        if (item.hidden === true || item.id === 'supertask-runner' || !AGENT_MODES.has(item.mode)) continue;
        agents.set(item.id, { name: item.id, mode: item.mode as OpenCodeAgentMode });
    }
    return sortAgents(agents.values());
}

/** 解析 OpenCode 2.x `api model.list`：variants 是 `{ id }` 数组而非 1.x 的对象键。 */
export function parseOpenCodeV2Models(output: string): {
    models: string[];
    variantsByModel: Record<string, string[]>;
} {
    const models = new Set<string>();
    const variantsByModel: Record<string, string[]> = {};
    for (const item of apiData(output, 'model.list')) {
        if (!isRecord(item) || typeof item.providerID !== 'string' || typeof item.id !== 'string') continue;
        const model = `${item.providerID}/${item.id}`;
        models.add(model);
        const variants = Array.isArray(item.variants)
            ? item.variants
                .map((variant) => (isRecord(variant) && typeof variant.id === 'string' ? variant.id.trim() : ''))
                .filter((variant) => variant.length > 0)
            : [];
        if (variants.length > 0) variantsByModel[model] = [...new Set(variants)].sort((left, right) => left.localeCompare(right));
    }
    return { models: [...models].sort((left, right) => left.localeCompare(right)), variantsByModel };
}

type CatalogContent = Omit<OpenCodeCatalog, 'cwd'>;

async function loadV1Catalog(executable: string, cwd: string, timeoutMs: number): Promise<CatalogContent> {
    const [modelsOutput, agentsOutput] = await Promise.all([
        runOpenCode(executable, ['models', '--verbose'], cwd, timeoutMs)
            .catch((error: unknown) => {
                if (!(error instanceof OpenCodeCommandExitError)) throw error;
                return runOpenCode(executable, ['models'], cwd, timeoutMs);
            }),
        runOpenCode(executable, ['agent', 'list'], cwd, timeoutMs),
    ]);
    const metadata = parseOpenCodeModelMetadata(modelsOutput);
    return {
        models: metadata.models.length > 0 ? metadata.models : parseOpenCodeModels(modelsOutput),
        variantsByModel: metadata.variantsByModel,
        agents: parseOpenCodeAgents(agentsOutput),
    };
}

/**
 * 2.x 的目录只能经服务端 API 读取。`--standalone` 每次都是新服务端，而 2.x 按项目目录惰性加载，
 * 首个请求会返回空列表；因此使用用户的后台服务，并在列表仍为空时有界重试。
 * 2.x 向管道写大 JSON 后偶发未刷完即退出，输出被截断时同样重试。
 */
async function loadV2List<T>(
    executable: string,
    operation: string,
    cwd: string,
    timeoutMs: number,
    parse: (output: string) => T,
    isEmpty: (value: T) => boolean,
): Promise<T> {
    // 截断的输出与写到一半退出（非零退出码）都按瞬时故障有界重试；超时和无法启动直接失败。
    const attempt = async (): Promise<T | Error> => {
        try {
            return parse(await runOpenCode(executable, ['api', operation], cwd, timeoutMs));
        } catch (error) {
            if (error instanceof OpenCodeApiOutputError || error instanceof OpenCodeCommandExitError) return error;
            throw error;
        }
    };
    let value = await attempt();
    for (const delayMs of V2_EMPTY_RETRY_DELAYS_MS) {
        if (!(value instanceof Error) && !isEmpty(value)) break;
        await Bun.sleep(delayMs);
        value = await attempt();
    }
    if (value instanceof Error) throw value;
    return value;
}

async function loadV2Catalog(executable: string, cwd: string, timeoutMs: number): Promise<CatalogContent> {
    const [metadata, agents] = await Promise.all([
        loadV2List(executable, 'model.list', cwd, timeoutMs, parseOpenCodeV2Models, (value) => value.models.length === 0),
        loadV2List(executable, 'agent.list', cwd, timeoutMs, parseOpenCodeV2Agents, (value) => value.length === 0),
    ]);
    return { ...metadata, agents };
}

export async function loadOpenCodeCatalog(
    cwd: string,
    options: CatalogOptions = {},
): Promise<OpenCodeCatalog> {
    validateTaskWorkingDirectory(cwd);
    const executable = options.executable ?? openCodeExecutable();
    const timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS;
    const cacheKey = `${executable}\0${cwd}`;
    const cached = catalogCache.get(cacheKey);
    if (options.useCache !== false && cached && cached.expiresAt > Date.now()) {
        return cached.result;
    }

    const result = detectOpenCodeVersion(executable, { cwd })
        .then(({ major }) => (major === 2
            ? loadV2Catalog(executable, cwd, timeoutMs)
            : loadV1Catalog(executable, cwd, timeoutMs)))
        .then(({ models, variantsByModel, agents: allAgents }) => {
            const agents = allAgents.filter((agent) => agent.mode !== 'subagent');
            if (models.length === 0) throw new Error('OpenCode 没有返回可用模型');
            if (agents.length === 0) throw new Error('OpenCode 没有返回可直接运行的主 Agent');
            return { cwd, models, variantsByModel, agents };
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
