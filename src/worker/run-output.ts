const SESSION_ID_PATTERN = /^ses_[A-Za-z0-9_]+$/;

type OutputStream = 'stdout' | 'stderr';

/**
 * Collects a bounded, line-coherent tail of OpenCode output.
 * stdout and stderr are buffered per stream so a chunk from one stream
 * never lands inside a JSON line of the other, and the session ID is
 * taken from the first top-level stdout event only: later events may
 * echo child/subagent session IDs inside tool output.
 */
export class RunOutput {
    private tail = '';
    private readonly partial: Record<OutputStream, string> = { stdout: '', stderr: '' };
    private sessionId: string | null = null;

    constructor(
        private readonly maxChars: number,
        private readonly onSessionId: (sessionId: string) => void,
    ) {}

    push(stream: OutputStream, chunk: string): void {
        const lines = (this.partial[stream] + chunk).split('\n');
        let rest = lines.pop() ?? '';
        if (rest.length > this.maxChars) {
            lines.push(rest);
            rest = '';
        }
        this.partial[stream] = rest;
        for (const line of lines) this.appendLine(stream, line);
    }

    flush(): void {
        for (const stream of ['stdout', 'stderr'] as const) {
            const rest = this.partial[stream];
            this.partial[stream] = '';
            if (rest) this.appendLine(stream, rest);
        }
    }

    text(): string {
        return this.tail;
    }

    private appendLine(stream: OutputStream, line: string): void {
        const clean = line.endsWith('\r') ? line.slice(0, -1) : line;
        this.tail = `${this.tail}${clean}\n`.slice(-this.maxChars);
        if (stream === 'stdout' && this.sessionId === null) this.detectSessionId(clean);
    }

    private detectSessionId(line: string): void {
        if (!line.startsWith('{') || !line.includes('ses_')) return;
        let event: unknown;
        try {
            event = JSON.parse(line);
        } catch {
            return;
        }
        const sessionId = topLevelSessionId(event);
        if (!sessionId) return;
        this.sessionId = sessionId;
        this.onSessionId(sessionId);
    }
}

export function topLevelSessionId(event: unknown): string | null {
    if (event === null || typeof event !== 'object' || Array.isArray(event)) return null;
    const record = event as Record<string, unknown>;
    const value = record.sessionID ?? record.sessionId;
    return typeof value === 'string' && SESSION_ID_PATTERN.test(value) ? value : null;
}
