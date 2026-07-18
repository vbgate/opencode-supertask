import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
    clearOpenCodeCatalogCache,
    loadOpenCodeCatalog,
    parseOpenCodeAgents,
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

    test('在所选项目目录调用真实命令形态', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'supertask-catalog-'));
        temporaryDirectories.push(directory);
        const executable = join(directory, 'fake-opencode');
        writeFileSync(executable, `#!/bin/sh
if [ "$1" = "models" ]; then
  printf 'local/model-a\\nlocal/model-b\\n'
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
            agents: [
                { name: 'custom', mode: 'primary' },
            ],
        });
    });

    test('目录非法时不会启动 OpenCode', async () => {
        await expect(loadOpenCodeCatalog(join(process.cwd(), 'package.json'), {
            executable: '/definitely/not/opencode',
            useCache: false,
        })).rejects.toThrow('不是目录');
    });
});
