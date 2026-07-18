import { spawnSync } from 'child_process';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { compareSemanticVersions, isSemanticVersion } from '@core/semver';

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

function cacheRoot(): string {
    return process.env.SUPERTASK_OPENCODE_CACHE_DIR
        ?? join(homedir(), '.cache/opencode/packages');
}

function installedPlugins(): InstalledPlugin[] {
    const root = cacheRoot();
    const packageDirs = existsSync(root)
        ? readdirSync(root, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && (entry.name === PACKAGE_NAME || entry.name.startsWith(`${PACKAGE_NAME}@`)))
            .map((entry) => join(root, entry.name, 'node_modules', PACKAGE_NAME))
        : [];
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
    return process.env.SUPERTASK_OPENCODE_BIN ?? 'opencode';
}

function npmBin(): string {
    return process.env.SUPERTASK_NPM_BIN ?? 'npm';
}

function latestVersion(): string {
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

export function resolveConfiguredPluginSpec(value: unknown): ConfiguredPluginSpec {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('[supertask] OpenCode 最终配置不是对象');
    }
    const plugins = (value as Record<string, unknown>).plugin;
    if (!Array.isArray(plugins)) {
        throw new Error(`[supertask] OpenCode 最终配置未启用 ${PACKAGE_NAME}`);
    }
    const matches = plugins.flatMap((entry) => {
        if (typeof entry === 'string') return [entry];
        if (Array.isArray(entry) && typeof entry[0] === 'string') return [entry[0]];
        return [];
    }).filter((spec) => spec === PACKAGE_NAME || spec.startsWith(`${PACKAGE_NAME}@`));
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
    const result = spawnSync(opencodeBin(), ['debug', 'config', '--pure'], {
        encoding: 'utf8',
        env: process.env,
        timeout: 30_000,
    });
    const failed = (message: string): OpenCodePluginDiagnostic => ({
        ok: false,
        spec: '',
        version: null,
        exact: false,
        cachedVersion: null,
        packageDir: null,
        error: message,
    });
    if (result.error) {
        return failed(`[supertask] 无法读取 OpenCode 最终配置: ${result.error.message}`);
    }
    if (result.status !== 0) {
        const detail = `${result.stderr ?? ''}`.trim();
        return failed(`[supertask] 无法读取 OpenCode 最终配置: ${detail || `退出码 ${result.status}`}`);
    }

    let config: unknown;
    try {
        config = JSON.parse(`${result.stdout ?? ''}`);
    } catch {
        return failed('[supertask] OpenCode 最终配置不是有效 JSON');
    }

    let configured: ConfiguredPluginSpec;
    try {
        configured = resolveConfiguredPluginSpec(config);
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
}

export function installPluginVersion(version: string): InstalledPlugin {
    if (!isSemanticVersion(version)) {
        throw new Error(`[supertask] OpenCode 插件版本无效: ${version}`);
    }
    const result = spawnSync(opencodeBin(), [
        'plugin',
        `${PACKAGE_NAME}@${version}`,
        '--global',
        '--force',
    ], {
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
    return resolveInstalledPluginVersion(version);
}

export function installLatestPlugin(): InstalledPlugin {
    return installPluginVersion(latestVersion());
}
