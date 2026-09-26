import { expect, test } from '@playwright/test';

test('Dashboard 核心客户端交互可在真实浏览器执行', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByText('Task queue', { exact: true }).first()).toBeVisible();

    await page.locator('#theme-select').selectOption('dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await page.evaluate(() => localStorage.getItem('supertask-theme'))).toBe('dark');

    await page.getByRole('button', { name: '中', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await expect(page.getByText('任务队列', { exact: true }).first()).toBeVisible();

    const createTaskButton = page.locator('button[onclick="openTaskCreator()"]');
    await createTaskButton.click();
    await expect(page.locator('#task-dialog')).toBeVisible();
    await expect(page.locator('#task-name')).toBeFocused();

    expect(pageErrors).toEqual([]);
});

const SEEDED_SESSION_COMMAND = "cd '/tmp/browser project' && /opt/opencode-v1/opencode --session ses_browserSeed1";

test('继续会话命令在异步读取后仍写入剪贴板', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/');
    await page.locator('button[onclick^="copySessionCommand("]').first().click();
    await expect(page.locator('#toast-region .toast.ok')).toBeVisible();
    expect(await page.evaluate('navigator.clipboard.readText()')).toBe(SEEDED_SESSION_COMMAND);
});

test('剪贴板被拒绝时回退到手动复制对话框', async ({ page }) => {
    await page.addInitScript(`
        const denied = () => Promise.reject(new DOMException('Write permission denied.', 'NotAllowedError'));
        Object.defineProperty(navigator, 'clipboard', { value: { write: denied, writeText: denied } });
        document.execCommand = () => false;
    `);
    await page.goto('/');
    await page.locator('button[onclick^="copySessionCommand("]').first().click();
    await expect(page.locator('#copy-dialog')).toBeVisible();
    await expect(page.locator('#copy-manual')).toHaveValue(SEEDED_SESSION_COMMAND);
    await expect(page.locator('#copy-manual')).toBeFocused();
});

test('系统设置可保存单位换算后为小数的合法配置', async ({ page }) => {
    await page.goto('/system');
    await expect(page.locator('#to')).toHaveValue('1.5');
    await expect(page.locator('#wcl')).toHaveValue('0.5');
    const saved = page.waitForRequest((request) => request.url().endsWith('/api/config') && request.method() === 'PUT');
    await page.locator('#config-form button[type="submit"]').first().click();
    const body = (await saved).postDataJSON() as { worker: { taskTimeoutMs: number }; watchdog: { cleanupIntervalMs: number } };
    expect(body.worker.taskTimeoutMs).toBe(90_000);
    expect(body.watchdog.cleanupIntervalMs).toBe(1_800_000);
    await expect(page.locator('#toast-region .toast.ok')).toBeVisible();
});

test('编辑非整 0.1 秒时长的任务可以直接保存', async ({ page }) => {
    await page.goto('/');
    const row = page.locator('tr', { hasText: 'Odd durations' });
    await row.locator('button[onclick^="openTaskEditor("]').click();
    await expect(page.locator('#task-dialog')).toBeVisible();
    const saved = page.waitForResponse((response) => /\/api\/tasks\/\d+$/.test(response.url()) && response.request().method() === 'PUT');
    await page.locator('#task-dialog button[type="submit"]').click();
    const response = await saved;
    expect(response.status()).toBe(200);
    expect(JSON.parse(response.request().postData() ?? '{}')).toMatchObject({
        agent: 'build', retryBackoff: '12.345s', timeout: '1.25s',
    });
});
