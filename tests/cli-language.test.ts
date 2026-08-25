import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { resolveCliLocale } from '../src/cli/i18n';

function help(args: string[], env: NodeJS.ProcessEnv = process.env) {
    return spawnSync('bun', ['run', 'src/cli/index.ts', ...args], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...env },
    });
}

describe('CLI 语言', () => {
    test('auto 根据系统 locale 选择语言，显式参数优先于环境变量', () => {
        expect(resolveCliLocale(['bun', 'cli'], { LANG: 'zh_CN.UTF-8' })).toBe('zh-CN');
        expect(resolveCliLocale(['bun', 'cli'], { LANG: 'es_ES.UTF-8' })).toBe('es');
        expect(resolveCliLocale(['bun', 'cli'], { LANG: 'C.UTF-8' })).toBe('en');
        expect(resolveCliLocale(['bun', 'cli', '--lang', 'en'], {
            SUPERTASK_LANG: 'zh-CN',
            LANG: 'zh_CN.UTF-8',
        })).toBe('en');
        expect(resolveCliLocale(['bun', 'cli', '--lang', 'es'], {
            SUPERTASK_LANG: 'en',
            LANG: 'en_US.UTF-8',
        })).toBe('es');
    });

    test('中英文帮助可显式切换，--lang 放在子命令后也生效', () => {
        const english = help(['--lang', 'en', '--help']);
        expect(english.status).toBe(0);
        expect(english.stdout).toContain('Durable task queue and scheduler');
        expect(english.stdout).toContain('create a queued task');

        const chinese = help(['add', '--lang', 'zh-CN', '--help']);
        expect(chinese.status).toBe(0);
        expect(chinese.stdout).toContain('创建新任务');
        expect(chinese.stdout).toContain('主 Agent 名称');
        expect(chinese.stdout).toContain('选项：');

        const spanish = help(['--lang', 'es', '--help']);
        expect(spanish.status).toBe(0);
        expect(spanish.stdout).toContain('Cola de tareas durable y programador');
        expect(spanish.stdout).toContain('crear una tarea en cola');
    });

    test('拒绝未知语言值', () => {
        const result = help(['--lang', 'fr', '--help']);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('Allowed choices');
    });
});
