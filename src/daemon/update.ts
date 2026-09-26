import { spawnSync } from 'child_process';
import {
    chmodSync,
    closeSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    openSync,
    readFileSync,
    readdirSync,
    realpathSync,
    renameSync,
    rmSync,
    writeFileSync,
} from 'fs';
import {
    applyEdits as applyJsoncEdits,
    modify as modifyJsonc,
    parse as parseJsonc,
    type ParseError,
} from 'jsonc-parser';
import { homedir, tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { compareSemanticVersions, isSemanticVersion } from '@core/semver';
import { detectOpenCodeVersionSync, openCodeExecutable } from '@core/opencode-cli';

const PACKAGE_NAME = 'opencode-supertask';

export interface InstalledPlugin {
    packageDir: string;
    gatewayEntry: string;
    version: string;
}

export interface ConfiguredPluginSpec {
    spec: string;
    version: string | null;
    exact: boolean;
}

export interface OpenCodePluginDiagnostic extends ConfiguredPluginSpec {
    ok: boolean;
    cachedVersion: string | null;
    packageDir: string | null;
    error: string | null;
}

export type GlobalCliPackageManager = 'npm' | 'bun';

export interface GlobalCliDiagnostic {
    installed: boolean;
    executable: string | null;
    packageDir: string | null;
    version: string | null;
    packageManager: GlobalCliPackageManager | null;
}

export interface GlobalCliUpdateResult extends GlobalCliDiagnostic {
    action: 'not-installed' | 'already-current' | 'updated';
}

export interface UpgradeConvergenceState {
    packageVersion: string;
    plugin: Pick<OpenCodePluginDiagnostic, 'ok' | 'version' | 'cachedVersion'>;
    cli: Pick<GlobalCliDiagnostic, 'installed' | 'version'>;
    gateway: {
        pm2Installed: boolean;
        processFound: boolean;
        status: string | null;
        ready: boolean;
        runningVersion: string | null;
        gatewayPackageVersion: string | null;
        scopeMatches: boolean;
    };
}

export function isVersionConverged(version: string, state: UpgradeConvergenceState): boolean {
    return state.packageVersion === version
        && state.plugin.ok
        && state.plugin.version === version
        && state.plugin.cachedVersion === version
        && (!state.cli.installed || state.cli.version === version)
        && state.gateway.pm2Installed
        && state.gateway.processFound
        && state.gateway.status === 'online'
        && state.gateway.ready
        && state.gateway.runningVersion === version
        && state.gateway.gatewayPackageVersion === version
        && state.gateway.scopeMatches;
}

function pluginAt(packageDir: string): InstalledPlugin | null {
    const packageJson = join(packageDir, 'package.json');
    const gatewayEntry = join(packageDir, 'dist/gateway/index.js');
    if (!existsSync(packageJson) || !existsSync(gatewayEntry)) return null;

    try {
        const pkg = JSON.parse(readFileSync(packageJson, 'utf8')) as {
            name?: unknown;
            version?: unknown;
        };
        if (pkg.name !== PACKAGE_NAME || typeof pkg.version !== 'string') return null;
        return { packageDir, gatewayEntry, version: pkg.version };
    } catch {
        return null;
    }
}

function compareVersions(left: string, right: string): number {
    return compareSemanticVersions(left, right) ?? left.localeCompare(right);
}

/**
 * OpenCode 1.x 缓存：`<cache>/opencode/packages/<spec>/node_modules/<name>`；
 * OpenCode 2.x 缓存：`<cache>/opencode/npm/<spec>/<generation>/node_modules/<name>`。
 * 显式覆盖目录时只扫描该目录（两种布局都识别），避免读到真实缓存。
 */
function cacheRoots(): string[] {
    const override = process.env.SUPERTASK_OPENCODE_CACHE_DIR;
    if (override) return [override];
    const opencodeCache = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'opencode');
    return [join(opencodeCache, 'packages'), join(opencodeCache, 'npm')];
}

function subdirectories(directory: string): string[] {
    try {
        return readdirSync(directory, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => join(directory, entry.name));
    } catch {
        return [];
    }
}

function installedPlugins(): InstalledPlugin[] {
    const packageDirs = cacheRoots().flatMap((root) => subdirectories(root)
        .filter((directory) => {
            const name = directory.slice(root.length + 1);
            return name === PACKAGE_NAME || name.startsWith(`${PACKAGE_NAME}@`);
        })
        .flatMap((specDirectory) => [
            join(specDirectory, 'node_modules', PACKAGE_NAME),
            ...subdirectories(specDirectory).map((generation) => join(generation, 'node_modules', PACKAGE_NAME)),
        ]));
    return packageDirs
        .map(pluginAt)
        .filter((plugin): plugin is InstalledPlugin => plugin !== null);
}

export function resolveInstalledPlugin(): InstalledPlugin {
    const override = process.env.SUPERTASK_PLUGIN_PACKAGE_DIR;
    if (override) {
        const plugin = pluginAt(override);
        if (!plugin) throw new Error(`[supertask] 安装包无效或缺少 Gateway 构建产物: ${override}`);
        return plugin;
    }

    const installed = installedPlugins()
        .sort((left, right) => compareVersions(right.version, left.version));
    if (!installed[0]) {
        throw new Error(`[supertask] OpenCode 插件缓存中找不到可运行的 ${PACKAGE_NAME}`);
    }
    return installed[0];
}

function opencodeBin(): string {
    return openCodeExecutable();
}

function npmBin(): string {
    return process.env.SUPERTASK_NPM_BIN ?? 'npm';
}

function bunBin(): string {
    return process.env.SUPERTASK_BUN_BIN ?? 'bun';
}

function resolveGlobalCliExecutable(): string | null {
    const override = process.env.SUPERTASK_CLI_BIN;
    if (override) return existsSync(override) ? resolve(override) : null;
    const result = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['supertask'], {
        encoding: 'utf8',
        env: process.env,
        timeout: 10_000,
    });
    if (result.status !== 0) return null;
    const executable = `${result.stdout ?? ''}`.trim().split(/\r?\n/)[0];
    return executable && existsSync(executable) ? resolve(executable) : null;
}

function cliPackageDir(executable: string): string | null {
    try {
        let directory = dirname(realpathSync(executable));
        for (let depth = 0; depth < 6; depth += 1) {
            const packagePath = join(directory, 'package.json');
            if (existsSync(packagePath)) {
                const pkg = JSON.parse(readFileSync(packagePath, 'utf8')) as {
                    name?: unknown;
                };
                if (pkg.name === PACKAGE_NAME) return directory;
            }
            const parent = dirname(directory);
            if (parent === directory) break;
            directory = parent;
        }
    } catch {}
    return null;
}

function packageVersion(packageDir: string): string | null {
    try {
        const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
            name?: unknown;
            version?: unknown;
        };
        return pkg.name === PACKAGE_NAME && typeof pkg.version === 'string'
            ? pkg.version
            : null;
    } catch {
        return null;
    }
}

function npmGlobalRoot(): string | null {
    const result = spawnSync(npmBin(), ['root', '-g'], {
        encoding: 'utf8',
        env: process.env,
        timeout: 30_000,
    });
    if (result.status !== 0) return null;
    const root = `${result.stdout ?? ''}`.trim();
    if (!root) return null;
    try {
        return realpathSync(root);
    } catch {
        return resolve(root);
    }
}

function globalCliPackageManager(packageDir: string): GlobalCliPackageManager | null {
    const normalized = packageDir.replaceAll('\\', '/');
    if (normalized.includes('/install/global/node_modules/')) return 'bun';
    const npmRoot = npmGlobalRoot();
    if (npmRoot && resolve(packageDir) === join(npmRoot, PACKAGE_NAME)) return 'npm';
    return null;
}

export function getGlobalCliDiagnostic(): GlobalCliDiagnostic {
    const executable = resolveGlobalCliExecutable();
    if (!executable) {
        return {
            installed: false,
            executable: null,
            packageDir: null,
            version: null,
            packageManager: null,
        };
    }
    const packageDir = cliPackageDir(executable);
    if (!packageDir) {
        return {
            installed: true,
            executable,
            packageDir: null,
            version: null,
            packageManager: null,
        };
    }
    return {
        installed: true,
        executable,
        packageDir,
        version: packageVersion(packageDir),
        packageManager: globalCliPackageManager(packageDir),
    };
}

export function updateGlobalCli(version: string): GlobalCliUpdateResult {
    if (!isSemanticVersion(version)) {
        throw new Error(`[supertask] 全局 CLI 目标版本无效: ${version}`);
    }
    const before = getGlobalCliDiagnostic();
    if (!before.installed) return { ...before, action: 'not-installed' };
    if (before.version === version) return { ...before, action: 'already-current' };
    if (!before.packageManager) {
        throw new Error(
            `[supertask] 无法确认全局 CLI 的包管理器（当前 ${before.version ?? 'unknown'}，目标 ${version}）；`
            + `请执行 npm install -g ${PACKAGE_NAME}@${version} 或 bun add -g ${PACKAGE_NAME}@${version}`,
        );
    }

    const command = before.packageManager === 'npm' ? npmBin() : bunBin();
    const args = before.packageManager === 'npm'
        ? ['install', '-g', `${PACKAGE_NAME}@${version}`]
        : ['add', '-g', `${PACKAGE_NAME}@${version}`];
    const result = spawnSync(command, args, {
        encoding: 'utf8',
        env: process.env,
        timeout: 120_000,
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    if (result.error) {
        throw new Error(`[supertask] 全局 CLI 更新失败: ${result.error.message}`);
    }
    if (result.status !== 0) {
        throw new Error(`[supertask] 全局 CLI 更新失败: ${output || `退出码 ${result.status}`}`);
    }

    const after = getGlobalCliDiagnostic();
    if (after.version !== version) {
        throw new Error(
            `[supertask] 全局 CLI 更新后版本不匹配：期望 ${version}，实际 ${after.version ?? 'unknown'}`,
        );
    }
    return { ...after, action: 'updated' };
}

export function getLatestVersion(): string {
    const result = spawnSync(npmBin(), [
        'view', PACKAGE_NAME, 'dist-tags.latest', '--json',
    ], {
        encoding: 'utf8',
        env: process.env,
        timeout: 30_000,
    });
    const output = `${result.stdout ?? ''}`.trim();
    if (result.error) {
        throw new Error(`[supertask] 查询 npm latest 失败: ${result.error.message}`);
    }
    if (result.status !== 0) {
        const detail = `${result.stderr ?? ''}`.trim();
        throw new Error(`[supertask] 查询 npm latest 失败: ${detail || `退出码 ${result.status}`}`);
    }

    let response: unknown;
    try {
        response = JSON.parse(output);
    } catch {
        throw new Error(`[supertask] npm latest 返回无法解析: ${output || '(empty)'}`);
    }
    const versions = typeof response === 'string'
        ? [response]
        : Array.isArray(response) && response.every((value) => typeof value === 'string')
            ? response
            : [];
    const uniqueVersions = [...new Set(versions)];
    if (uniqueVersions.length !== 1 || !isSemanticVersion(uniqueVersions[0])) {
        throw new Error(`[supertask] npm latest 版本无效: ${String(response)}`);
    }
    return uniqueVersions[0];
}

export function resolveInstalledPluginVersion(expectedVersion: string): InstalledPlugin {
    const override = process.env.SUPERTASK_PLUGIN_PACKAGE_DIR;
    const installed = override
        ? [pluginAt(override)].filter((plugin): plugin is InstalledPlugin => plugin !== null)
        : installedPlugins();
    const matched = installed.find((plugin) => plugin.version === expectedVersion);
    if (matched) return matched;

    const actual = installed.length > 0
        ? installed.map((plugin) => plugin.version).join(', ')
        : '未找到可运行缓存';
    throw new Error(`[supertask] OpenCode 插件缓存版本不匹配：期望 ${expectedVersion}，实际 ${actual}`);
}

/** 插件声明可为 `"spec"`、1.x 的 `["spec", options]` 或 2.x 的 `{ package, options }`。 */
function pluginEntrySpec(entry: unknown): string | null {
    if (typeof entry === 'string') return entry;
    if (Array.isArray(entry) && typeof entry[0] === 'string') return entry[0];
    if (entry !== null && typeof entry === 'object' && typeof (entry as { package?: unknown }).package === 'string') {
        return (entry as { package: string }).package;
    }
    return null;
}

/**
 * OpenCode 2.x 的 `debug config` 返回按优先级从低到高排列的配置来源数组；
 * 按顺序合并各文档的 plugins（兼容旧键 plugin），`-spec` 表示移除之前的同名声明。
 */
export function mergeOpenCodeV2PluginConfig(value: unknown): { plugin: string[] } {
    if (!Array.isArray(value)) throw new Error('[supertask] OpenCode 2.x 配置来源不是数组');
    const merged: string[] = [];
    for (const entry of value) {
        if (entry === null || typeof entry !== 'object' || (entry as { type?: unknown }).type !== 'document') continue;
        const info = (entry as { info?: unknown }).info;
        if (info === null || typeof info !== 'object') continue;
        const record = info as Record<string, unknown>;
        for (const key of ['plugin', 'plugins']) {
            const list = record[key];
            if (!Array.isArray(list)) continue;
            for (const spec of list.map(pluginEntrySpec)) {
                if (spec === null) continue;
                if (spec.startsWith('-')) {
                    const target = spec.slice(1);
                    for (let index = merged.length - 1; index >= 0; index -= 1) {
                        if (merged[index] === target) merged.splice(index, 1);
                    }
                    continue;
                }
                if (!merged.includes(spec)) merged.push(spec);
            }
        }
    }
    return { plugin: merged };
}

export function resolveConfiguredPluginSpec(value: unknown): ConfiguredPluginSpec {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('[supertask] OpenCode 最终配置不是对象');
    }
    const plugins = (value as Record<string, unknown>).plugin;
    if (!Array.isArray(plugins)) {
        throw new Error(`[supertask] OpenCode 最终配置未启用 ${PACKAGE_NAME}`);
    }
    const matches = plugins.map(pluginEntrySpec)
        .filter((spec): spec is string => spec !== null)
        .filter((spec) => spec === PACKAGE_NAME || spec.startsWith(`${PACKAGE_NAME}@`));
    if (matches.length === 0) {
        throw new Error(`[supertask] OpenCode 最终配置未启用 ${PACKAGE_NAME}`);
    }
    if (matches.length !== 1) {
        throw new Error(`[supertask] OpenCode 最终配置包含多个 ${PACKAGE_NAME} 声明: ${matches.join(', ')}`);
    }
    const spec = matches[0];
    const version = spec.startsWith(`${PACKAGE_NAME}@`)
        ? spec.slice(PACKAGE_NAME.length + 1)
        : null;
    return {
        spec,
        version: version !== null && isSemanticVersion(version) ? version : null,
        exact: version !== null && isSemanticVersion(version),
    };
}

export function getOpenCodePluginDiagnostic(): OpenCodePluginDiagnostic {
    const failed = (message: string): OpenCodePluginDiagnostic => ({
        ok: false,
        spec: '',
        version: null,
        exact: false,
        cachedVersion: null,
        packageDir: null,
        error: message,
    });
    let outputDirectory: string | null = null;
    let outputFd: number | null = null;

    try {
        // 2.x 没有 --pure，且输出为配置来源数组；1.x 用 --pure 避免诊断时加载外部插件。
        const openCode = detectOpenCodeVersionSync(opencodeBin());
        outputDirectory = mkdtempSync(join(tmpdir(), 'opencode-supertask-config-'));
        chmodSync(outputDirectory, 0o700);
        const outputPath = join(outputDirectory, 'resolved-config.json');
        outputFd = openSync(outputPath, 'w', 0o600);
        const args = openCode.major === 2 ? ['debug', 'config'] : ['debug', 'config', '--pure'];
        const result = spawnSync(opencodeBin(), args, {
            encoding: 'utf8',
            env: process.env,
            timeout: 30_000,
            stdio: ['ignore', outputFd, 'pipe'],
        });
        closeSync(outputFd);
        outputFd = null;
        if (result.error) {
            return failed(`[supertask] 无法读取 OpenCode 最终配置: ${result.error.message}`);
        }
        if (result.status !== 0) {
            const detail = `${result.stderr ?? ''}`.trim();
            return failed(`[supertask] 无法读取 OpenCode 最终配置: ${detail || `退出码 ${result.status}`}`);
        }

        let config: unknown;
        try {
            config = JSON.parse(readFileSync(outputPath, 'utf8'));
        } catch {
            return failed('[supertask] OpenCode 最终配置不是有效 JSON');
        }

        let configured: ConfiguredPluginSpec;
        try {
            configured = resolveConfiguredPluginSpec(
                openCode.major === 2 ? mergeOpenCodeV2PluginConfig(config) : config,
            );
        } catch (error) {
            return failed(error instanceof Error ? error.message : String(error));
        }
        if (!configured.exact || configured.version === null) {
            return {
                ok: false,
                ...configured,
                cachedVersion: null,
                packageDir: null,
                error: `[supertask] OpenCode 插件必须固定精确版本，不能使用 ${configured.spec}`,
            };
        }
        try {
            const installed = resolveInstalledPluginVersion(configured.version);
            return {
                ok: true,
                ...configured,
                cachedVersion: installed.version,
                packageDir: installed.packageDir,
                error: null,
            };
        } catch (error) {
            return {
                ok: false,
                ...configured,
                cachedVersion: null,
                packageDir: null,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    } catch (error) {
        return failed(`[supertask] 无法读取 OpenCode 最终配置: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
        if (outputFd !== null) {
            try {
                closeSync(outputFd);
            } catch {
                // The descriptor may already be closed after a spawn failure.
            }
        }
        if (outputDirectory !== null) rmSync(outputDirectory, { recursive: true, force: true });
    }
}

function isSuperTaskPluginEntry(entry: unknown): boolean {
    const spec = pluginEntrySpec(entry);
    return spec === PACKAGE_NAME || (spec?.startsWith(`${PACKAGE_NAME}@`) ?? false);
}

/** 与 OpenCode 2.x `plugin add` 相同的全局配置文件定位规则。 */
export function openCodeGlobalConfigPath(): string {
    const directory = process.env.OPENCODE_CONFIG_DIR
        ?? join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode');
    const candidates = ['opencode.json', 'opencode.jsonc', '.opencode/opencode.json', '.opencode/opencode.jsonc']
        .map((name) => join(directory, name));
    return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

/**
 * 让全局配置只保留一条 SuperTask 声明并固定到精确版本。
 * 旧键 `plugin` 同时被 1.x 与 2.x 读取，存在时优先保留在该键；2.x `plugin add`
 * 只检查新键 `plugins`，会在旧键已有声明时追加重复项，这里一并收敛。保留注释与格式。
 */
export function pinPluginInGlobalConfig(configPath: string, spec: string): void {
    const original = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '{}';
    const errors: ParseError[] = [];
    const config: unknown = parseJsonc(original, errors, { allowTrailingComma: true });
    if (errors.length > 0 || config === null || typeof config !== 'object' || Array.isArray(config)) {
        throw new Error(`[supertask] OpenCode 全局配置不是有效 JSON 对象: ${configPath}`);
    }
    const record = config as Record<string, unknown>;
    const targetKey = Array.isArray(record.plugin) ? 'plugin' : 'plugins';
    let replacement: unknown = spec;
    for (const key of ['plugin', 'plugins']) {
        const list = record[key];
        const existing = Array.isArray(list) ? list.find(isSuperTaskPluginEntry) : undefined;
        if (existing === undefined) continue;
        if (Array.isArray(existing)) replacement = [spec, ...existing.slice(1)];
        else if (existing !== null && typeof existing === 'object') replacement = { ...existing, package: spec };
        break;
    }

    let text = original;
    for (const key of ['plugin', 'plugins'] as const) {
        const list = Array.isArray(record[key]) ? record[key] as unknown[] : undefined;
        if (key !== targetKey && (list === undefined || !list.some(isSuperTaskPluginEntry))) continue;
        const current = list ?? [];
        let next = current.filter((entry) => !isSuperTaskPluginEntry(entry));
        if (key === targetKey) {
            const position = current.findIndex(isSuperTaskPluginEntry);
            next = [...next];
            next.splice(position < 0 ? next.length : Math.min(position, next.length), 0, replacement);
        }
        text = applyJsoncEdits(text, modifyJsonc(text, [key], next, {
            formattingOptions: { tabSize: 2, insertSpaces: true },
        }));
    }
    if (text === original) return;
    mkdirSync(dirname(configPath), { recursive: true });
    const temporary = `${configPath}.supertask-${process.pid}.tmp`;
    writeFileSync(temporary, text.endsWith('\n') ? text : `${text}\n`, { mode: 0o600 });
    renameSync(temporary, configPath);
}

export function installPluginVersion(version: string): InstalledPlugin {
    if (!isSemanticVersion(version)) {
        throw new Error(`[supertask] OpenCode 插件版本无效: ${version}`);
    }
    const spec = `${PACKAGE_NAME}@${version}`;
    const major = detectOpenCodeVersionSync(opencodeBin()).major;
    const result = spawnSync(opencodeBin(), major === 2
        ? ['plugin', 'add', spec]
        : ['plugin', spec, '--global', '--force'], {
        encoding: 'utf8',
        env: process.env,
        timeout: 120_000,
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    if (result.error) {
        throw new Error(`[supertask] OpenCode 插件更新失败: ${result.error.message}`);
    }
    if (result.status !== 0) {
        throw new Error(`[supertask] OpenCode 插件更新失败: ${output || `退出码 ${result.status}`}`);
    }
    if (major === 2) pinPluginInGlobalConfig(openCodeGlobalConfigPath(), spec);
    return resolveInstalledPluginVersion(version);
}

export function installLatestPlugin(): InstalledPlugin {
    return installPluginVersion(getLatestVersion());
}
