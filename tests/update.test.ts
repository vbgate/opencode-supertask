import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { installLatestPlugin, resolveInstalledPlugin } from '../src/daemon/update';

const dirs: string[] = [];
const originalEnv = {
    bin: process.env.SUPERTASK_OPENCODE_BIN,
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

    test('使用 OpenCode 官方插件命令刷新缓存后返回已校验包', () => {
        const dir = mkdtempSync(join(tmpdir(), 'supertask-update-'));
        dirs.push(dir);
        const packageDir = join(dir, 'package');
        const argsLog = join(dir, 'args.json');
        const fakeOpencode = join(dir, 'opencode');
        writePlugin(packageDir, '0.1.21');
        writeFileSync(fakeOpencode, `#!/usr/bin/env bun
await Bun.write(${JSON.stringify(argsLog)}, JSON.stringify(Bun.argv.slice(2)));
`);
        chmodSync(fakeOpencode, 0o755);
        process.env.SUPERTASK_OPENCODE_BIN = fakeOpencode;
        process.env.SUPERTASK_PLUGIN_PACKAGE_DIR = packageDir;

        expect(installLatestPlugin().version).toBe('0.1.21');
        expect(JSON.parse(readFileSync(argsLog, 'utf8'))).toEqual([
            'plugin', 'opencode-supertask@latest', '--global', '--force',
        ]);
    });
});
