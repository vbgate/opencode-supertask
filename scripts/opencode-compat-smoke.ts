// 用真实 OpenCode 1.x/2.x 可执行文件验证 SuperTask 的构建产物（先运行 bun run build）。
// 全部状态隔离在临时目录：XDG 目录、任务数据库、Gateway 配置；模型由本地假 OpenAI 兼容服务提供，不调用真实模型。
// 用法：bun scripts/opencode-compat-smoke.ts [opencode 可执行文件 ...]（默认 PATH 中的 opencode）
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { parseOpenCodeVersion } from '../src/core/opencode-cli';

const root = resolve(import.meta.dir, '..');
const pluginEntry = join(root, 'dist/plugin/supertask.js');
const gatewayEntry = join(root, 'dist/gateway/index.js');
const ADD_TASK_MARKER = 'SUPERTASK_COMPAT_ADD_TASK';
const RESULT_MARKER = 'SUPERTASK_COMPAT_OK';
const QUEUED_PROMPT = 'compat queued prompt';

type ChatMessage = { role: string; content?: unknown };
type ChatRequest = { messages: ChatMessage[]; tools?: { function: { name: string } }[]; stream?: boolean };

function sse(delta: Record<string, unknown>, finish: string | null): string {
    return `data: ${JSON.stringify({
        id: 'fake', object: 'chat.completion.chunk', created: 0, model: 'echo',
        choices: [{ index: 0, delta, finish_reason: finish }],
        ...(finish ? { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } : {}),
    })}\n\n`;
}

function messageText(message: ChatMessage | undefined): string {
    if (!message) return '';
    if (typeof message.content === 'string') return message.content;
    return Array.isArray(message.content)
        ? message.content.map((part) => (typeof part === 'object' && part && 'text' in part ? String(part.text) : '')).join('')
        : '';
}

/** 首轮：若用户要求建任务则发起工具调用（2.x codemode 经 execute 调用），否则直接回复标记文本。 */
function startFakeModel() {
    return Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(request) {
            if (new URL(request.url).pathname.endsWith('/models')) {
                return Response.json({ object: 'list', data: [{ id: 'echo', object: 'model' }] });
            }
            const body = await request.json() as ChatRequest;
            const offered = new Set((body.tools ?? []).map((tool) => tool.function.name));
            const toolResult = body.messages.find((message) => message.role === 'tool');
            const wantsTask = body.messages.some((message) => message.role === 'user' && messageText(message).includes(ADD_TASK_MARKER));
            const taskArgs = { name: 'compat task', agent: 'build', prompt: QUEUED_PROMPT };
            let frames: string[];
            if (wantsTask && !toolResult && (offered.has('supertask_add') || offered.has('execute'))) {
                const call = offered.has('supertask_add')
                    ? { name: 'supertask_add', arguments: JSON.stringify(taskArgs) }
                    : { name: 'execute', arguments: JSON.stringify({ code: `return await tools.supertask_add(${JSON.stringify(taskArgs)})` }) };
                frames = [sse({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_compat', type: 'function', function: call }] }, null), sse({}, 'tool_calls')];
            } else {
                frames = [sse({ role: 'assistant', content: `${RESULT_MARKER} ${toolResult ? messageText(toolResult) : ''}` }, null), sse({}, 'stop')];
            }
            if (body.stream === false) {
                return Response.json({ id: 'fake', object: 'chat.completion', created: 0, model: 'echo', choices: [{ index: 0, message: { role: 'assistant', content: RESULT_MARKER }, finish_reason: 'stop' }] });
            }
            return new Response(`${frames.join('')}data: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
        },
    });
}

async function waitFor<T>(label: string, probe: () => T | null | Promise<T | null>, timeoutMs = 90_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await probe();
        if (value !== null) return value;
        if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
        await Bun.sleep(250);
    }
}

function runToExit(
    executable: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ status: number | null; output: string }> {
    return new Promise((resolveRun, reject) => {
        const child = spawn(executable, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
        child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
        child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
        child.once('error', reject);
        child.once('close', (status) => {
            clearTimeout(timer);
            resolveRun({ status, output });
        });
    });
}

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

async function smoke(executable: string): Promise<void> {
    const versionOutput = spawnSync(executable, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const version = parseOpenCodeVersion(`${versionOutput.stdout}${versionOutput.stderr}`);
    assert(version, `无法识别 ${executable} 的版本`);
    console.log(`\n== OpenCode ${version.version} (${executable})`);

    const base = realpathSync(mkdtempSync(join(tmpdir(), `supertask-compat-v${version.major}-`)));
    const project = join(base, 'project');
    const configDir = join(base, 'config/opencode');
    mkdirSync(project, { recursive: true });
    mkdirSync(join(configDir, 'plugins'), { recursive: true });
    const model = startFakeModel();
    let gateway: ChildProcess | null = null;
    try {
        writeFileSync(join(configDir, 'opencode.json'), JSON.stringify({
            provider: {
                fake: {
                    npm: '@ai-sdk/openai-compatible',
                    name: 'Fake',
                    options: { baseURL: `http://127.0.0.1:${model.port}/v1`, apiKey: 'fake' },
                    models: { echo: { name: 'Echo', tool_call: true } },
                },
            },
            model: 'fake/echo',
        }, null, 2));
        writeFileSync(join(configDir, 'plugins/supertask.ts'), `export { default } from ${JSON.stringify(pluginEntry)};\n`);
        const databasePath = join(base, 'tasks.db');
        const dashboardPort = 20_000 + Math.floor(Math.random() * 20_000);
        writeFileSync(join(base, 'supertask.json'), JSON.stringify({
            worker: { pollIntervalMs: 200, taskTimeoutMs: 120_000 },
            scheduler: { enabled: false },
            dashboard: { enabled: true, port: dashboardPort },
        }));
        const env = {
            ...process.env,
            XDG_CONFIG_HOME: join(base, 'config'),
            XDG_DATA_HOME: join(base, 'data'),
            XDG_STATE_HOME: join(base, 'state'),
            XDG_CACHE_HOME: join(base, 'cache'),
            OPENCODE_CONFIG_DIR: configDir,
            SUPERTASK_DB_PATH: databasePath,
            SUPERTASK_CONFIG_PATH: join(base, 'supertask.json'),
            SUPERTASK_OPENCODE_BIN: executable,
            SUPERTASK_PM2_BIN: join(base, 'missing-pm2'),
        };

        // 1. 插件：模型调用 supertask_add，任务写入隔离数据库并使用 OpenCode 提供的项目目录。
        const runArgs = ['run', ...(version.major === 2 ? ['--standalone'] : []), '--format', 'json', '-m', 'fake/echo', '--agent', 'build', ADD_TASK_MARKER];
        // 假模型与本脚本同进程，必须异步等待子进程，不能用 spawnSync 阻塞事件循环。
        const pluginRun = await runToExit(executable, runArgs, { cwd: project, env: { ...env, PWD: project } });
        assert(pluginRun.status === 0, `插件会话失败（退出码 ${pluginRun.status}）：${pluginRun.output.slice(-800)}`);
        const database = new Database(databasePath);
        const queued = database.query('SELECT id, cwd, prompt, status FROM tasks').all() as { id: number; cwd: string; prompt: string; status: string }[];
        assert(queued.length === 1 && queued[0].prompt === QUEUED_PROMPT, `插件未创建任务：${JSON.stringify(queued)}`);
        assert(queued[0].cwd === project, `任务目录 ${queued[0].cwd} 不是项目目录 ${project}`);
        console.log(`  ✓ 插件工具已注册并写入任务 #${queued[0].id}（cwd=${queued[0].cwd}）`);

        // 2. Gateway：用构建产物的 Worker 执行该任务，并记录 Session ID 与实际命令。
        gateway = spawn(process.execPath, [gatewayEntry], { cwd: base, env, stdio: ['ignore', 'pipe', 'pipe'] });
        let gatewayLog = '';
        gateway.stdout?.on('data', (chunk: Buffer) => { gatewayLog += chunk.toString(); });
        gateway.stderr?.on('data', (chunk: Buffer) => { gatewayLog += chunk.toString(); });
        const run = await waitFor('Gateway 完成任务', () => {
            if (gateway?.exitCode !== null) throw new Error(`Gateway 提前退出：${gatewayLog.slice(-1500)}`);
            const row = database.query(`SELECT r.id, r.status, r.session_id AS sessionId, r.log, t.status AS taskStatus
                FROM task_runs r JOIN tasks t ON t.id = r.task_id WHERE t.id = ? ORDER BY r.id DESC LIMIT 1`)
                .get(queued[0].id) as { id: number; status: string; sessionId: string | null; log: string | null; taskStatus: string } | null;
            return row && ['done', 'dead_letter', 'failed'].includes(row.taskStatus) ? row : null;
        });
        assert(run.taskStatus === 'done', `任务未完成（${run.taskStatus}）：${run.log?.slice(-1500)}`);
        assert(run.log?.includes(RESULT_MARKER), '执行日志缺少模型输出标记');
        const sessionId = run.sessionId;
        assert(sessionId !== null && sessionId.startsWith('ses_'), `未捕获 Session ID：${sessionId}`);
        const standalone = run.log?.includes('"--standalone"') ?? false;
        assert(standalone === (version.major === 2), `2.x 必须且仅 2.x 使用 --standalone（实际 ${standalone}）`);
        console.log(`  ✓ Gateway 执行完成，run #${run.id}，session=${run.sessionId}`);

        // 3. Dashboard：继续会话命令回到项目目录，并复用执行时的 OpenCode。
        const response = await fetch(`http://127.0.0.1:${dashboardPort}/api/runs/${run.id}/session-command`);
        const { command } = await response.json() as { command: string };
        assert(command.startsWith(`cd ${project} && `) && command.endsWith(`--session ${run.sessionId}`), `会话命令异常：${command}`);
        assert(command.includes(executable), `会话命令未使用执行时的 OpenCode：${command}`);
        console.log(`  ✓ 继续会话命令：${command}`);

        // 4. 会话可在项目目录中继续（非交互地用 run --session 验证同一会话）。
        const resumeArgs = ['run', ...(version.major === 2 ? ['--standalone'] : []), '--format', 'json', '--session', sessionId, 'continue'];
        const resumed = await runToExit(executable, resumeArgs, { cwd: project, env: { ...env, PWD: project } });
        assert(resumed.status === 0, `继续会话失败（退出码 ${resumed.status}）：${resumed.output.slice(-800)}`);
        assert(resumed.output.includes(`"sessionID":"${run.sessionId}"`), `继续会话未复用 ${run.sessionId}`);
        console.log('  ✓ 会话可继续');
        database.close();
    } finally {
        if (gateway && gateway.exitCode === null) {
            gateway.kill('SIGTERM');
            await waitFor('Gateway 退出', () => (gateway?.exitCode !== null ? true : null), 60_000).catch(() => gateway?.kill('SIGKILL'));
        }
        model.stop(true);
        if (!process.env.SUPERTASK_COMPAT_KEEP) rmSync(base, { recursive: true, force: true });
    }
}

for (const required of [pluginEntry, gatewayEntry]) {
    if (!existsSync(required)) throw new Error(`缺少构建产物 ${required}，请先运行 bun run build`);
}
const executables = process.argv.slice(2);
for (const executable of executables.length > 0 ? executables : ['opencode']) await smoke(executable);
console.log('\nOpenCode compatibility smoke passed');
