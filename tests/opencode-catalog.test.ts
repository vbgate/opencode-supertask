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
} from '../src/core/opencode-catalog';

describe('OpenCode 项目能力目录', () => {
    const temporaryDirectories: string[] = [];

    afterEach(() => {
        clearOpenCodeCatalogCache();
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

    test('在所选项目目录调用真实命令形态', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'supertask-catalog-'));
        temporaryDirectories.push(directory);
        const executable = join(directory, 'fake-opencode');
        writeFileSync(executable, `#!/bin/sh
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
