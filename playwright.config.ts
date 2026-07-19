import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: './tests/browser',
    testMatch: '*.browser.ts',
    timeout: 30_000,
    retries: 0,
    use: {
        baseURL: 'http://127.0.0.1:4780',
        browserName: 'chromium',
        headless: true,
    },
    webServer: {
        command: 'bun tests/browser/server.ts',
        url: 'http://127.0.0.1:4780/',
        reuseExistingServer: false,
        timeout: 30_000,
    },
});
