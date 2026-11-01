import { describe, expect, it } from 'vitest';
import { accountBalance } from '../../src/domain/ledger';
import { arAging, agingBucket } from '../../src/domain/queries';
import { WORKSPACE_A } from '../../src/fixtures/seed';
import type { DomainCommand } from '../../src/domain/commandTypes';
import { ACCOUNTS, createHarness, debitTotal, creditTotal } from './harness';

const CUSTOMER = 'contact-a-cust-1';

type Harness = ReturnType<typeof createHarness>;

function invoiceDraft(
  overrides: Partial<Extract<DomainCommand, { type: 'invoice.create' }>['input']> = {},
): Extract<DomainCommand, { type: 'invoice.create' }>['input'] {
  return {
    customerContactId: CUSTOMER,
    invoiceDate: '2026-11-01',
    dueDate: '2026-11-30',
    branch: 'HEAD OFFICE',
    department: 'SERVICES',
    taxTreatment: 'none',
    lines: [
      { description: 'Synthetic service', quantityMilli: 1000, unitPriceCentavos: 100_000, accountId: ACCOUNTS.revenue },
    ],
    ...overrides,
  };
}

function postedInvoice(h: Harness, amountCentavos = 100_000, overrides: Partial<Extract<DomainCommand, { type: 'invoice.create' }>['input']> = {}) {
  const created = h.runOk({
    type: 'invoice.create',
    input: invoiceDraft({
      ...overrides,
      lines: [
        {
          description: 'Synthetic service',
          quantityMilli: 1000,
          unitPriceCentavos: amountCentavos,
          accountId: ACCOUNTS.revenue,
        },
      ],
    }),
  });
  h.runOk({ type: 'invoice.post', input: { invoiceId: created.documentId } });
  return created.documentId;
}

function receipt(
  h: Harness,
  amountCentavos: number,
  allocations: Array<{ invoiceId: string; amountCentavos: number }>,
  overrides: Partial<Extract<DomainCommand, { type: 'receipt.create' }>['input']> = {},
) {
  return h.runOk({
    type: 'receipt.create',
    input: {
      customerContactId: CUSTOMER,
      receiptDate: '2026-11-05',
      amountCentavos,
      bankAccountId: 'bank-a-1',
      method: 'bank_deposit',
      reference: 'SYN-DEP',
      allocations,
      ...overrides,
    },
  });
}

describe('receipts — partial and multi-invoice allocation with unapplied excess', () => {
  it('settles two invoices, tracks 1,500.00 unapplied, and refunds only that balance', () => {
    const h = createHarness();
    const first = postedInvoice(h, 100_000);
    const second = postedInvoice(h, 100_000, { invoiceDate: '2026-11-02' });

    const created = receipt(h, 250_000, [
      { invoiceId: first, amountCentavos: 60_000 },
      { invoiceId: second, amountCentavos: 40_000 },
    ]);
    expect(created.warnings).toHaveLength(1);
    expect(h.state.receipts[0]?.unappliedCentavos).toBe(150_000);
    expect(h.state.invoices.find((invoice) => invoice.id === first)).toMatchObject({
      paidCentavos: 60_000,
      outstandingCentavos: 40_000,
      status: 'partially_paid',
    });
    expect(h.state.invoices.find((invoice) => invoice.id === second)).toMatchObject({
      paidCentavos: 40_000,
      outstandingCentavos: 60_000,
      status: 'partially_paid',
    });
    expect(accountBalance(h.state, WORKSPACE_A, ACCOUNTS.ar, null, null).netDebitCentavos).toBe(100_000);
    expect(accountBalance(h.state, WORKSPACE_A, ACCOUNTS.unapplied, null, null).netDebitCentavos).toBe(-150_000);
    expect(accountBalance(h.state, WORKSPACE_A, ACCOUNTS.bank, null, null).netDebitCentavos).toBe(1_250_000);

    const refund = h.runOk({
      type: 'refund.create',
      input: {
        customerContactId: CUSTOMER,
        refundDate: '2026-11-06',
        amountCentavos: 100_000,
        bankAccountId: 'bank-a-1',
        reason: 'Synthetic customer refund',
      },
    });
    expect(refund.journalIds).toHaveLength(1);
    const tooMuch = h.run({
      type: 'refund.create',
      input: {
        customerContactId: CUSTOMER,
        refundDate: '2026-11-07',
        amountCentavos: 60_000,
        bankAccountId: 'bank-a-1',
        reason: 'Synthetic excess refund',
      },
    });
    expect(tooMuch.ok).toBe(false);
    if (!tooMuch.ok) expect(tooMuch.error.code).toBe('VALIDATION');
    expect(accountBalance(h.state, WORKSPACE_A, ACCOUNTS.unapplied, null, null).netDebitCentavos).toBe(-50_000);
  });

  it('rejects an allocation above the invoice balance and an over-sized receipt total', () => {
    const h = createHarness();
    const invoiceId = postedInvoice(h, 100_000);

    const overAllocation = h.run({
      type: 'receipt.create',
      input: {
        customerContactId: CUSTOMER,
        receiptDate: '2026-11-05',
        amountCentavos: 200_000,
        bankAccountId: 'bank-a-1',
        method: 'bank_deposit',
        reference: 'SYN-OVER',
        allocations: [{ invoiceId, amountCentavos: 120_000 }],
      },
    });
    expect(overAllocation.ok).toBe(false);
    if (!overAllocation.ok) expect(overAllocation.error.code).toBe('VALIDATION');

    const totalExceeds = h.run({
      type: 'receipt.create',
      input: {
        customerContactId: CUSTOMER,
        receiptDate: '2026-11-05',
        amountCentavos: 50_000,
        bankAccountId: 'bank-a-1',
        method: 'bank_deposit',
        reference: 'SYN-TOTAL',
        allocations: [
          { invoiceId, amountCentavos: 30_000 },
          { invoiceId, amountCentavos: 30_000 },
        ],
      },
    });
    expect(totalExceeds.ok).toBe(false);
    if (!totalExceeds.ok) expect(totalExceeds.error.code).toBe('VALIDATION');
    expect(h.state.receipts).toHaveLength(0);
    expect(h.state.invoices.find((invoice) => invoice.id === invoiceId)?.outstandingCentavos).toBe(100_000);
  });
});

describe('credit notes and returned receipts', () => {
  it('credits net and VAT, reduces AR, and blocks a credit above the outstanding balance', () => {
    const h = createHarness();
    const invoiceId = postedInvoice(h, 100_000, { taxTreatment: 'vat12' });

    const credit = h.runOk({
      type: 'creditNote.create',
      input: { invoiceId, creditDate: '2026-11-10', netCentavos: 50_000, reason: 'Synthetic service credit' },
    });
    const invoice = h.state.invoices.find((candidate) => candidate.id === invoiceId)!;
    expect(invoice.outstandingCentavos).toBe(56_000);
    expect(invoice.paidCentavos).toBe(0);
    const journal = h.state.journals.find((candidate) => candidate.id === credit.journalIds[0])!;
    expect(journal.lines.find((line) => line.accountId === ACCOUNTS.revenue)?.debitCentavos).toBe(50_000);
    expect(journal.lines.find((line) => line.accountId === ACCOUNTS.outputVat)?.debitCentavos).toBe(6_000);
    expect(journal.lines.find((line) => line.accountId === ACCOUNTS.ar)?.creditCentavos).toBe(56_000);
    expect(debitTotal(h, journal.id)).toBe(creditTotal(h, journal.id));
    expect(accountBalance(h.state, WORKSPACE_A, ACCOUNTS.ar, null, null).netDebitCentavos).toBe(56_000);

    const excess = h.run({
      type: 'creditNote.create',
      input: { invoiceId, creditDate: '2026-11-11', netCentavos: 60_000, reason: 'Synthetic oversized credit' },
    });
    expect(excess.ok).toBe(false);
    if (!excess.ok) expect(excess.error.code).toBe('VALIDATION');
    expect(h.state.creditNotes).toHaveLength(1);
  });

  it('returns a receipt with a linked reversal, restores the invoice, and refuses a second return', () => {
    const h = createHarness();
    const invoiceId = postedInvoice(h, 100_000);
    const created = receipt(h, 40_000, [{ invoiceId, amountCentavos: 40_000 }]);
    const receiptId = created.documentId;

    expect(h.state.invoices.find((candidate) => candidate.id === invoiceId)?.outstandingCentavos).toBe(60_000);
    const returned = h.runOk({
      type: 'receipt.return',
      input: { receiptId, returnDate: '2026-11-08', reason: 'Synthetic returned deposit' },
    });
    const receiptRow = h.state.receipts.find((candidate) => candidate.id === receiptId)!;
    expect(receiptRow.status).toBe('returned');
    expect(receiptRow.returnJournalId).toBe(returned.journalIds[0]);
    expect(h.state.journals.find((journal) => journal.id === receiptRow.journalId)?.reversedBy).toBe(
      returned.journalIds[0],
    );
    expect(h.state.journals.find((journal) => journal.id === returned.journalIds[0])?.reversalOf).toBe(
      receiptRow.journalId,
    );
    expect(h.state.invoices.find((candidate) => candidate.id === invoiceId)).toMatchObject({
      paidCentavos: 0,
      outstandingCentavos: 100_000,
      status: 'posted',
    });
    expect(accountBalance(h.state, WORKSPACE_A, ACCOUNTS.bank, null, null).netDebitCentavos).toBe(1_000_000);
    expect(accountBalance(h.state, WORKSPACE_A, ACCOUNTS.ar, null, null).netDebitCentavos).toBe(100_000);

    const again = h.run({
      type: 'receipt.return',
      input: { receiptId, returnDate: '2026-11-09', reason: 'Synthetic duplicate return' },
    });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe('CONFLICT');
    expect(h.state.journals.filter((journal) => journal.reversalOf === receiptRow.journalId)).toHaveLength(1);
  });
});

describe('AR aging and posted-customer snapshots', () => {
  it('buckets outstanding balances by due date as of the selected date', () => {
    const h = createHarness();
    postedInvoice(h, 100_000, { invoiceDate: '2026-10-01', dueDate: '2026-10-31' });
    postedInvoice(h, 200_000, { invoiceDate: '2026-09-01', dueDate: '2026-09-15' });
    postedInvoice(h, 300_000, { invoiceDate: '2026-06-01', dueDate: '2026-06-30' });
    postedInvoice(h, 400_000, { invoiceDate: '2026-11-01', dueDate: '2026-11-15' });

    const aging = arAging(h.state, WORKSPACE_A, '2026-11-01');
    expect(aging.totals.currentCentavos).toBe(400_000);
    expect(aging.totals.days1To30Centavos).toBe(100_000);
    expect(aging.totals.days31To60Centavos).toBe(200_000);
    expect(aging.totals.days61To90Centavos).toBe(0);
    expect(aging.totals.daysOver90Centavos).toBe(300_000);
    expect(aging.totals.totalCentavos).toBe(1_000_000);
    expect(aging.rows).toHaveLength(1);
    expect(aging.rows[0]?.customerName).toBe('Cordillera Services Demo Inc.');
    expect(agingBucket('2026-11-15', '2026-11-01')).toBe('current');
    expect(agingBucket('2026-10-31', '2026-11-01')).toBe('days_1_30');
  });

  it('keeps the posted customer snapshot when the master contact is renamed', () => {
    const h = createHarness();
    const invoiceId = postedInvoice(h, 100_000);
    expect(h.state.invoices[0]?.customerSnapshot.name).toBe('Cordillera Services Demo Inc.');

    h.runOk({
      type: 'contact.update',
      input: {
        contactId: CUSTOMER,
        name: 'Synthetic Customer Renamed',
        tin: '',
        address: 'Synthetic address',
        roles: ['customer'],
        active: true,
      },
    });
    expect(h.state.contacts.find((contact) => contact.id === CUSTOMER)?.name).toBe('Synthetic Customer Renamed');
    expect(h.state.invoices.find((invoice) => invoice.id === invoiceId)?.customerSnapshot.name).toBe(
      'Cordillera Services Demo Inc.',
    );
    expect(arAging(h.state, WORKSPACE_A, '2026-11-05').rows[0]?.customerName).toBe('Cordillera Services Demo Inc.');
  });
});
