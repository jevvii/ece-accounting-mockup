import { describe, expect, it } from 'vitest';
import {
  expenseReport,
  expenseReportLines,
  salesReport,
  salesReportLines,
  trialBalance,
} from '../../src/domain/queries';
import { WORKSPACE_A } from '../../src/fixtures/seed';
import type { DomainCommand } from '../../src/domain/commandTypes';
import { ACCOUNTS, createHarness } from './harness';

const CUSTOMER = 'contact-a-cust-1';
const VENDOR = 'contact-a-vend-1';

function postInvoice(h: ReturnType<typeof createHarness>, amountCentavos: number, date = '2026-11-05') {
  const created = h.runOk({
    type: 'invoice.create',
    input: {
      customerContactId: CUSTOMER,
      invoiceDate: date,
      dueDate: '2026-11-30',
      branch: 'HEAD OFFICE',
      department: 'SERVICES',
      taxTreatment: 'none',
      lines: [{ description: 'Synthetic report sale', quantityMilli: 1000, unitPriceCentavos: amountCentavos, accountId: ACCOUNTS.revenue }],
    },
  });
  h.runOk({ type: 'invoice.post', input: { invoiceId: created.documentId } });
  return created.documentId;
}

const BILL: Extract<DomainCommand, { type: 'bill.create' }>['input'] = {
  vendorContactId: VENDOR,
  supplierInvoiceNo: 'REP-BILL-1',
  billDate: '2026-11-04',
  dueDate: '2026-11-30',
  lines: [
    { description: 'Synthetic report purchase', accountId: ACCOUNTS.adjustment, amountCentavos: 50_000, taxTreatment: 'none' },
  ],
};

describe('three report families reconcile with posted journals', () => {
  it('reports beginning, inclusive movement, and ending in a balanced trial balance', () => {
    const h = createHarness();
    postInvoice(h, 100_000);
    h.runOk({
      type: 'receipt.create',
      input: {
        customerContactId: CUSTOMER,
        receiptDate: '2026-11-06',
        amountCentavos: 40_000,
        bankAccountId: 'bank-a-1',
        method: 'bank_deposit',
        reference: 'REP-DEP',
        allocations: [{ invoiceId: h.state.invoices[0]!.id, amountCentavos: 40_000 }],
      },
    });
    h.runOk({ type: 'bill.create', input: BILL });

    const tb = trialBalance(h.state, WORKSPACE_A, '2026-11-01', '2026-11-30');
    expect(tb.balanced).toBe(true);
    expect(tb.mode).toBe('activity');
    expect(tb.bookTotals.sales).toEqual({ debitCentavos: 100_000, creditCentavos: 100_000 });
    expect(tb.bookTotals.collections).toEqual({ debitCentavos: 40_000, creditCentavos: 40_000 });
    expect(tb.bookTotals.purchases).toEqual({ debitCentavos: 50_000, creditCentavos: 50_000 });
    expect(tb.grossTotals).toEqual({ debitCentavos: 190_000, creditCentavos: 190_000 });

    const row = (accountId: string) => tb.rows.find((candidate) => candidate.accountId === accountId)!;
    expect(row(ACCOUNTS.bank).openingDebitCentavos).toBe(1_000_000);
    expect(row(ACCOUNTS.bank).debitCentavos).toBe(40_000);
    expect(row(ACCOUNTS.bank).closingDebitCentavos).toBe(1_040_000);
    expect(row(ACCOUNTS.bank).books.collections.debitCentavos).toBe(40_000);

    expect(row(ACCOUNTS.ar).debitCentavos).toBe(100_000);
    expect(row(ACCOUNTS.ar).creditCentavos).toBe(40_000);
    expect(row(ACCOUNTS.ar).closingDebitCentavos).toBe(60_000);
    expect(row(ACCOUNTS.ar).books.sales.debitCentavos).toBe(100_000);
    expect(row(ACCOUNTS.ar).books.collections.creditCentavos).toBe(40_000);

    expect(row(ACCOUNTS.revenue).closingCreditCentavos).toBe(100_000);
    expect(row(ACCOUNTS.revenue).books.sales.creditCentavos).toBe(100_000);

    expect(row(ACCOUNTS.adjustment).closingDebitCentavos).toBe(50_000);
    expect(row(ACCOUNTS.adjustment).books.purchases.debitCentavos).toBe(50_000);

    expect(row(ACCOUNTS.ap).closingCreditCentavos).toBe(50_000);
    expect(row(ACCOUNTS.ap).books.purchases.creditCentavos).toBe(50_000);

    expect(tb.totals.openingDebitCentavos).toBe(tb.totals.openingCreditCentavos);
    expect(tb.totals.debitCentavos).toBe(tb.totals.creditCentavos);
    expect(tb.totals.closingDebitCentavos).toBe(tb.totals.closingCreditCentavos);
    expect(tb.totals.closingDebitCentavos).toBe(1_150_000);

    const early = trialBalance(h.state, WORKSPACE_A, '2026-10-01', '2026-10-31');
    const earlyAr = early.rows.find((candidate) => candidate.accountId === ACCOUNTS.ar);
    expect(earlyAr?.debitCentavos).toBe(0);
    expect(earlyAr?.creditCentavos).toBe(0);
    expect(earlyAr?.closingDebitCentavos).toBe(0);
    expect(early.totals.debitCentavos).toBe(0);
  });

  it('separates purchases from reimbursements and never treats cash as expense', () => {
    const h = createHarness();
    h.runOk({ type: 'bill.create', input: BILL });
    const advance = h.runOk({
      type: 'advance.create',
      input: { employeeId: 'emp-a-001', advanceDate: '2026-11-02', amountCentavos: 100_000, bankAccountId: 'bank-a-1' },
    });
    h.runOk({
      type: 'advance.liquidate',
      input: {
        advanceId: advance.documentId,
        liquidationDate: '2026-11-09',
        expenses: [{ accountId: ACCOUNTS.adjustment, description: 'Synthetic field expense', amountCentavos: 80_000 }],
        unusedReturnCentavos: 20_000,
        excessReimbursementCentavos: 0,
        bankAccountId: 'bank-a-1',
      },
    });

    const detail = expenseReportLines(h.state, WORKSPACE_A, '2026-11-01', '2026-11-30');
    expect(detail.purchasesTotalCentavos).toBe(50_000);
    expect(detail.reimbursementTotalCentavos).toBe(80_000);
    expect(detail.lines).toHaveLength(2);
    const purchase = detail.lines.find((line) => line.kind === 'purchase')!;
    expect(purchase.documentNo).toBe('BILL-0001');
    expect(purchase.partyName).toBe('Metro Office Supply Demo Co.');
    expect(purchase.totalCentavos).toBe(50_000);
    expect(purchase.paidCentavos).toBe(0);
    expect(purchase.outstandingCentavos).toBe(50_000);
    const reimbursement = detail.lines.find((line) => line.kind === 'reimbursement')!;
    expect(reimbursement.partyName).toBe('Ana Reyes');
    expect(reimbursement.totalCentavos).toBe(80_000);

    const summary = expenseReport(h.state, WORKSPACE_A, '2026-11-01', '2026-11-30');
    expect(summary.totalCentavos).toBe(130_000);
    expect(summary.rows.find((line) => line.accountId === ACCOUNTS.adjustment)?.amountCentavos).toBe(130_000);
  });

  it('reports sales per invoice and client with gross, tax, paid and outstanding', () => {
    const h = createHarness();
    const invoiceId = postInvoice(h, 100_000);
    h.runOk({
      type: 'receipt.create',
      input: {
        customerContactId: CUSTOMER,
        receiptDate: '2026-11-06',
        amountCentavos: 40_000,
        bankAccountId: 'bank-a-1',
        method: 'bank_deposit',
        reference: 'REP-DEP-2',
        allocations: [{ invoiceId, amountCentavos: 40_000 }],
      },
    });

    const rows = salesReportLines(h.state, WORKSPACE_A, '2026-11-01', '2026-11-30');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      invoiceNo: 'INV-0001',
      customerName: 'Cordillera Services Demo Inc.',
      subtotalCentavos: 100_000,
      taxCentavos: 0,
      totalCentavos: 100_000,
      paidCentavos: 40_000,
      outstandingCentavos: 60_000,
    });
    const summary = salesReport(h.state, WORKSPACE_A, '2026-11-01', '2026-11-30');
    expect(summary.totalCentavos).toBe(100_000);
    expect(summary.invoices).toHaveLength(1);
    expect(salesReportLines(h.state, WORKSPACE_A, '2026-12-01', '2026-12-31')).toHaveLength(0);
  });
});
