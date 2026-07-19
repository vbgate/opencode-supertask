import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('npm 发布通道', () => {
    test('预发布版本进入 next，稳定版本进入 latest', () => {
        const workflow = readFileSync(join(process.cwd(), '.github/workflows/publish.yml'), 'utf8');
        expect(workflow).toContain('"${PACKAGE_VERSION#v}" == *-*');
        expect(workflow).toContain('npm publish --access public --tag next "$PACKAGE_ARCHIVE"');
        expect(workflow).toContain('npm publish --access public --tag latest "$PACKAGE_ARCHIVE"');
        expect(workflow).toContain('bun scripts/package-install-smoke.ts "$archive_path"');
        expect(workflow).toContain('echo "PACKAGE_ARCHIVE=$archive_path" >> "$GITHUB_ENV"');
        expect(workflow).not.toMatch(/run:\s+npm publish --access public\s*$/m);
    });

    test('CI 和发布前执行完整质量门禁及最低 Bun 代表性验证', () => {
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
            expect(workflow).toContain('bun run test:coverage');
            expect(workflow).toContain('bun run typecheck:tests');
            expect(workflow).toContain('bun run lint');
            expect(workflow).toContain('bun run package:smoke');
            expect(workflow).toContain('bun run test:browser');
            expect(workflow).toContain('tests/package-e2e.test.ts');
        }
        expect(ci).toContain('runs-on: macos-latest');
        expect(publish).toContain('needs: macos-verify');
        expect(publish).toContain('Rebuild and verify publish artifact');
        expect(packageJson.engines?.bun).toBe('>=1.1.45');
    });
});
