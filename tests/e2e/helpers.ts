import { expect, type Page } from '@playwright/test';

export const ACTOR = {
  accountant: 'u-accountant',
  maker: 'u-maker',
  checker: 'u-checker',
  payroll: 'u-payroll',
  inventory: 'u-inventory',
  owner: 'u-owner',
  bAdmin: 'u-badmin',
  bPayroll: 'u-bpayroll',
  bInventory: 'u-binv',
} as const;

export const COMPANY = { a: 'ws-a', b: 'ws-b' } as const;

export interface ErrorCollector {
  errors: string[];
  assertClean: () => void;
}

/** Record page errors and console errors for the whole test. */
export function trackErrors(page: Page): ErrorCollector {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  return {
    errors,
    assertClean: () => expect(errors, 'unexpected browser errors').toEqual([]),
  };
}

/** Clear the browser snapshot and reload the synthetic seed fixture. */
export async function resetDemo(page: Page): Promise<void> {
  await page.goto('/#/billing/invoices');
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
  await expect(page.getByText(/Local demo · Synthetic data/i).first()).toBeVisible();
  await expect(page.locator('main h1').first()).toHaveText('Billing and Collection');
}

/** Open the disclosure that holds company, actor and demo-session controls. */
export async function openDemoControls(page: Page): Promise<void> {
  const details = page.locator('.demo-controls');
  const open = await details.evaluate((element) => element.hasAttribute('open'));
  if (!open) await details.locator('summary').click();
  await expect(page.getByLabel('Demo actor')).toBeVisible();
}

export async function useActor(page: Page, actorId: string): Promise<void> {
  await openDemoControls(page);
  await page.getByLabel('Demo actor').selectOption(actorId);
}

export async function useCompany(page: Page, workspaceId: string): Promise<void> {
  await openDemoControls(page);
  await page.getByLabel('Active demo company').selectOption(workspaceId);
}

/** Open an app from the compact All apps switcher, not a permanent module strip. */
export async function openDestination(page: Page, label: string): Promise<void> {
  const menu = page.locator('.apps-menu');
  const open = await menu.evaluate((element) => element.hasAttribute('open'));
  if (!open) await menu.locator('summary').click();
  await page.getByRole('navigation', { name: 'All apps' }).getByRole('link', { name: label, exact: true }).click();
  await expect(page.locator('main h1').first()).toHaveText(label);
}

/** Open a task-local page through its real anchor and aria-current state. */
export async function openTab(page: Page, name: string): Promise<void> {
  const nav = page.getByRole('navigation', { name: / pages$/ });
  await nav.getByRole('link', { name, exact: true }).click();
  await expect(nav.getByRole('link', { name, exact: true })).toHaveAttribute('aria-current', 'page');
}

export function dialog(page: Page) {
  return page.getByRole('dialog');
}

/** Wait for the toast with the given text and return its locator. */
export async function expectToast(page: Page, text: string | RegExp) {
  const toast = page.locator('.toast').filter({ hasText: text });
  await expect(toast.first()).toBeVisible();
  return toast.first();
}

export async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `artifacts/screenshots/${name}.png`, fullPage: true });
}
