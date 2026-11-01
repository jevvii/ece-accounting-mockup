import { expect, test } from '@playwright/test';
import {
  ACTOR,
  expectToast,
  openDestination,
  openTab,
  resetDemo,
  shot,
  trackErrors,
  useActor,
} from './helpers';

test('company admin applies the master series to current accounts and new accounts', async ({ page }) => {
  const errors = trackErrors(page);
  await resetDemo(page);
  await useActor(page, ACTOR.owner);
  await openDestination(page, 'Admin');
  await openTab(page, 'Numbering');

  await expect(page.getByRole('heading', { name: 'Numbering policies' })).toBeVisible();
  const policyTable = page.locator('table', { has: page.getByText('Current company codes and next values') });
  await expect(policyTable.locator('tbody tr').first()).toContainText('Account');
  await expect(policyTable.locator('tbody tr').first()).toContainText('A131');

  await page.getByLabel('Record kind').selectOption('account');
  await page.getByLabel('Prefix').fill('GL');
  await page.getByLabel('Starting number').fill('700');
  await page.getByLabel('Minimum digits').fill('4');
  await page.getByLabel('Increment').fill('5');
  await page.getByLabel('Change reason').fill('Owner-approved synthetic chart recode');
  await expect(page.getByText('GL0700 · GL0705 · GL0710')).toBeVisible();
  await page.getByRole('button', { name: 'Save numbering policy' }).click();
  await expectToast(page, /Accounts numbering policy applied. Next code: GL0855/);
  await expect(
    page.getByText('Current master codes now follow this policy. Internal IDs and posted document snapshots are preserved.').first(),
  ).toBeVisible();
  await shot(page, 'remediation-numbering-policy');

  await openTab(page, 'Contacts and accounts');
  await expect(page.getByRole('rowheader', { name: 'GL0700', exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Add account' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Account code will be allocated: GL0855')).toBeVisible();
  await dialog.getByLabel('Name').fill('Synthetic remediation clearing');
  await dialog.getByRole('button', { name: 'Add account' }).click();
  await expect(page.getByRole('rowheader', { name: 'GL0855', exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('rowheader', { name: 'GL0855', exact: true })).toBeVisible();
  await openTab(page, 'Numbering');
  await expect(page.getByText('Current saved next code: GL0860')).toBeVisible();
  await openTab(page, 'Contacts and accounts');
  await expect(page.getByRole('rowheader', { name: 'A100', exact: true })).toHaveCount(0);
  await expect(page.getByRole('rowheader', { name: 'GL0700', exact: true })).toHaveCount(1);
  await useActor(page, ACTOR.bAdmin);
  await openTab(page, 'Numbering');
  await expect(page.getByLabel('Record kind')).toHaveValue('account');
  // Company B has standalone Payroll/Inventory; Accounting stays inactive.
  await expect(page.getByText('The accounting product is not active for this company, so this series cannot be changed. Switch record kind to view a series whose product is active.')).toBeVisible();
  await expect(page.getByLabel('Prefix')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save numbering policy' })).toHaveCount(0);
  const companyBAccounts = policyTable.getByRole('row').filter({
    has: page.getByRole('rowheader', { name: 'Accounts', exact: true }),
  });
  await expect(companyBAccounts).toContainText('A100');
  await expect(companyBAccounts).toContainText('A131');
  await expect(companyBAccounts).not.toContainText('GL');

  // An entitled series is editable and loads B's own values, not A's GL series.
  await page.getByLabel('Record kind').selectOption('employee');
  await expect(page.getByLabel('Prefix')).toHaveValue('');
  await expect(page.getByLabel('Starting number')).toHaveValue('5000');
  await expect(page.getByText('Current saved next code: 5002')).toBeVisible();

  await useActor(page, ACTOR.owner);
  await openTab(page, 'Numbering');
  await expect(page.getByLabel('Record kind')).toHaveValue('account');
  await expect(page.getByLabel('Prefix')).toHaveValue('GL');
  await expect(page.getByLabel('Starting number')).toHaveValue('700');
  await expect(page.getByText('Current saved next code: GL0860')).toBeVisible();
  errors.assertClean();
});

test('numbering is read-only without a privileged role and company B has its own counter', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await resetDemo(page);
  await useActor(page, ACTOR.maker);
  await openDestination(page, 'Admin');
  await openTab(page, 'Numbering');
  await expect(page.getByRole('heading', { name: 'View one series' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save numbering policy' })).toHaveCount(0);

  await useActor(page, ACTOR.bAdmin);
  await expect(page.getByText('Bayanihan Trading Demo Co.')).toBeVisible();
  await openTab(page, 'Numbering');
  await page.getByLabel('Record kind').selectOption('employee');
  await page.getByLabel('Prefix').fill('E');
  await page.getByLabel('Starting number').fill('9000');
  await page.getByLabel('Minimum digits').fill('4');
  await page.getByLabel('Change reason').fill('Company B standalone payroll series');
  await page.getByRole('button', { name: 'Save numbering policy' }).click();
  await expectToast(page, /Employees numbering policy applied. Next code: E9002/);

  await useActor(page, ACTOR.owner);
  await openDestination(page, 'Admin');
  await openTab(page, 'Numbering');
  await page.getByLabel('Record kind').selectOption('employee');
  await expect(page.getByText('Current saved next code: 5003')).toBeVisible();
  await expect(page.getByText('Current saved next code: E9000')).toHaveCount(0);
  errors.assertClean();
});
