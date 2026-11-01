import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  sourceBookTrialBalance,
  trialBalance,
  trialBalanceCellDrilldown,
} from '../../src/domain/queries';
import {
  backfillJournalProvenance,
  resolveJournalProvenance,
} from '../../src/domain/ledger';
import type { Account, AppState, Journal, SourceBookKey } from '../../src/domain/schema';
import { ACCOUNTS, createHarness } from './harness';
import { createSeedState, WORKSPACE_A } from '../../src/fixtures/seed';

interface FixtureBook {
  key: SourceBookKey;
  label: string;
}

interface FixtureAccount {
  id: string;
  code: string;
  name: string;
  type: Account['type'];
}

interface FixtureJournalLine {
  accountId: string;
  debitCentavos: number;
  creditCentavos: number;
}

interface FixtureJournalInput {
  id: string;
  workspaceId: string;
  postingDate: string;
  sourceType: string;
  expectedBook: SourceBookKey;
  lines: FixtureJournalLine[];
}

interface FixtureRow {
  accountId: string;
  code: string;
  books: Record<SourceBookKey, { debitCentavos: number; creditCentavos: number }>;
  netBalance: { debitCentavos: number; creditCentavos: number };
}

interface OracleFixture {
  fixtureSchemaVersion: number;
  name: string;
  currency: string;
  moneyUnit: string;
  policy: string;
  scope: {
    mode: 'as_of' | 'activity';
    toDate: string;
    workspaceId: string;
  };
  books: FixtureBook[];
  accounts: FixtureAccount[];
  postedJournalInputs: FixtureJournalInput[];
  expectedRows: FixtureRow[];
  expectedBookTotals: Record<SourceBookKey, { debitCentavos: number; creditCentavos: number }>;
  expectedGrossTotals: { debitCentavos: number; creditCentavos: number };
  expectedNetBalanceTotals: { debitCentavos: number; creditCentavos: number };
  expectedIncludedJournalCount: number;
  requiredVisibleZeroNetAccounts: string[];
}

function loadOracleFixture(): OracleFixture {
  const fixturePath = resolve(__dirname, '../fixtures/trial-balance-oracle.json');
  const raw = readFileSync(fixturePath, 'utf-8');
  return JSON.parse(raw) as OracleFixture;
}

function createMinimalState(overrides: Partial<AppState> = {}): AppState {
  const seed = createSeedState();
  return {
    ...seed,
    accounts: [],
    journals: [],
    workspaces: [
      {
        ...seed.workspaces[0]!,
        id: 'fixture-company-a',
        name: 'Company A',
      },
      {
        ...seed.workspaces[1]!,
        id: 'fixture-company-b',
        name: 'Company B',
      },
    ],
    memberships: [
      {
        userId: 'user-accountant',
        workspaceId: 'fixture-company-a',
        roles: ['accountant'],
        payrollDetail: false,
        archiveGrant: false,
        active: true,
        seatId: null,
      },
      {
        userId: 'user-payroll',
        workspaceId: 'fixture-company-a',
        roles: ['accountant'],
        payrollDetail: true,
        archiveGrant: false,
        active: true,
        seatId: null,
      },
    ],
    ...overrides,
  };
}

describe('ECE Accounting source-book Trial Balance and Provenance', () => {
  it('1. matches exact ECE-ACCOUNTING-TRIAL-BALANCE-FIXTURE.json oracle numbers and AP visibility', () => {
    const fixture = loadOracleFixture();
    expect(fixture.fixtureSchemaVersion).toBe(1);

    const accounts: Account[] = fixture.accounts.map((acc) => ({
      id: acc.id,
      workspaceId: fixture.scope.workspaceId,
      code: acc.code,
      name: acc.name,
      type: acc.type,
      normalBalance: acc.type === 'asset' || acc.type === 'expense' ? 'debit' : 'credit',
      controlRole: null,
      active: true,
    }));

    const journals: Journal[] = fixture.postedJournalInputs.map((input, index) => ({
      id: input.id,
      workspaceId: input.workspaceId,
      journalNo: `JV-${String(index + 1).padStart(4, '0')}`,
      postingDate: input.postingDate,
      documentDate: input.postingDate,
      sourceType: input.sourceType,
      sourceId: input.id,
      effectKey: `fx-${input.id}`,
      memo: `Fixture journal ${input.id}`,
      lines: input.lines.map((line) => {
        const acc = accounts.find((a) => a.id === line.accountId)!;
        return {
          accountId: acc.id,
          accountCode: acc.code,
          debitCentavos: line.debitCentavos,
          creditCentavos: line.creditCentavos,
          memo: `Line for ${acc.name}`,
        };
      }),
      status: 'posted',
      createdBy: 'user-1',
      createdAt: '2026-10-31T00:00:00Z',
      approvedBy: 'user-1',
      policySnapshot: null,
      reversalOf: null,
      reversedBy: null,
    }));

    // Backfill provenance on raw fixture journals
    const state = backfillJournalProvenance(
      createMinimalState({
        accounts,
        journals,
      }),
    );

    // Verify backfilled provenance matches expectedBook
    for (const [i, input] of fixture.postedJournalInputs.entries()) {
      const j = state.journals[i]!;
      expect(j.sourceProvenance).toBeDefined();
      expect(j.sourceProvenance?.book).toBe(input.expectedBook);
      expect(j.sourceProvenance?.provisional).toBe(false);
    }

    const tb = trialBalance(state, fixture.scope.workspaceId, null, fixture.scope.toDate);

    expect(tb.mode).toBe('as_of');
    expect(tb.asOfDate).toBe(fixture.scope.toDate);
    expect(tb.includedJournalCount).toBe(fixture.expectedIncludedJournalCount);
    expect(tb.classificationExceptions).toHaveLength(0);
    expect(tb.balanced).toBe(true);

    // Check each expected account row
    for (const expectedRow of fixture.expectedRows) {
      const row = tb.rows.find((r) => r.accountId === expectedRow.accountId);
      expect(row, `Account ${expectedRow.accountId} must be present in rows`).toBeDefined();
      expect(row!.accountCode).toBe(expectedRow.code);
      expect(row!.books).toEqual(expectedRow.books);
      expect(row!.netBalance).toEqual(expectedRow.netBalance);
    }

    // Explicit AP zero-net verification
    const apRow = tb.rows.find((r) => r.accountId === 'ap')!;
    expect(apRow).toBeDefined();
    expect(apRow.books.purchases).toEqual({ debitCentavos: 0, creditCentavos: 50_000 });
    expect(apRow.books.cash_disbursements).toEqual({ debitCentavos: 50_000, creditCentavos: 0 });
    expect(apRow.netBalance).toEqual({ debitCentavos: 0, creditCentavos: 0 });

    // Check book totals
    expect(tb.bookTotals).toEqual(fixture.expectedBookTotals);

    // Check gross totals (12,500.00 PHP = 1,250,000 centavos per side)
    expect(tb.grossTotals).toEqual(fixture.expectedGrossTotals);

    // Check net balance totals (11,000.00 PHP = 1,100,000 centavos per side)
    expect(tb.netBalanceTotals).toEqual(fixture.expectedNetBalanceTotals);

    // Parity with sourceBookTrialBalance helper
    const sbTb = sourceBookTrialBalance(state, fixture.scope.workspaceId, {
      toDate: fixture.scope.toDate,
      mode: 'as_of',
    });
    expect(sbTb.bookTotals).toEqual(tb.bookTotals);
    expect(sbTb.grossTotals).toEqual(tb.grossTotals);
    expect(sbTb.netBalanceTotals).toEqual(tb.netBalanceTotals);
  });

  it('2. date-cutoff reversal: invoice posted 2026-11-10, reversed 2026-11-20', () => {
    const accounts: Account[] = [
      {
        id: 'acc-ar',
        workspaceId: 'fixture-company-a',
        code: 'A101',
        name: 'Accounts Receivable',
        type: 'asset',
        normalBalance: 'debit',
        controlRole: 'ar',
        active: true,
      },
      {
        id: 'acc-rev',
        workspaceId: 'fixture-company-a',
        code: 'A104',
        name: 'Sales Revenue',
        type: 'revenue',
        normalBalance: 'credit',
        controlRole: null,
        active: true,
      },
    ];

    const invJournal: Journal = {
      id: 'jv-inv-1',
      workspaceId: 'fixture-company-a',
      journalNo: 'JV-0001',
      postingDate: '2026-11-10',
      documentDate: '2026-11-10',
      sourceType: 'invoice',
      sourceId: 'inv-1',
      effectKey: 'invoice:inv-1',
      memo: 'Sale INV-0001',
      lines: [
        { accountId: 'acc-ar', accountCode: 'A101', debitCentavos: 100_000, creditCentavos: 0, memo: 'AR' },
        { accountId: 'acc-rev', accountCode: 'A104', debitCentavos: 0, creditCentavos: 100_000, memo: 'Revenue' },
      ],
      status: 'posted',
      createdBy: 'user-1',
      createdAt: '2026-11-10T00:00:00Z',
      approvedBy: 'user-1',
      policySnapshot: null,
      reversalOf: null,
      reversedBy: 'jv-rev-1',
    };

    const revJournal: Journal = {
      id: 'jv-rev-1',
      workspaceId: 'fixture-company-a',
      journalNo: 'JV-0002',
      postingDate: '2026-11-20',
      documentDate: '2026-11-20',
      sourceType: 'invoice_reversal',
      sourceId: 'inv-1',
      effectKey: 'journal-reversal:jv-inv-1',
      memo: 'Reversal · Sale INV-0001 · Customer cancellation',
      lines: [
        { accountId: 'acc-ar', accountCode: 'A101', debitCentavos: 0, creditCentavos: 100_000, memo: 'Reversal: AR' },
        { accountId: 'acc-rev', accountCode: 'A104', debitCentavos: 100_000, creditCentavos: 0, memo: 'Reversal: Revenue' },
      ],
      status: 'posted',
      createdBy: 'user-1',
      createdAt: '2026-11-20T00:00:00Z',
      approvedBy: 'user-1',
      policySnapshot: null,
      reversalOf: 'jv-inv-1',
      reversedBy: null,
    };

    const state = backfillJournalProvenance(
      createMinimalState({
        accounts,
        journals: [invJournal, revJournal],
      }),
    );

    // As of 2026-11-15: only invoice is included
    const early = trialBalance(state, 'fixture-company-a', null, '2026-11-15');
    expect(early.includedJournalCount).toBe(1);
    expect(early.bookTotals.sales).toEqual({ debitCentavos: 100_000, creditCentavos: 100_000 });
    const earlyAr = early.rows.find((r) => r.accountId === 'acc-ar')!;
    expect(earlyAr.books.sales).toEqual({ debitCentavos: 100_000, creditCentavos: 0 });
    expect(earlyAr.netBalance).toEqual({ debitCentavos: 100_000, creditCentavos: 0 });

    // As of 2026-11-25: both are included in Sales Report
    const late = trialBalance(state, 'fixture-company-a', null, '2026-11-25');
    expect(late.includedJournalCount).toBe(2);
    expect(late.bookTotals.sales).toEqual({ debitCentavos: 200_000, creditCentavos: 200_000 });
    expect(late.grossTotals).toEqual({ debitCentavos: 200_000, creditCentavos: 200_000 });
    expect(late.netBalanceTotals).toEqual({ debitCentavos: 0, creditCentavos: 0 });

    const lateAr = late.rows.find((r) => r.accountId === 'acc-ar')!;
    expect(lateAr.books.sales).toEqual({ debitCentavos: 100_000, creditCentavos: 100_000 });
    expect(lateAr.netBalance).toEqual({ debitCentavos: 0, creditCentavos: 0 });

    const lateRev = late.rows.find((r) => r.accountId === 'acc-rev')!;
    expect(lateRev.books.sales).toEqual({ debitCentavos: 100_000, creditCentavos: 100_000 });
    expect(lateRev.netBalance).toEqual({ debitCentavos: 0, creditCentavos: 0 });
  });

  it('3. bank clearing & clearing-undo inherits original book even after operational match links are cleared', () => {
    const h = createHarness();

    // 1) Receipt with incoming clearing
    const receipt = h.runOk({
      type: 'receipt.create',
      input: {
        customerContactId: 'contact-a-cust-1',
        receiptDate: '2026-11-06',
        amountCentavos: 40_000,
        bankAccountId: 'bank-a-1',
        method: 'incoming_clearing',
        reference: 'CLR-REC-01',
        allocations: [],
      },
    });

    const receiptJournal = h.state.journals.find((j) => j.sourceId === receipt.documentId)!;
    expect(receiptJournal.sourceProvenance?.book).toBe('collections');

    // 2) Import and match bank row against incoming clearing receipt
    h.runOk({
      type: 'bankRow.import',
      input: {
        bankAccountId: 'bank-a-1',
        sourceName: 'synthetic-receipt-test.csv',
        rows: [
          {
            rowRef: 'BNK-REC-40K',
            valueDate: '2026-11-06',
            description: 'Customer clearing deposit',
            direction: 'in',
            amountCentavos: 40_000,
          },
        ],
      },
    });

    const bankRow = h.state.bankRows.find((r) => r.rowRef === 'BNK-REC-40K')!;
    expect(bankRow).toBeDefined();

    h.runOk({
      type: 'bankRow.match',
      input: {
        rowId: bankRow.id,
        sourceType: 'customer_receipt',
        sourceId: receipt.documentId,
        reason: 'Receipt clearing match',
      },
    });

    const clearingJournal = h.state.journals.find(
      (j) => j.sourceType === 'bank_clearing' && j.sourceId === bankRow.id,
    )!;
    expect(clearingJournal).toBeDefined();
    expect(clearingJournal.sourceProvenance?.book).toBe('collections');
    expect(clearingJournal.sourceProvenance?.clearingTargetType).toBe('customer_receipt');

    // 3) Undo bank match
    h.runOk({
      type: 'bankRow.undo',
      input: {
        rowId: bankRow.id,
        reversalDate: '2026-11-08',
        reason: 'Incorrect match reference',
      },
    });

    const undoneRow = h.state.bankRows.find((r) => r.id === bankRow.id)!;
    expect(undoneRow.status).toBe('unmatched');
    expect(undoneRow.matchedSourceType).toBeNull();
    expect(undoneRow.clearingJournalId).toBeNull();

    // The bank_clearing_undo journal MUST have inherited Collections book and origin references!
    const undoJournal = h.state.journals.find((j) => j.sourceType === 'bank_clearing_undo')!;
    expect(undoJournal).toBeDefined();
    expect(undoJournal.sourceProvenance?.book).toBe('collections');
    expect(undoJournal.sourceProvenance?.originJournalId).toBe(clearingJournal.id);
    expect(undoJournal.sourceProvenance?.clearingTargetType).toBe('customer_receipt');
    expect(undoJournal.sourceProvenance?.provisional).toBe(false);

    // Verify trial balance includes both in Collections
    const tb = trialBalance(h.state, WORKSPACE_A, '2026-11-01', '2026-11-30');
    expect(tb.bookTotals.collections.debitCentavos).toBeGreaterThanOrEqual(80_000);
    expect(tb.bookTotals.collections.creditCentavos).toBeGreaterThanOrEqual(80_000);

    // 4) Supplier payment with outgoing clearing, match and undo both post to Cash Disbursements
    const bill = h.runOk({
      type: 'bill.create',
      input: {
        vendorContactId: 'contact-a-vend-1',
        supplierInvoiceNo: 'SUP-CLR-01',
        billDate: '2026-11-04',
        dueDate: '2026-11-30',
        lines: [
          {
            description: 'Synthetic service purchase',
            accountId: ACCOUNTS.adjustment,
            amountCentavos: 50_000,
            taxTreatment: 'none',
          },
        ],
      },
    });

    const rfp = h.runOk({
      type: 'rfp.create',
      input: { billId: bill.documentId, amountCentavos: 50_000 },
    });
    h.runOk({ type: 'rfp.approve', input: { rfpId: rfp.documentId } }, { actorId: 'u-checker' });
    const payment = h.runOk(
      {
        type: 'payment.create',
        input: { rfpId: rfp.documentId, paymentDate: '2026-11-05', method: 'outgoing_clearing' },
      },
      { actorId: 'u-accountant' },
    );

    const payJournal = h.state.journals.find((j) => j.id === payment.journalIds[0])!;
    expect(payJournal.sourceProvenance?.book).toBe('cash_disbursements');

    // Import outflow bank row
    h.runOk({
      type: 'bankRow.import',
      input: {
        bankAccountId: 'bank-a-1',
        sourceName: 'synthetic-payment-test.csv',
        rows: [
          {
            rowRef: 'BNK-PAY-50K',
            valueDate: '2026-11-07',
            description: 'Supplier clearing check',
            direction: 'out',
            amountCentavos: 50_000,
          },
        ],
      },
    });
    const payBankRow = h.state.bankRows.find((r) => r.rowRef === 'BNK-PAY-50K')!;

    // Match payment
    h.runOk({
      type: 'bankRow.match',
      input: {
        rowId: payBankRow.id,
        sourceType: 'payment',
        sourceId: payment.documentId,
        reason: 'Payment clearing match',
      },
    });

    const payClearingJournal = h.state.journals.find(
      (j) => j.sourceType === 'bank_clearing' && j.sourceId === payBankRow.id,
    )!;
    expect(payClearingJournal).toBeDefined();
    expect(payClearingJournal.sourceProvenance?.book).toBe('cash_disbursements');
    expect(payClearingJournal.sourceProvenance?.clearingTargetType).toBe('payment');

    // Undo match
    h.runOk({
      type: 'bankRow.undo',
      input: {
        rowId: payBankRow.id,
        reversalDate: '2026-11-09',
        reason: 'Payment clearing reversal test',
      },
    });

    const payUndoJournal = h.state.journals.find(
      (j) => j.sourceType === 'bank_clearing_undo' && j.reversalOf === payClearingJournal.id,
    )!;
    expect(payUndoJournal).toBeDefined();
    expect(payUndoJournal.sourceProvenance?.book).toBe('cash_disbursements');
    expect(payUndoJournal.sourceProvenance?.originJournalId).toBe(payClearingJournal.id);
    expect(payUndoJournal.sourceProvenance?.clearingTargetType).toBe('payment');
    expect(payUndoJournal.sourceProvenance?.provisional).toBe(false);
  });

  it('4. compound advance liquidation stays whole in Journals without line-splitting', () => {
    const h = createHarness();
    const adv = h.runOk({
      type: 'advance.create',
      input: {
        employeeId: 'emp-a-001',
        advanceDate: '2026-11-02',
        amountCentavos: 100_000,
        bankAccountId: 'bank-a-1',
      },
    });

    const advJournal = h.state.journals.find((j) => j.sourceId === adv.documentId)!;
    expect(advJournal.sourceProvenance?.book).toBe('cash_disbursements');

    // Compound liquidation: 80,000 expense + 20,000 unused cash return + 100,000 advance cleared
    h.runOk({
      type: 'advance.liquidate',
      input: {
        advanceId: adv.documentId,
        liquidationDate: '2026-11-09',
        expenses: [
          { accountId: ACCOUNTS.adjustment, description: 'Travel expense', amountCentavos: 80_000 },
        ],
        unusedReturnCentavos: 20_000,
        excessReimbursementCentavos: 0,
        bankAccountId: 'bank-a-1',
      },
    });

    const liqJournal = h.state.journals.find((j) => j.sourceType === 'advance_liquidation')!;
    expect(liqJournal).toBeDefined();
    expect(liqJournal.sourceProvenance?.book).toBe('journals');
    expect(liqJournal.lines).toHaveLength(3); // Expense Dr 80k, Bank Dr 20k, Advance Cr 100k
    expect(liqJournal.sourceProvenance?.provisional).toBe(false);

    const tb = trialBalance(h.state, WORKSPACE_A, '2026-11-01', '2026-11-30');
    // Whole journal debit 100k and credit 100k stays in Journals book
    expect(tb.bookTotals.journals.debitCentavos).toBeGreaterThanOrEqual(100_000);
    expect(tb.bookTotals.journals.creditCentavos).toBeGreaterThanOrEqual(100_000);
  });

  it('5. inventory valuation journals remain in Journals and subsequent bill links do not reclassify', () => {
    const h = createHarness();
    const item = h.state.items[0]!;
    const loc = h.state.locations[0]!;

    // Post standalone goods receipt movement
    const mv = h.runOk(
      {
        type: 'movement.receipt',
        input: {
          itemId: item.id,
          locationId: loc.id,
          occurredOn: '2026-11-03',
          quantityMilli: 10_000,
          unitCostCentavos: 500,
          sourceType: 'goods_receipt',
          sourceId: 'gr-01',
          effectKey: 'test-gr-val-01',
        },
      },
      { actorId: 'u-inventory' },
    );

    const mvJournal = h.state.journals.find((j) => j.sourceId === mv.documentId)!;
    expect(mvJournal).toBeDefined();
    expect(mvJournal.sourceType).toBe('inventory_receipt');
    expect(mvJournal.sourceProvenance?.book).toBe('journals');

    // Later bill is created
    const bill = h.runOk({
      type: 'bill.create',
      input: {
        vendorContactId: 'contact-a-vend-1',
        supplierInvoiceNo: 'SUP-INV-VAL',
        billDate: '2026-11-05',
        dueDate: '2026-11-30',
        lines: [
          {
            description: 'Inventory delivery',
            accountId: ACCOUNTS.adjustment,
            amountCentavos: 5_000,
            taxTreatment: 'none',
          },
        ],
      },
    });

    const billJournal = h.state.journals.find((j) => j.sourceId === bill.documentId)!;
    expect(billJournal.sourceProvenance?.book).toBe('purchases');

    // Inventory receipt journal remains in Journals!
    const recheckedMvJournal = h.state.journals.find((j) => j.sourceId === mv.documentId)!;
    expect(recheckedMvJournal.sourceProvenance?.book).toBe('journals');
  });

  it('6. payroll accrual is in Journals while payroll payment is in Cash Disbursements', () => {
    const accounts: Account[] = [
      {
        id: 'acc-sal-exp',
        workspaceId: 'fixture-company-a',
        code: 'A500',
        name: 'Salaries Expense',
        type: 'expense',
        normalBalance: 'debit',
        controlRole: null,
        active: true,
      },
      {
        id: 'acc-sal-pay',
        workspaceId: 'fixture-company-a',
        code: 'A200',
        name: 'Salaries Payable',
        type: 'liability',
        normalBalance: 'credit',
        controlRole: null,
        active: true,
      },
      {
        id: 'acc-bank',
        workspaceId: 'fixture-company-a',
        code: 'A100',
        name: 'Cash in Bank',
        type: 'asset',
        normalBalance: 'debit',
        controlRole: 'bank',
        active: true,
      },
    ];

    const accrualJournal: Journal = {
      id: 'jv-pr-run',
      workspaceId: 'fixture-company-a',
      journalNo: 'PR-RUN-001',
      postingDate: '2026-11-15',
      documentDate: '2026-11-15',
      sourceType: 'payroll_run',
      sourceId: 'pr-run-1',
      effectKey: 'payroll:pr-run-1',
      memo: 'Payroll period 2026-11-01 to 2026-11-15',
      lines: [
        { accountId: 'acc-sal-exp', accountCode: 'A500', debitCentavos: 250_000, creditCentavos: 0, memo: 'Gross salaries' },
        { accountId: 'acc-sal-pay', accountCode: 'A200', debitCentavos: 0, creditCentavos: 250_000, memo: 'Net payable' },
      ],
      status: 'posted',
      createdBy: 'user-1',
      createdAt: '2026-11-15T00:00:00Z',
      approvedBy: 'user-1',
      policySnapshot: null,
      reversalOf: null,
      reversedBy: null,
    };

    const paymentJournal: Journal = {
      id: 'jv-pr-pay',
      workspaceId: 'fixture-company-a',
      journalNo: 'PR-PAY-001',
      postingDate: '2026-11-16',
      documentDate: '2026-11-16',
      sourceType: 'payroll_payment',
      sourceId: 'pr-pay-1',
      effectKey: 'payroll-payment:pr-pay-1',
      memo: 'Disburse payroll PR-0001',
      lines: [
        { accountId: 'acc-sal-pay', accountCode: 'A200', debitCentavos: 250_000, creditCentavos: 0, memo: 'Clear salaries payable' },
        { accountId: 'acc-bank', accountCode: 'A100', debitCentavos: 0, creditCentavos: 250_000, memo: 'Bank outflow' },
      ],
      status: 'posted',
      createdBy: 'user-1',
      createdAt: '2026-11-16T00:00:00Z',
      approvedBy: 'user-1',
      policySnapshot: null,
      reversalOf: null,
      reversedBy: null,
    };

    const state = backfillJournalProvenance(
      createMinimalState({
        accounts,
        journals: [accrualJournal, paymentJournal],
      }),
    );

    const tb = trialBalance(state, 'fixture-company-a', '2026-11-01', '2026-11-30');
    expect(tb.bookTotals.journals).toEqual({ debitCentavos: 250_000, creditCentavos: 250_000 });
    expect(tb.bookTotals.cash_disbursements).toEqual({ debitCentavos: 250_000, creditCentavos: 250_000 });

    const payRow = tb.rows.find((r) => r.accountId === 'acc-sal-pay')!;
    expect(payRow.books.journals).toEqual({ debitCentavos: 0, creditCentavos: 250_000 });
    expect(payRow.books.cash_disbursements).toEqual({ debitCentavos: 250_000, creditCentavos: 0 });
    expect(payRow.netBalance).toEqual({ debitCentavos: 0, creditCentavos: 0 });
  });

  it('7. fixed asset acquisition, depreciation, and opening balances belong to Journals', () => {
    const provDepr = resolveJournalProvenance(
      { journals: [] },
      { sourceType: 'depreciation', sourceId: 'ast-1' } as Journal,
    );
    expect(provDepr.book).toBe('journals');

    const provAcq = resolveJournalProvenance(
      { journals: [] },
      { sourceType: 'asset_acquisition', sourceId: 'ast-1' } as Journal,
    );
    expect(provAcq.book).toBe('journals');

    const provOpening = resolveJournalProvenance(
      { journals: [] },
      { sourceType: 'opening', sourceId: 'op-1' } as Journal,
    );
    expect(provOpening.book).toBe('journals');

    const provStandalone = resolveJournalProvenance(
      { journals: [] },
      { sourceType: 'standalone_opening', sourceId: 'op-2' } as Journal,
    );
    expect(provStandalone.book).toBe('journals');
  });

  it('8. legacy/unrecognized sourceType or broken reversalOf is never omitted; surfaces provisional exception', () => {
    const accounts: Account[] = [
      {
        id: 'acc-bank',
        workspaceId: 'fixture-company-a',
        code: 'A100',
        name: 'Bank',
        type: 'asset',
        normalBalance: 'debit',
        controlRole: 'bank',
        active: true,
      },
      {
        id: 'acc-exp',
        workspaceId: 'fixture-company-a',
        code: 'A102',
        name: 'Expense',
        type: 'expense',
        normalBalance: 'debit',
        controlRole: null,
        active: true,
      },
    ];

    const unkJournal: Journal = {
      id: 'jv-unknown-1',
      workspaceId: 'fixture-company-a',
      journalNo: 'UNK-0001',
      postingDate: '2026-10-15',
      documentDate: '2026-10-15',
      sourceType: 'legacy_odd_source',
      sourceId: 'odd-1',
      effectKey: 'odd:1',
      memo: 'Unrecognized legacy feed',
      lines: [
        { accountId: 'acc-exp', accountCode: 'A102', debitCentavos: 12_345, creditCentavos: 0, memo: 'Debit' },
        { accountId: 'acc-bank', accountCode: 'A100', debitCentavos: 0, creditCentavos: 12_345, memo: 'Credit' },
      ],
      status: 'posted',
      createdBy: 'user-1',
      createdAt: '2026-10-15T00:00:00Z',
      approvedBy: 'user-1',
      policySnapshot: null,
      reversalOf: null,
      reversedBy: null,
    };

    const brokenRev: Journal = {
      id: 'jv-broken-rev',
      workspaceId: 'fixture-company-a',
      journalNo: 'REV-BROKEN',
      postingDate: '2026-10-16',
      documentDate: '2026-10-16',
      sourceType: 'journal_reversal',
      sourceId: 'non-existent-target',
      effectKey: 'broken-rev:1',
      memo: 'Reversal of missing journal',
      lines: [
        { accountId: 'acc-bank', accountCode: 'A100', debitCentavos: 5_000, creditCentavos: 0, memo: 'Debit' },
        { accountId: 'acc-exp', accountCode: 'A102', debitCentavos: 0, creditCentavos: 5_000, memo: 'Credit' },
      ],
      status: 'posted',
      createdBy: 'user-1',
      createdAt: '2026-10-16T00:00:00Z',
      approvedBy: 'user-1',
      policySnapshot: null,
      reversalOf: 'non-existent-target',
      reversedBy: null,
    };

    const state = backfillJournalProvenance(
      createMinimalState({
        accounts,
        journals: [unkJournal, brokenRev],
      }),
    );

    const tb = trialBalance(state, 'fixture-company-a', null, '2026-10-31');

    // Both journals are included in Journals book!
    expect(tb.includedJournalCount).toBe(2);
    expect(tb.bookTotals.journals.debitCentavos).toBe(17_345);
    expect(tb.bookTotals.journals.creditCentavos).toBe(17_345);

    // Both surface in classificationExceptions
    expect(tb.classificationExceptions).toHaveLength(2);
    expect(tb.classificationExceptions.some((e) => e.journalId === 'jv-unknown-1')).toBe(true);
    expect(tb.classificationExceptions.some((e) => e.journalId === 'jv-broken-rev')).toBe(true);

    // Test cycle detection
    const cycle1: Journal = { ...unkJournal, id: 'c1', reversalOf: 'c2' };
    const cycle2: Journal = { ...unkJournal, id: 'c2', reversalOf: 'c1' };
    const cycleProv = resolveJournalProvenance({ journals: [cycle1, cycle2] }, cycle1);
    expect(cycleProv.book).toBe('journals');
    expect(cycleProv.provisional).toBe(true);
    expect(cycleProv.exceptionReason).toContain('Cyclic reversal reference');
  });

  it('9. Company A vs Company B isolation: Company B journals never leak into Company A', () => {
    const accA: Account = {
      id: 'acc-a',
      workspaceId: 'fixture-company-a',
      code: 'A100',
      name: 'Bank A',
      type: 'asset',
      normalBalance: 'debit',
      controlRole: 'bank',
      active: true,
    };
    const accB: Account = {
      id: 'acc-b',
      workspaceId: 'fixture-company-b',
      code: 'A100',
      name: 'Bank B',
      type: 'asset',
      normalBalance: 'debit',
      controlRole: 'bank',
      active: true,
    };

    const jA: Journal = {
      id: 'jv-a',
      workspaceId: 'fixture-company-a',
      journalNo: 'J-A1',
      postingDate: '2026-11-01',
      documentDate: '2026-11-01',
      sourceType: 'opening',
      sourceId: 'op-a',
      effectKey: 'op:a',
      memo: 'Opening A',
      lines: [
        { accountId: 'acc-a', accountCode: 'A100', debitCentavos: 10_000, creditCentavos: 0, memo: 'Dr' },
        { accountId: 'acc-a', accountCode: 'A100', debitCentavos: 0, creditCentavos: 10_000, memo: 'Cr' },
      ],
      status: 'posted',
      createdBy: 'user-1',
      createdAt: '2026-11-01T00:00:00Z',
      approvedBy: 'user-1',
      policySnapshot: null,
      reversalOf: null,
      reversedBy: null,
    };

    const jB: Journal = {
      id: 'jv-b',
      workspaceId: 'fixture-company-b',
      journalNo: 'J-B1',
      postingDate: '2026-11-01',
      documentDate: '2026-11-01',
      sourceType: 'opening',
      sourceId: 'op-b',
      effectKey: 'op:b',
      memo: 'Opening B',
      lines: [
        { accountId: 'acc-b', accountCode: 'A100', debitCentavos: 999_999, creditCentavos: 0, memo: 'Dr' },
        { accountId: 'acc-b', accountCode: 'A100', debitCentavos: 0, creditCentavos: 999_999, memo: 'Cr' },
      ],
      status: 'posted',
      createdBy: 'user-1',
      createdAt: '2026-11-01T00:00:00Z',
      approvedBy: 'user-1',
      policySnapshot: null,
      reversalOf: null,
      reversedBy: null,
    };

    const state = backfillJournalProvenance(
      createMinimalState({
        accounts: [accA, accB],
        journals: [jA, jB],
      }),
    );

    const tbA = trialBalance(state, 'fixture-company-a', null, '2026-11-30');
    expect(tbA.includedJournalCount).toBe(1);
    expect(tbA.rows).toHaveLength(1);
    expect(tbA.rows[0]?.accountId).toBe('acc-a');
    expect(tbA.grossTotals).toEqual({ debitCentavos: 10_000, creditCentavos: 10_000 });

    const drillA = trialBalanceCellDrilldown(state, 'fixture-company-a', { accountId: 'acc-a' });
    expect(drillA).toHaveLength(2); // Two lines for jA
    expect(drillA.every((d) => d.journalId === 'jv-a')).toBe(true);
  });

  it('10. cell drill-through returns matching lines and enforces payroll confidentiality', () => {
    const fixture = loadOracleFixture();
    const accounts: Account[] = fixture.accounts.map((acc) => ({
      id: acc.id,
      workspaceId: fixture.scope.workspaceId,
      code: acc.code,
      name: acc.name,
      type: acc.type,
      normalBalance: acc.type === 'asset' || acc.type === 'expense' ? 'debit' : 'credit',
      controlRole: null,
      active: true,
    }));

    // Add payroll journal
    const payrollJournal: Journal = {
      id: 'jv-payroll-confidential',
      workspaceId: fixture.scope.workspaceId,
      journalNo: 'PR-2026-001',
      postingDate: '2026-10-10',
      documentDate: '2026-10-10',
      sourceType: 'payroll_run',
      sourceId: 'run-999',
      effectKey: 'pr:run-999',
      memo: 'Confidential Executive Payroll · Juan dela Cruz, Maria Santos',
      lines: [
        { accountId: 'expense', accountCode: 'A102', debitCentavos: 80_000, creditCentavos: 0, memo: 'Executive Base Pay' },
        { accountId: 'bank', accountCode: 'A100', debitCentavos: 0, creditCentavos: 80_000, memo: 'Direct bank release' },
      ],
      status: 'posted',
      createdBy: 'user-1',
      createdAt: '2026-10-10T00:00:00Z',
      approvedBy: 'user-1',
      policySnapshot: null,
      reversalOf: null,
      reversedBy: null,
    };

    const journals: Journal[] = [
      ...fixture.postedJournalInputs.map((input, index) => ({
        id: input.id,
        workspaceId: input.workspaceId,
        journalNo: `JV-${String(index + 1).padStart(4, '0')}`,
        postingDate: input.postingDate,
        documentDate: input.postingDate,
        sourceType: input.sourceType,
        sourceId: input.id,
        effectKey: `fx-${input.id}`,
        memo: `Fixture journal ${input.id}`,
        lines: input.lines.map((line) => {
          const acc = accounts.find((a) => a.id === line.accountId)!;
          return {
            accountId: acc.id,
            accountCode: acc.code,
            debitCentavos: line.debitCentavos,
            creditCentavos: line.creditCentavos,
            memo: `Line for ${acc.name}`,
          };
        }),
        status: 'posted' as const,
        createdBy: 'user-1',
        createdAt: '2026-10-31T00:00:00Z',
        approvedBy: 'user-1',
        policySnapshot: null,
        reversalOf: null,
        reversedBy: null,
      })),
      payrollJournal,
    ];

    const state = backfillJournalProvenance(
      createMinimalState({
        accounts,
        journals,
        payrollRuns: [
          {
            id: 'run-999',
            workspaceId: fixture.scope.workspaceId,
            runNo: 'PR-0099',
            policyId: 'policy-default',
            periodStart: '2026-10-01',
            periodEnd: '2026-10-15',
            payDate: '2026-10-10',
            status: 'posted',
            timeImportId: 'ti-1',
            lines: [],
            totals: {
              grossCentavos: 80_000,
              employeeDeductionsCentavos: 0,
              netCentavos: 80_000,
              employerContributionsCentavos: 0,
              employerCostCentavos: 80_000,
              employeeSssCentavos: 0,
              employeePhilhealthCentavos: 0,
              employeePagibigCentavos: 0,
              employeeTaxCentavos: 0,
            },
            errors: [],
            calculatedAt: '2026-10-10T00:00:00Z',
            calculatedBy: 'user-1',
            approvedAt: '2026-10-10T00:00:00Z',
            approvedBy: 'user-1',
            journalId: 'jv-payroll-confidential',
            paymentJournalId: null,
            reversedBy: null,
            createdAt: '2026-10-10T00:00:00Z',
          },
        ],
      }),
    );

    // Drill down on Bank collections cell
    const bankCollections = trialBalanceCellDrilldown(state, fixture.scope.workspaceId, {
      accountId: 'bank',
      book: 'collections',
      toDate: '2026-10-31',
    });
    expect(bankCollections).toHaveLength(1);
    expect(bankCollections[0]?.journalId).toBe('fixture-receipt');
    expect(bankCollections[0]?.book).toBe('collections');
    expect(bankCollections[0]?.debitCentavos).toBe(40_000);
    expect(bankCollections[0]?.creditCentavos).toBe(0);

    // Drill down on Expense with actor lacking payroll grant
    const unprivileged = trialBalanceCellDrilldown(state, fixture.scope.workspaceId, {
      accountId: 'expense',
      book: 'journals',
      toDate: '2026-10-31',
      actorId: 'user-accountant', // has payrollDetail: false
    });
    const prLineUnprivileged = unprivileged.find((l) => l.journalId === 'jv-payroll-confidential');
    expect(prLineUnprivileged).toBeDefined();
    expect(prLineUnprivileged?.sourceRoute).toBe('#/other/journals/jv-payroll-confidential');
    expect(prLineUnprivileged?.sourceDocumentNo).toBe('PR-0099');
    // Ensure sensitive names in memo are redacted
    expect(prLineUnprivileged?.memo).not.toContain('Juan dela Cruz');
    expect(prLineUnprivileged?.memo).toBe('Payroll journal · PR-2026-001');

    // Drill down with actor having payroll grant
    const privileged = trialBalanceCellDrilldown(state, fixture.scope.workspaceId, {
      accountId: 'expense',
      book: 'journals',
      toDate: '2026-10-31',
      actorId: 'user-payroll', // has payrollDetail: true
    });
    const prLinePrivileged = privileged.find((l) => l.journalId === 'jv-payroll-confidential');
    expect(prLinePrivileged).toBeDefined();
    expect(prLinePrivileged?.memo).toContain('Executive Base Pay');
  });

  it('11. search filtering in sourceBookTrialBalance preserves full report balance', () => {
    const fixture = loadOracleFixture();
    const accounts: Account[] = fixture.accounts.map((acc) => ({
      id: acc.id,
      workspaceId: fixture.scope.workspaceId,
      code: acc.code,
      name: acc.name,
      type: acc.type,
      normalBalance: acc.type === 'asset' || acc.type === 'expense' ? 'debit' : 'credit',
      controlRole: null,
      active: true,
    }));

    const journals: Journal[] = fixture.postedJournalInputs.map((input, index) => ({
      id: input.id,
      workspaceId: input.workspaceId,
      journalNo: `JV-${String(index + 1).padStart(4, '0')}`,
      postingDate: input.postingDate,
      documentDate: input.postingDate,
      sourceType: input.sourceType,
      sourceId: input.id,
      effectKey: `fx-${input.id}`,
      memo: `Fixture journal ${input.id}`,
      lines: input.lines.map((line) => {
        const acc = accounts.find((a) => a.id === line.accountId)!;
        return {
          accountId: acc.id,
          accountCode: acc.code,
          debitCentavos: line.debitCentavos,
          creditCentavos: line.creditCentavos,
          memo: `Line for ${acc.name}`,
        };
      }),
      status: 'posted' as const,
      createdBy: 'user-1',
      createdAt: '2026-10-31T00:00:00Z',
      approvedBy: 'user-1',
      policySnapshot: null,
      reversalOf: null,
      reversedBy: null,
    }));

    const state = backfillJournalProvenance(
      createMinimalState({
        accounts,
        journals,
      }),
    );

    // Search for single account "A100" (Bank)
    const filtered = sourceBookTrialBalance(state, fixture.scope.workspaceId, {
      toDate: '2026-10-31',
      mode: 'as_of',
      search: 'A100',
    });

    expect(filtered.rows).toHaveLength(1);
    expect(filtered.rows[0]?.accountCode).toBe('A100');
    // Balance check is for whole report, so it remains true!
    expect(filtered.balanced).toBe(true);
    expect(filtered.grossTotals).toEqual(fixture.expectedGrossTotals);
  });
});
