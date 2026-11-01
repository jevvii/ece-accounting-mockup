import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import Papa from 'papaparse';
import { openDestination, openTab, resetDemo, trackErrors } from './helpers';

const STORAGE_KEY = 'fin-axis-mockup:app-state:v1';

test('reload reconciles legacy saved account masters to their policy without clearing transactions', async ({ page }) => {
  const errors = trackErrors(page);
  await resetDemo(page);
  const before = await page.evaluate((key) => {
    const state = JSON.parse(window.localStorage.getItem(key)!);
    const result = { invoiceIds: state.invoices.map((row: { id: string }) => row.id), journalIds: state.journals.map((row: { id: string }) => row.id) };
    state.accounts.filter((row: { workspaceId: string }) => row.workspaceId === 'ws-a')
      .forEach((row: { code: string }, index: number) => { row.code = String(1010 + index); });
    state.numberingPolicies.find((row: { workspaceId: string; kind: string }) => row.workspaceId === 'ws-a' && row.kind === 'account').nextNumber = 100;
    window.localStorage.setItem(key, JSON.stringify(state));
    return result;
  }, STORAGE_KEY);
  await page.reload();
  await openDestination(page, 'Admin');
  await openTab(page, 'Contacts and accounts');
  await expect(page.getByRole('rowheader', { name: 'A100', exact: true })).toBeVisible();
  await expect(page.getByRole('rowheader', { name: '1010', exact: true })).toHaveCount(0);
  await openTab(page, 'Numbering');
  const accounts = page.getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'Accounts', exact: true }) });
  await expect(accounts).toContainText('A131');
  const after = await page.evaluate((key) => {
    const state = JSON.parse(window.localStorage.getItem(key)!);
    return { invoiceIds: state.invoices.map((row: { id: string }) => row.id), journalIds: state.journals.map((row: { id: string }) => row.id) };
  }, STORAGE_KEY);
  expect(after).toEqual(before);
  errors.assertClean();
});

test('month shortcuts and monthly activity keep screen, export and actual closing balances consistent', async ({ page }) => {
  const errors = trackErrors(page);
  await resetDemo(page);
  await openDestination(page, 'Reports');
  const month = page.getByLabel('Reporting month');
  await month.fill('2026-10');
  await page.getByRole('button', { name: 'Previous month', exact: true }).click();
  await expect(month).toHaveValue('2026-09');
  await page.getByRole('button', { name: 'Next month', exact: true }).click();
  await expect(month).toHaveValue('2026-10');
  await expect(page.getByText('Includes opening balances and all posted entries through the selected month end.')).toBeVisible();
  await page.getByLabel('Scope mode').selectOption('month_activity');
  await expect(page.getByText('Source columns show only this month’s postings. Closing balances also include earlier history.')).toBeVisible();

  const expected = await page.evaluate((key) => {
    const state = JSON.parse(window.localStorage.getItem(key)!);
    const bank = state.accounts.find((row: { workspaceId: string; controlRole: string }) => row.workspaceId === 'ws-a' && row.controlRole === 'bank');
    let balance = 0;
    for (const journal of state.journals) {
      if (journal.workspaceId !== 'ws-a' || journal.postingDate > '2026-10-31') continue;
      for (const line of journal.lines) if (line.accountId === bank.id) balance += line.debitCentavos - line.creditCentavos;
    }
    return { code: bank.code, balance };
  }, STORAGE_KEY);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export current report CSV' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toContain('month-activity-2026-10');
  const path = await download.path();
  expect(path).toBeTruthy();
  const csv = Papa.parse<Record<string, string>>(await readFile(path!, 'utf8'), { header: true, skipEmptyLines: true });
  const row = csv.data.find((record) => record['Account Code'] === expected.code)!;
  expect(row.Scope).toContain('Activity');
  expect(Number(row['Net Closing Debit']) - Number(row['Net Closing Credit'])).toBe(expected.balance / 100);
  await month.fill('');
  await expect(page.getByRole('alert')).toContainText('Choose a valid reporting month');
  await expect(page.getByRole('button', { name: 'Export current report CSV' })).toBeDisabled();
  errors.assertClean();
});
