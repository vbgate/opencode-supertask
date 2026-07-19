import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';

const directory = mkdtempSync(join(tmpdir(), 'supertask-package-install-'));
try {
    const packageDirectory = join(directory, 'package');
    mkdirSync(packageDirectory);
    writeFileSync(join(packageDirectory, 'package.json'), JSON.stringify({ private: true }));

    let archive = process.argv[2] ? resolve(process.argv[2]) : null;
    if (archive && !existsSync(archive)) throw new Error(`package archive does not exist: ${archive}`);
    if (!archive) {
        const packed = JSON.parse(execFileSync('npm', [
            'pack', '--json', '--pack-destination', directory,
        ], {
            cwd: process.cwd(),
            encoding: 'utf8',
        })) as Array<{ filename: string }>;
        const artifact = packed[0];
        if (!artifact) throw new Error('npm pack did not produce an artifact');
        archive = join(directory, artifact.filename);
    }
    execFileSync('npm', ['install', '--ignore-scripts', archive], {
        cwd: packageDirectory,
        stdio: 'pipe',
        timeout: 120_000,
    });
    const installedRoot = join(packageDirectory, 'node_modules/opencode-supertask');
    for (const required of ['LICENSE', 'dist/cli/index.js', 'dist/gateway/index.js', 'drizzle/meta/_journal.json']) {
        if (!existsSync(join(installedRoot, required))) {
            throw new Error(`installed package is missing ${required}`);
        }
    }
    const cli = join(installedRoot, 'dist/cli/index.js');
    const bin = join(packageDirectory, 'node_modules/.bin/supertask');
    const version = execFileSync(bin, ['--version'], {
        cwd: packageDirectory,
        encoding: 'utf8',
        timeout: 30_000,
    }).trim();
    const expectedVersion = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;
    if (version !== expectedVersion) throw new Error(`installed CLI version ${version} != ${expectedVersion}`);

    const databasePath = join(directory, 'smoke.db');
    const check = JSON.parse(execFileSync(process.execPath, [cli, 'db', 'check', '--json'], {
        cwd: packageDirectory,
        env: { ...process.env, SUPERTASK_DB_PATH: databasePath },
        encoding: 'utf8',
        timeout: 30_000,
    })) as { ok?: boolean; missingTables?: string[] };
    if (!check.ok || (check.missingTables?.length ?? 0) > 0) {
        throw new Error(`installed migration smoke failed: ${JSON.stringify(check)}`);
    }

    execFileSync(process.execPath, ['-e', `await import(${JSON.stringify(
        pathToFileURL(join(installedRoot, 'dist/plugin/supertask.js')).href,
    )})`], {
        cwd: packageDirectory,
        stdio: 'pipe',
        timeout: 30_000,
    });
    execFileSync(process.execPath, [
        join(process.cwd(), 'scripts/launcher-ipc-smoke.ts'),
        join(installedRoot, 'dist/worker/launcher.js'),
    ], {
        cwd: packageDirectory,
        stdio: 'pipe',
        timeout: 30_000,
    });
    const diagnostic = JSON.parse(execFileSync(process.execPath, [
        join(installedRoot, 'dist/daemon/gateway-diagnostic-runner.js'),
    ], {
        cwd: packageDirectory,
        env: {
            ...process.env,
            HOME: packageDirectory,
            PM2_HOME: join(directory, 'pm2-home'),
            SUPERTASK_PM2_BIN: join(directory, 'missing-pm2'),
        },
        encoding: 'utf8',
        timeout: 30_000,
    })) as { pm2Installed?: boolean };
    if (diagnostic.pm2Installed !== false) throw new Error('installed diagnostic runner smoke failed');
    console.log(`installed package smoke passed for ${version}`);
} finally {
    rmSync(directory, { recursive: true, force: true });
}
