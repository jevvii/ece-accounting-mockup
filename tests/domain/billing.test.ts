import { describe, expect, it } from 'vitest';
import { accountBalance } from '../../src/domain/ledger';
import { trialBalance } from '../../src/domain/queries';
import { WORKSPACE_A } from '../../src/fixtures/seed';
import type { DomainCommand } from '../../src/domain/commandTypes';
import { ACCOUNTS, createHarness, debitTotal, creditTotal } from './harness';

const CUSTOMER = 'contact-a-cust-1';
const REVENUE = ACCOUNTS.revenue;

function invoiceInput(overrides: Partial<Extract<DomainCommand, { type: 'invoice.create' }>['input']> = {}) {
  return {
    customerContactId: CUSTOMER,
    invoiceDate: '2026-11-01',
    dueDate: '2026-11-30',
    branch: 'HEAD OFFICE',
    department: 'SERVICES',
    taxTreatment: 'none' as const,
    lines: [
      { description: 'Consulting — synthetic', quantityMilli: 1000, unitPriceCentavos: 100_000, accountId: REVENUE },
    ],
    ...overrides,
  };
}

describe('G01 / G13 — service invoice, direct-bank receipt, accounting equation', () => {
  it('posts a 1,000.00 zero-tax invoice, applies a 400.00 receipt, and leaves 600.00 outstanding', () => {
    const h = createHarness();
    const created = h.runOk({ type: 'invoice.create', input: invoiceInput() });
    const posted = h.runOk({ type: 'invoice.post', input: { invoiceId: created.documentId } });

    const invoice = h.state.invoices.find((candidate) => candidate.id === created.documentId);
    expect(invoice?.status).toBe('posted');
    expect(invoice?.subtotalCentavos).toBe(100_000);
    expect(invoice?.taxCentavos).toBe(0);
    expect(invoice?.totalCentavos).toBe(100_000);
    expect(invoice?.outstandingCentavos).toBe(100_000);

    const journal = h.state.journals.find((candidate) => candidate.id === posted.journalIds[0]);
    expect(debitTotal(h, journal!.id)).toBe(100_000);
    expect(creditTotal(h, journal!.id)).toBe(100_000);
    expect(journal?.lines.find((line) => line.accountId === ACCOUNTS.ar)?.debitCentavos).toBe(100_000);
    expect(journal?.lines.find((line) => line.accountId === ACCOUNTS.revenue)?.creditCentavos).toBe(100_000);

    const receipt = h.runOk({
      type: 'receipt.create',
      input: {
        customerContactId: CUSTOMER,
        receiptDate: '2026-11-05',
        amountCentavos: 40_000,
        bankAccountId: 'bank-a-1',
        method: 'bank_deposit',
        reference: 'DEP-0001',
        allocations: [{ invoiceId: created.documentId, amountCentavos: 40_000 }],
      },
    });

    const settled = h.state.invoices.find((candidate) => candidate.id === created.documentId);
    expect(settled?.status).toBe('partially_paid');
    expect(settled?.paidCentavos).toBe(40_000);
    expect(settled?.outstandingCentavos).toBe(60_000);

    const receiptJournal = h.state.journals.find((candidate) => candidate.id === receipt.journalIds[0]);
    expect(receiptJournal?.lines.find((line) => line.accountId === ACCOUNTS.bank)?.debitCentavos).toBe(40_000);
    expect(receiptJournal?.lines.find((line) => line.accountId === ACCOUNTS.ar)?.creditCentavos).toBe(40_000);

    expect(
      accountBalance(h.state, WORKSPACE_A, ACCOUNTS.bank, null, null).netDebitCentavos,
    ).toBe(1_040_000);
    expect(accountBalance(h.state, WORKSPACE_A, ACCOUNTS.ar, null, null).netDebitCentavos).toBe(60_000);
    expect(
      accountBalance(h.state, WORKSPACE_A, ACCOUNTS.openingEquity, null, null).netDebitCentavos,
    ).toBe(-1_000_000);
    expect(
      accountBalance(h.state, WORKSPACE_A, ACCOUNTS.revenue, null, null).netDebitCentavos,
    ).toBe(-100_000);

    const trial = trialBalance(h.state, WORKSPACE_A, '2026-01-01', '2026-11-30');
    expect(trial.balanced).toBe(true);
    expect(trial.totals.closingDebitCentavos).toBe(1_100_000);
    expect(trial.totals.closingCreditCentavos).toBe(1_100_000);
    const bankRow = trial.rows.find((row) => row.accountId === ACCOUNTS.bank);
    const arRow = trial.rows.find((row) => row.accountId === ACCOUNTS.ar);
    const equityRow = trial.rows.find((row) => row.accountId === ACCOUNTS.openingEquity);
    const revenueRow = trial.rows.find((row) => row.accountId === ACCOUNTS.revenue);
    expect(bankRow?.closingDebitCentavos).toBe(1_040_000);
    expect(arRow?.closingDebitCentavos).toBe(60_000);
    expect(equityRow?.closingCreditCentavos).toBe(1_000_000);
    expect(revenueRow?.closingCreditCentavos).toBe(100_000);
  });

  it('does not post or receive twice when the same request key is retried', () => {
    const h = createHarness();
    const created = h.runOk({ type: 'invoice.create', input: invoiceInput() });
    const postCommand: DomainCommand = { type: 'invoice.post', input: { invoiceId: created.documentId } };
    const first = h.runOk(postCommand, { key: 'post-once' });
    const revisionAfterPost = h.state.revision;
    const journalCount = h.state.journals.length;

    const retried = h.runOk(postCommand, { key: 'post-once' });
    expect(retried).toEqual(first);
    expect(h.state.revision).toBe(revisionAfterPost);
    expect(h.state.journals.length).toBe(journalCount);

    const secondPost = h.run({ type: 'invoice.post', input: { invoiceId: created.documentId } });
    expect(secondPost.ok).toBe(false);
    if (!secondPost.ok) expect(secondPost.error.code).toBe('CONFLICT');
    expect(h.state.journals.length).toBe(journalCount);
  });
});

describe('G02 — idempotency key and payload conflict', () => {
  it('rejects reuse of one key with a different payload and keeps the original draft', () => {
    const h = createHarness();
    const first = h.runOk({ type: 'invoice.create', input: invoiceInput() }, { key: 'draft-1' });
    const revision = h.state.revision;
    const conflict = h.run(
      {
        type: 'invoice.create',
        input: invoiceInput({ lines: [{ description: 'Different', quantityMilli: 1000, unitPriceCentavos: 1, accountId: REVENUE }] }),
      },
      { key: 'draft-1' },
    );
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.error.code).toBe('IDEMPOTENCY_CONFLICT');
      expect(conflict.error.field).toBe('idempotencyKey');
    }
    expect(h.state.revision).toBe(revision);
    const invoice = h.state.invoices.find((candidate) => candidate.id === first.documentId);
    expect(invoice?.totalCentavos).toBe(100_000);
  });
});

describe('G12 — illustrative 12% VAT wiring', () => {
  it('records AR 1,120.00, revenue 1,000.00 and output VAT 120.00', () => {
    const h = createHarness();
    const created = h.runOk({
      type: 'invoice.create',
      input: invoiceInput({ taxTreatment: 'vat12' }),
    });
    const posted = h.runOk({ type: 'invoice.post', input: { invoiceId: created.documentId } });
    const invoice = h.state.invoices.find((candidate) => candidate.id === created.documentId);
    expect(invoice?.subtotalCentavos).toBe(100_000);
    expect(invoice?.taxCentavos).toBe(12_000);
    expect(invoice?.totalCentavos).toBe(112_000);

    const journal = h.state.journals.find((candidate) => candidate.id === posted.journalIds[0]);
    expect(journal?.lines.find((line) => line.accountId === ACCOUNTS.ar)?.debitCentavos).toBe(112_000);
    expect(journal?.lines.find((line) => line.accountId === ACCOUNTS.revenue)?.creditCentavos).toBe(100_000);
    expect(journal?.lines.find((line) => line.accountId === ACCOUNTS.outputVat)?.creditCentavos).toBe(12_000);
    expect(debitTotal(h, journal!.id)).toBe(112_000);
    expect(creditTotal(h, journal!.id)).toBe(112_000);

    const taxRecord = h.state.taxRecords.find((record) => record.sourceId === created.documentId);
    expect(taxRecord?.type).toBe('output_vat');
    expect(taxRecord?.baseCentavos).toBe(100_000);
    expect(taxRecord?.taxCentavos).toBe(12_000);
  });
});

describe('G14 — closed-period guard, authorized reopen, linked reversal', () => {
  it('rejects a post into a closed month without changing posted data', () => {
    const h = createHarness();
    h.runOk({ type: 'period.close', input: { year: 2026, month: 11, reason: 'Synthetic month-end close' } });
    const created = h.runOk({ type: 'invoice.create', input: invoiceInput() });
    const revisionBefore = h.state.revision;
    const journalCount = h.state.journals.length;

    const blocked = h.run({ type: 'invoice.post', input: { invoiceId: created.documentId } });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.code).toBe('CLOSED_PERIOD');
    expect(h.state.revision).toBe(revisionBefore);
    expect(h.state.journals.length).toBe(journalCount);
    expect(h.state.invoices.find((candidate) => candidate.id === created.documentId)?.status).toBe('draft');

    const reopened = h.runOk({
      type: 'period.reopen',
      input: { year: 2026, month: 11, reason: 'Approved synthetic reopening' },
    });
    expect(reopened.summary).toContain('reopened');
    const posted = h.runOk({ type: 'invoice.post', input: { invoiceId: created.documentId } });

    const reversal = h.runOk({
      type: 'invoice.reverse',
      input: { invoiceId: created.documentId, reversalDate: '2026-11-30', reason: 'Synthetic correction' },
    });
    const original = h.state.journals.find((journal) => journal.id === posted.journalIds[0]);
    const reverseJournal = h.state.journals.find((journal) => journal.id === reversal.journalIds[0]);
    expect(original?.reversedBy).toBe(reverseJournal?.id);
    expect(reverseJournal?.reversalOf).toBe(original?.id);
    expect(debitTotal(h, reverseJournal!.id)).toBe(creditTotal(h, original!.id));
    expect(creditTotal(h, reverseJournal!.id)).toBe(debitTotal(h, original!.id));
    expect(h.state.invoices.find((candidate) => candidate.id === created.documentId)?.status).toBe('reversed');

    const after = accountBalance(h.state, WORKSPACE_A, ACCOUNTS.ar, null, null);
    expect(after.netDebitCentavos).toBe(0);
    const reversalAgain = h.run({
      type: 'invoice.reverse',
      input: { invoiceId: created.documentId, reversalDate: '2026-11-30', reason: 'Duplicate attempt' },
    });
    expect(reversalAgain.ok).toBe(false);
  });
});

describe('G15 — cross-company isolation and payroll-detail boundary', () => {
  it('rejects a Company B actor in Company A and a Company A contact in Company B', () => {
    const h = createHarness();
    const actorMismatch = h.run(
      { type: 'invoice.create', input: invoiceInput() },
      { actorId: 'u-badmin', workspaceId: WORKSPACE_A },
    );
    expect(actorMismatch.ok).toBe(false);
    if (!actorMismatch.ok) expect(actorMismatch.error.code).toBe('FORBIDDEN');

    const foreignContact = h.run({
      type: 'invoice.create',
      input: invoiceInput({ customerContactId: 'contact-b-cust-1' }),
    });
    expect(foreignContact.ok).toBe(false);
    if (!foreignContact.ok) expect(foreignContact.error.code).toBe('VALIDATION');
    expect(h.state.invoices).toHaveLength(0);
  });

  it('refuses the payroll workspace to a non-member and keeps payroll detail behind its own grant', () => {
    const h = createHarness();
    const result = h.run({ type: 'time.import', input: { sourceName: 'denied.csv', rows: [] } }, { actorId: 'u-bpayroll' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('FORBIDDEN');
  });
});
