import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('npm 发布通道', () => {
    test('预发布版本进入 next，稳定版本进入 latest', () => {
        const workflow = readFileSync(join(process.cwd(), '.github/workflows/publish.yml'), 'utf8');
        expect(workflow).toContain('"${PACKAGE_VERSION#v}" == *-*');
        expect(workflow).toContain('npm publish --access public --tag next');
        expect(workflow).toContain('npm publish --access public --tag latest');
        expect(workflow).not.toMatch(/run:\s+npm publish --access public\s*$/m);
    });

    test('CI 和发布前都验证最低 Bun 版本的 launcher IPC', () => {
        const ci = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
        const publish = readFileSync(join(process.cwd(), '.github/workflows/publish.yml'), 'utf8');
        const packageJson = JSON.parse(
            readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
        ) as { engines?: { bun?: string } };

        for (const workflow of [ci, publish]) {
            expect(workflow).toContain('bun-version: 1.1.45');
            expect(workflow).toContain(
                'bun scripts/launcher-ipc-smoke.ts dist/worker/launcher.js',
            );
        }
        expect(packageJson.engines?.bun).toBe('>=1.1.45');
    });
});
