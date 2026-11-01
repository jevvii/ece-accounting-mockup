import { promises as fs } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  ACTOR,
  COMPANY,
  dialog,
  expectToast,
  openDestination,
  openTab,
  resetDemo,
  shot,
  trackErrors,
  useActor,
  useCompany,
} from './helpers';

const ARCHIVE_PATH = path.resolve('artifacts/company-a-archive.json');

test('an expired payroll entitlement stays readable but blocks writes', async ({ page }) => {
  const errors = trackErrors(page);
  await resetDemo(page);
  await useActor(page, ACTOR.bAdmin);
  await openDestination(page, 'Admin');
  await openTab(page, 'Entitlements');

  const payrollRow = page.getByRole('row', { name: /^Payroll/ });
  await expect(payrollRow).toContainText('active');
  await payrollRow.getByRole('button', { name: 'Change' }).click();
  const entitlementDialog = dialog(page);
  await entitlementDialog.getByLabel('Expires on (blank for no expiry)').fill('2026-10-01');
  await entitlementDialog.getByRole('button', { name: 'Save entitlement' }).click();
  await expect(entitlementDialog).toBeHidden();
  await expectToast(page, /payroll entitlement/);
  await expect(payrollRow).toContainText('expired');

  await useActor(page, ACTOR.bPayroll);
  await openDestination(page, 'Payroll');
  await expect(page.getByText('Payroll is expired.', { exact: false })).toBeVisible();
  await openTab(page, 'Time import');
  await expect(page.getByRole('button', { name: 'Import time CSV' })).toBeDisabled();
  await shot(page, 'payroll-expired-read-only');
  errors.assertClean();
});

test('full-company archive export, checksum verification and authorized restore', async ({ page }) => {
  const errors = trackErrors(page);
  await resetDemo(page);
  await useActor(page, ACTOR.owner);
  await openDestination(page, 'Admin');
  await openTab(page, 'Archive and recovery');

  await page.getByRole('button', { name: 'Prepare archive' }).click();
  await expect(page.getByText('Checksum', { exact: true })).toBeVisible();
  const checksum = (await page.locator('.archive-preview .mono').first().textContent())?.trim() ?? '';
  expect(checksum).toMatch(/^[0-9a-f]{64}$/);

  await fs.mkdir(path.dirname(ARCHIVE_PATH), { recursive: true });
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download sealed archive JSON' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^ece-accounting-company-ws-a-.*\.json$/);
  await download.saveAs(ARCHIVE_PATH);
  await expect(page.getByText(/plaintext synthetic data/)).toBeVisible();
  await shot(page, 'admin-archive-manifest');

  await page.getByLabel('Archive JSON file').setInputFiles(ARCHIVE_PATH);
  await expect(page.getByText('Verified company')).toBeVisible();
  await expect(
    page.locator('.archive-preview').filter({ hasText: 'Verified company' }),
  ).toContainText(/Checksum matches/i);
  await page.getByLabel('Restore reason').fill('Round-trip verification of the synthetic archive');
  await page.getByRole('checkbox', { name: /I understand this replaces/i }).check();
  await page.getByRole('button', { name: 'Restore verified archive' }).click();
  await expectToast(page, /Archive restored for Northwind Services Demo/);

  const logTable = page.getByRole('table', { name: /Restore history/i });
  await expect(logTable).toContainText('Round-trip verification');
  await expect(logTable).toContainText(checksum.slice(0, 12));
  await shot(page, 'admin-archive-log');
  errors.assertClean();
});

test('accounting-only membership cannot export a payroll-bearing archive', async ({ page }) => {
  const errors = trackErrors(page);
  await resetDemo(page);
  await useActor(page, ACTOR.accountant);
  await openDestination(page, 'Admin');
  await openTab(page, 'Archive and recovery');
  await expect(page.getByRole('button', { name: 'Prepare archive' })).toBeDisabled();
  await expect(page.getByText(/lacks at least one required privilege/)).toBeVisible();
  errors.assertClean();
});

test('maintenance blocks ordinary writes while authorized export stays available', async ({ page }) => {
  const errors = trackErrors(page);
  await resetDemo(page);
  await useActor(page, ACTOR.owner);
  await openDestination(page, 'Admin');
  await openTab(page, 'Access');

  await page.getByLabel('Start note (optional)').fill('Synthetic maintenance drill');
  await page.getByRole('button', { name: 'Start maintenance' }).click();
  await expect(page.getByText('Maintenance is active.', { exact: true })).toBeVisible();

  await openTab(page, 'Archive and recovery');
  await expect(page.getByRole('button', { name: 'Prepare archive' })).toBeEnabled();
  await page.getByRole('button', { name: 'Prepare archive' }).click();
  await expect(page.getByText('Checksum', { exact: true })).toBeVisible();

  await openTab(page, 'Access');
  await openDestination(page, 'Billing and Collection');
  await page.getByRole('button', { name: 'New invoice' }).click();
  const invoiceDialog = dialog(page);
  await invoiceDialog.getByLabel('Customer').selectOption('contact-a-cust-1');
  await invoiceDialog.getByLabel('Line 1 description').fill('Blocked during maintenance');
  await invoiceDialog.getByLabel('Line 1 quantity').fill('1');
  await invoiceDialog.getByLabel('Line 1 unit price').fill('100.00');
  await invoiceDialog.getByRole('button', { name: 'Save and post' }).click();
  await expectToast(page, /Maintenance mode is active/);
  await expect(invoiceDialog).toBeVisible();
  await invoiceDialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('tbody tr').filter({ hasText: 'Blocked during maintenance' })).toHaveCount(0);
  await shot(page, 'maintenance-blocks-write');

  await openDestination(page, 'Admin');
  await openTab(page, 'Access');
  await page.getByLabel('Completion note (required)').fill('Synthetic maintenance drill complete');
  await page.getByRole('button', { name: 'End maintenance' }).click();
  await expect(page.getByText('Maintenance is off.')).toBeVisible();
  errors.assertClean();
});

test('Company B standalone cutover requires the exact approved opening value', async ({ page }) => {
  const errors = trackErrors(page);
  await resetDemo(page);
  await useActor(page, ACTOR.bAdmin);
  await useCompany(page, COMPANY.b);
  await openDestination(page, 'Admin');
  await openTab(page, 'Entitlements');

  const accountingRow = page.locator('tbody tr').filter({ hasText: 'Accounting' });
  await expect(accountingRow.getByText('inactive', { exact: true })).toBeVisible();

  await page.getByLabel('Confirm opening value (PHP)').fill('999.00');
  await page.getByLabel('Activation reason').fill('Standalone reconciliation approved');
  await page.getByRole('button', { name: 'Activate Accounting once' }).click();
  await expectToast(page, /Confirm the approved opening value/);

  await page.getByLabel('Confirm opening value (PHP)').fill('1000.00');
  await page.getByRole('button', { name: 'Activate Accounting once' }).click();
  await expectToast(page, /Accounting activated at 2026-11-15/);
  await expect(
    page.locator('tbody tr').filter({ hasText: 'Accounting' }).getByText('active', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Activated', { exact: true })).toBeVisible();
  await shot(page, 'admin-company-b-cutover-activated');
  errors.assertClean();
});

test('a company admin cannot remove their own active admin access', async ({ page }) => {
  const errors = trackErrors(page);
  await resetDemo(page);
  await useActor(page, ACTOR.owner);
  await openDestination(page, 'Admin');
  await openTab(page, 'Access');

  await page
    .locator('tbody tr')
    .filter({ hasText: 'Victor Lim' })
    .getByRole('button', { name: 'Edit' })
    .click();
  const memberDialog = dialog(page);
  await memberDialog.getByRole('checkbox', { name: /Accountant/i }).check();
  await memberDialog.getByRole('checkbox', { name: /Company Admin/i }).uncheck();
  await memberDialog.getByRole('button', { name: 'Save membership' }).click();
  await expectToast(page, /Self-demotion blocked/);
  await expect(memberDialog).toBeVisible();
  await memberDialog.getByRole('button', { name: 'Cancel' }).click();

  await expect(
    page.getByRole('row', { name: /Victor Lim Company Admin/ }),
  ).toBeVisible();
  errors.assertClean();
});

test('a Company A archive cannot be restored into Company B', async ({ page }) => {
  const errors = trackErrors(page);
  await resetDemo(page);
  await useActor(page, ACTOR.bAdmin);
  await useCompany(page, COMPANY.b);
  await openDestination(page, 'Admin');
  await openTab(page, 'Archive and recovery');

  await page.getByLabel('Archive JSON file').setInputFiles(ARCHIVE_PATH);
  await expect(page.getByText('Verified company')).toBeVisible();
  await expect(page.getByText(/belongs to another company/i)).toBeVisible();
  await page.getByLabel('Restore reason').fill('Cross-company rejection check');
  await page.getByRole('checkbox', { name: /I understand this replaces/i }).check();
  await page.getByRole('button', { name: 'Restore verified archive' }).click();
  await expectToast(page, /A company archive can only be restored into its own workspace/);
  await expect(page.getByText('No restores recorded for this company')).toBeVisible();
  errors.assertClean();
});
