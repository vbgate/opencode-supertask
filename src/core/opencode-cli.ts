import { spawn, spawnSync } from 'child_process';

/**
 * OpenCode 1.x 与 2.x 的命令行差异集中在此处：
 * - 2.x 没有 `run --variant`，variant 写在 `-m provider/model#variant` 中；
 * - 2.x 的 `run` 默认连接共享后台服务，环境变量（如 SUPERTASK_MANAGED_RUN）和配置作用域
 *   不会传给该服务，因此受管执行必须使用 `--standalone` 私有服务端。
 */
export type OpenCodeMajor = 1 | 2;

export interface OpenCodeVersion {
    version: string;
    major: OpenCodeMajor;
}

export interface OpenCodeRunTarget {
    agent: string;
    model: string | null;
    variant: string | null;
    prompt: string;
}

/** 当前 OpenCode 版本无法表达的任务配置；重试不会改变结果。 */
export class OpenCodeInvocationError extends Error {}

const VERSION_TIMEOUT_MS = 15_000;
const VERSION_CACHE_MS = 5 * 60_000;
const versionCache = new Map<string, { expiresAt: number; result: Promise<OpenCodeVersion> }>();

export function openCodeExecutable(): string {
    return process.env.SUPERTASK_OPENCODE_BIN ?? 'opencode';
}

export function parseOpenCodeVersion(output: string): OpenCodeVersion | null {
    const match = /(?:^|\s|v)(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?/.exec(output.trim());
    if (!match) return null;
    const major = Number(match[1]);
    if (major !== 1 && major !== 2) return null;
    return { version: match[0].trim().replace(/^v/, ''), major };
}

export function detectOpenCodeVersion(
    executable = openCodeExecutable(),
    options: { cwd?: string; useCache?: boolean } = {},
): Promise<OpenCodeVersion> {
    const cached = versionCache.get(executable);
    if (options.useCache !== false && cached && cached.expiresAt > Date.now()) return cached.result;

    const result = new Promise<OpenCodeVersion>((resolve, reject) => {
        const child = spawn(executable, ['--version'], {
            cwd: options.cwd,
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`OpenCode --version 超过 ${VERSION_TIMEOUT_MS}ms 未完成`));
        }, VERSION_TIMEOUT_MS);
        child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
        child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
        child.once('error', (error) => {
            clearTimeout(timer);
            reject(new Error(`无法执行 OpenCode（${executable}）：${error.message}`));
        });
        child.once('close', (code) => {
            clearTimeout(timer);
            const parsed = code === 0 ? parseOpenCodeVersion(output) : null;
            if (parsed) resolve(parsed);
            else reject(new Error(`无法识别 OpenCode 版本（${executable} --version 退出码 ${code ?? 'null'}）：${output.trim().slice(0, 200)}`));
        });
    });

    if (options.useCache !== false) {
        versionCache.set(executable, { expiresAt: Date.now() + VERSION_CACHE_MS, result });
        result.catch(() => {
            if (versionCache.get(executable)?.result === result) versionCache.delete(executable);
        });
    }
    return result;
}

/** 同步探测，供 doctor/upgrade 等同步诊断流程使用；不写入异步缓存。 */
export function detectOpenCodeVersionSync(executable = openCodeExecutable()): OpenCodeVersion {
    const result = spawnSync(executable, ['--version'], {
        encoding: 'utf8',
        env: process.env,
        timeout: VERSION_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error) throw new Error(`无法执行 OpenCode（${executable}）：${result.error.message}`);
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    const parsed = result.status === 0 ? parseOpenCodeVersion(output) : null;
    if (!parsed) {
        throw new Error(`无法识别 OpenCode 版本（${executable} --version 退出码 ${result.status ?? 'null'}）：${output.trim().slice(0, 200)}`);
    }
    return parsed;
}

export function clearOpenCodeVersionCache(): void {
    versionCache.clear();
}

/** 接受 2.x 的 `provider/model#variant` 写法，并拆成与 1.x 通用的 model + variant。 */
function normalizeModelVariant(target: OpenCodeRunTarget): OpenCodeRunTarget {
    const hashIndex = target.model?.indexOf('#') ?? -1;
    if (!target.model || hashIndex < 0) return target;
    const model = target.model.slice(0, hashIndex);
    const embedded = target.model.slice(hashIndex + 1);
    if (!model || !embedded || embedded.includes('#')) {
        throw new OpenCodeInvocationError(`模型格式无效：${target.model}`);
    }
    if (target.variant && target.variant !== embedded) {
        throw new OpenCodeInvocationError(`模型 ${target.model} 内嵌的 variant 与任务 variant=${target.variant} 冲突`);
    }
    return { ...target, model, variant: embedded };
}

export function buildOpenCodeRunArgs(major: OpenCodeMajor, input: OpenCodeRunTarget): string[] {
    const target = normalizeModelVariant(input);
    if (major === 1) {
        const args = ['run', '--agent', target.agent, '--format', 'json'];
        if (target.model) args.push('-m', target.model);
        if (target.variant) args.push('--variant', target.variant);
        args.push(target.prompt);
        return args;
    }

    if (target.variant && !target.model) {
        throw new OpenCodeInvocationError(
            `OpenCode 2.x 只能通过 -m provider/model#variant 指定 variant；任务设置了 variant=${target.variant} 但未指定模型，请为任务补充模型或清空 variant`,
        );
    }
    if (target.model && !/^[^/\s]+\/\S+$/.test(target.model)) {
        throw new OpenCodeInvocationError(`OpenCode 2.x 需要 provider/model 格式的模型：${target.model}`);
    }
    const args = ['run', '--standalone', '--agent', target.agent, '--format', 'json'];
    if (target.model) args.push('-m', target.variant ? `${target.model}#${target.variant}` : target.model);
    args.push(target.prompt);
    return args;
}
