import { expect, test } from '@playwright/test';
import {
  ACTOR,
  dialog,
  expectToast,
  openDestination,
  resetDemo,
  shot,
  trackErrors,
  useActor,
} from './helpers';

/**
 * G03/G17 in the browser: a payment settles through outgoing clearing, then a synthetic
 * bank row is imported, suggested, reconciled with a reason, and undone with a linked
 * reversal. The bank row itself is never deleted.
 */
test('bank CSV import, reviewed clearing match and reasoned undo', async ({ page }) => {
  const errors = trackErrors(page);
  await resetDemo(page);
  await useActor(page, ACTOR.maker);
  await openDestination(page, 'Purchases and Disbursement');

  await page.getByRole('button', { name: 'New bill' }).click();
  const billDialog = dialog(page);
  await billDialog.getByLabel('Vendor').selectOption({ label: 'C102 · Metro Office Supply Demo Co.' });
  await billDialog.getByLabel('Supplier invoice number').fill('SYN-BANK-BILL-0001');
  await billDialog.getByLabel('Line 1 description').fill('Synthetic bank-clearing expense');
  await billDialog
    .getByLabel('Line 1 account')
    .selectOption({ label: 'A127 · Rent and operating expense' });
  await billDialog.getByLabel('Line 1 amount').fill('5000.00');
  await billDialog.getByRole('button', { name: 'Post bill' }).click();
  await expect(billDialog).toBeHidden();

  const billRow = page.locator('tbody tr').filter({ hasText: 'SYN-BANK-BILL-0001' });
  await billRow.getByRole('button', { name: 'Request payment' }).click();
  const requestDialog = dialog(page);
  await requestDialog.getByRole('button', { name: 'Create request' }).click();
  await expect(requestDialog).toBeHidden();

  await useActor(page, ACTOR.owner);
  await page.getByRole('button', { name: 'Approve', exact: true }).first().click();
  const approveDialog = dialog(page);
  await approveDialog.getByRole('button', { name: 'Approve as checker' }).click();
  await expect(approveDialog).toBeHidden();
  await page.getByRole('button', { name: 'Pay', exact: true }).click();
  const paymentDialog = dialog(page);
  await expect(paymentDialog.getByLabel('Method')).toHaveValue('outgoing_clearing');
  await paymentDialog.getByRole('button', { name: 'Post payment' }).click();
  await expect(paymentDialog).toBeHidden();

  await openDestination(page, 'Cash Management');
  await page.getByRole('button', { name: 'Import CSV' }).click();
  const importDialog = dialog(page);
  await importDialog.getByLabel('Statement source name').fill('synthetic-bank-nov.csv');
  await importDialog
    .getByLabel('CSV text')
    .fill(
      [
        'reference,value_date,description,direction,amount',
        'BNK-TEST-0001,2026-11-01,Synthetic outgoing settlement,out,5000.00',
      ].join('\n'),
    );
  await importDialog.getByRole('button', { name: 'Validate and preview' }).click();
  await expect(importDialog.getByRole('status')).toContainText('1 valid row(s)');
  await importDialog.getByRole('button', { name: 'Import 1 row(s)' }).click();
 await expect(importDialog).toBeHidden();
  await expectToast(page, /Imported 1 bank row/);

  const bankRow = page.locator('tbody tr').filter({ hasText: 'BNK-TEST-0001' });
  await expect(bankRow).toContainText('5,000.00');
  await expect(bankRow).toContainText('unmatched');
  await expect(bankRow).toContainText(/PAY-0002/);

  await bankRow.getByRole('button', { name: 'Review match' }).click();
  const matchDialog = dialog(page);
  await expect(matchDialog.getByText(/Suggested source:/)).toBeVisible();
  await expect(matchDialog.getByLabel('Match reason')).not.toHaveValue('');
  await matchDialog.getByRole('button', { name: 'Record reconciliation' }).click();
  await expect(matchDialog).toBeHidden();
  await expectToast(page, /reconciled/);
  await expect(bankRow).toContainText('reconciled');
  await shot(page, 'cash-bank-matched');

  await bankRow.getByRole('button', { name: 'Undo' }).click();
  const undoDialog = dialog(page);
  await undoDialog.getByLabel('Reason').fill('Synthetic reconciliation correction');
  await undoDialog.getByRole('button', { name: 'Post linked reversal' }).click();
  await expect(undoDialog).toBeHidden();
  await expectToast(page, /undone; history retained/);
  await expect(bankRow).toContainText('unmatched');

  await page.getByRole('button', { name: 'Import history' }).click();
  const history = dialog(page);
  await expect(history.getByRole('cell', { name: 'synthetic-bank-nov.csv' })).toBeVisible();
  errors.assertClean();
});
