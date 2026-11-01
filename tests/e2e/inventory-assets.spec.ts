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

test('inventory item receipt and issue preserve quantity and moving-average value', async ({ page }) => {
  const errors = trackErrors(page);
  await resetDemo(page);
  await useActor(page, ACTOR.inventory);
  await openDestination(page, 'Inventory');

  await page.getByRole('button', { name: 'New item' }).click();
  const itemDialog = dialog(page);
  await itemDialog.getByLabel('SKU').fill('SYN-ITEM-200');
  await itemDialog.getByLabel('Item name').fill('Synthetic demo component');
  await itemDialog.getByLabel('Base unit').fill('pc');
  await itemDialog.getByRole('button', { name: 'Create item', exact: true }).click();
  await expect(itemDialog).toBeHidden();
  await expect(page.getByRole('row', { name: /SYN-ITEM-200/ }).first()).toContainText('pc');
  await openTab(page, 'Valuation');
  const row = page.getByRole('row', { name: /SYN-ITEM-200/ }).first();
  await expect(row).toBeVisible();
  await expect(row).toContainText('0 pc');

  await row.getByRole('button', { name: 'Receive' }).click();
  const receiptDialog = dialog(page);
  await receiptDialog.getByLabel('Quantity').fill('100');
  await receiptDialog.getByLabel(/Unit cost/).fill('25.00');
  await receiptDialog.getByRole('button', { name: 'Post movement' }).click();
  await expect(receiptDialog).toBeHidden();
  await expect(row).toContainText('100 pc');
  await expect(row).toContainText('2,500.00');
  await shot(page, 'inventory-received');

  await row.getByRole('button', { name: 'Issue' }).click();
  const issueDialog = dialog(page);
  await issueDialog.getByLabel('Quantity').fill('10');
  await issueDialog.getByLabel('Purpose').fill('Synthetic demo consumption');
  await issueDialog.getByRole('button', { name: 'Post movement' }).click();
  await expect(issueDialog).toBeHidden();
  await expect(row).toContainText('90 pc');
  await expect(row).toContainText('2,250.00');

  await row.getByRole('button', { name: 'Transfer' }).click();
  const transferDialog = dialog(page);
  await expect(transferDialog.getByLabel('From location')).not.toHaveValue('');
  await expect(transferDialog.getByLabel('To location')).not.toHaveValue('');
  await transferDialog.getByLabel('Quantity').fill('5');
  await transferDialog.getByRole('button', { name: 'Post movement' }).click();
  await expect(transferDialog).toBeHidden();
  await expectToast(page, /Stock transfer recorded/);
  await expect(row).toContainText('90 pc');
  await expect(row).toContainText('2,250.00');
  await shot(page, 'inventory-stock-valuation');
  errors.assertClean();
});

test('fixed asset acquisition and two-user depreciation posting', async ({ page }) => {
  const errors = trackErrors(page);
  await resetDemo(page);
  await openDestination(page, 'Fixed Assets');

  await page.getByRole('button', { name: 'New asset' }).click();
  const assetDialog = dialog(page);
  await assetDialog.getByLabel('Company vendor/brand').fill('Synthetic Demo Machines');
  await assetDialog.getByLabel('Item Description').fill('Demo packaging machine');
  await assetDialog.getByLabel('Supplier', { exact: true }).selectOption({ label: 'C103 · Tandang Hardware Demo Co.' });
  await assetDialog.getByLabel('Serial No.').fill('SYN-SN-0001');
  await assetDialog.getByLabel('Cost (PHP)').fill('12000.00');
  await assetDialog.getByLabel('Useful life for Year').fill('5');
  await assetDialog.getByLabel('Residual value (PHP)').fill('1200.00');
  await assetDialog.getByLabel('Depreciation start').fill('2026-11-01');
  await assetDialog.getByRole('button', { name: 'Add asset', exact: true }).click();
  await expect(assetDialog).toBeHidden();

  const assetRow = page.locator('tbody tr').filter({ hasText: 'Demo packaging machine' });
  await expect(assetRow).toContainText('12,000.00');
  await expect(assetRow).toContainText('180.00');

  await openTab(page, 'Depreciation');
  const periodPanel = page.locator('.panel').filter({ hasText: 'Monthly depreciation' });
  await periodPanel.getByRole('button', { name: 'Calculate', exact: true }).click();
  await expect(periodPanel.locator('tbody tr').filter({ hasText: 'Demo packaging machine' })).toContainText(
    /calculated/i,
  );
  await expect(periodPanel.getByRole('button', { name: 'Approve calculated' })).toBeDisabled();

  await useActor(page, ACTOR.owner);
  await periodPanel.getByRole('button', { name: 'Approve calculated' }).click();
  await expect(periodPanel.locator('tbody tr').filter({ hasText: 'Demo packaging machine' })).toContainText(
    /approved/i,
  );
  await periodPanel.getByRole('button', { name: 'Post approved' }).click();
  const postedRow = periodPanel.locator('tbody tr').filter({ hasText: 'Demo packaging machine' });
  await expect(postedRow).toContainText(/posted/i);
  await expect(postedRow.locator('td').last()).not.toHaveText('—');
  await shot(page, 'assets-depreciation-posted');

  await openTab(page, 'Asset register');
  await expect(assetRow).toContainText('Demo packaging machine');
  await assetRow.getByRole('button', { name: 'Schedule' }).click();
  const scheduleDialog = dialog(page);
  await expect(scheduleDialog.getByRole('heading', { name: /FA101/ })).toBeVisible();
  await expect(scheduleDialog).toContainText('180.00');
  await shot(page, 'assets-schedule');
  errors.assertClean();
});
