import { defineConfig, type Options } from 'tsup';

const shared: Options & { alias: Record<string, string> } = {
  outDir: 'dist',
  format: ['esm'],
  target: 'esnext',
  splitting: false,
  sourcemap: true,
  clean: true,
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
    '@daemon': './src/daemon',
  },
};

export default defineConfig([
  {
    ...shared,
    entry: { 'cli/index': 'src/cli/index.ts' },
    banner: { js: '#!/usr/bin/env bun\n' },
    dts: { resolve: true },
  },
  {
    ...shared,
    entry: {
      'gateway/index': 'src/gateway/index.ts',
      'web/index': 'src/web/index.tsx',
      'plugin/supertask': 'plugin/supertask.ts',
      'worker/index': 'src/worker/index.ts',
      'worker/launcher': 'src/worker/launcher.ts',
      'daemon/gateway-diagnostic-runner': 'src/daemon/gateway-diagnostic-runner.ts',
      'daemon/pm2-supervisor': 'src/daemon/pm2-supervisor.ts',
    },
    dts: { resolve: true },
  },
]);
