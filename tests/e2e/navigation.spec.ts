import { expect, test } from '@playwright/test';
import {
  COMPANY,
  openDestination,
  openTab,
  resetDemo,
  shot,
  trackErrors,
  useActor,
} from './helpers';

const DESTINATIONS = [
  ['Cash Management', '#/cash/statements', 'Bank statements'],
  ['Billing and Collection', '#/billing/invoices', 'Invoices'],
  ['Purchases and Disbursement', '#/purchases/bills', 'Bills'],
  ['Fixed Assets', '#/assets/register', 'Asset register'],
  ['Admin', '#/admin/company', 'Company'],
  ['Reports', '#/reports/trial-balance', 'Trial balance'],
  ['Payroll', '#/payroll/runs', 'Payroll runs'],
  ['Inventory', '#/inventory/items', 'Items'],
  ['Other', '#/other/journals', 'Journals'],
] as const;

test('Main is the real default home with one entry per app', async ({ page }) => {
  await resetDemo(page);
  await page.goto('/#/home');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Main');
  await expect(page.locator('.app-tile')).toHaveCount(9);
  await expect(page.getByRole('link', { name: /Billing and Collection/ })).toBeVisible();
  await expect(page.locator('.demo-controls summary')).toHaveText('Demo controls');
});

test('all nine destinations open as deep links and survive reload', async ({ page }) => {
  const errors = trackErrors(page);
  await resetDemo(page);

  for (const [label, hash, pageLabel] of DESTINATIONS) {
    await openDestination(page, label);
    await expect(page).toHaveURL(new RegExp(`${hash}$`));
    await expect(page).toHaveTitle(new RegExp(`${pageLabel} · .* · ECE Accounting$`));
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(label);
    const nav = page.getByRole('navigation', { name: `${label} pages` });
    await expect(nav.getByRole('link', { name: pageLabel, exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
  }

  await openDestination(page, 'Reports');
  await expect(page.getByText('Balanced').first()).toBeVisible();
  await shot(page, 'reports-trial-balance');

  await openDestination(page, 'Billing and Collection');
  await expect(page.getByText('Sales invoices').first()).toBeVisible();
  errors.assertClean();
});

test('company switching follows demo memberships and never exposes another company', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await resetDemo(page);

  // Rosa has no Company B membership, so the selector only offers Northwind for her.
  await expect(page.getByLabel('Active demo company')).toHaveValue(COMPANY.a);
  await expect(page.getByLabel('Active demo company').getByRole('option')).toHaveCount(1);

  // Mila belongs to Company B; selecting her moves the active company with the membership.
  await useActor(page, 'u-badmin');
  await expect(page.getByLabel('Active demo company')).toHaveValue(COMPANY.b);
  await expect(page.getByText('Bayanihan Trading Demo Co.')).toBeVisible();
  await expect(page.getByText(/Local demo · Synthetic data/i).first()).toBeVisible();

  // Returning to a Company A actor returns the selector to Company A.
  await useActor(page, 'u-accountant');
  await expect(page.getByLabel('Active demo company')).toHaveValue(COMPANY.a);
  await expect(page.getByText('Northwind Services Demo Co.')).toBeVisible();
  await expect(page.getByText('Bayanihan Trading Demo Co.')).toHaveCount(0);
  errors.assertClean();
});

test('Back and Forward restore the exact page and record context', async ({ page }) => {
  const errors = trackErrors(page);
  await resetDemo(page);
  await openDestination(page, 'Inventory');
  await page.locator('tbody tr').first().getByRole('button', { name: 'View details' }).click();
  const recordHash = new URL(page.url()).hash;
  expect(recordHash).toMatch(/^#\/inventory\/items\/[^/]+$/);

  await page.goBack();
  await expect(page).toHaveURL(/#\/inventory\/items$/);
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`${recordHash}$`));
  await expect(page.getByRole('dialog')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page).toHaveURL(/#\/inventory\/items$/);

  await openTab(page, 'Valuation');
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Inventory');
  await expect(
    page.getByRole('navigation', { name: 'Inventory pages' }).getByRole('link', {
      name: 'Valuation',
      exact: true,
    }),
  ).toHaveAttribute('aria-current', 'page');

  await page.goBack();
  await expect(page).toHaveURL(/#\/inventory\/items$/);
  await page.goForward();
  await expect(page).toHaveURL(/#\/inventory\/valuation$/);
  errors.assertClean();
});

test('corrupt browser storage is reported without silently resetting', async ({ page }) => {
  const errors = trackErrors(page);
  await resetDemo(page);
  await page.evaluate(() =>
    window.localStorage.setItem('fin-axis-mockup:app-state:v1', '{"schemaVersion":1,'),
  );
  await page.reload();
  await expect(page.getByRole('heading', { name: /saved demo data could not be opened/i })).toBeVisible();
  await expect(page.getByLabel('Raw stored snapshot preview')).toBeVisible();
  await expect(page.getByText(/Nothing has been replaced/)).toBeVisible();
  await shot(page, 'recovery-corrupt-storage');

  await page.getByRole('button', { name: 'Reset synthetic demo' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Reset demo data' })).toBeDisabled();
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Reset demo data' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Billing and Collection');
  errors.assertClean();
});

test('narrow viewport keeps navigation and tables usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await resetDemo(page);
  await openDestination(page, 'Inventory');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Inventory');
  await expect(page.locator('.table-wrap').first()).toBeVisible();
  await shot(page, 'inventory-narrow-390');
});

test('Main states entitlement and role availability without pretending access', async ({ page }) => {
  const errors = trackErrors(page);
  await resetDemo(page);
  await useActor(page, 'u-bpayroll');
  await page.goto('/#/home');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Main');
  const billing = page.getByRole('link', { name: /^Billing and Collection\./ });
  await expect(billing).toContainText('Not licensed');
  const payroll = page.getByRole('link', { name: /^Payroll\./ });
  await expect(payroll).toContainText('Available');
  await billing.click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Billing and Collection');
  await expect(page.getByRole('status').filter({ hasText: /not licensed/i })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Return to Main' })).toBeVisible();
  await page.getByRole('link', { name: 'Return to Main' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Main');
  errors.assertClean();
});

test('Main and app pages remain usable at a 390px phone width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await resetDemo(page);
  await page.goto('/#/home');
  await expect(page.locator('.app-tile')).toHaveCount(9);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
  await shot(page, 'remediation-main-390');
  await openDestination(page, 'Payroll');
  await expect(page.getByRole('navigation', { name: 'Payroll pages' })).toBeVisible();
  await shot(page, 'remediation-payroll-390');
});
