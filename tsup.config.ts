import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'cli/index': 'src/cli/index.ts',
    'gateway/index': 'src/gateway/index.ts',
    'web/index': 'src/web/index.tsx',
    'plugin/supertask': 'plugin/supertask.ts',
    'worker/index': 'src/worker/index.ts',
  },
  outDir: 'dist',
  format: ['esm'],
  target: 'esnext',
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: {
    resolve: true,
  },
  banner: {
    js: '#!/usr/bin/env bun\n',
  },
  external: [
    'bun:sqlite',
    'bun:test',
  ],
  noExternal: [
    '@opencode-ai/plugin',
    'commander',
    'cron-parser',
    'drizzle-orm',
    'glob',
    'hono',
  ],
  alias: {
    '@core': './src/core',
    '@worker': './src/worker',
    '@web': './src/web',
    '@plugin': './plugin',
    '@gateway': './src/gateway',
  },
});
