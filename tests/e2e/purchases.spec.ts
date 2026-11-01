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

test('bill, payment request, independent approval and payment', async ({ page }) => {
  const errors = trackErrors(page);
  await resetDemo(page);
  await useActor(page, ACTOR.maker);
  await openDestination(page, 'Purchases and Disbursement');

  await page.getByRole('button', { name: 'New bill' }).click();
  const billDialog = dialog(page);
  await billDialog.getByLabel('Vendor').selectOption({ label: 'C102 · Metro Office Supply Demo Co.' });
  await billDialog.getByLabel('Supplier invoice number').fill('SYN-BILL-2026-0001');
  await billDialog.getByLabel('Line 1 description').fill('Synthetic office rent');
  await billDialog.getByLabel('Line 1 account').selectOption({ label: 'A127 · Rent and operating expense' });
  await billDialog.getByLabel('Line 1 amount').fill('5000.00');
  await billDialog.getByRole('button', { name: 'Post bill' }).click();
  await expect(billDialog).toBeHidden();

  const billRow = page.locator('tbody tr').filter({ hasText: 'SYN-BILL-2026-0001' });
  await expect(billRow).toBeVisible();
  await expect(billRow).toContainText('5,000.00');

  await billRow.getByRole('button', { name: 'Request payment' }).click();
  const requestDialog = dialog(page);
  await expect(requestDialog.getByLabel(/Amount \(PHP, maximum/)).toHaveValue('5000.00');
  await requestDialog.getByRole('button', { name: 'Create request' }).click();
  await expect(requestDialog).toBeHidden();
  await expect(page.locator('tbody tr').filter({ hasText: 'SYN-BILL-2026-0001' })).toContainText(
    'pending',
  );

  await useActor(page, ACTOR.owner);
  await expect(page.getByRole('button', { name: 'Approve', exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Approve', exact: true }).first().click();
  const approveDialog = dialog(page);
  await approveDialog.getByRole('button', { name: 'Approve as checker' }).click();
  await expect(approveDialog).toBeHidden();
  await expect(page.locator('tbody tr').filter({ hasText: 'SYN-BILL-2026-0001' })).toContainText(
    'approved',
  );
  await shot(page, 'purchases-approved-request');

  await page.getByRole('button', { name: 'Pay', exact: true }).click();
  const paymentDialog = dialog(page);
  await expect(paymentDialog.getByText(/Approved by Victor Lim/)).toBeVisible();
  await paymentDialog.getByRole('button', { name: 'Post payment' }).click();
  await expect(paymentDialog).toBeHidden();
  await expectToast(page, 'Payment');

  await expect(page.locator('tbody tr').filter({ hasText: 'SYN-BILL-2026-0001' })).toContainText(
    '0.00',
  );
  await openTab(page, 'Payments');
  await expect(
    page.locator('tbody tr').filter({ hasText: '5,000.00' }).first(),
  ).toBeVisible();
  await shot(page, 'purchases-payment-posted');

  await openDestination(page, 'Reports');
  await openTab(page, 'Expenses');
  await page.locator('tbody tr').filter({ hasText: 'Synthetic office rent' }).getByRole('link', { name: 'Bill detail' }).click();
  await expect(page).toHaveURL(/#\/purchases\/bills\/[^/]+$/);
  const sourceDialog = dialog(page);
  await expect(sourceDialog).toContainText('Synthetic office rent');
  await sourceDialog.getByRole('button', { name: 'Close dialog' }).click();
  await expect(page).toHaveURL(/#\/purchases\/bills$/);
  errors.assertClean();
});

test('a requester cannot approve their own payment request', async ({ page }) => {
  const errors = trackErrors(page);
  await resetDemo(page);
  await openDestination(page, 'Purchases and Disbursement');

  await page.getByRole('button', { name: 'New bill' }).click();
  const billDialog = dialog(page);
  await billDialog.getByLabel('Vendor').selectOption({ label: 'C102 · Metro Office Supply Demo Co.' });
  await billDialog.getByLabel('Supplier invoice number').fill('SYN-BILL-SELF-0001');
  await billDialog.getByLabel('Line 1 description').fill('Synthetic self-check attempt');
  await billDialog.getByLabel('Line 1 account').selectOption({ label: 'A127 · Rent and operating expense' });
  await billDialog.getByLabel('Line 1 amount').fill('900.00');
  await billDialog.getByRole('button', { name: 'Post bill' }).click();
  await expect(billDialog).toBeHidden();

  const billRow = page
    .locator('tbody tr')
    .filter({ hasText: 'Metro Office Supply Demo Co.' })
    .first();
  await billRow.getByRole('button', { name: 'Request payment' }).click();
  const requestDialog = dialog(page);
  await requestDialog.getByRole('button', { name: 'Create request' }).click();
  await expect(requestDialog).toBeHidden();

  // Rosa is the requester; the Approve control must not be offered to her.
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
  errors.assertClean();
});
