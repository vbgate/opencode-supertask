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
});
