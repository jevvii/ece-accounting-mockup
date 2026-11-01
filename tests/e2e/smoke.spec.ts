import { expect, test } from '@playwright/test';

test('smoke: application renders the Main launcher without console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });

  await page.goto('/#/home');
  await expect(page.getByText('Local demo · Synthetic data').first()).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Main');
  await expect(page.locator('.app-tile')).toHaveCount(9);
  await expect(page.locator('.apps-menu')).toHaveCount(1);
  await expect(page.locator('.demo-controls')).toHaveCount(1);
  await page.screenshot({ path: 'artifacts/screenshots/smoke-home.png', fullPage: true });

  await page.getByRole('link', { name: /Billing and Collection/ }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Billing and Collection');
  await expect(page).toHaveURL(/#\/billing\/invoices$/);
  await page.screenshot({ path: 'artifacts/screenshots/smoke-billing.png', fullPage: true });
  expect(errors).toEqual([]);
});
