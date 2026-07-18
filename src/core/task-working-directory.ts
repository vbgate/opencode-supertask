import { statSync } from 'fs';
import { isAbsolute } from 'path';

export class InvalidTaskWorkingDirectoryError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'InvalidTaskWorkingDirectoryError';
    }
}

export function validateTaskWorkingDirectory(cwd: string | null | undefined): void {
    if (cwd == null) return;
    if (!cwd.trim()) {
        throw new InvalidTaskWorkingDirectoryError('任务工作目录不能为空');
    }
    if (!isAbsolute(cwd)) {
        throw new InvalidTaskWorkingDirectoryError(`任务工作目录必须是绝对路径：${cwd}`);
    }

    let stat: ReturnType<typeof statSync>;
    try {
        stat = statSync(cwd);
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new InvalidTaskWorkingDirectoryError(`任务工作目录不存在或无法访问：${cwd}（${detail}）`);
    }
    if (!stat.isDirectory()) {
        throw new InvalidTaskWorkingDirectoryError(`任务工作目录不是目录：${cwd}`);
    }
}
