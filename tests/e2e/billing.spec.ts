import { expect, test } from '@playwright/test';
import {
  dialog,
  expectToast,
  openDestination,
  openTab,
  resetDemo,
  shot,
  trackErrors,
} from './helpers';

test('invoice posting, excess receipt, reload persistence and balanced reports', async ({ page }) => {
  const errors = trackErrors(page);
  await resetDemo(page);

  await page.getByRole('button', { name: 'New invoice' }).click();
  const invoiceDialog = dialog(page);
  await invoiceDialog.getByLabel('Customer').selectOption('contact-a-cust-1');
  await invoiceDialog.getByLabel('Tax treatment').selectOption('none');
  await invoiceDialog.getByLabel('Line 1 description').fill('Synthetic consulting service');
  await invoiceDialog.getByLabel('Line 1 quantity').fill('2');
  await invoiceDialog.getByLabel('Line 1 unit price').fill('5000.00');
  await invoiceDialog.getByRole('button', { name: 'Save and post' }).click();
  await expect(invoiceDialog).toBeHidden();

  const invoiceRow = page.locator('tbody tr').filter({ hasText: 'Cordillera Services Demo Inc.' });
  await expect(invoiceRow).toBeVisible();
  await expect(invoiceRow).toContainText('posted');
  await expect(invoiceRow).toContainText('10,000.00');
  await shot(page, 'billing-invoice-posted');

  await page.reload();
  await expect(
    page.locator('tbody tr').filter({ hasText: 'Cordillera Services Demo Inc.' }),
  ).toContainText('posted');

  await openTab(page, 'Receipts');
  await page.getByRole('button', { name: 'New receipt' }).click();
  const receiptDialog = dialog(page);
  await receiptDialog.getByLabel('Customer').selectOption('contact-a-cust-1');
  await receiptDialog.getByLabel('Total amount (PHP)').fill('12000.00');
  await receiptDialog.getByLabel(/Allocation to INV-/).fill('10000.00');
  await receiptDialog.getByRole('button', { name: 'Post receipt' }).click();
  await expect(receiptDialog).toBeHidden();
  await expectToast(page, 'Receipt');

  await expect(
    page.locator('.stat').filter({ hasText: 'Unapplied credits' }),
  ).toContainText('2,000.00');
  await openTab(page, 'Credits');
  await expect(page.getByRole('table')).toContainText('CN-0001');

  await openTab(page, 'Invoices');
  const paidRow = page.locator('tbody tr').filter({ hasText: 'Cordillera Services Demo Inc.' });
  await expect(paidRow).toContainText('paid');
  await shot(page, 'billing-invoice-paid');

  await openDestination(page, 'Reports');
  await expect(page.getByText('Balanced').first()).toBeVisible();
  await expect(page.getByRole('table').filter({ hasText: 'Service and sales revenue' })).toContainText(
    '85,000.00',
  );
  await shot(page, 'reports-after-invoice-receipt');

  await openTab(page, 'Expenses');
  await expect(page.getByRole('heading', { name: 'Expenses by account' })).toBeVisible();
  await openTab(page, 'Sales');
  await expect(page.getByRole('heading', { name: 'Sales invoice detail' })).toBeVisible();
  await expect(
    page.getByRole('table').filter({ hasText: 'Cordillera Services Demo Inc.' }),
  ).toContainText('10,000.00');

  await page.getByRole('link', { name: 'Invoice detail' }).first().click();
  await expect(page).toHaveURL(/#\/billing\/invoices\/[^/]+$/);
  const sourceDialog = dialog(page);
  await expect(sourceDialog.getByRole('heading', { name: /INV-/ })).toBeVisible();
  await sourceDialog.getByRole('button', { name: 'Close dialog' }).click();
  await expect(page).toHaveURL(/#\/billing\/invoices$/);

  await openDestination(page, 'Other');
  await openTab(page, 'Tax register');
  await expect(page.getByRole('heading', { name: 'Tax register' })).toBeVisible();
  await expect(page.getByText('Output VAT', { exact: true })).toBeVisible();
  await openTab(page, '2307 certificates');
  await expect(page.getByRole('heading', { name: 'Certificate 2307 register' })).toBeVisible();
  errors.assertClean();
});

test('over-allocating a receipt is rejected without changing the invoice', async ({ page }) => {
  const errors = trackErrors(page);
  await resetDemo(page);

  await page.getByRole('button', { name: 'New invoice' }).click();
  const invoiceDialog = dialog(page);
  await invoiceDialog.getByLabel('Customer').selectOption('contact-a-cust-1');
  await invoiceDialog.getByLabel('Tax treatment').selectOption('none');
  await invoiceDialog.getByLabel('Line 1 description').fill('Synthetic support retainer');
  await invoiceDialog.getByLabel('Line 1 quantity').fill('1');
  await invoiceDialog.getByLabel('Line 1 unit price').fill('1000.00');
  await invoiceDialog.getByRole('button', { name: 'Save and post' }).click();
  await expect(invoiceDialog).toBeHidden();

  await openTab(page, 'Receipts');
  await page.getByRole('button', { name: 'New receipt' }).click();
  const receiptDialog = dialog(page);
  await receiptDialog.getByLabel('Customer').selectOption('contact-a-cust-1');
  await receiptDialog.getByLabel('Total amount (PHP)').fill('2000.00');
  await receiptDialog.getByLabel(/Allocation to INV-/).fill('2000.00');
  await receiptDialog.getByRole('button', { name: 'Post receipt' }).click();
  await expect(receiptDialog).toBeVisible();
  await expectToast(page, /exceeds its outstanding balance/i);
  await receiptDialog.getByRole('button', { name: 'Cancel' }).click();

  await openTab(page, 'Invoices');
  await expect(
    page.locator('tbody tr').filter({ hasText: 'Cordillera Services Demo Inc.' }),
  ).toContainText('posted');
  errors.assertClean();
});
