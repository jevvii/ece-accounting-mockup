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

/** G04 in the browser: release 1,000.00; support 800.00; return 200.00 unused cash. */
test('employee advance release and liquidation return unused cash', async ({ page }) => {
  const errors = trackErrors(page);
  await resetDemo(page);
  await useActor(page, ACTOR.maker);
  await openDestination(page, 'Purchases and Disbursement');
  await openTab(page, 'Advances');

  await page.getByRole('button', { name: 'New advance' }).click();
  const advanceDialog = dialog(page);
  await advanceDialog.getByLabel('Employee').selectOption({ label: '5000 · Ana Reyes' });
  await advanceDialog.getByLabel('Advance date').fill('2026-11-01');
  await advanceDialog.getByLabel('Amount (PHP)').fill('1000.00');
  await advanceDialog.getByRole('button', { name: 'Post advance' }).click();
  await expect(advanceDialog).toBeHidden();
  await expectToast(page, /Advance ADV-0002 released/);

  const row = page.locator('tbody tr').filter({ hasText: 'ADV-0002' });
  await expect(row).toContainText('1,000.00');
  await expect(row).toContainText('open');

  await row.getByRole('button', { name: 'Liquidate' }).click();
  const liquidationDialog = dialog(page);
  await liquidationDialog.getByLabel('Expense account').selectOption({
    label: 'A127 · Rent and operating expense',
  });
  await liquidationDialog.getByLabel('Description').fill('Synthetic field expenses');
  await liquidationDialog.getByLabel('Supported expense (PHP)').fill('800.00');
  await expect(liquidationDialog.getByText(/Unused return: 200\.00/)).toBeVisible();
  await liquidationDialog.getByRole('button', { name: 'Post liquidation' }).click();
  await expect(liquidationDialog).toBeHidden();
  await expectToast(page, /Advance ADV-0002 liquidated/);
  await expect(row).toContainText('800.00');
  await expect(row).toContainText('200.00');
  await expect(row).toContainText('closed');
  await shot(page, 'advances-liquidated');
  errors.assertClean();
});
