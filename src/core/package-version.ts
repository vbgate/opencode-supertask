import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

export function getPackageVersion(): string {
    let directory = dirname(fileURLToPath(import.meta.url));
    for (let depth = 0; depth < 5; depth += 1) {
        const packagePath = join(directory, 'package.json');
        if (existsSync(packagePath)) {
            try {
                const pkg = JSON.parse(readFileSync(packagePath, 'utf8')) as { version?: unknown };
                if (typeof pkg.version === 'string') return pkg.version;
            } catch {
                return '0.0.0';
            }
        }
        directory = dirname(directory);
    }
    return '0.0.0';
}
