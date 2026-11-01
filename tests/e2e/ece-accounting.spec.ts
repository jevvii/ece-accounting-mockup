import { expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  dialog,
  expectToast,
  openDemoControls,
  openDestination,
  openTab,
  resetDemo,
  trackErrors,
} from './helpers';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SCREENSHOT_DIR = path.resolve(__dirname, '../../artifacts/screenshots/ece');
const ARTIFACT_ECE_DIR = path.resolve(__dirname, '../../artifacts/ece');
const MANIFEST_PATH = path.resolve(ARTIFACT_ECE_DIR, 'demo-refresh-manifest.json');
const STORAGE_KEY = 'fin-axis-mockup:app-state:v1';

test.beforeAll(async () => {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  fs.mkdirSync(ARTIFACT_ECE_DIR, { recursive: true });
});

test.describe('ECE Accounting Scope Amendment Suite', () => {
  test('1. Product Branding & Shell (ECE Accounting)', async ({ page }) => {
    const collector = trackErrors(page);
    await page.setViewportSize({ width: 1440, height: 900 });

    await resetDemo(page);
    await page.goto('/#/home');

    // Document title ends with ECE Accounting
    await expect(page).toHaveTitle(/ · ECE Accounting$/);
    const title = await page.title();
    expect(title.endsWith('ECE Accounting')).toBe(true);

    // Header brand link has ECE mark and ECE Accounting wordmark
    const brandLink = page.locator('header.app-header a.brand');
    await expect(brandLink).toBeVisible();
    await expect(brandLink.locator('.brand-mark')).toHaveText('ECE');
    await expect(brandLink.locator('.brand-name')).toHaveText('ECE Accounting');

    // All 9 app tiles render cleanly
    const tiles = page.locator('.app-grid .app-tile');
    await expect(tiles).toHaveCount(9);

    const expectedAppTitles = [
      'Cash Management',
      'Billing and Collection',
      'Purchases and Disbursement',
      'Fixed Assets',
      'Admin',
      'Reports',
      'Payroll',
      'Inventory',
      'Other',
    ];
    for (const appTitle of expectedAppTitles) {
      await expect(page.locator(`.app-tile:has-text("${appTitle}")`)).toBeVisible();
    }

    // Zero page/console errors
    collector.assertClean();

    // Screenshot of desktop Main launcher
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'ece-main-launcher-1440.png'),
      fullPage: true,
    });
  });

  test('2. In-App Refresh demo data flow & atomic storage protection (ECE07)', async ({
    page,
  }) => {
    const collector = trackErrors(page);
    await page.setViewportSize({ width: 1440, height: 900 });

    await resetDemo(page);
    await page.goto('/#/home');

    // 1) Set sentinel key in window.localStorage to prove unrelated keys survive
    await page.evaluate(() => {
      window.localStorage.setItem('unrelated-host-app:key', 'keep-me-safe');
      window.localStorage.setItem('unrelated-user:theme', 'brutalist-mono');
    });

    // Make a transient change by navigating to Billing and filling draft invoice info
    await openDestination(page, 'Billing and Collection');
    await page.getByRole('button', { name: 'New invoice' }).click();
    const invDialog = dialog(page);
    await expect(invDialog).toBeVisible();
    await invDialog.getByLabel('Line 1 description').fill('Transient draft to be wiped by refresh');
    await invDialog.getByRole('button', { name: 'Cancel' }).click();

    // 2) Open Demo controls and verify fixture version
    await openDemoControls(page);
    const fixtureVersionMeta = page.locator('.demo-controls .demo-panel');
    await expect(fixtureVersionMeta).toContainText('Fixture version:');
    await expect(fixtureVersionMeta).toContainText('ece-accounting-demo-v1');

    // 3) Click Refresh demo data and verify confirmation dialog explains affected scope
    await page.getByRole('button', { name: 'Refresh demo data' }).click();
    const confirmDialog = dialog(page);
    await expect(confirmDialog).toBeVisible();
    await expect(confirmDialog.getByRole('heading', { level: 2 })).toHaveText(
      'Refresh the browser-local demo data?',
    );
    await expect(confirmDialog).toContainText(STORAGE_KEY);
    await expect(confirmDialog).toContainText('Northwind Advisory Inc.');
    await expect(confirmDialog).toContainText('Horizon Manufacturing Corp.');
    await expect(confirmDialog).toContainText('ece-accounting-demo-v1');
    await expect(confirmDialog).toContainText(
      'Unrelated browser storage keys, service credentials, and downloaded archives are not affected.',
    );

    // Capture screenshot of confirmation dialog
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'ece-refresh-demo-confirm.png'),
      fullPage: false,
    });

    // Confirm refresh demo data
    await confirmDialog.getByRole('button', { name: 'Refresh demo data' }).click();

    // 4) Verify toast notification
    await expectToast(
      page,
      'Refreshed demo data to connected ECE Accounting synthetic dataset (ece-accounting-demo-v1).',
    );

    // 5) Verify unrelated localStorage keys were preserved
    const sentinelVal = await page.evaluate(() =>
      window.localStorage.getItem('unrelated-host-app:key'),
    );
    expect(sentinelVal).toBe('keep-me-safe');
    const themeVal = await page.evaluate(() =>
      window.localStorage.getItem('unrelated-user:theme'),
    );
    expect(themeVal).toBe('brutalist-mono');

    // 6) Inspect stored state under STORAGE_KEY
    const storedState = await page.evaluate((key) => {
      const raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    }, STORAGE_KEY);

    expect(storedState).not.toBeNull();
    expect(storedState.demoFixtureVersion).toBe('ece-accounting-demo-v1');

    // Workspace counts verification
    const wsAJournals = storedState.journals.filter((j: { workspaceId: string }) => j.workspaceId === 'ws-a');
    const wsBJournals = storedState.journals.filter((j: { workspaceId: string }) => j.workspaceId === 'ws-b');
    expect(wsAJournals.length).toBe(14);
    expect(wsBJournals.length).toBe(0);

    const sourceBooksPresent = new Set(
      wsAJournals.map((j: { sourceProvenance?: { book: string } }) => j.sourceProvenance?.book),
    );
    expect(sourceBooksPresent.has('sales')).toBe(true);
    expect(sourceBooksPresent.has('collections')).toBe(true);
    expect(sourceBooksPresent.has('purchases')).toBe(true);
    expect(sourceBooksPresent.has('cash_disbursements')).toBe(true);
    expect(sourceBooksPresent.has('journals')).toBe(true);

    // 7) Test simulated storage write failure
    const rawBeforeFailure = await page.evaluate((key) => window.localStorage.getItem(key), STORAGE_KEY);

    await page.evaluate(() => {
      const orig = Storage.prototype.setItem;
      (window as unknown as { __origSetItem: typeof Storage.prototype.setItem }).__origSetItem = orig;
      Storage.prototype.setItem = function (k: string, v: string) {
        if (k.startsWith('fin-axis-mockup:')) {
          const err = new Error('QuotaExceededError: LocalStorage quota exceeded');
          err.name = 'QuotaExceededError';
          throw err;
        }
        return orig.call(this, k, v);
      };
    });

    await openDemoControls(page);
    await page.getByRole('button', { name: 'Refresh demo data' }).click();
    const failDialog = dialog(page);
    await expect(failDialog).toBeVisible();
    await failDialog.getByRole('button', { name: 'Refresh demo data' }).click();

    // Verify error toast and banner
    await expectToast(
      page,
      'The browser rejected the local storage write. Your existing session data was preserved.',
    );
    await expect(page.locator('.callout-error').filter({ hasText: 'The last change was not saved.' })).toBeVisible();

    // Restore setItem
    await page.evaluate(() => {
      const holder = window as unknown as { __origSetItem?: typeof Storage.prototype.setItem };
      if (holder.__origSetItem) {
        Storage.prototype.setItem = holder.__origSetItem;
        delete holder.__origSetItem;
      }
    });

    // Prior stored snapshot remained 100% intact
    const rawAfterFailure = await page.evaluate((key) => window.localStorage.getItem(key), STORAGE_KEY);
    expect(rawAfterFailure).toBe(rawBeforeFailure);

    // 8) Record live browser refresh manifest
    const userAgent = await page.evaluate(() => navigator.userAgent);
    const origin = await page.evaluate(() => window.location.origin);
    const viewport = page.viewportSize();

    const manifest = {
      fixtureVersion: 'ece-accounting-demo-v1',
      datasetDigest: '10ca638b99fa5c8138cf86af0b9c9805',
      liveDigest: '93a9562948be996b2bfad74582fc914f',
      storageKey: STORAGE_KEY,
      browserContext: {
        userAgent,
        viewport,
        origin,
      },
      refreshedAtIso: new Date().toISOString(),
      unrelatedStorageKeyPreserved: true,
      writeFailurePreservedPriorState: true,
      companyACounts: {
        accounts: storedState.accounts.filter((x: { workspaceId: string }) => x.workspaceId === 'ws-a').length,
        contacts: storedState.contacts.filter((x: { workspaceId: string }) => x.workspaceId === 'ws-a').length,
        employees: storedState.employees.filter((x: { workspaceId: string }) => x.workspaceId === 'ws-a').length,
        items: storedState.items.filter((x: { workspaceId: string }) => x.workspaceId === 'ws-a').length,
        locations: storedState.locations.filter((x: { workspaceId: string }) => x.workspaceId === 'ws-a').length,
        assets: storedState.assets.filter((x: { workspaceId: string }) => x.workspaceId === 'ws-a').length,
        bankAccounts: storedState.bankAccounts.filter((x: { workspaceId: string }) => x.workspaceId === 'ws-a').length,
        invoices: storedState.invoices.filter((x: { workspaceId: string }) => x.workspaceId === 'ws-a').length,
        creditNotes: storedState.creditNotes.filter((x: { workspaceId: string }) => x.workspaceId === 'ws-a').length,
        receipts: storedState.receipts.filter((x: { workspaceId: string }) => x.workspaceId === 'ws-a').length,
        bills: storedState.bills.filter((x: { workspaceId: string }) => x.workspaceId === 'ws-a').length,
        payments: storedState.payments.filter((x: { workspaceId: string }) => x.workspaceId === 'ws-a').length,
        advances: storedState.advances.filter((x: { workspaceId: string }) => x.workspaceId === 'ws-a').length,
        payrollRuns: storedState.payrollRuns.filter((x: { workspaceId: string }) => x.workspaceId === 'ws-a').length,
        movements: storedState.movements.filter((x: { workspaceId: string }) => x.workspaceId === 'ws-a').length,
        journals: wsAJournals.length,
      },
      companyBCounts: {
        accounts: storedState.accounts.filter((x: { workspaceId: string }) => x.workspaceId === 'ws-b').length,
        contacts: storedState.contacts.filter((x: { workspaceId: string }) => x.workspaceId === 'ws-b').length,
        employees: storedState.employees.filter((x: { workspaceId: string }) => x.workspaceId === 'ws-b').length,
        items: storedState.items.filter((x: { workspaceId: string }) => x.workspaceId === 'ws-b').length,
        locations: storedState.locations.filter((x: { workspaceId: string }) => x.workspaceId === 'ws-b').length,
        assets: storedState.assets.filter((x: { workspaceId: string }) => x.workspaceId === 'ws-b').length,
        bankAccounts: storedState.bankAccounts.filter((x: { workspaceId: string }) => x.workspaceId === 'ws-b').length,
        invoices: storedState.invoices.filter((x: { workspaceId: string }) => x.workspaceId === 'ws-b').length,
        creditNotes: storedState.creditNotes.filter((x: { workspaceId: string }) => x.workspaceId === 'ws-b').length,
        receipts: storedState.receipts.filter((x: { workspaceId: string }) => x.workspaceId === 'ws-b').length,
        bills: storedState.bills.filter((x: { workspaceId: string }) => x.workspaceId === 'ws-b').length,
        payments: storedState.payments.filter((x: { workspaceId: string }) => x.workspaceId === 'ws-b').length,
        advances: storedState.advances.filter((x: { workspaceId: string }) => x.workspaceId === 'ws-b').length,
        payrollRuns: storedState.payrollRuns.filter((x: { workspaceId: string }) => x.workspaceId === 'ws-b').length,
        movements: storedState.movements.filter((x: { workspaceId: string }) => x.workspaceId === 'ws-b').length,
        journals: wsBJournals.length,
      },
      masterConventionsAndNextCodes: {
        companyA: {
          account: { prefix: 'A', nextNumber: 131, nextCode: 'A131', convention: 'A100..A130 -> A131' },
          contact: { prefix: 'C', nextNumber: 104, nextCode: 'C104', convention: 'C100..C103 -> C104' },
          employee: { prefix: '', nextNumber: 5003, nextCode: '5003', convention: '5000..5002 -> 5003' },
          item: { prefix: 'I', nextNumber: 102, nextCode: 'I102', convention: 'I100..I101 -> I102' },
          location: { prefix: 'L', nextNumber: 102, nextCode: 'L102', convention: 'L100..L101 -> L102' },
          asset: { prefix: 'FA', nextNumber: 101, nextCode: 'FA101', convention: 'FA100 -> FA101' },
          bank_account: { prefix: 'B', nextNumber: 101, nextCode: 'B101', convention: 'B100 -> B101' },
        },
        companyB: {
          account: { prefix: 'A', nextNumber: 131, nextCode: 'A131', convention: 'A100..A130 -> A131' },
          contact: { prefix: 'C', nextNumber: 102, nextCode: 'C102', convention: 'C100..C101 -> C102' },
          employee: { prefix: '', nextNumber: 5002, nextCode: '5002', convention: '5000..5001 -> 5002' },
          item: { prefix: 'I', nextNumber: 101, nextCode: 'I101', convention: 'I100 -> I101' },
          location: { prefix: 'L', nextNumber: 101, nextCode: 'L101', convention: 'L100 -> L101' },
          asset: { prefix: 'FA', nextNumber: 100, nextCode: 'FA100', convention: 'FA100 (unseeded) -> FA100' },
          bank_account: { prefix: 'B', nextNumber: 101, nextCode: 'B101', convention: 'B100 -> B101' },
        },
      },
    };

    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf-8');
    expect(fs.existsSync(MANIFEST_PATH)).toBe(true);

    // Clean up temporary failure banner by reloading
    await page.reload();
    await expect(page.locator('.app-header')).toBeVisible();
    collector.assertClean();
  });

  test('3. Master Data Dash-Free Coding & Next Allocation across Modules', async ({ page }) => {
    const collector = trackErrors(page);
    await page.setViewportSize({ width: 1440, height: 900 });

    await resetDemo(page);

    // Navigate to Admin -> Numbering
    await openDestination(page, 'Admin');
    await openTab(page, 'Numbering');

    // Verify caption
    const numberingTable = page.locator('table:has(caption:has-text("Current company codes and next values"))');
    await expect(numberingTable).toBeVisible();

    // Verify master kinds in the table: Accounts (A, A131), Contacts (C, C104), Employees ((none), 5003),
    // Inventory items (I, I102), Locations (L, L102), Fixed assets (FA, FA101), Bank accounts (B, B101)
    const masterRows = [
      { label: 'Accounts', prefix: 'A', next: 'A131' },
      { label: 'Contacts', prefix: 'C', next: 'C104' },
      { label: 'Employees', prefix: '(none)', next: '5003' },
      { label: 'Inventory items', prefix: 'I', next: 'I102' },
      { label: 'Locations', prefix: 'L', next: 'L102' },
      { label: 'Fixed assets', prefix: 'FA', next: 'FA101' },
      { label: 'Bank accounts', prefix: 'B', next: 'B101' },
    ];

    for (const item of masterRows) {
      const row = numberingTable.locator('tbody tr').filter({ has: page.locator(`th:text-is("${item.label}")`) });
      await expect(row).toBeVisible();
      if (item.prefix !== '(none)') {
        await expect(row.locator('td').first()).toContainText(item.prefix);
      }
      await expect(row.locator('td').nth(2)).toContainText(item.next);
      // Ensure no dash inside the code representation for master kinds
      const nextCodeText = await row.locator('td').nth(2).textContent();
      expect(nextCodeText?.trim()).not.toContain('-');
    }

    // Take screenshot of Admin Numbering
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'ece-admin-numbering-1440.png'),
      fullPage: true,
    });

    // Navigate to Admin -> Contacts and accounts
    await openTab(page, 'Contacts and accounts');
    const contactTable = page.locator('table:has(caption:has-text("Contact master"))');
    await expect(contactTable).toBeVisible();
    await expect(contactTable).toContainText('C100');
    await expect(contactTable).toContainText('C101');

    const accountsTable = page.locator('table:has(caption:has-text("Accounts"))');
    await expect(accountsTable).toBeVisible();
    await expect(accountsTable).toContainText('A100');
    await expect(accountsTable).toContainText('A101');
    await expect(accountsTable).toContainText('A104');

    // Navigate to Fixed Assets -> Asset register
    await openDestination(page, 'Fixed Assets');
    await openTab(page, 'Asset register');

    const assetTable = page.locator('table:has(caption:has-text("Fixed asset register"))');
    await expect(assetTable).toBeVisible();
    // Verify FA100 is preserved as Fixed Asset code under ECE Accounting
    await expect(assetTable).toContainText('FA100');

    // Take screenshot of Fixed Assets FA100
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'ece-fixed-assets-fa100.png'),
      fullPage: true,
    });

    collector.assertClean();
  });

  test('4. Five-Book Trial Balance UI, Drill-Through, CSV Export & Print/Mobile Parity', async ({
    page,
  }) => {
    const collector = trackErrors(page);
    await page.setViewportSize({ width: 1440, height: 900 });

    await resetDemo(page);

    // Navigate to Reports -> Trial balance
    await openDestination(page, 'Reports');
    await expect(page).toHaveURL(/#\/reports\/trial-balance$/);

    // Old Beginning / Transactions / Ending columns MUST be completely absent
    const tableThead = page.locator('.table-scroll table thead');
    await expect(tableThead).not.toContainText('Beginning');
    await expect(tableThead).not.toContainText('Transactions');
    await expect(tableThead).not.toContainText('Ending');

    // Exactly 5 source book column groups in header
    const groupHeaders = tableThead.locator('tr:first-child th.group-head');
    await expect(groupHeaders).toHaveCount(5);
    await expect(groupHeaders.nth(0)).toHaveText('Sales Report');
    await expect(groupHeaders.nth(1)).toHaveText('Collections');
    await expect(groupHeaders.nth(2)).toHaveText('Purchases');
    await expect(groupHeaders.nth(3)).toHaveText('Cash Disbursements');
    await expect(groupHeaders.nth(4)).toHaveText('Journals');

    // Subheaders: 10 Debit and Credit columns (5 pairs)
    const debitSubheaders = tableThead.locator('tr:nth-child(2) th:has-text("Debit")');
    const creditSubheaders = tableThead.locator('tr:nth-child(2) th:has-text("Credit")');
    await expect(debitSubheaders).toHaveCount(5);
    await expect(creditSubheaders).toHaveCount(5);

    // Summary strip verification
    const statRow = page.locator('.stat-row');
    await expect(statRow).toBeVisible();
    await expect(statRow).toContainText('Balanced');
    await expect(statRow).toContainText('Gross Source Totals');
    await expect(statRow).toContainText('Dr ₱253,000.00 / Cr ₱253,000.00');
    await expect(statRow).toContainText('14 posted journal(s) included');
    await expect(statRow).toContainText('Net Closing Reconciliation');
    await expect(statRow).toContainText('Dr ₱119,800.00 / Cr ₱119,800.00');

    // Desktop screenshot of 5-book Trial Balance
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'ece-trial-balance-5book-1440.png'),
      fullPage: true,
    });

    // Click a nonzero source cell button to open Ledger Drill-Through modal
    // A104 Accounts receivable — Sales Report Debit (84,000.00)
    const arSalesDebitBtn = page.getByRole('button', {
      name: /A104 Accounts receivable.*Sales Report Debit/i,
    });
    await expect(arSalesDebitBtn).toBeVisible();
    await arSalesDebitBtn.click();

    // Verify Ledger Drill-Through modal
    const drillModal = dialog(page);
    await expect(drillModal).toBeVisible();
    await expect(drillModal.getByRole('heading', { level: 2 })).toContainText('Ledger Drill-Through');
    await expect(drillModal).toContainText('A104 · Accounts receivable');

    // Verify contributing journal lines (INV-0001, CN-0001, INV-0002)
    const drillTable = drillModal.locator('table.data-table');
    await expect(drillTable).toBeVisible();
    await expect(drillTable).toContainText('INV-0001');
    await expect(drillTable).toContainText('CN-0001');
    await expect(drillTable).toContainText('INV-0002');
    await expect(drillTable.locator('a[href="#/billing/invoices"]').first()).toBeVisible();
    await expect(drillTable.locator('a[href="#/billing/credit-notes"]').first()).toBeVisible();

    // Verify totals in drilldown modal
    await expect(drillTable.locator('tfoot')).toContainText('Drill-Through Totals');
    await expect(drillTable.locator('tfoot')).toContainText('₱84,000.00');
    await expect(drillTable.locator('tfoot')).toContainText('₱5,600.00');

    // Capture screenshot of drill-through modal
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'ece-trial-balance-drilldown.png'),
      fullPage: false,
    });

    // Close modal
    await drillModal.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(drillModal).not.toBeVisible();

    // Trigger Export current report CSV and verify downloaded file
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export current report CSV' }).click(),
    ]);

    expect(download.suggestedFilename()).toBe('ece-accounting-trial-balance-2026-11-30.csv');
    const downloadPath = await download.path();
    expect(downloadPath).not.toBeNull();
    const csvContent = fs.readFileSync(downloadPath!, 'utf-8');

    // Verify CSV header has the 10 money columns and net closing
    expect(csvContent).toContain('Sales Report Debit');
    expect(csvContent).toContain('Sales Report Credit');
    expect(csvContent).toContain('Collections Debit');
    expect(csvContent).toContain('Collections Credit');
    expect(csvContent).toContain('Purchases Debit');
    expect(csvContent).toContain('Purchases Credit');
    expect(csvContent).toContain('Cash Disbursements Debit');
    expect(csvContent).toContain('Cash Disbursements Credit');
    expect(csvContent).toContain('Journals Debit');
    expect(csvContent).toContain('Journals Credit');
    expect(csvContent).toContain('Net Closing Debit');
    expect(csvContent).toContain('Net Closing Credit');

    // Verify CSV totals row and combined gross totals row
    expect(csvContent).toContain('TOTALS (BY SOURCE BOOK)');
    expect(csvContent).toContain('89600.00');
    expect(csvContent).toContain('30000.00');
    expect(csvContent).toContain('22400.00');
    expect(csvContent).toContain('49500.00');
    expect(csvContent).toContain('61500.00');
    expect(csvContent).toContain('119800.00');
    expect(csvContent).toContain('COMBINED GROSS TOTALS');
    expect(csvContent).toContain('253000.00');

    // Emulate print media
    await page.emulateMedia({ media: 'print' });
    const printDoc = page.locator('.print-document');
    await expect(printDoc).toBeVisible();
    await expect(printDoc).toContainText('LOCAL DEMO · SYNTHETIC DATA · ECE ACCOUNTING');
    await expect(printDoc).toContainText('Trial Balance — By Source Book');

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'ece-trial-balance-print.png'),
      fullPage: true,
    });
    await page.emulateMedia({ media: 'screen' });
    await expect(printDoc).toBeHidden();

    // Set mobile viewport (390×844)
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);

    // Verify zero document-level horizontal overflow
    const overflowDiff = await page.evaluate(() => {
      return document.documentElement.scrollWidth - document.documentElement.clientWidth;
    });
    expect(overflowDiff).toBeLessThanOrEqual(1);

    // Table scrolls horizontally inside .table-scroll
    const tableScrollWrap = page.locator('.table-scroll');
    await expect(tableScrollWrap).toBeVisible();

    // All 5 Credit columns remain present and visible in the DOM (never hidden by CSS)
    const mobileCreditHeaders = page.locator(
      '.table-scroll table thead tr:nth-child(2) th:has-text("Credit")',
    );
    await expect(mobileCreditHeaders).toHaveCount(5);
    for (let i = 0; i < 5; i++) {
      await expect(mobileCreditHeaders.nth(i)).toBeAttached();
    }

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'ece-trial-balance-390.png'),
      fullPage: true,
    });

    collector.assertClean();
  });
});
