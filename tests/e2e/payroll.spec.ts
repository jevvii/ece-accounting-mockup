import { expect, test } from '@playwright/test';
import {
  ACTOR,
  dialog,
  expectToast,
  openDestination,
  openTab,
  resetDemo,
  shot,
  trackErrors,
  useActor,
} from './helpers';

const TIME_CSV = [
  'employee_no,bucket,minutes',
  '5000,ordinary_regular,5280',
  '5001,ordinary_regular,5280',
  '5002,ordinary_regular,5280',
].join('\n');

test('time import, payroll lifecycle, masking and protected register', async ({ page }) => {
  const errors = trackErrors(page);
  await resetDemo(page);
  await useActor(page, ACTOR.payroll);
  await openDestination(page, 'Payroll');

  await openTab(page, 'Time import');
  await page.getByRole('button', { name: 'Import time CSV' }).click();
  const importDialog = dialog(page);
  await importDialog.getByLabel('Paste CSV').fill(TIME_CSV);
  await expect(importDialog.getByText('3 valid row(s) read.')).toBeVisible();
  await importDialog.getByRole('button', { name: 'Import 3 row(s)' }).click();
  await expect(importDialog).toBeHidden();
  await expect(page.getByRole('rowheader', { name: 'synthetic-time.csv' })).toBeVisible();

  await openTab(page, 'Payroll runs');
  await page.getByRole('button', { name: 'Calculate payroll' }).click();
  const runRow = page.locator('tbody tr').filter({ hasText: 'PR-0002' });
  await expect(runRow.first()).toContainText('calculated');
  await expectToast(page, 'Payroll');
  await shot(page, 'payroll-calculated');

  await useActor(page, ACTOR.owner);
  await runRow.first().getByRole('button', { name: 'Approve' }).click();
  await expect(runRow.first()).toContainText('approved');

  await useActor(page, ACTOR.accountant);
  await expect(page.getByText('Payroll detail is not granted to this demo actor.')).toBeVisible();
  await expect(page.getByText('Ana Reyes')).toHaveCount(0);
  await runRow.first().getByRole('button', { name: 'Post' }).click();
  await expect(runRow.first()).toContainText('posted');
  await expect(page.getByText(/Per-employee register hidden/).first()).toBeVisible();
  await shot(page, 'payroll-posted-masked-detail');

  await runRow.first().getByRole('button', { name: 'Pay net' }).click();
  const payDialog = dialog(page);
  await expect(payDialog.getByText(/Net pay is released once/)).toBeVisible();
  await payDialog.getByRole('button', { name: 'Release net pay once' }).click();
  await expect(payDialog).toBeHidden();
  await expect(runRow.first()).toContainText('paid');

  await openTab(page, 'Employees');
  await expect(page.getByText('Payroll detail not granted')).toBeVisible();
  await expect(page.getByText('Ana Reyes')).toHaveCount(0);
  errors.assertClean();
});

test('duplicate employee bucket rows are refused before import', async ({ page }) => {
  const errors = trackErrors(page);
  await resetDemo(page);
  await useActor(page, ACTOR.payroll);
  await openDestination(page, 'Payroll');
  await openTab(page, 'Time import');
  await page.getByRole('button', { name: 'Import time CSV' }).click();
  const importDialog = dialog(page);
  await importDialog
    .getByLabel('Paste CSV')
    .fill('employee_no,bucket,minutes\n5000,ordinary_regular,60\n5000,ordinary_regular,120');
  await expect(importDialog.getByText(/buckets must be disjoint/)).toBeVisible();
  await expect(importDialog.getByRole('button', { name: /Import/ })).toBeDisabled();
  await importDialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByText('No time imports yet')).toBeVisible();
  errors.assertClean();
});

test('13th-month worksheet saves with explicit inputs and visible result', async ({ page }) => {
  const errors = trackErrors(page);
  await resetDemo(page);
  await useActor(page, ACTOR.owner);
  await openDestination(page, 'Payroll');
  await openTab(page, 'Worksheets');
  await page.getByRole('button', { name: 'New worksheet' }).click();
  const worksheetDialog = dialog(page);
  await worksheetDialog.getByLabel('Employee (optional)').selectOption('emp-a-001');
  await worksheetDialog.getByLabel('Label').fill('Demo 13th month — Ana Reyes');
  await worksheetDialog.getByLabel('Annual basic earned (PHP)').fill('240000.00');
  await worksheetDialog.getByRole('button', { name: 'Save worksheet' }).click();
  await expect(worksheetDialog).toBeHidden();
  await expect(page.getByRole('rowheader', { name: 'Demo 13th month — Ana Reyes' })).toBeVisible();
  await expect(page.locator('tbody tr').filter({ hasText: 'Demo 13th month' })).toContainText(
    'Ana Reyes',
  );
  await shot(page, 'payroll-worksheet');
  errors.assertClean();
});
