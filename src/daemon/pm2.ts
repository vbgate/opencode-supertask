import { execSync, spawnSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { Database } from "bun:sqlite";
import { loadConfig } from "../gateway/config";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROCESS_NAME = "supertask-gateway";

interface Pm2Process {
    name: string;
    pid?: number;
    pm2_env?: { status?: string };
}

const GATEWAY_LOCK_STALE_MS = 30_000;

export type EnsureGatewayResult =
    | { ok: true; action: "already-running" | "started" | "restarted" }
    | { ok: false; reason: "pm2-not-installed" };

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

function pm2StartGateway(): void {
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
        resolveGatewayEntry(),
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

    const startup = pm2Exec(["startup"]);
    if (startup.output) console.log(startup.output);
    if (!startup.ok) {
        console.warn("[supertask] pm2 startup 未完成；请按 pm2 输出执行需要管理员权限的命令，然后运行 `pm2 save`。");
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

export function upgrade(): { before: string | null; after: string; restarted: boolean } {
    if (!isPm2Installed()) {
        throw new Error("[supertask] pm2 is not installed. Run `supertask install` first.");
    }

    const before = getRunningVersion();
    const currentVersion = getPackageVersion();
    const existing = pm2JsonList().find((item) => item.name === PROCESS_NAME);
    if (existing) requirePm2(["delete", PROCESS_NAME], "pm2 delete old Gateway");

    pm2StartGateway();
    writeRunningVersion(currentVersion);
    savePm2State();
    return { before, after: currentVersion, restarted: true };
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
