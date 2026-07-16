import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { installLatestPlugin, installPluginVersion, resolveInstalledPlugin } from '../src/daemon/update';

const dirs: string[] = [];
const originalEnv = {
    bin: process.env.SUPERTASK_OPENCODE_BIN,
    npmBin: process.env.SUPERTASK_NPM_BIN,
    cache: process.env.SUPERTASK_OPENCODE_CACHE_DIR,
    packageDir: process.env.SUPERTASK_PLUGIN_PACKAGE_DIR,
};

function restoreEnv(name: string, value: string | undefined): void {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
}

afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    restoreEnv('SUPERTASK_OPENCODE_BIN', originalEnv.bin);
    restoreEnv('SUPERTASK_NPM_BIN', originalEnv.npmBin);
    restoreEnv('SUPERTASK_OPENCODE_CACHE_DIR', originalEnv.cache);
    restoreEnv('SUPERTASK_PLUGIN_PACKAGE_DIR', originalEnv.packageDir);
});

function writePlugin(packageDir: string, version: string): void {
    mkdirSync(join(packageDir, 'dist/gateway'), { recursive: true });
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
        name: 'opencode-supertask',
        version,
    }));
    writeFileSync(join(packageDir, 'dist/gateway/index.js'), '');
}

describe('OpenCode 插件升级', () => {
    test('从多个缓存键中选择版本最高且包含 Gateway 的安装包', () => {
        const root = mkdtempSync(join(tmpdir(), 'supertask-cache-'));
        dirs.push(root);
        const oldPackage = join(root, 'opencode-supertask@latest/node_modules/opencode-supertask');
        const newPackage = join(root, 'opencode-supertask/node_modules/opencode-supertask');
        writePlugin(oldPackage, '0.1.5');
        writePlugin(newPackage, '0.1.21');
        process.env.SUPERTASK_OPENCODE_CACHE_DIR = root;
        delete process.env.SUPERTASK_PLUGIN_PACKAGE_DIR;

        expect(resolveInstalledPlugin()).toEqual({
            packageDir: newPackage,
            gatewayEntry: join(newPackage, 'dist/gateway/index.js'),
            version: '0.1.21',
        });
    });

    test('稳定版高于同核心版本的预发布缓存', () => {
        const root = mkdtempSync(join(tmpdir(), 'supertask-prerelease-cache-'));
        dirs.push(root);
        const prereleasePackage = join(root, 'opencode-supertask@next/node_modules/opencode-supertask');
        const stablePackage = join(root, 'opencode-supertask/node_modules/opencode-supertask');
        writePlugin(prereleasePackage, '0.2.0-beta.9');
        writePlugin(stablePackage, '0.2.0');
        process.env.SUPERTASK_OPENCODE_CACHE_DIR = root;
        delete process.env.SUPERTASK_PLUGIN_PACKAGE_DIR;

        expect(resolveInstalledPlugin().version).toBe('0.2.0');
    });

    test('先解析 npm latest 的精确版本，再用 OpenCode 官方命令安装并校验缓存', () => {
        const dir = mkdtempSync(join(tmpdir(), 'supertask-update-'));
        dirs.push(dir);
        const packageDir = join(dir, 'package');
        const argsLog = join(dir, 'args.json');
        const fakeOpencode = join(dir, 'opencode');
        const fakeNpm = join(dir, 'npm');
        writePlugin(packageDir, '0.1.23');
        writeFileSync(fakeOpencode, `#!/usr/bin/env bun
await Bun.write(${JSON.stringify(argsLog)}, JSON.stringify(Bun.argv.slice(2)));
`);
        writeFileSync(fakeNpm, '#!/usr/bin/env bun\nconsole.log(JSON.stringify("0.1.23"));\n');
        chmodSync(fakeOpencode, 0o755);
        chmodSync(fakeNpm, 0o755);
        process.env.SUPERTASK_OPENCODE_BIN = fakeOpencode;
        process.env.SUPERTASK_NPM_BIN = fakeNpm;
        process.env.SUPERTASK_PLUGIN_PACKAGE_DIR = packageDir;

        expect(installLatestPlugin().version).toBe('0.1.23');
        expect(JSON.parse(readFileSync(argsLog, 'utf8'))).toEqual([
            'plugin', 'opencode-supertask@0.1.23', '--global', '--force',
        ]);
    });

    test('OpenCode 返回成功但缓存仍是旧版本时拒绝重启 Gateway', () => {
        const dir = mkdtempSync(join(tmpdir(), 'supertask-stale-update-'));
        dirs.push(dir);
        const packageDir = join(dir, 'package');
        const fakeOpencode = join(dir, 'opencode');
        const fakeNpm = join(dir, 'npm');
        writePlugin(packageDir, '0.1.22');
        writeFileSync(fakeOpencode, '#!/usr/bin/env bun\nprocess.exit(0);\n');
        writeFileSync(fakeNpm, '#!/usr/bin/env bun\nconsole.log(JSON.stringify("0.1.23"));\n');
        chmodSync(fakeOpencode, 0o755);
        chmodSync(fakeNpm, 0o755);
        process.env.SUPERTASK_OPENCODE_BIN = fakeOpencode;
        process.env.SUPERTASK_NPM_BIN = fakeNpm;
        process.env.SUPERTASK_PLUGIN_PACKAGE_DIR = packageDir;

        expect(() => installLatestPlugin()).toThrow('期望 0.1.23，实际 0.1.22');
    });

    test('升级失败时可用精确旧版本命令回滚 OpenCode 插件', () => {
        const dir = mkdtempSync(join(tmpdir(), 'supertask-update-rollback-'));
        dirs.push(dir);
        const packageDir = join(dir, 'package');
        const argsLog = join(dir, 'args.json');
        const fakeOpencode = join(dir, 'opencode');
        writePlugin(packageDir, '0.1.20');
        writeFileSync(fakeOpencode, `#!/usr/bin/env bun
await Bun.write(${JSON.stringify(argsLog)}, JSON.stringify(Bun.argv.slice(2)));
`);
        chmodSync(fakeOpencode, 0o755);
        process.env.SUPERTASK_OPENCODE_BIN = fakeOpencode;
        process.env.SUPERTASK_PLUGIN_PACKAGE_DIR = packageDir;

        expect(installPluginVersion('0.1.20').version).toBe('0.1.20');
        expect(JSON.parse(readFileSync(argsLog, 'utf8'))).toEqual([
            'plugin', 'opencode-supertask@0.1.20', '--global', '--force',
        ]);
        expect(() => installPluginVersion('latest')).toThrow('版本无效');
    });
});
