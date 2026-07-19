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
