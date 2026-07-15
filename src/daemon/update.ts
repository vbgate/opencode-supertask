import { spawnSync } from 'child_process';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const PACKAGE_NAME = 'opencode-supertask';

export interface InstalledPlugin {
    packageDir: string;
    gatewayEntry: string;
    version: string;
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

function versionParts(version: string): number[] | null {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
    return match ? match.slice(1).map(Number) : null;
}

function compareVersions(left: string, right: string): number {
    const a = versionParts(left);
    const b = versionParts(right);
    if (!a || !b) return left.localeCompare(right);
    for (let index = 0; index < 3; index += 1) {
        if (a[index] !== b[index]) return a[index] - b[index];
    }
    return 0;
}

function cacheRoot(): string {
    return process.env.SUPERTASK_OPENCODE_CACHE_DIR
        ?? join(homedir(), '.cache/opencode/packages');
}

export function resolveInstalledPlugin(): InstalledPlugin {
    const override = process.env.SUPERTASK_PLUGIN_PACKAGE_DIR;
    if (override) {
        const plugin = pluginAt(override);
        if (!plugin) throw new Error(`[supertask] 安装包无效或缺少 Gateway 构建产物: ${override}`);
        return plugin;
    }

    const root = cacheRoot();
    const packageDirs = existsSync(root)
        ? readdirSync(root, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && (entry.name === PACKAGE_NAME || entry.name.startsWith(`${PACKAGE_NAME}@`)))
            .map((entry) => join(root, entry.name, 'node_modules', PACKAGE_NAME))
        : [];
    const installed = packageDirs
        .map(pluginAt)
        .filter((plugin): plugin is InstalledPlugin => plugin !== null)
        .sort((left, right) => compareVersions(right.version, left.version));
    if (!installed[0]) {
        throw new Error(`[supertask] OpenCode 插件缓存中找不到可运行的 ${PACKAGE_NAME}`);
    }
    return installed[0];
}

function opencodeBin(): string {
    return process.env.SUPERTASK_OPENCODE_BIN ?? 'opencode';
}

export function installLatestPlugin(): InstalledPlugin {
    const result = spawnSync(opencodeBin(), [
        'plugin',
        `${PACKAGE_NAME}@latest`,
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
    return resolveInstalledPlugin();
}
