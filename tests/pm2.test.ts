import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Database } from 'bun:sqlite';
import {
    ensurePm2LogRotation,
    ensureGateway,
    getPackageVersion,
    installMacLaunchAgent,
    isLinuxStartupConfigured,
    isMacLaunchAgentConfigured,
    isGatewayRunning,
    resolveGatewayEntry,
    resolvePm2SupervisorEntry,
    uninstall,
    upgrade,
    withGatewayMaintenance,
} from '../src/daemon/pm2';
import { superviseOnce } from '../src/daemon/pm2-supervisor';
import { withExclusiveManagementLock } from '../src/daemon/management-lock';

const dirs: string[] = [];
const originalEnv = {
    pm2: process.env.SUPERTASK_PM2_BIN,
    bun: process.env.SUPERTASK_BUN_BIN,
    entry: process.env.SUPERTASK_GATEWAY_ENTRY,
    version: process.env.SUPERTASK_VERSION_FILE,
    db: process.env.SUPERTASK_DB_PATH,
    config: process.env.SUPERTASK_CONFIG_PATH,
    readyTimeout: process.env.SUPERTASK_GATEWAY_READY_TIMEOUT_MS,
    killTimeout: process.env.SUPERTASK_PM2_KILL_TIMEOUT_MS,
    launchAgent: process.env.SUPERTASK_LAUNCH_AGENT_PATH,
    launchctl: process.env.SUPERTASK_LAUNCHCTL_BIN,
    path: process.env.PATH,
    managementLock: process.env.SUPERTASK_PM2_MANAGEMENT_LOCK,
    managementLockTimeout: process.env.SUPERTASK_PM2_MANAGEMENT_LOCK_TIMEOUT_MS,
    pm2CommandTimeout: process.env.SUPERTASK_PM2_COMMAND_TIMEOUT_MS,
    supervisorCommandTimeout: process.env.SUPERTASK_PM2_SUPERVISOR_COMMAND_TIMEOUT_MS,
    systemctl: process.env.SUPERTASK_SYSTEMCTL_BIN,
    systemdUnit: process.env.SUPERTASK_PM2_SYSTEMD_UNIT,
    pm2Home: process.env.PM2_HOME,
    launchVerifyTimeout: process.env.SUPERTASK_LAUNCH_AGENT_VERIFY_TIMEOUT_MS,
};

beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'supertask-pm2-test-launch-agent-'));
    dirs.push(dir);
    process.env.SUPERTASK_LAUNCH_AGENT_PATH = join(dir, 'missing.plist');
});

afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    restoreEnv('SUPERTASK_PM2_BIN', originalEnv.pm2);
    restoreEnv('SUPERTASK_BUN_BIN', originalEnv.bun);
    restoreEnv('SUPERTASK_GATEWAY_ENTRY', originalEnv.entry);
    restoreEnv('SUPERTASK_VERSION_FILE', originalEnv.version);
    restoreEnv('SUPERTASK_DB_PATH', originalEnv.db);
    restoreEnv('SUPERTASK_CONFIG_PATH', originalEnv.config);
    restoreEnv('SUPERTASK_GATEWAY_READY_TIMEOUT_MS', originalEnv.readyTimeout);
    restoreEnv('SUPERTASK_PM2_KILL_TIMEOUT_MS', originalEnv.killTimeout);
    restoreEnv('SUPERTASK_LAUNCH_AGENT_PATH', originalEnv.launchAgent);
    restoreEnv('SUPERTASK_LAUNCHCTL_BIN', originalEnv.launchctl);
    restoreEnv('PATH', originalEnv.path);
    restoreEnv('SUPERTASK_PM2_MANAGEMENT_LOCK', originalEnv.managementLock);
    restoreEnv('SUPERTASK_PM2_MANAGEMENT_LOCK_TIMEOUT_MS', originalEnv.managementLockTimeout);
    restoreEnv('SUPERTASK_PM2_COMMAND_TIMEOUT_MS', originalEnv.pm2CommandTimeout);
    restoreEnv('SUPERTASK_PM2_SUPERVISOR_COMMAND_TIMEOUT_MS', originalEnv.supervisorCommandTimeout);
    restoreEnv('SUPERTASK_SYSTEMCTL_BIN', originalEnv.systemctl);
    restoreEnv('SUPERTASK_PM2_SYSTEMD_UNIT', originalEnv.systemdUnit);
    restoreEnv('PM2_HOME', originalEnv.pm2Home);
    restoreEnv('SUPERTASK_LAUNCH_AGENT_VERIFY_TIMEOUT_MS', originalEnv.launchVerifyTimeout);
});

function restoreEnv(name: string, value: string | undefined): void {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
}

describe('PM2 Gateway 管理', () => {
    test('显式安装流程会配置有限保留的 PM2 日志轮转', () => {
        const dir = mkdtempSync(join(tmpdir(), 'supertask-pm2-logrotate-'));
        dirs.push(dir);
        const fakePm2 = join(dir, 'pm2');
        const moduleState = join(dir, 'module-state');
        const log = join(dir, 'calls.jsonl');
        writeFileSync(fakePm2, `#!/usr/bin/env node
const { appendFileSync, existsSync, writeFileSync } = require('fs');
const args = process.argv.slice(2);
if (args[0] === '--version') process.exit(0);
if (args[0] === 'jlist') {
    console.log(existsSync(${JSON.stringify(moduleState)})
        ? JSON.stringify([{ name: 'pm2-logrotate', pid: 42, pm2_env: { status: 'online' } }])
        : '[]');
    process.exit(0);
}
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] === 'install') writeFileSync(${JSON.stringify(moduleState)}, 'installed');
`);
        chmodSync(fakePm2, 0o755);
        process.env.SUPERTASK_PM2_BIN = fakePm2;

        expect(ensurePm2LogRotation()).toBe(true);
        const calls = readFileSync(log, 'utf8').trim().split('\n')
            .map((line) => JSON.parse(line) as string[]);
        expect(calls).toEqual([
            ['install', 'pm2-logrotate'],
            ['set', 'pm2-logrotate:max_size', '10M'],
            ['set', 'pm2-logrotate:retain', '7'],
            ['set', 'pm2-logrotate:compress', 'true'],
            ['set', 'pm2-logrotate:workerInterval', '3600'],
        ]);
    });

    test('macOS 用户级 LaunchAgent 长期监督 PM2 且无需 sudo', () => {
        const dir = mkdtempSync(join(tmpdir(), 'supertask-launch-agent-'));
        dirs.push(dir);
        const fakePm2 = join(dir, 'pm2 & tool');
        const pm2Home = join(dir, '.pm2');
        const fakeLaunchctl = join(dir, 'launchctl');
        const launchctlLog = join(dir, 'launchctl.jsonl');
        const plist = join(dir, 'LaunchAgents', 'supertask.plist');
        const supervisorEntry = join(process.cwd(), 'src/daemon/pm2-supervisor.ts');
        const gateway = join(dir, 'gateway.js');
        const expectedEnv = { ...process.env, PM2_HOME: pm2Home };
        mkdirSync(pm2Home, { recursive: true });
        writeFileSync(gateway, '');
        writeFileSync(fakePm2, '#!/bin/sh\nexit 0\n');
        chmodSync(fakePm2, 0o755);
        writeFileSync(join(pm2Home, 'dump.pm2'), JSON.stringify([{
            name: 'supertask-gateway', pm_exec_path: process.execPath, args: [gateway],
            pm2_env: { args: [gateway], pm_exec_path: process.execPath, pm_cwd: process.cwd(), env: expectedEnv },
        }]));
        writeFileSync(fakeLaunchctl, `#!/usr/bin/env bun
import { appendFileSync } from 'fs';
const args = Bun.argv.slice(2);
appendFileSync(${JSON.stringify(launchctlLog)}, JSON.stringify(args) + '\\n');
if (args[0] === 'print') {
    console.log('path = ${plist}');
    console.log('program = ${process.execPath}');
    console.log('state = running');
}
`);
        chmodSync(fakeLaunchctl, 0o755);
        process.env.SUPERTASK_PM2_BIN = fakePm2;
        process.env.SUPERTASK_LAUNCHCTL_BIN = fakeLaunchctl;
        process.env.SUPERTASK_LAUNCH_AGENT_PATH = plist;
        process.env.PM2_HOME = pm2Home;

        expect(installMacLaunchAgent({
            gatewayEntry: gateway,
            bunPath: process.execPath,
            cwd: process.cwd(),
            env: expectedEnv,
        })).toBe(plist);
        const contents = readFileSync(plist, 'utf8');
        expect(contents).toContain('com.supertask.pm2-resurrect');
        expect(contents).toContain(`${fakePm2.replace('&', '&amp;')}`);
        expect(contents).toContain(`<string>${supervisorEntry}</string>`);
        expect(contents).toContain(`<string>${join(pm2Home, 'supertask-gateway.manage.sqlite')}</string>`);
        expect(contents).toContain('<key>KeepAlive</key>\n    <true/>');
        const calls = readFileSync(launchctlLog, 'utf8').trim().split('\n')
            .map((line) => JSON.parse(line) as string[]);
        expect(calls).toEqual([
            ['bootout', `gui/${process.getuid()}/com.supertask.pm2-resurrect`],
            ['bootstrap', `gui/${process.getuid()}`, plist],
            ['print', `gui/${process.getuid()}/com.supertask.pm2-resurrect`],
        ]);
    });

    test('新 LaunchAgent 加载失败时恢复旧配置和已加载状态', () => {
        const dir = mkdtempSync(join(tmpdir(), 'supertask-launch-agent-rollback-'));
        dirs.push(dir);
        const fakePm2 = join(dir, 'pm2');
        const fakeLaunchctl = join(dir, 'launchctl');
        const launchctlLog = join(dir, 'launchctl.jsonl');
        const plist = join(dir, 'supertask.plist');
        writeFileSync(fakePm2, '');
        writeFileSync(plist, 'old-plist');
        writeFileSync(fakeLaunchctl, `#!/usr/bin/env bun
import { appendFileSync, readFileSync } from 'fs';
const args = Bun.argv.slice(2);
appendFileSync(${JSON.stringify(launchctlLog)}, JSON.stringify(args) + '\\n');
if (args[0] === 'print') process.exit(0);
if (args[0] === 'bootstrap' && readFileSync(${JSON.stringify(plist)}, 'utf8') !== 'old-plist') {
    console.error('new plist rejected');
    process.exit(7);
}
`);
        chmodSync(fakeLaunchctl, 0o755);
        process.env.SUPERTASK_PM2_BIN = fakePm2;
        process.env.SUPERTASK_LAUNCHCTL_BIN = fakeLaunchctl;
        process.env.SUPERTASK_LAUNCH_AGENT_PATH = plist;

        expect(() => installMacLaunchAgent()).toThrow('new plist rejected');
        expect(readFileSync(plist, 'utf8')).toBe('old-plist');
        const calls = readFileSync(launchctlLog, 'utf8').trim().split('\n')
            .map((line) => JSON.parse(line) as string[]);
        expect(calls.map((call) => call[0])).toEqual(['print', 'bootout', 'bootstrap', 'bootstrap']);
    });

    test('LaunchAgent bootstrap 成功但监督进程未运行时仍回滚旧配置', () => {
        const dir = mkdtempSync(join(tmpdir(), 'supertask-launch-agent-not-running-'));
        dirs.push(dir);
        const fakePm2 = join(dir, 'pm2');
        const fakeLaunchctl = join(dir, 'launchctl');
        const plist = join(dir, 'supertask.plist');
        writeFileSync(fakePm2, '#!/bin/sh\nexit 0\n');
        chmodSync(fakePm2, 0o755);
        writeFileSync(plist, 'old-plist');
        writeFileSync(fakeLaunchctl, '#!/bin/sh\nexit 0\n');
        chmodSync(fakeLaunchctl, 0o755);
        process.env.SUPERTASK_PM2_BIN = fakePm2;
        process.env.SUPERTASK_LAUNCHCTL_BIN = fakeLaunchctl;
        process.env.SUPERTASK_LAUNCH_AGENT_PATH = plist;
        process.env.SUPERTASK_LAUNCH_AGENT_VERIFY_TIMEOUT_MS = '10';

        expect(() => installMacLaunchAgent()).toThrow('supervisor 未保持 running');
        expect(readFileSync(plist, 'utf8')).toBe('old-plist');
    });

    test('LaunchAgent 诊断同时校验已加载程序和 PM2 dump', () => {
        const dir = mkdtempSync(join(tmpdir(), 'supertask-launch-agent-doctor-'));
        dirs.push(dir);
        const pm2Home = join(dir, '.pm2');
        const fakePm2 = join(dir, 'pm2');
        const fakeLaunchctl = join(dir, 'launchctl');
        const plist = join(dir, 'supertask.plist');
        const gateway = join(dir, 'gateway.js');
        mkdirSync(pm2Home, { recursive: true });
        writeFileSync(fakePm2, '#!/bin/sh\nexit 0\n');
        writeFileSync(gateway, '');
        chmodSync(fakePm2, 0o755);
        const supervisorEntry = join(process.cwd(), 'src/daemon/pm2-supervisor.ts');
        const validPlist = `<plist><dict>
<key>ProgramArguments</key><array><string>${process.execPath}</string><string>${supervisorEntry}</string><string>${fakePm2}</string></array>
<key>EnvironmentVariables</key><dict><key>PM2_HOME</key><string>${pm2Home}</string><key>SUPERTASK_PM2_MANAGEMENT_LOCK</key><string>${join(pm2Home, 'supertask-gateway.manage.sqlite')}</string></dict>
</dict></plist>`;
        writeFileSync(plist, validPlist);
        writeFileSync(join(pm2Home, 'dump.pm2'), JSON.stringify([{
            name: 'supertask-gateway',
            pm_exec_path: fakePm2,
            args: [gateway],
            pm_cwd: dir,
            env: { HOME: dir, PM2_HOME: pm2Home },
        }]));
        writeFileSync(fakeLaunchctl, `#!/usr/bin/env bun
console.log('path = ${plist}');
console.log('program = ${process.execPath}');
console.log('state = running');
`);
        chmodSync(fakeLaunchctl, 0o755);
        process.env.SUPERTASK_LAUNCHCTL_BIN = fakeLaunchctl;
        process.env.SUPERTASK_LAUNCH_AGENT_PATH = plist;

        expect(isMacLaunchAgentConfigured(pm2Home)).toBe(true);

        writeFileSync(join(pm2Home, 'dump.pm2'), JSON.stringify([{
            name: 'supertask-gateway',
            pm_exec_path: join(dir, 'missing-saved-bun'),
            args: [gateway],
            pm2_env: {
                args: [gateway],
                pm_exec_path: join(dir, 'missing-saved-bun'),
                pm_cwd: dir,
                env: { HOME: dir, PM2_HOME: pm2Home },
            },
        }]));
        process.env.SUPERTASK_BUN_BIN = fakePm2;
        expect(isMacLaunchAgentConfigured(pm2Home)).toBe(false);

        writeFileSync(plist, validPlist.replace(fakePm2, join(dir, 'missing-pm2')));
        expect(isMacLaunchAgentConfigured(pm2Home)).toBe(false);

        writeFileSync(plist, validPlist);
        writeFileSync(join(pm2Home, 'dump.pm2'), '[]');
        expect(isMacLaunchAgentConfigured(pm2Home)).toBe(false);
    });

    test('源码和构建目录都使用真实包版本与可用 Gateway 入口', () => {
        const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { version: string };
        const ambientVersion = process.env.npm_package_version;
        process.env.npm_package_version = '99.88.77-host-project';
        try {
            expect(getPackageVersion()).toBe(pkg.version);
        } finally {
            if (ambientVersion === undefined) delete process.env.npm_package_version;
            else process.env.npm_package_version = ambientVersion;
        }
        expect(resolveGatewayEntry()).toBe(join(process.cwd(), 'src/gateway/index.ts'));
    });

    test('构建后的 CLI 能定位 daemon 目录中的 PM2 supervisor', () => {
        const dir = mkdtempSync(join(tmpdir(), 'supertask-built-supervisor-'));
        dirs.push(dir);
        const cliDir = join(dir, 'dist/cli');
        const supervisorEntry = join(dir, 'dist/daemon/pm2-supervisor.js');
        mkdirSync(cliDir, { recursive: true });
        mkdirSync(join(dir, 'dist/daemon'), { recursive: true });
        writeFileSync(supervisorEntry, '');

        expect(resolvePm2SupervisorEntry(cliDir)).toBe(supervisorEntry);
    });

    test('插件探测不到 pm2 时不执行全局安装', () => {
        process.env.SUPERTASK_PM2_BIN = join(tmpdir(), '不存在的-pm2');
        expect(ensureGateway()).toEqual({ ok: false, reason: 'pm2-not-installed' });
    });

    test('PM2 命令忽略 TERM 并永久挂起时管理操作会硬超时', () => {
        const dir = mkdtempSync(join(tmpdir(), 'supertask-pm2-timeout-'));
        dirs.push(dir);
        const fakePm2 = join(dir, 'pm2');
        const started = join(dir, 'started');
        writeFileSync(fakePm2, `#!/usr/bin/env bun
import { writeFileSync } from 'fs';
writeFileSync(${JSON.stringify(started)}, 'yes');
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`);
        chmodSync(fakePm2, 0o755);
        process.env.SUPERTASK_PM2_BIN = fakePm2;
        process.env.SUPERTASK_PM2_COMMAND_TIMEOUT_MS = '500';
        process.env.SUPERTASK_PM2_MANAGEMENT_LOCK = join(dir, 'gateway.sqlite');

        const startedAt = Date.now();
        expect(ensureGateway()).toEqual({ ok: false, reason: 'pm2-not-installed' });
        expect(Date.now() - startedAt).toBeLessThan(2_000);
        expect(existsSync(started)).toBe(true);
        expect(ensureGateway()).toEqual({ ok: false, reason: 'pm2-not-installed' });
    });

    test('Gateway SQLite 管理锁覆盖完整操作并拒绝嵌套 PM2 替换', () => {
        const dir = mkdtempSync(join(tmpdir(), 'supertask-pm2-lock-'));
        dirs.push(dir);
        const lock = join(dir, 'gateway.sqlite');
        process.env.SUPERTASK_PM2_MANAGEMENT_LOCK = lock;
        process.env.SUPERTASK_PM2_MANAGEMENT_LOCK_TIMEOUT_MS = '20';
        process.env.SUPERTASK_PM2_BIN = join(dir, 'must-not-run-pm2');

        withExclusiveManagementLock(lock, 100, () => {
            expect(() => ensureGateway()).toThrow('另一个 Gateway 管理操作仍在进行');
            let operationRan = false;
            expect(() => withGatewayMaintenance(false, () => {
                operationRan = true;
            })).toThrow('另一个 Gateway 管理操作仍在进行');
            expect(operationRan).toBe(false);
        });

        expect(ensureGateway()).toEqual({ ok: false, reason: 'pm2-not-installed' });
    });

    test('两个真实进程争用管理锁时临界区绝不重叠', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'supertask-pm2-lock-contenders-'));
        dirs.push(dir);
        const lock = join(dir, 'gateway.sqlite');
        const log = join(dir, 'critical-sections.log');
        const contender = join(dir, 'contender.ts');
        writeFileSync(contender, `
import { appendFileSync } from 'fs';
import { withExclusiveManagementLock } from ${JSON.stringify(join(process.cwd(), 'src/daemon/management-lock.ts'))};
const [lock, log, id] = process.argv.slice(2);
const sleeper = new Int32Array(new SharedArrayBuffer(4));
withExclusiveManagementLock(lock, 2_000, () => {
    appendFileSync(log, \`enter:\${id}\\n\`);
    Atomics.wait(sleeper, 0, 0, 150);
    appendFileSync(log, \`exit:\${id}\\n\`);
});
`);

        const first = Bun.spawn([process.execPath, contender, lock, log, 'first'], {
            stdout: 'pipe', stderr: 'pipe',
        });
        const second = Bun.spawn([process.execPath, contender, lock, log, 'second'], {
            stdout: 'pipe', stderr: 'pipe',
        });
        expect(await Promise.all([first.exited, second.exited])).toEqual([0, 0]);
        const events = readFileSync(log, 'utf8').trim().split('\n');
        expect(events).toHaveLength(4);
        expect(events[0].startsWith('enter:')).toBe(true);
        expect(events[1]).toBe(events[0].replace('enter:', 'exit:'));
        expect(events[2].startsWith('enter:')).toBe(true);
        expect(events[3]).toBe(events[2].replace('enter:', 'exit:'));
    });

    test('后续 CLI 未带旧 custom override 时仍与旧监督器跨进程互斥', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'supertask-pm2-legacy-lock-handoff-'));
        dirs.push(dir);
        const pm2Home = join(dir, '.pm2');
        const customLock = join(dir, 'legacy-custom.sqlite');
        const events = join(dir, 'events.log');
        const ready = join(dir, 'ready');
        const holder = join(dir, 'legacy-holder.ts');
        const nextCli = join(dir, 'next-cli.ts');
        mkdirSync(pm2Home, { recursive: true });
        writeFileSync(join(pm2Home, 'dump.pm2'), JSON.stringify([{
            name: 'supertask-gateway',
            pm2_env: {
                pm_cwd: dir,
                env: { SUPERTASK_PM2_MANAGEMENT_LOCK: customLock },
            },
        }]));
        writeFileSync(holder, `
import { appendFileSync, writeFileSync } from 'fs';
import { withExclusiveManagementLock } from ${JSON.stringify(join(process.cwd(), 'src/daemon/management-lock.ts'))};
const sleeper = new Int32Array(new SharedArrayBuffer(4));
withExclusiveManagementLock(${JSON.stringify(customLock)}, 2_000, () => {
    appendFileSync(${JSON.stringify(events)}, 'legacy-enter\\n');
    writeFileSync(${JSON.stringify(ready)}, 'ready');
    Atomics.wait(sleeper, 0, 0, 400);
    appendFileSync(${JSON.stringify(events)}, 'legacy-exit\\n');
});
`);
        writeFileSync(nextCli, `
import { appendFileSync } from 'fs';
process.env.PM2_HOME = ${JSON.stringify(pm2Home)};
process.env.SUPERTASK_PM2_BIN = ${JSON.stringify(join(dir, 'missing-pm2'))};
process.env.SUPERTASK_PM2_MANAGEMENT_LOCK_TIMEOUT_MS = '2000';
process.env.SUPERTASK_LAUNCH_AGENT_PATH = ${JSON.stringify(process.env.SUPERTASK_LAUNCH_AGENT_PATH)};
delete process.env.SUPERTASK_PM2_MANAGEMENT_LOCK;
const { ensureGateway } = await import(${JSON.stringify(join(process.cwd(), 'src/daemon/pm2.ts'))});
ensureGateway();
appendFileSync(${JSON.stringify(events)}, 'next-cli-done\\n');
`);

        const oldSupervisor = Bun.spawn([process.execPath, holder], {
            stdout: 'pipe', stderr: 'pipe',
        });
        const deadline = Date.now() + 3_000;
        while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(20);
        expect(existsSync(ready)).toBe(true);
        const newCli = Bun.spawn([process.execPath, nextCli], {
            stdout: 'pipe', stderr: 'pipe',
        });

        expect(await Promise.all([oldSupervisor.exited, newCli.exited])).toEqual([0, 0]);
        expect(readFileSync(events, 'utf8').trim().split('\n')).toEqual([
            'legacy-enter',
            'legacy-exit',
            'next-cli-done',
        ]);
    });

    test('已安装 LaunchAgent 的 PM2_HOME 不同时在任何修改前失败关闭', () => {
        if (process.platform !== 'darwin') return;
        const dir = mkdtempSync(join(tmpdir(), 'supertask-pm2-home-mismatch-'));
        dirs.push(dir);
        const installedPm2Home = join(dir, 'installed-pm2');
        const currentPm2Home = join(dir, 'current-pm2');
        const plist = join(dir, 'supertask.plist');
        mkdirSync(installedPm2Home, { recursive: true });
        mkdirSync(currentPm2Home, { recursive: true });
        writeFileSync(plist, `
<plist><dict>
<key>PM2_HOME</key><string>${installedPm2Home}</string>
<key>SUPERTASK_PM2_MANAGEMENT_LOCK</key><string>${join(installedPm2Home, 'supertask-gateway.manage.sqlite')}</string>
</dict></plist>
`);
        process.env.SUPERTASK_LAUNCH_AGENT_PATH = plist;
        process.env.PM2_HOME = currentPm2Home;
        process.env.SUPERTASK_PM2_BIN = join(dir, 'missing-pm2');

        expect(() => ensureGateway()).toThrow('两个 PM2 daemon');
        let operationRan = false;
        expect(() => withGatewayMaintenance(false, () => {
            operationRan = true;
        })).toThrow('两个 PM2 daemon');
        expect(operationRan).toBe(false);
        expect(existsSync(join(currentPm2Home, 'dump.pm2'))).toBe(false);
    });

    test('PM2 stop 超过通用 15 秒超时但仍在 kill window 内时管理锁保持到命令完成', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'supertask-pm2-slow-stop-'));
        dirs.push(dir);
        const fakePm2 = join(dir, 'pm2');
        const fakeBun = join(dir, 'bun');
        const gateway = join(dir, 'gateway.ts');
        const dbPath = join(dir, 'tasks.db');
        const configPath = join(dir, 'config.json');
        const lockPath = join(dir, 'gateway-management.sqlite');
        const stopStarted = join(dir, 'stop-started');
        const contenderResult = join(dir, 'contender-result');
        const contender = join(dir, 'contender.ts');
        writeFileSync(fakeBun, '#!/bin/sh\nexit 0\n');
        writeFileSync(gateway, '');
        writeFileSync(configPath, JSON.stringify({
            configVersion: 2,
            worker: { shutdownGracePeriodMs: 0 },
        }));
        chmodSync(fakeBun, 0o755);

        process.env.SUPERTASK_PM2_BIN = fakePm2;
        process.env.SUPERTASK_BUN_BIN = fakeBun;
        process.env.SUPERTASK_GATEWAY_ENTRY = gateway;
        process.env.SUPERTASK_DB_PATH = dbPath;
        process.env.SUPERTASK_CONFIG_PATH = configPath;
        process.env.SUPERTASK_PM2_MANAGEMENT_LOCK = lockPath;
        process.env.PM2_HOME = join(dir, '.pm2');
        const savedEnv = { ...process.env };
        const snapshot = [{
            name: 'supertask-gateway',
            pid: 4242,
            kill_timeout: 15_000,
            pm2_env: {
                status: 'online',
                args: [gateway],
                pm_exec_path: fakeBun,
                pm_cwd: process.cwd(),
                env: savedEnv,
                kill_timeout: 15_000,
            },
        }];
        writeFileSync(fakePm2, `#!/usr/bin/env bun
import { writeFileSync } from 'fs';
const args = Bun.argv.slice(2);
if (args[0] === '--version') process.exit(0);
if (args[0] === 'jlist') {
    console.log(${JSON.stringify(JSON.stringify(snapshot))});
    process.exit(0);
}
if (args[0] === 'stop') {
    writeFileSync(${JSON.stringify(stopStarted)}, 'started');
    await Bun.sleep(16_000);
    process.exit(0);
}
process.exit(0);
`);
        chmodSync(fakePm2, 0o755);
        const database = new Database(dbPath);
        database.exec('CREATE TABLE gateway_lock (id INTEGER PRIMARY KEY, pid INTEGER NOT NULL, acquired_at INTEGER NOT NULL, heartbeat_at INTEGER NOT NULL, ready_at INTEGER, version TEXT)');
        database.query('INSERT INTO gateway_lock (id, pid, acquired_at, heartbeat_at, ready_at) VALUES (1, ?, ?, ?, ?)')
            .run(4242, Date.now(), Date.now(), Date.now());
        database.close();

        writeFileSync(contender, `
import { existsSync, writeFileSync } from 'fs';
import { ManagementLockBusyError, withExclusiveManagementLock } from ${JSON.stringify(join(process.cwd(), 'src/daemon/management-lock.ts'))};
while (!existsSync(${JSON.stringify(stopStarted)})) await Bun.sleep(10);
await Bun.sleep(15_200);
try {
    withExclusiveManagementLock(${JSON.stringify(lockPath)}, 100, () => {});
    writeFileSync(${JSON.stringify(contenderResult)}, 'acquired');
} catch (error) {
    writeFileSync(${JSON.stringify(contenderResult)}, error instanceof ManagementLockBusyError ? 'busy' : 'error');
}
`);
        const competing = Bun.spawn([process.execPath, contender], { stdout: 'pipe', stderr: 'pipe' });
        const startedAt = Date.now();
        const maintenance = withGatewayMaintenance(true, () => 'maintained');

        expect(maintenance.result).toBe('maintained');
        expect(maintenance.wasRunning).toBe(true);
        expect(maintenance.keptStopped).toBe(true);
        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(16_000);
        expect(await competing.exited).toBe(0);
        expect(readFileSync(contenderResult, 'utf8')).toBe('busy');
    }, 25_000);

    test('相对数据库路径按 PM2 pm_cwd 解析，作用域不同时禁止插件写入另一数据库', () => {
        const dir = mkdtempSync(join(tmpdir(), 'supertask-pm2-scope-'));
        dirs.push(dir);
        const fakePm2 = join(dir, 'pm2');
        const fakeBun = join(dir, 'bun');
        const gateway = join(dir, 'gateway.js');
        const calls = join(dir, 'calls.jsonl');
        writeFileSync(fakeBun, '#!/bin/sh\nexit 0\n');
        writeFileSync(gateway, '');
        chmodSync(fakeBun, 0o755);
        writeFileSync(fakePm2, `#!/usr/bin/env bun
import { appendFileSync } from 'fs';
const args = Bun.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
if (args[0] === '--version') process.exit(0);
if (args[0] === 'jlist') console.log(JSON.stringify([{ name: 'supertask-gateway', pid: 4242, pm2_env: {
    status: 'online', args: [${JSON.stringify(gateway)}], pm_exec_path: ${JSON.stringify(fakeBun)},
    pm_cwd: ${JSON.stringify(dir)}, env: { ...process.env, SUPERTASK_DB_PATH: 'relative.db', SUPERTASK_PM2_BIN: ${JSON.stringify(fakePm2)} }
} }]));
`);
        chmodSync(fakePm2, 0o755);
        process.env.SUPERTASK_PM2_BIN = fakePm2;
        process.env.SUPERTASK_BUN_BIN = fakeBun;
        process.env.SUPERTASK_GATEWAY_ENTRY = gateway;
        process.env.SUPERTASK_DB_PATH = 'relative.db';

        expect(() => ensureGateway()).toThrow('作用域不一致');
        const recorded = readFileSync(calls, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[]);
        expect(recorded.some((args) => args[0] === 'delete')).toBe(false);
    });

    test('Linux 自启只在 systemd 已启用且 unit 指向 pm2 resurrect 时通过', () => {
        const dir = mkdtempSync(join(tmpdir(), 'supertask-systemd-'));
        dirs.push(dir);
        const systemctl = join(dir, 'systemctl');
        const unitBody = join(dir, 'unit-body');
        const pm2Home = join(dir, '.pm2');
        const fakeBun = join(dir, 'bun');
        const gateway = join(dir, 'gateway.js');
        mkdirSync(pm2Home, { recursive: true });
        writeFileSync(fakeBun, '#!/bin/sh\nexit 0\n');
        writeFileSync(gateway, '');
        chmodSync(fakeBun, 0o755);
        writeFileSync(unitBody, `[Service]\nEnvironment=PM2_HOME=${pm2Home}\nExecStart=/usr/bin/pm2 resurrect\n`);
        writeFileSync(systemctl, `#!/usr/bin/env bun
import { readFileSync } from 'fs';
const args = Bun.argv.slice(2);
if (args[0] === 'is-enabled') console.log('enabled');
else if (args[0] === 'cat') process.stdout.write(readFileSync(${JSON.stringify(unitBody)}, 'utf8'));
else process.exit(2);
`);
        chmodSync(systemctl, 0o755);
        const env = { ...process.env, SUPERTASK_SYSTEMCTL_BIN: systemctl, PM2_HOME: pm2Home };
        writeFileSync(join(pm2Home, 'dump.pm2'), JSON.stringify([{
            name: 'supertask-gateway',
            pm_exec_path: fakeBun,
            args: [gateway],
            pm2_env: {
                args: [gateway],
                pm_exec_path: fakeBun,
                pm_cwd: process.cwd(),
                env,
            },
        }]));
        expect(isLinuxStartupConfigured(env)).toBe(true);
        writeFileSync(join(pm2Home, 'dump.pm2'), '[]');
        expect(isLinuxStartupConfigured(env)).toBe(false);
        writeFileSync(join(pm2Home, 'dump.pm2'), JSON.stringify([{
            name: 'supertask-gateway', pm_exec_path: fakeBun, args: [gateway],
            pm2_env: { args: [gateway], pm_exec_path: fakeBun, pm_cwd: process.cwd(), env },
        }]));
        writeFileSync(unitBody, '[Service]\nExecStart=/usr/bin/pm2-runtime start ecosystem.js\n');
        expect(isLinuxStartupConfigured(env)).toBe(false);
    });

    test('macOS 监督器只恢复 dump 中明确存在的 Gateway，并尊重管理锁和 PM2 熔断', () => {
        const dir = mkdtempSync(join(tmpdir(), 'supertask-supervisor-'));
        dirs.push(dir);
        const fakePm2 = join(dir, 'pm2');
        const state = join(dir, 'state');
        const calls = join(dir, 'calls.jsonl');
        const managementLock = join(dir, 'supertask-gateway.manage.sqlite');
        const env = { ...process.env, PM2_HOME: dir, SUPERTASK_PM2_MANAGEMENT_LOCK: managementLock };
        writeFileSync(fakePm2, `#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'fs';
const args = Bun.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
if (args[0] === 'jlist') console.log(existsSync(${JSON.stringify(state)}) ? JSON.stringify([{ name: 'supertask-gateway', pm2_env: { status: readFileSync(${JSON.stringify(state)}, 'utf8') } }]) : '[]');
if (args[0] === 'resurrect') writeFileSync(${JSON.stringify(state)}, 'online');
`);
        chmodSync(fakePm2, 0o755);

        writeFileSync(join(dir, 'dump.pm2'), JSON.stringify([{ name: 'supertask-gateway' }]));
        withExclusiveManagementLock(managementLock, 100, () => {
            expect(superviseOnce(fakePm2, env)).toBe(true);
            expect(existsSync(calls)).toBe(false);
        });
        expect(superviseOnce(fakePm2, env)).toBe(true);
        expect(superviseOnce(fakePm2, env)).toBe(true);
        writeFileSync(state, 'stopped');
        expect(superviseOnce(fakePm2, env)).toBe(true);
        writeFileSync(state, 'errored');
        for (let index = 0; index < 3; index += 1) expect(superviseOnce(fakePm2, env)).toBe(true);

        rmSync(state, { force: true });
        writeFileSync(join(dir, 'dump.pm2'), '[]');
        for (let index = 0; index < 3; index += 1) expect(superviseOnce(fakePm2, env)).toBe(true);
        const recorded = readFileSync(calls, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[]);
        expect(recorded.filter((args) => args[0] === 'resurrect')).toHaveLength(1);
        expect(recorded.filter((args) => args[0] === 'restart')).toHaveLength(0);
    });

    test('macOS 监督器在 jlist 超时、失败或损坏时不改变 PM2 状态', () => {
        const dir = mkdtempSync(join(tmpdir(), 'supertask-supervisor-unknown-'));
        dirs.push(dir);
        const fakePm2 = join(dir, 'pm2');
        const mode = join(dir, 'mode');
        const calls = join(dir, 'calls.jsonl');
        const env = {
            ...process.env,
            PM2_HOME: dir,
            SUPERTASK_PM2_MANAGEMENT_LOCK: join(dir, 'gateway.sqlite'),
            SUPERTASK_PM2_SUPERVISOR_COMMAND_TIMEOUT_MS: '500',
        };
        writeFileSync(join(dir, 'dump.pm2'), JSON.stringify([{ name: 'supertask-gateway' }]));
        writeFileSync(fakePm2, `#!/bin/sh
printf '["%s"]\\n' "$1" >> ${JSON.stringify(calls)}
current=$(cat ${JSON.stringify(mode)})
if [ "$1" != "jlist" ]; then exit 0; fi
if [ "$current" = "hang" ]; then trap '' TERM; while :; do :; done; fi
if [ "$current" = "fail" ]; then exit 7; fi
printf '{broken\\n'
`);
        chmodSync(fakePm2, 0o755);

        for (const current of ['hang', 'fail', 'broken']) {
            writeFileSync(mode, current);
            const startedAt = Date.now();
            expect(superviseOnce(fakePm2, env)).toBe(false);
            expect(Date.now() - startedAt).toBeLessThan(2_000);
        }
        const recorded = readFileSync(calls, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[]);
        expect(recorded.every((args) => args[0] === 'jlist')).toBe(true);
    });

    test('macOS 卸载会停止已加载但 plist 已缺失的项目监督器', () => {
        if (process.platform !== 'darwin') return;
        const dir = mkdtempSync(join(tmpdir(), 'supertask-uninstall-launch-agent-'));
        dirs.push(dir);
        const fakePm2 = join(dir, 'pm2');
        const launchctl = join(dir, 'launchctl');
        const pm2Calls = join(dir, 'pm2-calls.jsonl');
        const launchctlCalls = join(dir, 'launchctl-calls.jsonl');
        const missingPlist = join(dir, 'missing.plist');
        writeFileSync(fakePm2, `#!/usr/bin/env bun
import { appendFileSync } from 'fs';
const args = Bun.argv.slice(2);
appendFileSync(${JSON.stringify(pm2Calls)}, JSON.stringify(args) + '\\n');
if (args[0] === 'jlist') console.log('[]');
`);
        writeFileSync(launchctl, `#!/usr/bin/env bun
import { appendFileSync } from 'fs';
appendFileSync(${JSON.stringify(launchctlCalls)}, JSON.stringify(Bun.argv.slice(2)) + '\\n');
`);
        chmodSync(fakePm2, 0o755);
        chmodSync(launchctl, 0o755);
        process.env.SUPERTASK_PM2_BIN = fakePm2;
        process.env.SUPERTASK_LAUNCHCTL_BIN = launchctl;
        process.env.SUPERTASK_LAUNCH_AGENT_PATH = missingPlist;
        process.env.SUPERTASK_PM2_MANAGEMENT_LOCK = join(dir, 'gateway.sqlite');

        uninstall();

        expect(existsSync(missingPlist)).toBe(false);
        const launchCalls = readFileSync(launchctlCalls, 'utf8').trim().split('\n')
            .map((line) => JSON.parse(line) as string[]);
        expect(launchCalls.map((args) => args[0])).toEqual(['print', 'bootout']);
        const recordedPm2 = readFileSync(pm2Calls, 'utf8').trim().split('\n')
            .map((line) => JSON.parse(line) as string[]);
        expect(recordedPm2.some((args) => args[0] === 'save')).toBe(true);
    });

    test('旧运行环境无法执行 PM2 时在删除健康 Gateway 前失败关闭', () => {
        const dir = mkdtempSync(join(tmpdir(), 'supertask-pm2-manager-preflight-'));
        dirs.push(dir);
        const currentBin = join(dir, 'current-bin');
        const fakePm2 = join(currentBin, 'pm2');
        const gateway = join(dir, 'gateway.js');
        const dbPath = join(dir, 'tasks.db');
        const log = join(dir, 'calls.jsonl');
        mkdirSync(currentBin, { recursive: true });
        writeFileSync(gateway, '');
        writeFileSync(fakePm2, `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
if [ "$1" = "--version" ]; then exit 0; fi
if [ "$1" = "jlist" ]; then
  printf '%s\\n' ${JSON.stringify(JSON.stringify([{
      name: 'supertask-gateway',
      pid: 4242,
      pm2_env: {
          status: 'online',
          args: [gateway],
          pm_exec_path: fakePm2,
          pm_cwd: dir,
          env: {
              PATH: join(dir, 'removed-old-bin'),
              HOME: dir,
              SUPERTASK_DB_PATH: dbPath,
          },
      },
  }]))}
  exit 0
fi
`);
        chmodSync(fakePm2, 0o755);
        const sqlite = new Database(dbPath);
        sqlite.exec('CREATE TABLE gateway_lock (id INTEGER PRIMARY KEY, pid INTEGER NOT NULL, acquired_at INTEGER NOT NULL, heartbeat_at INTEGER NOT NULL, ready_at INTEGER)');
        sqlite.query('INSERT INTO gateway_lock VALUES (1, ?, ?, ?, ?)').run(4242, Date.now(), Date.now(), Date.now());
        sqlite.close();

        process.env.PATH = `${currentBin}:${originalEnv.path ?? ''}`;
        process.env.SUPERTASK_PM2_BIN = 'pm2';
        process.env.SUPERTASK_GATEWAY_ENTRY = gateway;

        expect(() => upgrade({ gatewayEntry: gateway, version: '0.1.28' })).toThrow('已拒绝删除现有进程');
        expect(readFileSync(log, 'utf8')).not.toContain('delete');
    });

    test('用参数数组注册 Gateway 并记录版本', () => {
        const dir = mkdtempSync(join(tmpdir(), 'supertask-pm2-'));
        dirs.push(dir);
        const log = join(dir, 'pm2-args.jsonl');
        const fakePm2 = join(dir, 'pm2');
        const fakeBun = join(dir, 'bun executable');
        const state = join(dir, 'pm2-state');
        const gateway = join(dir, 'gateway entry.ts');
        const versionFile = join(dir, 'version');
        const dbPath = join(dir, 'tasks.db');
        writeFileSync(gateway, '');
        writeFileSync(fakeBun, '#!/bin/sh\nexit 0\n');
        chmodSync(fakeBun, 0o755);
        writeFileSync(fakePm2, `#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { Database } from 'bun:sqlite';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('6.0.0'); process.exit(0); }
if (args[0] === 'jlist') {
    if (!existsSync(${JSON.stringify(state)})) console.log('[]');
    else {
        const current = JSON.parse(readFileSync(${JSON.stringify(state)}, 'utf8'));
        console.log(JSON.stringify([{ name: 'supertask-gateway', pid: 4242, pm2_env: { status: 'online', args: [current.entry], pm_exec_path: current.bunPath, pm_cwd: current.cwd, env: process.env } }]));
    }
    process.exit(0);
}
if (args[0] === 'start') {
    writeFileSync(${JSON.stringify(state)}, JSON.stringify({ entry: args.at(-1), bunPath: args[1], cwd: args[args.indexOf('--cwd') + 1] }));
    const db = new Database(${JSON.stringify(dbPath)});
    db.exec('CREATE TABLE IF NOT EXISTS gateway_lock (id INTEGER PRIMARY KEY, pid INTEGER NOT NULL, acquired_at INTEGER NOT NULL, heartbeat_at INTEGER NOT NULL, ready_at INTEGER)');
    db.query('INSERT OR REPLACE INTO gateway_lock (id, pid, acquired_at, heartbeat_at, ready_at) VALUES (1, ?, ?, ?, ?)').run(4242, Date.now(), Date.now(), Date.now());
    db.close();
}
if (args[0] === 'save' && existsSync(${JSON.stringify(versionFile)})) {
    console.error('version marker was written before pm2 save');
    process.exit(9);
}
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
`);
        chmodSync(fakePm2, 0o755);

        process.env.SUPERTASK_PM2_BIN = fakePm2;
        process.env.SUPERTASK_BUN_BIN = fakeBun;
        process.env.SUPERTASK_GATEWAY_ENTRY = gateway;
        process.env.SUPERTASK_VERSION_FILE = versionFile;
        process.env.SUPERTASK_DB_PATH = dbPath;
        process.env.SUPERTASK_CONFIG_PATH = join(dir, 'missing-config.json');
        process.env.SUPERTASK_GATEWAY_READY_TIMEOUT_MS = '200';

        expect(ensureGateway()).toEqual({ ok: true, action: 'started' });
        expect(isGatewayRunning()).toBe(true);
        const calls = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[]);
        expect(calls[0]).toEqual([
            'start', fakeBun, '--name', 'supertask-gateway', '--interpreter', 'none',
            '--restart-delay', '5000', '--max-restarts', '30', '--max-memory-restart', '512M',
            '--kill-timeout', '45000', '--cwd', process.cwd(), '--', gateway,
        ]);
        expect(calls[1]).toEqual(['save']);
        expect(readFileSync(versionFile, 'utf8')).toBe(getPackageVersion());
    });

    test('显式 PM2 kill timeout 低于 Worker 安全收尾下限时失败关闭', () => {
        const dir = mkdtempSync(join(tmpdir(), 'supertask-pm2-kill-timeout-'));
        dirs.push(dir);
        const fakePm2 = join(dir, 'pm2');
        const fakeBun = join(dir, 'bun');
        const gateway = join(dir, 'gateway.ts');
        const calls = join(dir, 'calls.jsonl');
        writeFileSync(fakeBun, '#!/bin/sh\nexit 0\n');
        writeFileSync(gateway, '');
        chmodSync(fakeBun, 0o755);
        writeFileSync(fakePm2, `#!/usr/bin/env bun
import { appendFileSync } from 'fs';
const args = Bun.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
if (args[0] === 'jlist') console.log('[]');
`);
        chmodSync(fakePm2, 0o755);
        process.env.SUPERTASK_PM2_BIN = fakePm2;
        process.env.SUPERTASK_BUN_BIN = fakeBun;
        process.env.SUPERTASK_GATEWAY_ENTRY = gateway;
        process.env.SUPERTASK_CONFIG_PATH = join(dir, 'missing-config.json');
        process.env.SUPERTASK_PM2_KILL_TIMEOUT_MS = '44999';
        process.env.SUPERTASK_PM2_MANAGEMENT_LOCK = join(dir, 'gateway.sqlite');

        expect(() => ensureGateway()).toThrow('必须是至少 45000 的整数');
        const recorded = readFileSync(calls, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[]);
        expect(recorded.some((args) => args[0] === 'start')).toBe(false);
    });

    test('显式 PM2 command timeout 低于 kill window 时在启动或删除前失败关闭', () => {
        const dir = mkdtempSync(join(tmpdir(), 'supertask-pm2-command-timeout-'));
        dirs.push(dir);
        const fakePm2 = join(dir, 'pm2');
        const fakeBun = join(dir, 'bun');
        const gateway = join(dir, 'gateway.ts');
        const configPath = join(dir, 'config.json');
        const calls = join(dir, 'calls.jsonl');
        writeFileSync(fakeBun, '#!/bin/sh\nexit 0\n');
        writeFileSync(gateway, '');
        writeFileSync(configPath, JSON.stringify({
            configVersion: 2,
            worker: { shutdownGracePeriodMs: 0 },
        }));
        chmodSync(fakeBun, 0o755);
        writeFileSync(fakePm2, `#!/usr/bin/env bun
import { appendFileSync } from 'fs';
const args = Bun.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
if (args[0] === 'jlist') console.log('[]');
`);
        chmodSync(fakePm2, 0o755);
        process.env.SUPERTASK_PM2_BIN = fakePm2;
        process.env.SUPERTASK_BUN_BIN = fakeBun;
        process.env.SUPERTASK_GATEWAY_ENTRY = gateway;
        process.env.SUPERTASK_CONFIG_PATH = configPath;
        process.env.SUPERTASK_PM2_KILL_TIMEOUT_MS = '15000';
        process.env.SUPERTASK_PM2_COMMAND_TIMEOUT_MS = '19999';
        process.env.SUPERTASK_PM2_MANAGEMENT_LOCK = join(dir, 'gateway.sqlite');

        expect(() => ensureGateway()).toThrow('SUPERTASK_PM2_COMMAND_TIMEOUT_MS 必须是至少 20000');
        const recorded = readFileSync(calls, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[]);
        expect(recorded.some((args) => args[0] === 'start' || args[0] === 'delete')).toBe(false);
    });

    test('PM2 online 但没有匹配的 Gateway ready 心跳时判定为未运行', () => {
        const dir = mkdtempSync(join(tmpdir(), 'supertask-pm2-unready-'));
        dirs.push(dir);
        const fakePm2 = join(dir, 'pm2');
        const fakeBun = join(dir, 'bun');
        const gateway = join(dir, 'gateway.ts');
        const dbPath = join(dir, 'tasks.db');
        writeFileSync(gateway, '');
        writeFileSync(fakeBun, '#!/bin/sh\nexit 0\n');
        chmodSync(fakeBun, 0o755);
        writeFileSync(fakePm2, `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('6.0.0'); process.exit(0); }
if (args[0] === 'jlist') { console.log(JSON.stringify([{ name: 'supertask-gateway', pid: 4242, pm2_env: { status: 'online', args: [${JSON.stringify(gateway)}], pm_exec_path: ${JSON.stringify(fakeBun)}, pm_cwd: ${JSON.stringify(process.cwd())}, env: process.env } }])); process.exit(0); }
if (args[0] === 'start') process.exit(0);
`);
        chmodSync(fakePm2, 0o755);

        process.env.SUPERTASK_PM2_BIN = fakePm2;
        process.env.SUPERTASK_BUN_BIN = fakeBun;
        process.env.SUPERTASK_GATEWAY_ENTRY = gateway;
        process.env.SUPERTASK_DB_PATH = dbPath;
        process.env.SUPERTASK_GATEWAY_READY_TIMEOUT_MS = '50';
        process.env.SUPERTASK_PM2_KILL_TIMEOUT_MS = '45000';

        expect(isGatewayRunning()).toBe(false);
        expect(() => ensureGateway()).toThrow('未在限定时间内就绪');
    });

    test('插件自动替换 Gateway 失败时恢复 PM2 记录中的旧入口', () => {
        const dir = mkdtempSync(join(tmpdir(), 'supertask-pm2-ensure-rollback-'));
        dirs.push(dir);
        const fakePm2 = join(dir, 'pm2');
        const fakeBun = join(dir, 'bun');
        const state = join(dir, 'state.json');
        const log = join(dir, 'calls.jsonl');
        const oldGateway = join(dir, 'old-gateway.js');
        const newGateway = join(dir, 'new-broken-gateway.js');
        const dbPath = join(dir, 'tasks.db');
        const versionFile = join(dir, 'version');
        writeFileSync(oldGateway, '');
        writeFileSync(newGateway, '');
        writeFileSync(fakeBun, '#!/bin/sh\nexit 0\n');
        chmodSync(fakeBun, 0o755);
        writeFileSync(state, JSON.stringify({ entry: oldGateway, pid: 4242 }));
        writeFileSync(versionFile, '0.1.20');
        writeFileSync(fakePm2, `#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { Database } from 'bun:sqlite';
const args = Bun.argv.slice(2);
if (args[0] === '--version') process.exit(0);
if (args[0] === 'jlist') {
    if (!existsSync(${JSON.stringify(state)})) console.log('[]');
    else {
        const current = JSON.parse(readFileSync(${JSON.stringify(state)}, 'utf8'));
        console.log(JSON.stringify([{ name: 'supertask-gateway', pid: current.pid, pm2_env: { status: 'online', args: [current.entry], pm_exec_path: ${JSON.stringify(fakeBun)}, pm_cwd: ${JSON.stringify(process.cwd())}, env: process.env } }]));
    }
    process.exit(0);
}
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] === 'delete') rmSync(${JSON.stringify(state)}, { force: true });
if (args[0] === 'start') {
    const entry = args.at(-1);
    writeFileSync(${JSON.stringify(state)}, JSON.stringify({ entry, pid: 4242 }));
    const db = new Database(${JSON.stringify(dbPath)});
    db.exec('CREATE TABLE IF NOT EXISTS gateway_lock (id INTEGER PRIMARY KEY, pid INTEGER NOT NULL, acquired_at INTEGER NOT NULL, heartbeat_at INTEGER NOT NULL, ready_at INTEGER)');
    db.query('INSERT OR REPLACE INTO gateway_lock (id, pid, acquired_at, heartbeat_at, ready_at) VALUES (1, ?, ?, ?, ?)').run(4242, Date.now(), Date.now(), entry === ${JSON.stringify(oldGateway)} ? Date.now() : null);
    db.close();
}
`);
        chmodSync(fakePm2, 0o755);

        const initialDb = new Database(dbPath);
        initialDb.exec('CREATE TABLE gateway_lock (id INTEGER PRIMARY KEY, pid INTEGER NOT NULL, acquired_at INTEGER NOT NULL, heartbeat_at INTEGER NOT NULL, ready_at INTEGER)');
        initialDb.query('INSERT INTO gateway_lock VALUES (1, ?, ?, ?, ?)').run(4242, Date.now(), Date.now(), Date.now());
        initialDb.close();

        process.env.SUPERTASK_PM2_BIN = fakePm2;
        process.env.SUPERTASK_BUN_BIN = fakeBun;
        process.env.SUPERTASK_GATEWAY_ENTRY = newGateway;
        process.env.SUPERTASK_DB_PATH = dbPath;
        process.env.SUPERTASK_VERSION_FILE = versionFile;
        process.env.SUPERTASK_GATEWAY_READY_TIMEOUT_MS = '50';
        process.env.SUPERTASK_PM2_KILL_TIMEOUT_MS = '45000';

        expect(() => ensureGateway()).toThrow('已回滚到旧 Gateway');
        const starts = readFileSync(log, 'utf8').trim().split('\n')
            .map((line) => JSON.parse(line) as string[])
            .filter((call) => call[0] === 'start');
        expect(starts.map((call) => call.at(-1))).toEqual([newGateway, oldGateway]);
        expect(readFileSync(versionFile, 'utf8')).toBe('0.1.20');
        expect(isGatewayRunning()).toBe(true);
    });

    test('升级时用已安装新包的 Gateway 入口和版本替换旧进程', () => {
        const dir = mkdtempSync(join(tmpdir(), 'supertask-pm2-upgrade-'));
        dirs.push(dir);
        const fakePm2 = join(dir, 'pm2');
        const fakeBun = join(dir, 'bun');
        const state = join(dir, 'state');
        const log = join(dir, 'calls.jsonl');
        const envLog = join(dir, 'runtime-env.json');
        const oldGateway = join(dir, 'old-gateway.ts');
        const newGateway = join(dir, 'new-gateway.js');
        const dbPath = join(dir, 'tasks.db');
        const versionFile = join(dir, 'version');
        writeFileSync(oldGateway, '');
        writeFileSync(newGateway, '');
        writeFileSync(fakeBun, '#!/bin/sh\nexit 0\n');
        chmodSync(fakeBun, 0o755);
        writeFileSync(state, JSON.stringify({ entry: oldGateway }));
        writeFileSync(versionFile, '0.1.20');
        writeFileSync(fakePm2, `#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { Database } from 'bun:sqlite';
const args = process.argv.slice(2);
if (args[0] === '--version') process.exit(0);
if (args[0] === 'jlist') {
    const current = existsSync(${JSON.stringify(state)}) ? JSON.parse(readFileSync(${JSON.stringify(state)}, 'utf8')) : null;
    console.log(current ? JSON.stringify([{ name: 'supertask-gateway', pid: 4242, pm2_env: {
        status: 'online',
        args: [current.entry],
        pm_exec_path: ${JSON.stringify(fakeBun)},
        pm_cwd: ${JSON.stringify(dir)},
        env: {
            SUPERTASK_PM2_BIN: ${JSON.stringify(fakePm2)},
            PATH: ${JSON.stringify(process.env.PATH)},
            HOME: ${JSON.stringify(dir)},
            SUPERTASK_DB_PATH: ${JSON.stringify(dbPath)},
            SUPERTASK_VERSION_FILE: ${JSON.stringify(versionFile)},
            SUPERTASK_GATEWAY_READY_TIMEOUT_MS: '100',
            SUPERTASK_PM2_KILL_TIMEOUT_MS: '45000'
        }
    } }]) : '[]');
    process.exit(0);
}
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] === 'delete') rmSync(${JSON.stringify(state)}, { force: true });
if (args[0] === 'start') {
    writeFileSync(${JSON.stringify(state)}, JSON.stringify({ entry: args.at(-1) }));
    writeFileSync(${JSON.stringify(envLog)}, JSON.stringify({ dbPath: process.env.SUPERTASK_DB_PATH }));
    const db = new Database(process.env.SUPERTASK_DB_PATH);
    db.exec('CREATE TABLE IF NOT EXISTS gateway_lock (id INTEGER PRIMARY KEY, pid INTEGER NOT NULL, acquired_at INTEGER NOT NULL, heartbeat_at INTEGER NOT NULL, ready_at INTEGER)');
    db.query('INSERT OR REPLACE INTO gateway_lock (id, pid, acquired_at, heartbeat_at, ready_at) VALUES (1, ?, ?, ?, ?)').run(4242, Date.now(), Date.now(), Date.now());
    db.close();
}
`);
        chmodSync(fakePm2, 0o755);
        process.env.SUPERTASK_PM2_BIN = fakePm2;
        process.env.SUPERTASK_BUN_BIN = fakeBun;
        process.env.SUPERTASK_GATEWAY_ENTRY = oldGateway;
        process.env.SUPERTASK_DB_PATH = join(dir, 'wrong-current-shell.db');
        process.env.SUPERTASK_VERSION_FILE = versionFile;
        process.env.SUPERTASK_GATEWAY_READY_TIMEOUT_MS = '100';
        process.env.SUPERTASK_PM2_KILL_TIMEOUT_MS = '45000';

        expect(upgrade({ gatewayEntry: newGateway, version: '0.1.21' })).toEqual({
            before: '0.1.20', after: '0.1.21', restarted: true,
        });
        const calls = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[]);
        expect(calls.find((call) => call[0] === 'start')?.at(-1)).toBe(newGateway);
        expect(JSON.parse(readFileSync(envLog, 'utf8'))).toEqual({ dbPath });
        expect(readFileSync(versionFile, 'utf8')).toBe('0.1.21');
    });

    test('新 Gateway 未就绪时恢复旧入口和旧版本', () => {
        const dir = mkdtempSync(join(tmpdir(), 'supertask-pm2-rollback-'));
        dirs.push(dir);
        const fakePm2 = join(dir, 'pm2');
        const fakeBun = join(dir, 'bun');
        const state = join(dir, 'state');
        const log = join(dir, 'calls.jsonl');
        const oldGateway = join(dir, 'old-gateway.ts');
        const newGateway = join(dir, 'broken-gateway.js');
        const dbPath = join(dir, 'tasks.db');
        const versionFile = join(dir, 'version');
        writeFileSync(oldGateway, '');
        writeFileSync(newGateway, '');
        writeFileSync(fakeBun, '#!/bin/sh\nexit 0\n');
        chmodSync(fakeBun, 0o755);
        writeFileSync(state, JSON.stringify({ entry: oldGateway }));
        writeFileSync(versionFile, '0.1.20');
        writeFileSync(fakePm2, `#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { Database } from 'bun:sqlite';
const args = process.argv.slice(2);
if (args[0] === '--version') process.exit(0);
if (args[0] === 'jlist') {
    const current = existsSync(${JSON.stringify(state)}) ? JSON.parse(readFileSync(${JSON.stringify(state)}, 'utf8')) : null;
    console.log(current ? JSON.stringify([{ name: 'supertask-gateway', pid: 4242, pm2_env: { status: 'online', args: [current.entry], pm_exec_path: ${JSON.stringify(fakeBun)}, pm_cwd: ${JSON.stringify(process.cwd())}, env: process.env } }]) : '[]');
    process.exit(0);
}
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] === 'delete') rmSync(${JSON.stringify(state)}, { force: true });
if (args[0] === 'start') {
    writeFileSync(${JSON.stringify(state)}, JSON.stringify({ entry: args.at(-1) }));
    const db = new Database(${JSON.stringify(dbPath)});
    db.exec('CREATE TABLE IF NOT EXISTS gateway_lock (id INTEGER PRIMARY KEY, pid INTEGER NOT NULL, acquired_at INTEGER NOT NULL, heartbeat_at INTEGER NOT NULL, ready_at INTEGER)');
    const readyAt = args.at(-1) === ${JSON.stringify(oldGateway)} ? Date.now() : null;
    db.query('INSERT OR REPLACE INTO gateway_lock (id, pid, acquired_at, heartbeat_at, ready_at) VALUES (1, ?, ?, ?, ?)').run(4242, Date.now(), Date.now(), readyAt);
    db.close();
}
`);
        chmodSync(fakePm2, 0o755);
        process.env.SUPERTASK_PM2_BIN = fakePm2;
        process.env.SUPERTASK_BUN_BIN = fakeBun;
        process.env.SUPERTASK_GATEWAY_ENTRY = oldGateway;
        process.env.SUPERTASK_DB_PATH = dbPath;
        process.env.SUPERTASK_VERSION_FILE = versionFile;
        process.env.SUPERTASK_GATEWAY_READY_TIMEOUT_MS = '50';
        process.env.SUPERTASK_PM2_KILL_TIMEOUT_MS = '45000';

        expect(() => upgrade({ gatewayEntry: newGateway, version: '0.1.21' })).toThrow('已回滚到旧 Gateway');
        const starts = readFileSync(log, 'utf8').trim().split('\n')
            .map((line) => JSON.parse(line) as string[])
            .filter((call) => call[0] === 'start');
        expect(starts.map((call) => call.at(-1))).toEqual([newGateway, oldGateway]);
        expect(readFileSync(versionFile, 'utf8')).toBe('0.1.20');
        expect(isGatewayRunning()).toBe(true);
    });
});
