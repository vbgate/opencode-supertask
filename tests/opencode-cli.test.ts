import { describe, expect, test } from 'bun:test';
import { buildOpenCodeRunArgs, OpenCodeInvocationError, parseOpenCodeVersion } from '../src/core/opencode-cli';

describe('OpenCode CLI 版本适配', () => {
    test('识别 1.x 裸版本号与 2.x 带前缀版本号', () => {
        expect(parseOpenCodeVersion('1.18.32\n')).toEqual({ version: '1.18.32', major: 1 });
        expect(parseOpenCodeVersion('opencode v2.0.16\n')).toEqual({ version: '2.0.16', major: 2 });
        expect(parseOpenCodeVersion('test-opencode 1.0.0')).toEqual({ version: '1.0.0', major: 1 });
        expect(parseOpenCodeVersion('opencode v3.0.0')).toBeNull();
        expect(parseOpenCodeVersion('not a version')).toBeNull();
    });

    const target = { agent: 'build', model: 'openai/gpt-5', variant: 'high', prompt: 'hi' };

    test('1.x 保持 --variant，2.x 改用私有服务端和 model#variant', () => {
        expect(buildOpenCodeRunArgs(1, target)).toEqual([
            'run', '--agent', 'build', '--format', 'json', '-m', 'openai/gpt-5', '--variant', 'high', 'hi',
        ]);
        expect(buildOpenCodeRunArgs(2, target)).toEqual([
            'run', '--standalone', '--agent', 'build', '--format', 'json', '-m', 'openai/gpt-5#high', 'hi',
        ]);
        expect(buildOpenCodeRunArgs(2, { ...target, model: null, variant: null })).toEqual([
            'run', '--standalone', '--agent', 'build', '--format', 'json', 'hi',
        ]);
    });

    test('2.x 风格的 model#variant 在两代 CLI 上都可执行', () => {
        const embedded = { ...target, model: 'openai/gpt-5#low', variant: null };
        expect(buildOpenCodeRunArgs(1, embedded)).toContain('--variant');
        expect(buildOpenCodeRunArgs(1, embedded).slice(5, 9)).toEqual(['-m', 'openai/gpt-5', '--variant', 'low']);
        expect(buildOpenCodeRunArgs(2, embedded)).toContain('openai/gpt-5#low');
        expect(() => buildOpenCodeRunArgs(2, { ...embedded, variant: 'high' })).toThrow(OpenCodeInvocationError);
    });

    test('2.x 拒绝无法表达的配置而不是静默丢弃 variant', () => {
        expect(() => buildOpenCodeRunArgs(2, { ...target, model: null })).toThrow(OpenCodeInvocationError);
        expect(() => buildOpenCodeRunArgs(2, { ...target, model: 'gpt-5', variant: null })).toThrow('provider/model');
        expect(buildOpenCodeRunArgs(1, { ...target, model: null })).toEqual([
            'run', '--agent', 'build', '--format', 'json', '--variant', 'high', 'hi',
        ]);
    });
});
