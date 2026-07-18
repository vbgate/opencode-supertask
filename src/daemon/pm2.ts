import { execSync, spawnSync } from "child_process";
import {
    accessSync,
    chmodSync,
    constants,
    existsSync,
    mkdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "fs";
import { homedir, userInfo } from "os";
import { delimiter, dirname, isAbsolute, join, resolve } from "path";
import { fileURLToPath } from "url";
import { Database } from "bun:sqlite";
import { loadConfig } from "../gateway/config";
import { getPackageVersion } from "../core/package-version";
import { ManagementLockBusyError, withExclusiveManagementLock } from "./management-lock";

export { getPackageVersion } from "../core/package-version";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROCESS_NAME = "supertask-gateway";
const MAC_LAUNCH_AGENT_LABEL = "com.supertask.pm2-resurrect";

interface Pm2Process {
    name: string;
    pid?: number;
    args?: string[] | string;
    pm_exec_path?: string;
    pm_cwd?: string;
    env?: Record<string, unknown>;
    kill_timeout?: number;
    pm2_env?: {
        status?: string;
        args?: string[] | string;
        pm_exec_path?: string;
        pm_cwd?: string;
        env?: Record<string, unknown>;
        kill_timeout?: number;
    };
}

export interface GatewayRuntime {
    gatewayEntry: string;
    bunPath: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    killTimeoutMs?: number;
}

export interface RuntimeScope {
    cwd: string;
    databasePath: string;
    configPath: string;
    opencodePath: string;
    home: string;
    pm2Home: string;
    managementLockPath: string;
}

export interface GatewayDiagnostic {
    pm2Installed: boolean;
    processFound: boolean;
    status: string | null;
    pid: number | null;
    ready: boolean;
    runningVersion: string | null;
    gatewayEntry: string | null;
    gatewayPackageVersion: string | null;
    logRotationInstalled: boolean;
    startupConfigured: boolean | null;
    currentScope: RuntimeScope;
    gatewayScope: RuntimeScope | null;
    scopeMatches: boolean;
}

const GATEWAY_LOCK_STALE_MS = 30_000;

export type EnsureGatewayResult =
    | { ok: true; action: "already-running" | "started" | "restarted" }
    | { ok: false; reason: "pm2-not-installed" };

export interface GatewayMaintenanceState {
    wasRunning: boolean;
    env?: NodeJS.ProcessEnv;
    cwd?: string;
}

export interface GatewayMaintenanceResult<T> {
    result: T;
    wasRunning: boolean;
    restarted: boolean;
    keptStopped: boolean;
}

export function resolveGatewayEntry(): string {
    const override = process.env.SUPERTASK_GATEWAY_ENTRY;
    if (override) {
        if (!existsSync(override)) throw new Error(`[supertask] Gateway entry not found: ${override}`);
        return override;
    }

    const candidates = [
        join(__dirname, "../gateway/index.js"),
        join(__dirname, "../gateway/index.ts"),
    ];
    const entry = candidates.find((candidate) => existsSync(candidate));
    if (!entry) throw new Error(`[supertask] Gateway entry not found. Checked: ${candidates.join(", ")}`);
    return entry;
}

function runtimeHome(env: NodeJS.ProcessEnv): string {
    return resolve(env.HOME || homedir());
}

function runtimePath(value: string, cwd: string): string {
    return resolve(cwd, value);
}

function versionFile(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
    return env.SUPERTASK_VERSION_FILE
        ? runtimePath(env.SUPERTASK_VERSION_FILE, cwd)
        : join(runtimeHome(env), ".local/share/opencode/supertask-gateway-version");
}

function getRunningVersion(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string | null {
    try {
        const path = versionFile(env, cwd);
        if (!existsSync(path)) return null;
        return readFileSync(path, "utf-8").trim() || null;
    } catch {
        return null;
    }
}

function packageVersionFromGatewayEntry(gatewayEntry: string | null): string | null {
    if (gatewayEntry === null) return null;
    let directory = dirname(gatewayEntry);
    for (let depth = 0; depth < 6; depth += 1) {
        const packagePath = join(directory, 'package.json');
        if (existsSync(packagePath)) {
            try {
                const pkg = JSON.parse(readFileSync(packagePath, 'utf8')) as {
                    name?: unknown;
                    version?: unknown;
                };
                if (pkg.name === 'opencode-supertask' && typeof pkg.version === 'string') {
                    return pkg.version;
                }
            } catch {}
        }
        const parent = dirname(directory);
        if (parent === directory) break;
        directory = parent;
    }
    return null;
}

function resolveRuntimeExecutable(command: string, env: NodeJS.ProcessEnv, cwd: string): string {
    if (isAbsolute(command) || command.includes("/")) return runtimePath(command, cwd);
    for (const entry of (env.PATH ?? "").split(delimiter)) {
        if (!entry) continue;
        const candidate = resolve(cwd, entry, command);
        try {
            accessSync(candidate, constants.X_OK);
            return candidate;
        } catch {}
    }
    return command;
}

function runtimeScope(runtime: Pick<GatewayRuntime, "cwd" | "env">): RuntimeScope {
    const { cwd, env } = runtime;
    const home = runtimeHome(env);
    return {
        cwd: resolve(cwd),
        databasePath: env.SUPERTASK_DB_PATH
            ? runtimePath(env.SUPERTASK_DB_PATH, cwd)
            : join(home, ".local/share/opencode/tasks.db"),
        configPath: env.SUPERTASK_CONFIG_PATH
            ? runtimePath(env.SUPERTASK_CONFIG_PATH, cwd)
            : join(home, ".config/opencode/supertask.json"),
        opencodePath: resolveRuntimeExecutable(env.SUPERTASK_OPENCODE_BIN ?? "opencode", env, cwd),
        home,
        pm2Home: env.PM2_HOME
            ? runtimePath(env.PM2_HOME, cwd)
            : join(home, ".pm2"),
        managementLockPath: canonicalManagementLockPath(env, cwd),
    };
}

function scopesMatch(left: RuntimeScope, right: RuntimeScope): boolean {
    return left.databasePath === right.databasePath
        && left.configPath === right.configPath
        && left.opencodePath === right.opencodePath
        && left.home === right.home
        && left.pm2Home === right.pm2Home
        && left.managementLockPath === right.managementLockPath;
}

function currentScope(): RuntimeScope {
    return runtimeScope({ cwd: process.cwd(), env: process.env });
}

export function getGatewayDiagnostic(): GatewayDiagnostic {
    const producerScope = currentScope();
    if (!isPm2Installed()) {
        return {
            pm2Installed: false,
            processFound: false,
            status: null,
            pid: null,
            ready: false,
            runningVersion: getRunningVersion(),
            gatewayEntry: null,
            gatewayPackageVersion: null,
            logRotationInstalled: false,
            startupConfigured: process.platform === "darwin" || process.platform === "linux" ? false : null,
            currentScope: producerScope,
            gatewayScope: null,
            scopeMatches: false,
        };
    }

    const processes = pm2JsonList();
    const gateway = processes.find((item) => item.name === PROCESS_NAME);
    const runtime = gatewayRuntimeFromProcess(gateway);
    const gatewayEnv = runtime?.env ?? process.env;
    const managedScope = runtime ? runtimeScope(runtime) : null;
    const pid = typeof gateway?.pid === "number" ? gateway.pid : null;
    const readyPath = managedScope?.databasePath ?? databasePath();
    const lockedVersion = pid == null ? undefined : gatewayVersionFromLock(pid, readyPath);
    const gatewayEntry = runtime?.gatewayEntry ?? null;
    return {
        pm2Installed: true,
        processFound: gateway != null,
        status: gateway?.pm2_env?.status ?? null,
        pid,
        ready: pid != null && isGatewayReady(pid, readyPath),
        runningVersion: lockedVersion === undefined
            ? getRunningVersion(gatewayEnv, runtime?.cwd)
            : lockedVersion,
        gatewayEntry,
        gatewayPackageVersion: packageVersionFromGatewayEntry(gatewayEntry),
        logRotationInstalled: processes.some((item) => (
            item.name === "pm2-logrotate" && item.pm2_env?.status === "online"
        )),
        startupConfigured: process.platform === "darwin"
            ? isMacLaunchAgentConfigured(
                gatewayEnv.PM2_HOME ?? join(runtimeHome(gatewayEnv), ".pm2"),
                runtime ?? undefined,
            )
            : process.platform === "linux"
                ? isLinuxStartupConfigured(gatewayEnv, runtime?.cwd, runtime ?? undefined)
                : null,
        currentScope: producerScope,
        gatewayScope: managedScope,
        scopeMatches: managedScope != null && scopesMatch(producerScope, managedScope),
    };
}

function writeRunningVersion(
    version: string,
    env: NodeJS.ProcessEnv = process.env,
    cwd = process.cwd(),
): void {
    const path = versionFile(env, cwd);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, version, "utf-8");
}

function pm2Bin(env: NodeJS.ProcessEnv = process.env): string {
    return env.SUPERTASK_PM2_BIN
        ?? (process.platform === "win32" ? "pm2.cmd" : "pm2");
}

function pm2CommandTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
    const configured = Number(env.SUPERTASK_PM2_COMMAND_TIMEOUT_MS ?? 15_000);
    return Number.isFinite(configured) && configured > 0 ? configured : 15_000;
}

function xmlEscape(value: string): string {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&apos;");
}

function resolvePm2Bin(): string {
    const configured = pm2Bin();
    if (isAbsolute(configured)) return configured;
    const result = spawnSync("which", [configured], { encoding: "utf8" });
    const resolved = result.status === 0 ? result.stdout.trim().split("\n")[0] : "";
    if (!resolved) throw new Error(`[supertask] 无法解析 pm2 可执行文件: ${configured}`);
    return resolved;
}

function launchAgentPath(): string {
    return process.env.SUPERTASK_LAUNCH_AGENT_PATH
        ?? join(runtimeHome(process.env), "Library/LaunchAgents", `${MAC_LAUNCH_AGENT_LABEL}.plist`);
}

function launchctlBin(): string {
    return process.env.SUPERTASK_LAUNCHCTL_BIN ?? "launchctl";
}

export function resolvePm2SupervisorEntry(baseDir = __dirname): string {
    const override = process.env.SUPERTASK_PM2_SUPERVISOR_ENTRY;
    if (override) {
        if (!existsSync(override)) throw new Error(`[supertask] PM2 supervisor entry not found: ${override}`);
        return resolve(override);
    }
    const candidates = [
        join(baseDir, "pm2-supervisor.js"),
        join(baseDir, "pm2-supervisor.ts"),
        join(baseDir, "../daemon/pm2-supervisor.js"),
        join(baseDir, "../daemon/pm2-supervisor.ts"),
    ];
    const entry = candidates.find((candidate) => existsSync(candidate));
    if (!entry) throw new Error(`[supertask] PM2 supervisor entry not found. Checked: ${candidates.join(", ")}`);
    return resolve(entry);
}

function xmlUnescape(value: string): string {
    return value
        .replaceAll("&apos;", "'")
        .replaceAll("&quot;", '"')
        .replaceAll("&gt;", ">")
        .replaceAll("&lt;", "<")
        .replaceAll("&amp;", "&");
}

function plistValue(contents: string, key: string): string | null {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = contents.match(new RegExp(`<key>\\s*${escapedKey}\\s*</key>\\s*<string>([^<]*)</string>`));
    return match?.[1] ? xmlUnescape(match[1]) : null;
}

export function isMacLaunchAgentConfigured(
    expectedPm2Home?: string,
    expectedRuntime?: GatewayRuntime,
): boolean {
    if (typeof process.getuid !== "function") return false;
    const plistPath = launchAgentPath();
    if (!existsSync(plistPath)) return false;

    try {
        const contents = readFileSync(plistPath, "utf8");
        const argumentsBlock = contents.match(
            /<key>\s*ProgramArguments\s*<\/key>\s*<array>([\s\S]*?)<\/array>/,
        )?.[1];
        const programArguments = argumentsBlock
            ? [...argumentsBlock.matchAll(/<string>([^<]*)<\/string>/g)].map((match) => xmlUnescape(match[1]))
            : [];
        const bunPath = programArguments[0];
        const supervisorEntry = programArguments[1];
        const pm2Path = programArguments[2];
        const pm2Home = plistValue(contents, "PM2_HOME");
        const managementLock = plistValue(contents, "SUPERTASK_PM2_MANAGEMENT_LOCK");
        if (!bunPath || !supervisorEntry || !pm2Path || !pm2Home || !managementLock) return false;
        if (expectedPm2Home && pm2Home !== expectedPm2Home) return false;
        const expectedManagementLock = expectedRuntime
            ? managementLockPath(expectedRuntime.env, expectedRuntime.cwd)
            : process.env.SUPERTASK_PM2_MANAGEMENT_LOCK
                ? managementLockPath()
                : join(expectedPm2Home ?? currentScope().pm2Home, "supertask-gateway.manage.sqlite");
        if (managementLock !== expectedManagementLock) return false;

        accessSync(bunPath, constants.X_OK);
        accessSync(supervisorEntry, constants.R_OK);
        accessSync(pm2Path, constants.X_OK);
        if (spawnSync(bunPath, ["--version"], {
            stdio: "ignore",
            timeout: pm2CommandTimeoutMs(),
            killSignal: "SIGKILL",
        }).status !== 0) return false;
        if (spawnSync(pm2Path, ["--version"], {
            stdio: "ignore",
            env: { ...process.env, PM2_HOME: pm2Home },
            timeout: pm2CommandTimeoutMs(),
            killSignal: "SIGKILL",
        }).status !== 0) return false;

        const loaded = spawnSync(
            launchctlBin(),
            ["print", `gui/${process.getuid()}/${MAC_LAUNCH_AGENT_LABEL}`],
            {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
                timeout: pm2CommandTimeoutMs(),
                killSignal: "SIGKILL",
            },
        );
        if (loaded.status !== 0) return false;
        if (!loaded.stdout.includes("state = running")) return false;
        if (!loaded.stdout.includes(`path = ${plistPath}`)) return false;
        if (!loaded.stdout.includes(`program = ${bunPath}`)) return false;

        const dumpPath = join(pm2Home, "dump.pm2");
        const dump = JSON.parse(readFileSync(dumpPath, "utf8")) as unknown;
        if (!Array.isArray(dump)) return false;
        const gateway = (dump as Pm2Process[]).find((item) => item.name === PROCESS_NAME);
        const dumpRuntime = gatewayRuntimeFromProcess(gateway);
        if (!dumpRuntime || !hasRestorableSavedGatewayRuntime(gateway)) return false;
        return expectedRuntime === undefined || (
            dumpRuntime.gatewayEntry === expectedRuntime.gatewayEntry
            && dumpRuntime.bunPath === expectedRuntime.bunPath
            && dumpRuntime.cwd === expectedRuntime.cwd
            && scopesMatch(runtimeScope(dumpRuntime), runtimeScope(expectedRuntime))
        );
    } catch {
        return false;
    }
}

function bootstrapMacLaunchAgent(domain: string, path: string) {
    const retryDeadline = Date.now() + 2_000;
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    let result = spawnSync(launchctlBin(), ["bootstrap", domain, path], {
        encoding: "utf8",
        timeout: pm2CommandTimeoutMs(),
        killSignal: "SIGKILL",
    });

    while (result.status !== 0 && Date.now() < retryDeadline) {
        const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
        if (result.status !== 5 && !output.includes("Bootstrap failed: 5:")) break;
        Atomics.wait(sleeper, 0, 0, 100);
        result = spawnSync(launchctlBin(), ["bootstrap", domain, path], {
            encoding: "utf8",
            timeout: pm2CommandTimeoutMs(),
            killSignal: "SIGKILL",
        });
    }

    return result;
}

export function installMacLaunchAgent(expectedRuntime = currentGatewayRuntime()): string {
    if (typeof process.getuid !== "function") {
        throw new Error("[supertask] 当前运行时无法获取 macOS 用户 ID");
    }

    const path = launchAgentPath();
    const home = runtimeHome(expectedRuntime.env);
    const pm2Home = runtimeScope(expectedRuntime).pm2Home;
    const managementLock = managementLockPath(expectedRuntime.env, expectedRuntime.cwd);
    const environmentPath = expectedRuntime.env.PATH
        ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
    const bunPath = findBunPath();
    const supervisorEntry = resolvePm2SupervisorEntry();
    const pm2Path = resolvePm2Bin();
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${MAC_LAUNCH_AGENT_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${xmlEscape(bunPath)}</string>
      <string>${xmlEscape(supervisorEntry)}</string>
      <string>${xmlEscape(pm2Path)}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>EnvironmentVariables</key>
    <dict>
      <key>HOME</key>
      <string>${xmlEscape(home)}</string>
      <key>PATH</key>
      <string>${xmlEscape(environmentPath)}</string>
      <key>PM2_HOME</key>
      <string>${xmlEscape(pm2Home)}</string>
      <key>SUPERTASK_PM2_MANAGEMENT_LOCK</key>
      <string>${xmlEscape(managementLock)}</string>
    </dict>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(join(pm2Home, "supertask-launchd-error.log"))}</string>
    <key>StandardOutPath</key>
    <string>${xmlEscape(join(pm2Home, "supertask-launchd-output.log"))}</string>
  </dict>
</plist>
`;
    const domain = `gui/${process.getuid()}`;
    const previousPlist = existsSync(path) ? readFileSync(path) : null;
    const wasLoaded = previousPlist != null && spawnSync(
        launchctlBin(),
        ["print", `${domain}/${MAC_LAUNCH_AGENT_LABEL}`],
        {
            stdio: "ignore",
            timeout: pm2CommandTimeoutMs(),
            killSignal: "SIGKILL",
        },
    ).status === 0;

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, plist, { mode: 0o600 });
    chmodSync(path, 0o600);

    spawnSync(launchctlBin(), ["bootout", `${domain}/${MAC_LAUNCH_AGENT_LABEL}`], {
        stdio: "ignore",
        timeout: pm2CommandTimeoutMs(),
        killSignal: "SIGKILL",
    });
    const loaded = bootstrapMacLaunchAgent(domain, path);
    const configuredVerifyTimeout = Number(process.env.SUPERTASK_LAUNCH_AGENT_VERIFY_TIMEOUT_MS ?? 2_000);
    const verifyTimeoutMs = Number.isFinite(configuredVerifyTimeout) && configuredVerifyTimeout > 0
        ? configuredVerifyTimeout
        : 2_000;
    const verifyDeadline = Date.now() + verifyTimeoutMs;
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    let verified = loaded.status === 0 && isMacLaunchAgentConfigured(pm2Home, expectedRuntime);
    while (loaded.status === 0 && !verified && Date.now() < verifyDeadline) {
        Atomics.wait(sleeper, 0, 0, 100);
        verified = isMacLaunchAgentConfigured(pm2Home, expectedRuntime);
    }
    if (loaded.status !== 0 || !verified) {
        const output = loaded.status === 0
            ? "supervisor 未保持 running 或 PM2 dump 不可恢复"
            : `${loaded.stdout ?? ""}${loaded.stderr ?? ""}`.trim();
        if (loaded.status === 0) {
            spawnSync(launchctlBin(), ["bootout", `${domain}/${MAC_LAUNCH_AGENT_LABEL}`], {
                stdio: "ignore",
                timeout: pm2CommandTimeoutMs(),
                killSignal: "SIGKILL",
            });
        }
        if (previousPlist == null) rmSync(path, { force: true });
        else {
            writeFileSync(path, previousPlist, { mode: 0o600 });
            chmodSync(path, 0o600);
        }

        let rollbackFailure = "";
        if (wasLoaded && previousPlist != null) {
            const restored = bootstrapMacLaunchAgent(domain, path);
            if (restored.status !== 0) {
                rollbackFailure = `；旧 LaunchAgent 恢复失败: ${`${restored.stdout ?? ""}${restored.stderr ?? ""}`.trim() || `退出码 ${restored.status}`}`;
            }
        }
        throw new Error(`[supertask] macOS LaunchAgent 加载失败: ${output || `退出码 ${loaded.status}`}${rollbackFailure}`);
    }
    return path;
}

function systemctlBin(env: NodeJS.ProcessEnv = process.env): string {
    return env.SUPERTASK_SYSTEMCTL_BIN ?? "systemctl";
}

export function isLinuxStartupConfigured(
    env: NodeJS.ProcessEnv = process.env,
    cwd = process.cwd(),
    expectedRuntime?: GatewayRuntime,
): boolean {
    const unit = env.SUPERTASK_PM2_SYSTEMD_UNIT ?? `pm2-${userInfo().username}.service`;
    const enabled = spawnSync(systemctlBin(env), ["is-enabled", unit], {
        encoding: "utf8",
        env,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: pm2CommandTimeoutMs(env),
        killSignal: "SIGKILL",
    });
    if (enabled.status !== 0 || enabled.stdout.trim() !== "enabled") return false;

    const contents = spawnSync(systemctlBin(env), ["cat", unit], {
        encoding: "utf8",
        env,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: pm2CommandTimeoutMs(env),
        killSignal: "SIGKILL",
    });
    if (contents.status !== 0) return false;
    const expectedPm2Home = env.PM2_HOME ?? join(runtimeHome(env), ".pm2");
    if (!contents.stdout.includes("resurrect") || !contents.stdout.includes(expectedPm2Home)) {
        return false;
    }
    try {
        const dump = JSON.parse(readFileSync(join(expectedPm2Home, "dump.pm2"), "utf8")) as unknown;
        if (!Array.isArray(dump)) return false;
        const gateway = (dump as Pm2Process[]).find((item) => item.name === PROCESS_NAME);
        const runtime = gatewayRuntimeFromProcess(gateway);
        if (!runtime || !hasRestorableSavedGatewayRuntime(gateway)) return false;
        return runtime.cwd === resolve(cwd)
            && scopesMatch(runtimeScope(runtime), runtimeScope({ cwd, env }))
            && (expectedRuntime === undefined || (
                runtime.gatewayEntry === expectedRuntime.gatewayEntry
                && runtime.bunPath === expectedRuntime.bunPath
            ));
    } catch {
        return false;
    }
}

export function isPm2Installed(env: NodeJS.ProcessEnv = process.env): boolean {
    const result = spawnSync(pm2Bin(env), ["--version"], {
        stdio: "ignore",
        env,
        shell: process.platform === "win32",
        timeout: pm2CommandTimeoutMs(env),
        killSignal: "SIGKILL",
    });
    return result.status === 0;
}

function installPm2(): boolean {
    console.log("[supertask] Installing pm2...");
    try {
        execSync("npm install -g pm2", { stdio: "inherit" });
        return true;
    } catch {
        try {
            execSync("bun install -g pm2", { stdio: "inherit" });
            return true;
        } catch {
            return false;
        }
    }
}

function resolveCommand(command: string): string | null {
    const lookup = process.platform === "win32" ? "where" : "which";
    const result = spawnSync(lookup, [command], { encoding: "utf8" });
    return result.status === 0 ? result.stdout.trim().split("\n")[0] || null : null;
}

function npmPreferredEnvironment(): { command: string; env: NodeJS.ProcessEnv } | null {
    if (process.platform === "win32") return null;
    const npm = resolveCommand("npm");
    const node = resolveCommand("node");
    if (!npm || !node) return null;
    const command = resolvePm2Bin();
    const path = [...new Set([
        dirname(command),
        dirname(npm),
        dirname(node),
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
    ])].join(delimiter);
    return { command, env: { ...process.env, PATH: path } };
}

function pm2Exec(
    args: string[],
    options: { preferNpm?: boolean; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): { ok: boolean; output: string } {
    const npmEnvironment = options.preferNpm ? npmPreferredEnvironment() : null;
    const effectiveEnv = options.env ?? npmEnvironment?.env ?? process.env;
    const result = spawnSync(npmEnvironment?.command ?? pm2Bin(effectiveEnv), args, {
        stdio: ["pipe", "pipe", "pipe"],
        encoding: "utf-8",
        env: effectiveEnv,
        shell: process.platform === "win32",
        timeout: options.timeoutMs ?? pm2CommandTimeoutMs(effectiveEnv),
        killSignal: "SIGKILL",
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    if (result.error) return { ok: false, output: result.error.message };
    return { ok: result.status === 0, output };
}

function requirePm2(
    args: string[],
    action: string,
    options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): string {
    const result = pm2Exec(args, options);
    if (!result.ok) throw new Error(`[supertask] ${action} failed: ${result.output || "unknown pm2 error"}`);
    return result.output;
}

export function ensurePm2LogRotation(env: NodeJS.ProcessEnv = process.env): boolean {
    if (!isPm2Installed(env)) return false;
    const installed = pm2JsonList(env).some((item) => item.name === "pm2-logrotate");
    if (!installed) {
        const result = pm2Exec(["install", "pm2-logrotate"], { preferNpm: true, env });
        if (!result.ok) return false;
    }

    for (const [key, value] of [
        ["max_size", "10M"],
        ["retain", "7"],
        ["compress", "true"],
        ["workerInterval", "3600"],
    ] as const) {
        const result = pm2Exec(["set", `pm2-logrotate:${key}`, value], { env });
        if (!result.ok) return false;
    }
    return true;
}

function pm2JsonList(env: NodeJS.ProcessEnv = process.env): Pm2Process[] {
    const output = requirePm2(["jlist"], "pm2 jlist", { env });
    try {
        const parsed = JSON.parse(output) as unknown;
        if (!Array.isArray(parsed)) throw new Error("result is not an array");
        return parsed as Pm2Process[];
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`[supertask] Invalid pm2 jlist output: ${message}`);
    }
}

function gatewayEntryFromProcess(processInfo: Pm2Process | undefined): string | null {
    const args = processInfo?.pm2_env?.args ?? processInfo?.args;
    const candidates = Array.isArray(args) ? [...args].reverse() : typeof args === "string" ? [args] : [];
    const savedCwd = processInfo?.pm2_env?.pm_cwd ?? processInfo?.pm_cwd;
    for (const candidate of candidates) {
        const path = typeof savedCwd === "string" ? runtimePath(candidate, savedCwd) : candidate;
        if (existsSync(path)) return resolve(path);
    }
    return null;
}

function gatewayEnvironmentFromProcess(processInfo: Pm2Process | undefined): NodeJS.ProcessEnv {
    const saved = processInfo?.pm2_env?.env ?? processInfo?.env;
    if (!saved) return { ...process.env };

    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(saved)) {
        if (typeof value === "string") env[key] = value;
    }
    return env;
}

function gatewayRuntimeFromProcess(processInfo: Pm2Process | undefined): GatewayRuntime | null {
    const gatewayEntry = gatewayEntryFromProcess(processInfo);
    if (!gatewayEntry) return null;
    const savedBunPath = processInfo?.pm2_env?.pm_exec_path ?? processInfo?.pm_exec_path;
    const savedCwd = processInfo?.pm2_env?.pm_cwd ?? processInfo?.pm_cwd;
    const savedEnv = gatewayEnvironmentFromProcess(processInfo);
    if (typeof savedBunPath !== "string" || typeof savedCwd !== "string") return null;
    try {
        accessSync(savedBunPath, constants.X_OK);
        if (!statSync(savedCwd).isDirectory()) return null;
        if (spawnSync(savedBunPath, ["--version"], {
            stdio: "ignore",
            env: savedEnv,
            timeout: pm2CommandTimeoutMs(savedEnv),
            killSignal: "SIGKILL",
        }).status !== 0) return null;
    } catch {
        return null;
    }
    const killTimeout = processInfo?.pm2_env?.kill_timeout ?? processInfo?.kill_timeout;
    return {
        gatewayEntry,
        bunPath: savedBunPath,
        cwd: resolve(savedCwd),
        env: savedEnv,
        killTimeoutMs: Number.isInteger(killTimeout) && killTimeout! >= 5000
            ? killTimeout
            : undefined,
    };
}

function hasRestorableSavedGatewayRuntime(processInfo: Pm2Process | undefined): boolean {
    return gatewayRuntimeFromProcess(processInfo) !== null;
}

function currentGatewayRuntime(gatewayEntry = resolveGatewayEntry()): GatewayRuntime {
    return {
        gatewayEntry: resolve(gatewayEntry),
        bunPath: resolve(findBunPath()),
        cwd: process.cwd(),
        env: { ...process.env },
    };
}

function refreshGatewayExecutionEnvironment(
    runtime: GatewayRuntime,
    gatewayEntry: string,
): GatewayRuntime {
    const env = { ...process.env };

    // The explicit install/upgrade command is the point where users expect a
    // Gateway to pick up the same OpenCode/provider environment as their shell.
    // Keep daemon identity and SuperTask scope pinned to the proven old runtime;
    // everything else (including OPENCODE_*, XDG_* and provider credentials)
    // comes from the invoking environment.
    for (const key of new Set([
        ...Object.keys(runtime.env).filter((name) => name.startsWith('SUPERTASK_')),
        ...Object.keys(env).filter((name) => name.startsWith('SUPERTASK_')),
        'HOME',
        'PATH',
        'PM2_HOME',
    ])) {
        const value = runtime.env[key];
        if (value === undefined) delete env[key];
        else env[key] = value;
    }

    return {
        ...runtime,
        gatewayEntry: resolve(gatewayEntry),
        env,
    };
}

export function isGatewayRunning(): boolean {
    if (!isPm2Installed()) return false;
    const proc = pm2JsonList().find((item) => item.name === PROCESS_NAME);
    const runtime = gatewayRuntimeFromProcess(proc);
    return proc?.pm2_env?.status === "online"
        && typeof proc.pid === "number"
        && runtime !== null
        && isGatewayReady(proc.pid, runtimeScope(runtime).databasePath);
}

function databasePath(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
    return env.SUPERTASK_DB_PATH
        ? runtimePath(env.SUPERTASK_DB_PATH, cwd)
        : join(runtimeHome(env), ".local/share/opencode/tasks.db");
}

export function isGatewayReady(expectedPid?: number, path = databasePath()): boolean {
    if (!existsSync(path)) return false;

    let database: Database | null = null;
    try {
        database = new Database(path, { readonly: true });
        const row = database.query(
            "SELECT pid, heartbeat_at, ready_at FROM gateway_lock WHERE id = 1",
        ).get() as { pid: number; heartbeat_at: number; ready_at: number | null } | null;
        if (!row || row.ready_at == null) return false;
        if (expectedPid !== undefined && row.pid !== expectedPid) return false;
        const ageMs = Date.now() - row.heartbeat_at;
        return ageMs >= -5000 && ageMs < GATEWAY_LOCK_STALE_MS;
    } catch {
        return false;
    } finally {
        database?.close();
    }
}

function gatewayVersionFromLock(expectedPid: number, path: string): string | null | undefined {
    if (!existsSync(path)) return undefined;
    let database: Database | null = null;
    try {
        database = new Database(path, { readonly: true });
        const row = database.query(
            "SELECT pid, version FROM gateway_lock WHERE id = 1",
        ).get() as { pid: number; version: string | null } | null;
        if (!row || row.pid !== expectedPid) return undefined;
        return row.version;
    } catch {
        return undefined;
    } finally {
        database?.close();
    }
}

function readyTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
    const value = Number(env.SUPERTASK_GATEWAY_READY_TIMEOUT_MS ?? 30_000);
    return Number.isFinite(value) && value > 0 ? value : 30_000;
}

function waitForGatewayReady(
    pid: number,
    path = databasePath(),
    env: NodeJS.ProcessEnv = process.env,
): boolean {
    const deadline = Date.now() + readyTimeoutMs(env);
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    while (Date.now() < deadline) {
        if (isGatewayReady(pid, path)) return true;
        Atomics.wait(sleeper, 0, 0, 100);
    }
    return isGatewayReady(pid, path);
}

export function stopGatewayForMaintenance(): GatewayMaintenanceState {
    if (!isPm2Installed()) return { wasRunning: false };

    const proc = pm2JsonList().find((item) => item.name === PROCESS_NAME);
    const runtime = gatewayRuntimeFromProcess(proc);
    const managedCurrentDatabase = proc?.pm2_env?.status === "online"
        && typeof proc.pid === "number"
        && runtime !== null
        && scopesMatch(currentScope(), runtimeScope(runtime))
        && isGatewayReady(proc.pid, runtimeScope(runtime).databasePath);
    if (!managedCurrentDatabase) return { wasRunning: false };

    assertRuntimeCanControlPm2(runtime, proc);
    requirePm2Termination("stop", "pm2 stop Gateway for database maintenance", runtime);
    return { wasRunning: true, env: runtime.env, cwd: runtime.cwd };
}

export function restartGatewayAfterMaintenance(state: GatewayMaintenanceState): boolean {
    if (!state.wasRunning) return false;

    const env = state.env ?? process.env;
    const cwd = state.cwd ?? process.cwd();
    requirePm2(["start", PROCESS_NAME], "pm2 restart Gateway after database maintenance", { env });
    const started = pm2JsonList(env).find((item) => item.name === PROCESS_NAME);
    if (started?.pm2_env?.status !== "online") {
        throw new Error(
            `[supertask] Gateway 数据库维护后未恢复 online（状态：${started?.pm2_env?.status ?? "missing"}）`,
        );
    }
    if (typeof started.pid !== "number" || !waitForGatewayReady(started.pid, databasePath(env, cwd), env)) {
        throw new Error("[supertask] Gateway 数据库维护后已 online，但未在限定时间内就绪；请查看 pm2 logs supertask-gateway");
    }
    return true;
}

export function withGatewayMaintenance<T>(
    keepStopped: boolean,
    operation: () => T,
): GatewayMaintenanceResult<T> {
    return withManagementLock(() => {
        const state = stopGatewayForMaintenance();
        let result: T;
        try {
            result = operation();
        } catch (error) {
            if (state.wasRunning && !keepStopped) {
                try {
                    restartGatewayAfterMaintenance(state);
                } catch (restartError) {
                    const original = error instanceof Error ? error.message : String(error);
                    const restart = restartError instanceof Error ? restartError.message : String(restartError);
                    throw new Error(`${original}；Gateway 自动恢复也失败：${restart}`);
                }
            }
            throw error;
        }

        let restarted = false;
        if (state.wasRunning && !keepStopped) {
            try {
                restarted = restartGatewayAfterMaintenance(state);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                throw new Error(`数据库维护已完成，但 Gateway 自动重启失败：${message}`);
            }
        }
        return {
            result,
            wasRunning: state.wasRunning,
            restarted,
            keptStopped: state.wasRunning && keepStopped,
        };
    });
}

function findBunPath(): string {
    const override = process.env.SUPERTASK_BUN_BIN;
    if (override) return override;
    try {
        const command = process.platform === "win32" ? "where bun" : "which bun";
        return execSync(command, { stdio: "pipe" }).toString().trim().split("\n")[0];
    } catch {
        return process.execPath;
    }
}

function pm2MaxMemoryRestart(env: NodeJS.ProcessEnv = process.env): string {
    const value = env.SUPERTASK_PM2_MAX_MEMORY ?? "512M";
    if (!/^\d+(?:K|M|G)$/i.test(value)) {
        throw new Error("[supertask] SUPERTASK_PM2_MAX_MEMORY 必须使用 512M / 1G 这类格式");
    }
    return value;
}

function gatewayKillTimeoutMs(runtime: GatewayRuntime): number {
    const shutdownGracePeriodMs = loadConfig(runtimeScope(runtime).configPath).worker.shutdownGracePeriodMs;
    const minimumKillTimeoutMs = shutdownGracePeriodMs + 15_000;
    const configuredValue = runtime.env.SUPERTASK_PM2_KILL_TIMEOUT_MS;
    if (configuredValue !== undefined) {
        const configuredKillTimeout = Number(configuredValue);
        if (!Number.isInteger(configuredKillTimeout) || configuredKillTimeout < minimumKillTimeoutMs) {
            throw new Error(
                `[supertask] SUPERTASK_PM2_KILL_TIMEOUT_MS 必须是至少 ${minimumKillTimeoutMs} 的整数`
                + `（worker shutdown grace ${shutdownGracePeriodMs}ms + 15000ms 收尾余量）`,
            );
        }
        return configuredKillTimeout;
    }
    return Math.max(runtime.killTimeoutMs ?? 0, minimumKillTimeoutMs);
}

function gatewayTerminationCommandTimeoutMs(runtime: GatewayRuntime): number {
    const effectiveKillTimeoutMs = Math.max(
        runtime.killTimeoutMs ?? 0,
        gatewayKillTimeoutMs(runtime),
    );
    const minimumCommandTimeoutMs = effectiveKillTimeoutMs + 5_000;
    const configuredValue = runtime.env.SUPERTASK_PM2_COMMAND_TIMEOUT_MS;
    if (configuredValue !== undefined) {
        const configuredTimeoutMs = Number(configuredValue);
        if (!Number.isInteger(configuredTimeoutMs) || configuredTimeoutMs < minimumCommandTimeoutMs) {
            throw new Error(
                `[supertask] SUPERTASK_PM2_COMMAND_TIMEOUT_MS 必须是至少 ${minimumCommandTimeoutMs} 的整数`
                + `（Gateway kill timeout ${effectiveKillTimeoutMs}ms + 5000ms PM2 收尾余量）`,
            );
        }
        return configuredTimeoutMs;
    }
    return Math.max(pm2CommandTimeoutMs(runtime.env), minimumCommandTimeoutMs);
}

function requirePm2Termination(
    command: "stop" | "delete",
    action: string,
    runtime: GatewayRuntime,
): string {
    return requirePm2([command, PROCESS_NAME], action, {
        env: runtime.env,
        timeoutMs: gatewayTerminationCommandTimeoutMs(runtime),
    });
}

function pm2StartGateway(runtime = currentGatewayRuntime()): void {
    try {
        accessSync(runtime.bunPath, constants.X_OK);
        accessSync(runtime.gatewayEntry, constants.R_OK);
        if (!statSync(runtime.cwd).isDirectory()) throw new Error("cwd is not a directory");
    } catch (error) {
        throw new Error(`[supertask] Gateway 目标运行时不可用: ${error instanceof Error ? error.message : String(error)}`);
    }
    const killTimeoutMs = gatewayKillTimeoutMs(runtime);
    requirePm2([
        "start",
        runtime.bunPath,
        "--name",
        PROCESS_NAME,
        "--interpreter",
        "none",
        "--restart-delay",
        "5000",
        "--max-restarts",
        "30",
        "--max-memory-restart",
        pm2MaxMemoryRestart(runtime.env),
        "--kill-timeout",
        String(killTimeoutMs),
        "--cwd",
        runtime.cwd,
        "--",
        runtime.gatewayEntry,
    ], "pm2 start", { env: runtime.env });
    const started = pm2JsonList(runtime.env).find((item) => item.name === PROCESS_NAME);
    if (started?.pm2_env?.status !== "online") {
        throw new Error(`[supertask] Gateway did not become online (status: ${started?.pm2_env?.status ?? "missing"})`);
    }
    const observedRuntime = gatewayRuntimeFromProcess(started);
    if (
        !observedRuntime
        || observedRuntime.gatewayEntry !== resolve(runtime.gatewayEntry)
        || observedRuntime.bunPath !== runtime.bunPath
        || observedRuntime.cwd !== resolve(runtime.cwd)
        || !scopesMatch(runtimeScope(observedRuntime), runtimeScope(runtime))
    ) {
        throw new Error("[supertask] PM2 online 记录与本次启动目标不一致，已拒绝接管");
    }
    if (
        typeof started.pid !== "number"
        || !waitForGatewayReady(started.pid, runtimeScope(runtime).databasePath, runtime.env)
    ) {
        throw new Error("[supertask] Gateway 进程 online，但未在限定时间内就绪；请查看 pm2 logs supertask-gateway");
    }
}

function assertRuntimeCanControlPm2(runtime: GatewayRuntime | null, existing?: Pm2Process): void {
    if (!existing) return;
    if (!runtime) {
        throw new Error(
            "[supertask] 无法完整验证已有 Gateway 的入口、Bun 和 cwd，已拒绝删除现有进程",
        );
    }
    const probe = pm2Exec(["--version"], { env: runtime.env });
    if (!probe.ok) {
        throw new Error(
            `[supertask] 保存的 Gateway 运行环境无法执行 pm2，已拒绝删除现有进程；请先修复 PATH 或 SUPERTASK_PM2_BIN: ${probe.output || "pm2 unavailable"}`,
        );
    }
    const observed = pm2JsonList(runtime.env).find((item) => item.name === PROCESS_NAME);
    const observedRuntime = gatewayRuntimeFromProcess(observed);
    if (
        !observed
        || observed.pid !== existing.pid
        || !observedRuntime
        || observedRuntime.gatewayEntry !== runtime.gatewayEntry
        || observedRuntime.bunPath !== runtime.bunPath
        || observedRuntime.cwd !== runtime.cwd
    ) {
        throw new Error("[supertask] 保存的 PM2 环境无法重现同一 Gateway 记录，已拒绝删除现有进程");
    }
}

function savePm2State(env: NodeJS.ProcessEnv = process.env): void {
    requirePm2(["save"], "pm2 save", { env });
}

function managementLockPath(
    env: NodeJS.ProcessEnv = process.env,
    cwd = process.cwd(),
): string {
    const override = env.SUPERTASK_PM2_MANAGEMENT_LOCK;
    if (override) return runtimePath(override, cwd);
    return join(runtimeScope({ env, cwd }).pm2Home, "supertask-gateway.manage.sqlite");
}

function canonicalManagementLockPath(
    env: NodeJS.ProcessEnv = process.env,
    cwd = process.cwd(),
): string {
    const home = runtimeHome(env);
    const pm2Home = env.PM2_HOME
        ? runtimePath(env.PM2_HOME, cwd)
        : join(home, ".pm2");
    return join(pm2Home, "supertask-gateway.manage.sqlite");
}

function addLegacyManagementLock(
    paths: Set<string>,
    env: Record<string, unknown> | undefined,
    cwd: string,
): void {
    const value = env?.SUPERTASK_PM2_MANAGEMENT_LOCK;
    if (typeof value === "string" && value.length > 0) paths.add(runtimePath(value, cwd));
}

function savedManagementLockPaths(): string[] {
    const canonical = canonicalManagementLockPath();
    const legacy = new Set<string>();
    addLegacyManagementLock(legacy, process.env, process.cwd());

    const pm2Home = currentScope().pm2Home;
    try {
        const dump = JSON.parse(readFileSync(join(pm2Home, "dump.pm2"), "utf8")) as unknown;
        if (Array.isArray(dump)) {
            const gateway = (dump as Pm2Process[]).find((item) => item.name === PROCESS_NAME);
            const cwd = gateway?.pm2_env?.pm_cwd;
            if (typeof cwd === "string") {
                addLegacyManagementLock(
                    legacy,
                    gateway?.pm2_env?.env ?? gateway?.env,
                    cwd,
                );
            }
        }
    } catch {}

    if (process.platform === "darwin") {
        try {
            const configured = plistValue(
                readFileSync(launchAgentPath(), "utf8"),
                "SUPERTASK_PM2_MANAGEMENT_LOCK",
            );
            if (configured) legacy.add(resolve(configured));
        } catch {}
    }

    if (isPm2Installed()) {
        const gateway = pm2JsonList().find((item) => item.name === PROCESS_NAME);
        const cwd = gateway?.pm2_env?.pm_cwd;
        if (typeof cwd === "string") {
            addLegacyManagementLock(
                legacy,
                gateway?.pm2_env?.env ?? gateway?.env,
                cwd,
            );
        }
    }

    return [
        canonical,
        ...[...legacy].filter((path) => path !== canonical).sort(),
    ];
}

function withManagementLocks<T>(
    paths: string[],
    timeoutMs: number,
    action: () => T,
    index = 0,
): T {
    const path = paths[index];
    if (!path) return action();
    return withExclusiveManagementLock(
        path,
        timeoutMs,
        () => withManagementLocks(paths, timeoutMs, action, index + 1),
    );
}

function assertMacLaunchAgentPm2HomeMatchesCurrent(): void {
    if (process.platform !== "darwin") return;
    try {
        const configuredPm2Home = plistValue(
            readFileSync(launchAgentPath(), "utf8"),
            "PM2_HOME",
        );
        if (!configuredPm2Home) return;
        const installedPm2Home = resolve(configuredPm2Home);
        const activePm2Home = currentScope().pm2Home;
        if (installedPm2Home !== activePm2Home) {
            throw new Error(
                `[supertask] 已安装的 macOS LaunchAgent 使用 PM2_HOME=${installedPm2Home}，`
                + `当前 CLI 使用 ${activePm2Home}；为避免两个 PM2 daemon 同时管理 Gateway，已拒绝修改。`
                + `请使用 PM2_HOME=${installedPm2Home} 重新执行命令`,
            );
        }
    } catch (error) {
        if (error instanceof Error && error.message.startsWith("[supertask] 已安装的 macOS LaunchAgent")) {
            throw error;
        }
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
}

function withManagementLock<T>(action: () => T): T {
    const paths = savedManagementLockPaths();
    const configuredTimeout = Number(process.env.SUPERTASK_PM2_MANAGEMENT_LOCK_TIMEOUT_MS ?? 15_000);
    const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
        ? configuredTimeout
        : 15_000;
    try {
        return withManagementLocks(paths, timeoutMs, () => {
            assertMacLaunchAgentPm2HomeMatchesCurrent();
            return action();
        });
    } catch (error) {
        if (error instanceof ManagementLockBusyError) {
            throw new Error("[supertask] 另一个 Gateway 管理操作仍在进行，已拒绝并发修改 PM2 状态");
        }
        throw error;
    }
}

export function install(): void {
    return withManagementLock(installUnlocked);
}

function installUnlocked(): void {
    if (!isPm2Installed() && !installPm2()) {
        throw new Error("[supertask] Failed to install pm2. Please install it manually: npm install -g pm2");
    }

    const existing = pm2JsonList().find((item) => item.name === PROCESS_NAME);
    const oldRuntime = gatewayRuntimeFromProcess(existing);
    const targetRuntime = oldRuntime
        ? refreshGatewayExecutionEnvironment(oldRuntime, resolveGatewayEntry())
        : currentGatewayRuntime();
    const before = getRunningVersion(oldRuntime?.env ?? process.env, oldRuntime?.cwd);
    if (oldRuntime && !scopesMatch(currentScope(), runtimeScope(oldRuntime))) {
        throw new Error("[supertask] 当前 CLI 与 PM2 Gateway 的数据库/配置/OpenCode 运行作用域不一致，已拒绝覆盖");
    }
    assertRuntimeCanControlPm2(oldRuntime, existing);
    gatewayKillTimeoutMs(targetRuntime);
    gatewayTerminationCommandTimeoutMs(targetRuntime);
    if (existing) requirePm2Termination("delete", "pm2 delete existing Gateway", oldRuntime!);

    const version = getPackageVersion();
    try {
        pm2StartGateway(targetRuntime);
        savePm2State(targetRuntime.env);
        writeRunningVersion(version, targetRuntime.env, targetRuntime.cwd);
    } catch (error) {
        const failed = pm2JsonList(targetRuntime.env).find((item) => item.name === PROCESS_NAME);
        if (failed) {
            requirePm2Termination(
                "delete",
                "pm2 delete failed Gateway",
                gatewayRuntimeFromProcess(failed) ?? targetRuntime,
            );
        }
        if (oldRuntime) {
            try {
                pm2StartGateway(oldRuntime);
                savePm2State(oldRuntime.env);
                if (before) writeRunningVersion(before, oldRuntime.env, oldRuntime.cwd);
            } catch (rollbackError) {
                const original = error instanceof Error ? error.message : String(error);
                const rollback = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
                throw new Error(`${original}; 旧 Gateway 回滚也失败: ${rollback}`);
            }
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`${message}; 已回滚到旧 Gateway`);
        }
        throw error;
    }
    if (!ensurePm2LogRotation(targetRuntime.env)) {
        console.warn("[supertask] pm2-logrotate 安装或配置失败；Gateway 已运行，但请执行 `supertask doctor` 检查日志治理。");
    }
    if (process.platform === "darwin") {
        const path = installMacLaunchAgent(targetRuntime);
        console.log(`[supertask] macOS LaunchAgent installed: ${path}`);
    } else {
        const startup = pm2Exec(["startup"], { env: targetRuntime.env });
        if (startup.output) console.log(startup.output);
        if (process.platform === "linux" && (!startup.ok || !isLinuxStartupConfigured(targetRuntime.env, targetRuntime.cwd, targetRuntime))) {
            throw new Error("[supertask] pm2 startup 未完成或 systemd 自启未生效；Gateway 当前已运行，但安装未达到可重启恢复标准");
        }
    }

    console.log("[supertask] Gateway installed and running.");
    console.log("[supertask] Manage with: pm2 status / pm2 logs supertask-gateway");
}

export function uninstall(): void {
    return withManagementLock(uninstallUnlocked);
}

function removeMacLaunchAgent(): void {
    if (typeof process.getuid !== "function") return;
    const path = launchAgentPath();
    const domain = `gui/${process.getuid()}`;
    const loaded = spawnSync(
        launchctlBin(),
        ["print", `${domain}/${MAC_LAUNCH_AGENT_LABEL}`],
        {
            stdio: "ignore",
            timeout: pm2CommandTimeoutMs(),
            killSignal: "SIGKILL",
        },
    );
    if (loaded.error) {
        throw new Error(`[supertask] 无法确认 macOS LaunchAgent 状态: ${loaded.error.message}`);
    }
    if (loaded.status === 0) {
        const removed = spawnSync(
            launchctlBin(),
            ["bootout", `${domain}/${MAC_LAUNCH_AGENT_LABEL}`],
            {
                encoding: "utf8",
                timeout: pm2CommandTimeoutMs(),
                killSignal: "SIGKILL",
            },
        );
        if (removed.status !== 0 || removed.error) {
            const output = `${removed.stdout ?? ""}${removed.stderr ?? ""}`.trim();
            throw new Error(
                `[supertask] Gateway 已从 PM2 与 dump 中移除，但 macOS LaunchAgent 停止失败: `
                + (output || removed.error?.message || `退出码 ${removed.status}`),
            );
        }
    }
    rmSync(path, { force: true });
}

function uninstallUnlocked(): void {
    if (!isPm2Installed()) throw new Error("[supertask] pm2 is not installed");
    const existing = pm2JsonList().find((item) => item.name === PROCESS_NAME);
    const runtime = gatewayRuntimeFromProcess(existing);
    assertRuntimeCanControlPm2(runtime, existing);
    if (existing) requirePm2Termination("delete", "pm2 delete Gateway", runtime!);
    savePm2State(runtime?.env);
    if (process.platform === "darwin") removeMacLaunchAgent();
    console.log("[supertask] Gateway removed from pm2. Other pm2 startup entries were preserved.");
}

export function upgrade(target?: {
    gatewayEntry: string;
    version: string;
}): { before: string | null; after: string; restarted: boolean } {
    return withManagementLock(() => upgradeUnlocked(target));
}

function upgradeUnlocked(target?: {
    gatewayEntry: string;
    version: string;
}): { before: string | null; after: string; restarted: boolean } {
    if (!isPm2Installed()) {
        throw new Error("[supertask] pm2 is not installed. Run `supertask install` first.");
    }

    const existing = pm2JsonList().find((item) => item.name === PROCESS_NAME);
    const oldRuntime = gatewayRuntimeFromProcess(existing)
        ?? (process.env.SUPERTASK_GATEWAY_ENTRY ? currentGatewayRuntime(resolveGatewayEntry()) : null);
    const before = getRunningVersion(oldRuntime?.env ?? process.env, oldRuntime?.cwd);
    const currentVersion = target?.version ?? getPackageVersion();
    const targetRuntime = oldRuntime
        ? refreshGatewayExecutionEnvironment(
            oldRuntime,
            target?.gatewayEntry ?? oldRuntime.gatewayEntry,
        )
        : currentGatewayRuntime(target?.gatewayEntry ?? resolveGatewayEntry());
    assertRuntimeCanControlPm2(oldRuntime, existing);
    gatewayKillTimeoutMs(targetRuntime);
    gatewayTerminationCommandTimeoutMs(targetRuntime);
    if (existing) requirePm2Termination("delete", "pm2 delete old Gateway", oldRuntime!);

    try {
        pm2StartGateway(targetRuntime);
        savePm2State(targetRuntime.env);
        writeRunningVersion(currentVersion, targetRuntime.env, targetRuntime.cwd);
        return { before, after: currentVersion, restarted: true };
    } catch (error) {
        const failed = pm2JsonList(targetRuntime.env).find((item) => item.name === PROCESS_NAME);
        if (failed) {
            requirePm2Termination(
                "delete",
                "pm2 delete failed Gateway",
                gatewayRuntimeFromProcess(failed) ?? targetRuntime,
            );
        }
        if (!oldRuntime) throw error;
        try {
            pm2StartGateway(oldRuntime);
            savePm2State(oldRuntime.env);
            if (before) writeRunningVersion(before, oldRuntime.env, oldRuntime.cwd);
        } catch (rollbackError) {
            const original = error instanceof Error ? error.message : String(error);
            const rollback = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
            throw new Error(`${original}; 旧 Gateway 回滚也失败: ${rollback}`);
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${message}; 已回滚到旧 Gateway`);
    }
}

export function ensureGateway(): EnsureGatewayResult {
    return withManagementLock(ensureGatewayUnlocked);
}

function ensureGatewayUnlocked(): EnsureGatewayResult {
    if (!isPm2Installed()) {
        return { ok: false, reason: "pm2-not-installed" };
    }

    const currentVersion = getPackageVersion();
    const processList = pm2JsonList();
    const existing = processList.find((item) => item.name === PROCESS_NAME);
    const oldRuntime = gatewayRuntimeFromProcess(existing);
    if (oldRuntime && !scopesMatch(currentScope(), runtimeScope(oldRuntime))) {
        throw new Error("[supertask] 当前 OpenCode/CLI 与 PM2 Gateway 的数据库、配置或 OpenCode 可执行文件作用域不一致，已拒绝继续写入");
    }
    assertRuntimeCanControlPm2(oldRuntime, existing);
    const lockedVersion = existing && typeof existing.pid === "number" && oldRuntime
        ? gatewayVersionFromLock(existing.pid, runtimeScope(oldRuntime).databasePath)
        : undefined;
    if (
        existing?.pm2_env?.status === "online"
        && typeof existing.pid === "number"
        && oldRuntime !== null
        && isGatewayReady(existing.pid, runtimeScope(oldRuntime).databasePath)
        && (
            lockedVersion === currentVersion
            || (
                lockedVersion === undefined
                && getRunningVersion(oldRuntime.env, oldRuntime.cwd) === currentVersion
            )
        )
    ) {
        return { ok: true, action: "already-running" };
    }

    const targetRuntime = oldRuntime
        ? { ...oldRuntime, gatewayEntry: resolve(resolveGatewayEntry()) }
        : currentGatewayRuntime();
    const before = getRunningVersion(oldRuntime?.env ?? process.env, oldRuntime?.cwd);

    gatewayKillTimeoutMs(targetRuntime);
    gatewayTerminationCommandTimeoutMs(targetRuntime);
    if (existing) requirePm2Termination("delete", "pm2 delete stale Gateway", oldRuntime!);
    try {
        pm2StartGateway(targetRuntime);
        savePm2State(targetRuntime.env);
        writeRunningVersion(currentVersion, targetRuntime.env, targetRuntime.cwd);
    } catch (error) {
        const failed = pm2JsonList(targetRuntime.env).find((item) => item.name === PROCESS_NAME);
        if (failed) {
            requirePm2Termination(
                "delete",
                "pm2 delete failed Gateway",
                gatewayRuntimeFromProcess(failed) ?? targetRuntime,
            );
        }
        if (oldRuntime) {
            try {
                pm2StartGateway(oldRuntime);
                savePm2State(oldRuntime.env);
                if (before) writeRunningVersion(before, oldRuntime.env, oldRuntime.cwd);
            } catch (rollbackError) {
                const original = error instanceof Error ? error.message : String(error);
                const rollback = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
                throw new Error(`${original}; 旧 Gateway 回滚也失败: ${rollback}`);
            }
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`${message}; 已回滚到旧 Gateway`);
        }
        throw error;
    }
    return { ok: true, action: existing ? "restarted" : "started" };
}
