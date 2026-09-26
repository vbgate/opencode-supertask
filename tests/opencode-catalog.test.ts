import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
    clearOpenCodeCatalogCache,
    loadOpenCodeCatalog,
    parseOpenCodeAgents,
    parseOpenCodeModelMetadata,
    parseOpenCodeModels,
    parseOpenCodeV2Agents,
    parseOpenCodeV2Models,
} from '../src/core/opencode-catalog';
import { clearOpenCodeVersionCache } from '../src/core/opencode-cli';

describe('OpenCode 项目能力目录', () => {
    const temporaryDirectories: string[] = [];

    afterEach(() => {
        clearOpenCodeCatalogCache();
        clearOpenCodeVersionCache();
        for (const directory of temporaryDirectories.splice(0)) {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    test('解析模型和 Agent，并排除旧 runner', () => {
        expect(parseOpenCodeModels('openai/gpt-5\nopenai/gpt-5\nanthropic/claude\n')).toEqual([
            'anthropic/claude',
            'openai/gpt-5',
        ]);
        expect(parseOpenCodeAgents([
            'build (primary)',
            '  [{"permission":"*"}]',
            'general (subagent)',
            'supertask-runner (all)',
            'compaction (primary)',
            'title (primary)',
            'summary (primary)',
        ].join('\n'))).toEqual([
            { name: 'build', mode: 'primary' },
            { name: 'general', mode: 'subagent' },
        ]);
    });

    test('解析 verbose 模型元数据中的 variants', () => {
        expect(parseOpenCodeModelMetadata(`openai/gpt-5.6-sol
{
  "id": "gpt-5.6-sol",
  "api": { "url": "https://example.test/v1" },
  "variants": { "xhigh": {}, "high": {}, "none": {} }
}
local/plain
{
  "id": "plain",
  "variants": {}
}
`)).toEqual({
            models: ['local/plain', 'openai/gpt-5.6-sol'],
            variantsByModel: {
                'local/plain': [],
                'openai/gpt-5.6-sol': ['high', 'none', 'xhigh'],
            },
        });
    });

    test('解析 OpenCode 2.x API 目录：数组 variants、hidden Agent', () => {
        expect(parseOpenCodeV2Models(JSON.stringify({
            location: { directory: '/tmp' },
            data: [
                { providerID: 'openai', id: 'gpt-5', variants: [{ id: 'high' }, { id: 'low' }, { id: 'high' }] },
                { providerID: 'local', id: 'plain' },
            ],
        }))).toEqual({
            models: ['local/plain', 'openai/gpt-5'],
            variantsByModel: { 'openai/gpt-5': ['high', 'low'] },
        });
        expect(parseOpenCodeV2Agents(JSON.stringify({
            data: [
                { id: 'build', mode: 'primary', hidden: false },
                { id: 'title', mode: 'primary', hidden: true },
                { id: 'docs', mode: 'all' },
                { id: 'explore', mode: 'subagent' },
                { id: 'supertask-runner', mode: 'all' },
            ],
        }))).toEqual([
            { name: 'build', mode: 'primary' },
            { name: 'docs', mode: 'all' },
            { name: 'explore', mode: 'subagent' },
        ]);
    });

    test('OpenCode 2.x 惰性加载首个空列表、截断 JSON 与瞬时非零退出时有界重试', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'supertask-catalog-v2-'));
        temporaryDirectories.push(directory);
        const executable = join(directory, 'fake-opencode');
        const counter = join(directory, 'calls');
        writeFileSync(executable, `#!/bin/sh
[ "$1" = "--version" ] && { echo "opencode v2.0.16"; exit 0; }
echo x >> ${JSON.stringify(counter)}
calls=$(wc -l < ${JSON.stringify(counter)} | tr -d ' ')
if [ "$1 $2" = "api model.list" ]; then
  if [ ! -f ${JSON.stringify(join(directory, 'models-once'))} ]; then touch ${JSON.stringify(join(directory, 'models-once'))}; printf '{"data":[{"providerID":"openai","id":"gp'; exit 0; fi
  printf '{"data":[{"providerID":"openai","id":"gpt-5","variants":[{"id":"high"}]}]}'
elif [ "$1 $2" = "api agent.list" ]; then
  if [ ! -f ${JSON.stringify(join(directory, 'agents-exit'))} ]; then touch ${JSON.stringify(join(directory, 'agents-exit'))}; printf 'service restarting' >&2; exit 1; fi
  if [ ! -f ${JSON.stringify(join(directory, 'agents-once'))} ]; then touch ${JSON.stringify(join(directory, 'agents-once'))}; printf '{"data":[]}'; exit 0; fi
  printf '{"data":[{"id":"build","mode":"primary"},{"id":"explore","mode":"subagent"}]}'
else
  exit 2
fi
`, { mode: 0o755 });
        chmodSync(executable, 0o755);

        await expect(loadOpenCodeCatalog(directory, { executable, useCache: false })).resolves.toEqual({
            cwd: directory,
            models: ['openai/gpt-5'],
            variantsByModel: { 'openai/gpt-5': ['high'] },
            agents: [{ name: 'build', mode: 'primary' }],
        });
    });

    test('在所选项目目录调用真实命令形态', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'supertask-catalog-'));
        temporaryDirectories.push(directory);
        const executable = join(directory, 'fake-opencode');
        writeFileSync(executable, `#!/bin/sh
[ "$1" = "--version" ] && { echo 1.18.32; exit 0; }
if [ "$1" = "models" ] && [ "$2" = "--verbose" ]; then
  printf 'local/model-a\\n{\\n  "variants": { "fast": {}, "slow": {} }\\n}\\nlocal/model-b\\n{\\n  "variants": {}\\n}\\n'
elif [ "$1" = "agent" ] && [ "$2" = "list" ]; then
  printf 'custom (primary)\\n  []\\nhelper (subagent)\\n  []\\n'
else
  exit 2
fi
`, { mode: 0o755 });
        chmodSync(executable, 0o755);

        await expect(loadOpenCodeCatalog(directory, {
            executable,
            useCache: false,
        })).resolves.toEqual({
            cwd: directory,
            models: ['local/model-a', 'local/model-b'],
            variantsByModel: {
                'local/model-a': ['fast', 'slow'],
                'local/model-b': [],
            },
            agents: [
                { name: 'custom', mode: 'primary' },
            ],
        });
    });

    test('verbose 不可用时退回普通模型目录', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'supertask-catalog-fallback-'));
        temporaryDirectories.push(directory);
        const executable = join(directory, 'fake-opencode');
        writeFileSync(executable, `#!/bin/sh
[ "$1" = "--version" ] && { echo 1.18.32; exit 0; }
if [ "$1" = "models" ] && [ "$2" = "--verbose" ]; then
  exit 2
elif [ "$1" = "models" ]; then
  printf 'local/fallback\\n'
elif [ "$1" = "agent" ] && [ "$2" = "list" ]; then
  printf 'build (primary)\\n  []\\n'
else
  exit 2
fi
`, { mode: 0o755 });
        chmodSync(executable, 0o755);

        await expect(loadOpenCodeCatalog(directory, {
            executable,
            useCache: false,
        })).resolves.toEqual({
            cwd: directory,
            models: ['local/fallback'],
            variantsByModel: {},
            agents: [{ name: 'build', mode: 'primary' }],
        });
    });

    test('忽略 SIGTERM 的目录命令仍在超时后有界返回', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'supertask-catalog-timeout-'));
        temporaryDirectories.push(directory);
        const executable = join(directory, 'fake-opencode');
        const descendantPidFile = join(directory, 'descendant.pid');
        writeFileSync(executable, `#!/bin/sh
[ "$1" = "--version" ] && { echo 1.18.32; exit 0; }
[ "$1" = "--warmup" ] && exit 0
if [ "$1" = "agent" ]; then
  printf 'build (primary)\\n  []\\n'
  exit 0
fi
trap 'exit 0' TERM
sh -c 'trap "" TERM; while true; do sleep 1; done' </dev/null >/dev/null 2>&1 &
printf '%s' "$!" > ${JSON.stringify(descendantPidFile)}
while true; do sleep 1; done
`, { mode: 0o755 });
        chmodSync(executable, 0o755);
        // macOS scans a new executable on first exec; keep that cost out of the 50ms budget.
        Bun.spawnSync([executable, '--warmup']);
        const startedAt = Date.now();

        await expect(loadOpenCodeCatalog(directory, {
            executable,
            timeoutMs: 50,
            useCache: false,
        })).rejects.toThrow('超过 50ms');
        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_000);
        expect(Date.now() - startedAt).toBeLessThan(1_500);
        const descendantPid = Number(readFileSync(descendantPidFile, 'utf8'));
        await Bun.sleep(50);
        expect(() => process.kill(descendantPid, 0)).toThrow();
    });

    test('目录非法时不会启动 OpenCode', async () => {
        await expect(loadOpenCodeCatalog(join(process.cwd(), 'package.json'), {
            executable: '/definitely/not/opencode',
            useCache: false,
        })).rejects.toThrow('不是目录');
    });
});
