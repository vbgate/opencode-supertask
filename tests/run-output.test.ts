import { describe, expect, test } from 'bun:test';
import { RunOutput } from '../src/worker/run-output';

function collect(maxChars = 1_000) {
    const sessions: string[] = [];
    const output = new RunOutput(maxChars, (id) => sessions.push(id));
    return { output, sessions };
}

describe('RunOutput', () => {
    test('跨 chunk 拼接 JSON 行，并锁定首个顶层 sessionID', () => {
        const { output, sessions } = collect();
        output.push('stdout', '{"type":"step_start","sessi');
        output.push('stdout', 'onID":"ses_main1"}\n{"type":"tool_use","sessionID":"ses_main1",');
        output.push('stdout', '"part":{"state":{"metadata":{"sessionId":"ses_child9"}}}}\n');
        output.push('stdout', '{"type":"text","sessionID":"ses_other2"}\n');

        expect(sessions).toEqual(['ses_main1']);
    });

    test('嵌套或工具输出中的 sessionID 不会被当作本次会话', () => {
        const { output, sessions } = collect();
        output.push('stdout', '{"type":"tool_use","part":{"sessionID":"ses_child1"}}\n');
        output.push('stdout', 'plain text mentioning "sessionID":"ses_fake"\n');
        output.push('stderr', '{"sessionID":"ses_stderr"}\n');
        expect(sessions).toEqual([]);

        output.push('stdout', '{"type":"step_start","sessionId":"ses_main2"}\n');
        expect(sessions).toEqual(['ses_main2']);
    });

    test('stderr chunk 不会插进 stdout 的 JSON 行中间', () => {
        const { output } = collect();
        output.push('stdout', '{"type":"text","part":{"text":"he');
        output.push('stderr', 'warning: slow provider\n');
        output.push('stdout', 'llo"}}\n');
        output.flush();

        const lines = output.text().trim().split('\n');
        expect(lines).toEqual(['warning: slow provider', '{"type":"text","part":{"text":"hello"}}']);
    });

    test('只保留有界尾部，并在结束时输出未换行的残余内容', () => {
        const { output } = collect(20);
        output.push('stdout', 'aaaaaaaaaa\nbbbbbbbbbb\ncccc');
        output.flush();
        expect(output.text().length).toBeLessThanOrEqual(20);
        expect(output.text().endsWith('cccc\n')).toBe(true);
    });

    test('超长未换行内容不会无界累积', () => {
        const { output } = collect(16);
        output.push('stdout', 'x'.repeat(100));
        output.push('stdout', 'y'.repeat(100));
        expect(output.text().length).toBeLessThanOrEqual(16);
    });
});
