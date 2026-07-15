import { execSync, spawnSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, isAbsolute, join } from "path";
import { fileURLToPath } from "url";
import { Database } from "bun:sqlite";
import { loadConfig } from "../gateway/config";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROCESS_NAME = "supertask-gateway";
const MAC_LAUNCH_AGENT_LABEL = "com.supertask.pm2-resurrect";

interface Pm2Process {
    name: string;
    pid?: number;
    pm2_env?: { status?: string };
}

const GATEWAY_LOCK_STALE_MS = 30_000;

export type EnsureGatewayResult =
    | { ok: true; action: "already-running" | "started" | "restarted" }
    | { ok: false; reason: "pm2-not-installed" };

export interface GatewayMaintenanceState {
    wasRunning: boolean;
}

export function getPackageVersion(): string {
    const envVersion = process.env.npm_package_version;
    if (envVersion) return envVersion;

    try {
        const pkgPath = join(__dirname, "../../package.json");
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: unknown };
        return typeof pkg.version === "string" ? pkg.version : "0.0.0";
    } catch {
        return "0.0.0";
    }
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

function versionFile(): string {
    return process.env.SUPERTASK_VERSION_FILE
        ?? join(homedir(), ".local/share/opencode/supertask-gateway-version");
}

function getRunningVersion(): string | null {
    try {
        const path = versionFile();
        if (!existsSync(path)) return null;
        return readFileSync(path, "utf-8").trim() || null;
    } catch {
        return null;
    }
}

function writeRunningVersion(version: string): void {
    const path = versionFile();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, version, "utf-8");
}

function pm2Bin(): string {
    return process.env.SUPERTASK_PM2_BIN
        ?? (process.platform === "win32" ? "pm2.cmd" : "pm2");
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
        ?? join(homedir(), "Library/LaunchAgents", `${MAC_LAUNCH_AGENT_LABEL}.plist`);
}

function launchctlBin(): string {
    return process.env.SUPERTASK_LAUNCHCTL_BIN ?? "launchctl";
}

export function installMacLaunchAgent(): string {
    if (typeof process.getuid !== "function") {
        throw new Error("[supertask] 当前运行时无法获取 macOS 用户 ID");
    }

    const path = launchAgentPath();
    const home = homedir();
    const pm2Home = process.env.PM2_HOME ?? join(home, ".pm2");
    const environmentPath = process.env.PATH
        ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${MAC_LAUNCH_AGENT_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${xmlEscape(resolvePm2Bin())}</string>
      <string>resurrect</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>
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
    </dict>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(join(pm2Home, "supertask-launchd-error.log"))}</string>
    <key>StandardOutPath</key>
    <string>${xmlEscape(join(pm2Home, "supertask-launchd-output.log"))}</string>
  </dict>
</plist>
`;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, plist, { mode: 0o600 });
    chmodSync(path, 0o600);

    const domain = `gui/${process.getuid()}`;
    spawnSync(launchctlBin(), ["bootout", `${domain}/${MAC_LAUNCH_AGENT_LABEL}`], {
        stdio: "ignore",
    });
    const loaded = spawnSync(launchctlBin(), ["bootstrap", domain, path], {
        encoding: "utf8",
    });
    if (loaded.status !== 0) {
        const output = `${loaded.stdout ?? ""}${loaded.stderr ?? ""}`.trim();
        throw new Error(`[supertask] macOS LaunchAgent 加载失败: ${output || `退出码 ${loaded.status}`}`);
    }
    return path;
}

export function isPm2Installed(): boolean {
    const result = spawnSync(pm2Bin(), ["--version"], {
        stdio: "ignore",
        shell: process.platform === "win32",
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

function pm2Exec(args: string[]): { ok: boolean; output: string } {
    const result = spawnSync(pm2Bin(), args, {
        stdio: ["pipe", "pipe", "pipe"],
        encoding: "utf-8",
        env: process.env,
        shell: process.platform === "win32",
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    if (result.error) return { ok: false, output: result.error.message };
    return { ok: result.status === 0, output };
}

function requirePm2(args: string[], action: string): string {
    const result = pm2Exec(args);
    if (!result.ok) throw new Error(`[supertask] ${action} failed: ${result.output || "unknown pm2 error"}`);
    return result.output;
}

function pm2JsonList(): Pm2Process[] {
    const output = requirePm2(["jlist"], "pm2 jlist");
    try {
        const parsed = JSON.parse(output) as unknown;
        if (!Array.isArray(parsed)) throw new Error("result is not an array");
        return parsed as Pm2Process[];
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`[supertask] Invalid pm2 jlist output: ${message}`);
    }
}

export function isGatewayRunning(): boolean {
    if (!isPm2Installed()) return false;
    const proc = pm2JsonList().find((item) => item.name === PROCESS_NAME);
    return proc?.pm2_env?.status === "online"
        && typeof proc.pid === "number"
        && isGatewayReady(proc.pid);
}

function databasePath(): string {
    return process.env.SUPERTASK_DB_PATH
        ?? join(homedir(), ".local/share/opencode/tasks.db");
}

export function isGatewayReady(expectedPid?: number): boolean {
    const path = databasePath();
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

function readyTimeoutMs(): number {
    const value = Number(process.env.SUPERTASK_GATEWAY_READY_TIMEOUT_MS ?? 30_000);
    return Number.isFinite(value) && value > 0 ? value : 30_000;
}

function waitForGatewayReady(pid: number): boolean {
    const deadline = Date.now() + readyTimeoutMs();
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    while (Date.now() < deadline) {
        if (isGatewayReady(pid)) return true;
        Atomics.wait(sleeper, 0, 0, 100);
    }
    return isGatewayReady(pid);
}

export function stopGatewayForMaintenance(): GatewayMaintenanceState {
    if (!isPm2Installed()) return { wasRunning: false };

    const proc = pm2JsonList().find((item) => item.name === PROCESS_NAME);
    const managedCurrentDatabase = proc?.pm2_env?.status === "online"
        && typeof proc.pid === "number"
        && isGatewayReady(proc.pid);
    if (!managedCurrentDatabase) return { wasRunning: false };

    requirePm2(["stop", PROCESS_NAME], "pm2 stop Gateway for database maintenance");
    return { wasRunning: true };
}

export function restartGatewayAfterMaintenance(state: GatewayMaintenanceState): boolean {
    if (!state.wasRunning) return false;

    requirePm2(["start", PROCESS_NAME], "pm2 restart Gateway after database maintenance");
    const started = pm2JsonList().find((item) => item.name === PROCESS_NAME);
    if (started?.pm2_env?.status !== "online") {
        throw new Error(
            `[supertask] Gateway 数据库维护后未恢复 online（状态：${started?.pm2_env?.status ?? "missing"}）`,
        );
    }
    if (typeof started.pid !== "number" || !waitForGatewayReady(started.pid)) {
        throw new Error("[supertask] Gateway 数据库维护后已 online，但未在限定时间内就绪；请查看 pm2 logs supertask-gateway");
    }
    return true;
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

function pm2StartGateway(gatewayEntry = resolveGatewayEntry()): void {
    const configuredKillTimeout = Number(process.env.SUPERTASK_PM2_KILL_TIMEOUT_MS);
    const killTimeoutMs = Number.isInteger(configuredKillTimeout) && configuredKillTimeout >= 5000
        ? configuredKillTimeout
        : loadConfig().worker.shutdownGracePeriodMs + 5000;
    requirePm2([
        "start",
        findBunPath(),
        "--name",
        PROCESS_NAME,
        "--interpreter",
        "none",
        "--restart-delay",
        "5000",
        "--max-restarts",
        "30",
        "--kill-timeout",
        String(killTimeoutMs),
        "--",
        gatewayEntry,
    ], "pm2 start");
    const started = pm2JsonList().find((item) => item.name === PROCESS_NAME);
    if (started?.pm2_env?.status !== "online") {
        throw new Error(`[supertask] Gateway did not become online (status: ${started?.pm2_env?.status ?? "missing"})`);
    }
    if (typeof started.pid !== "number" || !waitForGatewayReady(started.pid)) {
        throw new Error("[supertask] Gateway 进程 online，但未在限定时间内就绪；请查看 pm2 logs supertask-gateway");
    }
}

function savePm2State(): void {
    requirePm2(["save"], "pm2 save");
}

export function install(): void {
    if (!isPm2Installed() && !installPm2()) {
        throw new Error("[supertask] Failed to install pm2. Please install it manually: npm install -g pm2");
    }

    const existing = pm2JsonList().find((item) => item.name === PROCESS_NAME);
    if (existing) requirePm2(["delete", PROCESS_NAME], "pm2 delete existing Gateway");

    const version = getPackageVersion();
    pm2StartGateway();
    writeRunningVersion(version);
    savePm2State();

    if (process.platform === "darwin") {
        try {
            const path = installMacLaunchAgent();
            console.log(`[supertask] macOS LaunchAgent installed: ${path}`);
        } catch (error) {
            console.warn(error instanceof Error ? error.message : String(error));
        }
    } else {
        const startup = pm2Exec(["startup"]);
        if (startup.output) console.log(startup.output);
        if (!startup.ok) {
            console.warn("[supertask] pm2 startup 未完成；请按 pm2 输出执行需要管理员权限的命令，然后运行 `pm2 save`。");
        }
    }

    console.log("[supertask] Gateway installed and running.");
    console.log("[supertask] Manage with: pm2 status / pm2 logs supertask-gateway");
}

export function uninstall(): void {
    if (!isPm2Installed()) throw new Error("[supertask] pm2 is not installed");
    const existing = pm2JsonList().find((item) => item.name === PROCESS_NAME);
    if (existing) requirePm2(["delete", PROCESS_NAME], "pm2 delete Gateway");
    savePm2State();
    console.log("[supertask] Gateway removed from pm2. Other pm2 startup entries were preserved.");
}

export function upgrade(target?: {
    gatewayEntry: string;
    version: string;
}): { before: string | null; after: string; restarted: boolean } {
    if (!isPm2Installed()) {
        throw new Error("[supertask] pm2 is not installed. Run `supertask install` first.");
    }

    const before = getRunningVersion();
    const oldGatewayEntry = resolveGatewayEntry();
    const currentVersion = target?.version ?? getPackageVersion();
    const existing = pm2JsonList().find((item) => item.name === PROCESS_NAME);
    if (existing) requirePm2(["delete", PROCESS_NAME], "pm2 delete old Gateway");

    try {
        pm2StartGateway(target?.gatewayEntry ?? oldGatewayEntry);
        writeRunningVersion(currentVersion);
        savePm2State();
        return { before, after: currentVersion, restarted: true };
    } catch (error) {
        const failed = pm2JsonList().find((item) => item.name === PROCESS_NAME);
        if (failed) requirePm2(["delete", PROCESS_NAME], "pm2 delete failed Gateway");
        try {
            pm2StartGateway(oldGatewayEntry);
            if (before) writeRunningVersion(before);
            savePm2State();
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
    if (!isPm2Installed()) {
        return { ok: false, reason: "pm2-not-installed" };
    }

    const currentVersion = getPackageVersion();
    const processList = pm2JsonList();
    const existing = processList.find((item) => item.name === PROCESS_NAME);
    if (
        existing?.pm2_env?.status === "online"
        && typeof existing.pid === "number"
        && isGatewayReady(existing.pid)
        && getRunningVersion() === currentVersion
    ) {
        return { ok: true, action: "already-running" };
    }

    if (existing) requirePm2(["delete", PROCESS_NAME], "pm2 delete stale Gateway");
    pm2StartGateway();
    writeRunningVersion(currentVersion);
    savePm2State();
    return { ok: true, action: existing ? "restarted" : "started" };
}
