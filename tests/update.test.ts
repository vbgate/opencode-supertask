import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
    getGlobalCliDiagnostic,
    getOpenCodePluginDiagnostic,
    installLatestPlugin,
    installPluginVersion,
    resolveConfiguredPluginSpec,
    resolveInstalledPlugin,
    updateGlobalCli,
} from '../src/daemon/update';

const dirs: string[] = [];
const originalEnv = {
    bin: process.env.SUPERTASK_OPENCODE_BIN,
    bunBin: process.env.SUPERTASK_BUN_BIN,
    cliBin: process.env.SUPERTASK_CLI_BIN,
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
    restoreEnv('SUPERTASK_BUN_BIN', originalEnv.bunBin);
    restoreEnv('SUPERTASK_CLI_BIN', originalEnv.cliBin);
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
    test('最终配置必须只有一个精确版本的 SuperTask 声明', () => {
        expect(resolveConfiguredPluginSpec({
            plugin: ['other-plugin', 'opencode-supertask@0.1.31'],
        })).toEqual({ spec: 'opencode-supertask@0.1.31', version: '0.1.31', exact: true });
        expect(resolveConfiguredPluginSpec({ plugin: ['opencode-supertask@latest'] })).toEqual({
            spec: 'opencode-supertask@latest', version: null, exact: false,
        });
        expect(() => resolveConfiguredPluginSpec({
            plugin: ['opencode-supertask@0.1.30', 'opencode-supertask@0.1.31'],
        })).toThrow('包含多个');
    });

    test('诊断最终配置的精确版本并核对对应缓存包', () => {
        const dir = mkdtempSync(join(tmpdir(), 'supertask-doctor-plugin-'));
        dirs.push(dir);
        const packageDir = join(dir, 'package');
        const fakeOpencode = join(dir, 'opencode');
        writePlugin(packageDir, '0.1.31');
        writeFileSync(fakeOpencode, `#!/usr/bin/env bun
if (Bun.argv.slice(2).join(' ') === 'debug config --pure') {
  console.log(JSON.stringify({ plugin: ['opencode-supertask@0.1.31'] }));
  process.exit(0);
}
process.exit(1);
`);
        chmodSync(fakeOpencode, 0o755);
        process.env.SUPERTASK_OPENCODE_BIN = fakeOpencode;
        process.env.SUPERTASK_PLUGIN_PACKAGE_DIR = packageDir;

        expect(getOpenCodePluginDiagnostic()).toMatchObject({
            ok: true,
            spec: 'opencode-supertask@0.1.31',
            version: '0.1.31',
            cachedVersion: '0.1.31',
            packageDir,
            error: null,
        });
    });

    test('诊断拒绝 latest，即使旧缓存目录仍可读取', () => {
        const dir = mkdtempSync(join(tmpdir(), 'supertask-doctor-latest-'));
        dirs.push(dir);
        const packageDir = join(dir, 'package');
        const fakeOpencode = join(dir, 'opencode');
        writePlugin(packageDir, '0.1.5');
        writeFileSync(fakeOpencode, '#!/usr/bin/env bun\nconsole.log(JSON.stringify({ plugin: ["opencode-supertask@latest"] }));\n');
        chmodSync(fakeOpencode, 0o755);
        process.env.SUPERTASK_OPENCODE_BIN = fakeOpencode;
        process.env.SUPERTASK_PLUGIN_PACKAGE_DIR = packageDir;

        expect(getOpenCodePluginDiagnostic()).toMatchObject({
            ok: false,
            spec: 'opencode-supertask@latest',
            version: null,
            exact: false,
            cachedVersion: null,
        });
        expect(getOpenCodePluginDiagnostic().error).toContain('必须固定精确版本');
    });

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
        // npm 12 在部分 registry 响应中会把单个 dist-tag 包成数组。
        writeFileSync(fakeNpm, '#!/usr/bin/env bun\nconsole.log(JSON.stringify(["0.1.23"]));\n');
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

describe('全局 CLI 版本同步', () => {
    test('识别 Bun 全局安装并更新到精确版本', () => {
        const dir = mkdtempSync(join(tmpdir(), 'supertask-cli-bun-'));
        dirs.push(dir);
        const packageDir = join(dir, '.bun/install/global/node_modules/opencode-supertask');
        const executable = join(packageDir, 'dist/cli/index.js');
        const packageJson = join(packageDir, 'package.json');
        const argsLog = join(dir, 'bun-args.json');
        const fakeBun = join(dir, 'bun');
        mkdirSync(join(packageDir, 'dist/cli'), { recursive: true });
        writeFileSync(packageJson, JSON.stringify({ name: 'opencode-supertask', version: '0.1.31' }));
        writeFileSync(executable, '#!/usr/bin/env bun\n');
        chmodSync(executable, 0o755);
        writeFileSync(fakeBun, `#!/usr/bin/env bun
const args = Bun.argv.slice(2);
await Bun.write(${JSON.stringify(argsLog)}, JSON.stringify(args));
const spec = args.at(-1) ?? '';
const version = spec.slice(spec.lastIndexOf('@') + 1);
await Bun.write(${JSON.stringify(packageJson)}, JSON.stringify({ name: 'opencode-supertask', version }));
`);
        chmodSync(fakeBun, 0o755);
        process.env.SUPERTASK_CLI_BIN = executable;
        process.env.SUPERTASK_BUN_BIN = fakeBun;

        expect(getGlobalCliDiagnostic()).toMatchObject({
            installed: true,
            executable,
            packageDir: realpathSync(packageDir),
            version: '0.1.31',
            packageManager: 'bun',
        });
        expect(updateGlobalCli('0.1.34')).toMatchObject({
            action: 'updated',
            version: '0.1.34',
            packageManager: 'bun',
        });
        expect(JSON.parse(readFileSync(argsLog, 'utf8'))).toEqual([
            'add', '-g', 'opencode-supertask@0.1.34',
        ]);
    });

    test('识别 npm 全局安装并且同版本不重复安装', () => {
        const dir = mkdtempSync(join(tmpdir(), 'supertask-cli-npm-'));
        dirs.push(dir);
        const npmRoot = join(dir, 'npm-global/node_modules');
        const packageDir = join(npmRoot, 'opencode-supertask');
        const executable = join(packageDir, 'dist/cli/index.js');
        const packageJson = join(packageDir, 'package.json');
        const argsLog = join(dir, 'npm-args.json');
        const fakeNpm = join(dir, 'npm');
        mkdirSync(join(packageDir, 'dist/cli'), { recursive: true });
        writeFileSync(packageJson, JSON.stringify({ name: 'opencode-supertask', version: '0.1.33' }));
        writeFileSync(executable, '#!/usr/bin/env bun\n');
        chmodSync(executable, 0o755);
        writeFileSync(fakeNpm, `#!/usr/bin/env bun
const args = Bun.argv.slice(2);
if (args.join(' ') === 'root -g') {
  console.log(${JSON.stringify(npmRoot)});
  process.exit(0);
}
await Bun.write(${JSON.stringify(argsLog)}, JSON.stringify(args));
const spec = args.at(-1) ?? '';
const version = spec.slice(spec.lastIndexOf('@') + 1);
await Bun.write(${JSON.stringify(packageJson)}, JSON.stringify({ name: 'opencode-supertask', version }));
`);
        chmodSync(fakeNpm, 0o755);
        process.env.SUPERTASK_CLI_BIN = executable;
        process.env.SUPERTASK_NPM_BIN = fakeNpm;

        expect(getGlobalCliDiagnostic().packageManager).toBe('npm');
        expect(updateGlobalCli('0.1.34')).toMatchObject({
            action: 'updated',
            version: '0.1.34',
            packageManager: 'npm',
        });
        expect(JSON.parse(readFileSync(argsLog, 'utf8'))).toEqual([
            'install', '-g', 'opencode-supertask@0.1.34',
        ]);
        rmSync(argsLog);
        expect(updateGlobalCli('0.1.34').action).toBe('already-current');
        expect(existsSync(argsLog)).toBe(false);
    });

    test('无法确认包管理器时拒绝猜测并给出两种精确命令', () => {
        const dir = mkdtempSync(join(tmpdir(), 'supertask-cli-unknown-'));
        dirs.push(dir);
        const packageDir = join(dir, 'unknown/opencode-supertask');
        const executable = join(packageDir, 'dist/cli/index.js');
        const fakeNpm = join(dir, 'npm');
        mkdirSync(join(packageDir, 'dist/cli'), { recursive: true });
        writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
            name: 'opencode-supertask', version: '0.1.31',
        }));
        writeFileSync(executable, '#!/usr/bin/env bun\n');
        writeFileSync(fakeNpm, '#!/usr/bin/env bun\nprocess.exit(1);\n');
        chmodSync(executable, 0o755);
        chmodSync(fakeNpm, 0o755);
        process.env.SUPERTASK_CLI_BIN = executable;
        process.env.SUPERTASK_NPM_BIN = fakeNpm;

        expect(getGlobalCliDiagnostic().packageManager).toBeNull();
        expect(() => updateGlobalCli('0.1.34')).toThrow('npm install -g opencode-supertask@0.1.34');
        expect(() => updateGlobalCli('0.1.34')).toThrow('bun add -g opencode-supertask@0.1.34');
    });
});
