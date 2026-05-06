import { execSync, spawnSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GATEWAY_ENTRY = join(__dirname, "../gateway/index.js");
const PROCESS_NAME = "supertask-gateway";

function pm2Bin(): string {
    return process.platform === "win32" ? "pm2.cmd" : "pm2";
}

function isPm2Installed(): boolean {
    try {
        const cmd = process.platform === "win32" ? "where pm2" : "which pm2";
        execSync(cmd, { stdio: "pipe" });
        return true;
    } catch {
        return false;
    }
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
    const bin = pm2Bin();
    try {
        const result = spawnSync(bin, args, {
            stdio: ["pipe", "pipe", "pipe"],
            encoding: "utf-8",
            shell: process.platform === "win32",
        });
        const output = (result.stdout ?? "") + (result.stderr ?? "");
        return { ok: result.status === 0, output };
    } catch (err) {
        return { ok: false, output: err instanceof Error ? err.message : String(err) };
    }
}

function pm2JsonList(): Array<{ name: string; pm2_env?: { status: string } }> {
    const { ok, output } = pm2Exec(["jlist"]);
    if (!ok) return [];
    try {
        return JSON.parse(output);
    } catch {
        return [];
    }
}

export function isGatewayRunning(): boolean {
    const list = pm2JsonList();
    const proc = list.find((p) => p.name === PROCESS_NAME);
    if (!proc) return false;
    return proc.pm2_env?.status === "online";
}

function findBunPath(): string {
    try {
        const cmd = process.platform === "win32" ? "where bun" : "which bun";
        return execSync(cmd, { stdio: "pipe" }).toString().trim().split("\n")[0];
    } catch {
        return process.execPath;
    }
}

export function install(): void {
    if (!isPm2Installed()) {
        if (!installPm2()) {
            throw new Error("[supertask] Failed to install pm2. Please install it manually: npm install -g pm2");
        }
    }
    console.log("[supertask] pm2 ready");

    const list = pm2JsonList();
    const existing = list.find((p) => p.name === PROCESS_NAME);

    if (existing) {
        console.log("[supertask] Gateway process already registered, reloading...");
        const { ok } = pm2Exec(["reload", PROCESS_NAME]);
        if (!ok) {
            console.error("[supertask] pm2 reload failed, trying restart...");
            pm2Exec(["restart", PROCESS_NAME]);
        }
    } else {
        console.log("[supertask] Starting Gateway with pm2...");
        const bunPath = findBunPath();
        const { ok, output } = pm2Exec([
            "start",
            GATEWAY_ENTRY,
            "--name",
            PROCESS_NAME,
            "--interpreter",
            bunPath,
            "--restart-delay",
            "5000",
            "--max-restarts",
            "30",
        ]);
        if (!ok) {
            throw new Error(`[supertask] pm2 start failed: ${output}`);
        }
    }

    pm2Exec(["save"]);

    console.log("[supertask] Configuring startup...");
    const { ok: startupOk, output: startupOutput } = pm2Exec(["startup"]);
    if (!startupOk) {
        if (startupOutput.includes("sudo") || startupOutput.includes("run as root")) {
            console.log("[supertask] pm2 startup requires elevated permissions.");
            console.log("[supertask] Run the command shown above, or manually execute:");
            console.log(`  pm2 startup`);
            console.log(`  pm2 save`);
        } else if (process.platform === "win32") {
            console.log("[supertask] On Windows, use pm2-installer for startup:");
            console.log("  npm install -g pm2-windows-startup");
            console.log("  pm2-startup install");
        }
    }

    console.log("\n[supertask] Gateway installed and running!");
    console.log("[supertask] Manage with: pm2 status / pm2 logs supertask-gateway");
}

export function uninstall(): void {
    console.log("[supertask] Stopping Gateway...");
    pm2Exec(["stop", PROCESS_NAME]);

    console.log("[supertask] Removing Gateway from pm2...");
    pm2Exec(["delete", PROCESS_NAME]);

    pm2Exec(["save"]);

    console.log("\n[supertask] Gateway removed from pm2.");
    console.log("[supertask] Note: pm2 startup config was not removed (you may have other pm2 processes).");
    console.log("[supertask] To fully remove pm2 startup: pm2 unstartup");
}

export function ensureGateway(): void {
    try {
        const list = pm2JsonList();
        const proc = list.find((p) => p.name === PROCESS_NAME);
        if (proc && proc.pm2_env?.status === "online") {
            return;
        }
    } catch {}

    if (!isPm2Installed()) {
        try {
            execSync("npm install -g pm2", { stdio: "pipe" });
        } catch {
            try {
                execSync("bun install -g pm2", { stdio: "pipe" });
            } catch {
                return;
            }
        }
    }

    const list = pm2JsonList();
    const existing = list.find((p) => p.name === PROCESS_NAME);

    if (existing) {
        pm2Exec(["restart", PROCESS_NAME]);
    } else {
        const bunPath = findBunPath();
        pm2Exec([
            "start",
            GATEWAY_ENTRY,
            "--name",
            PROCESS_NAME,
            "--interpreter",
            bunPath,
            "--restart-delay",
            "5000",
            "--max-restarts",
            "30",
        ]);
    }

    pm2Exec(["save"]);
}
