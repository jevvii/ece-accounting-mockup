import { describe, expect, it } from 'vitest';
import { accountBalance } from '../../src/domain/ledger';
import { WORKSPACE_A } from '../../src/fixtures/seed';
import { ACCOUNTS, createHarness } from './harness';

const CUSTOMER = 'contact-a-cust-1';

function postInvoice(h: ReturnType<typeof createHarness>) {
  const created = h.runOk({
    type: 'invoice.create',
    input: {
      customerContactId: CUSTOMER,
      invoiceDate: '2026-11-01',
      dueDate: '2026-11-30',
      branch: 'HEAD OFFICE',
      department: 'SERVICES',
      taxTreatment: 'none',
      lines: [
        {
          description: 'Synthetic consulting service',
          quantityMilli: 1000,
          unitPriceCentavos: 100_000,
          accountId: ACCOUNTS.revenue,
        },
      ],
    },
  });
  return h.runOk({ type: 'invoice.post', input: { invoiceId: created.documentId } });
}

function postClearingReceipt(h: ReturnType<typeof createHarness>, invoiceId: string) {
  return h.runOk({
    type: 'receipt.create',
    input: {
      customerContactId: CUSTOMER,
      receiptDate: '2026-11-05',
      amountCentavos: 40_000,
      bankAccountId: 'bank-a-1',
      method: 'incoming_clearing',
      reference: 'CLR-0001',
      allocations: [{ invoiceId, amountCentavos: 40_000 }],
    },
  });
}

function importRows(
  h: ReturnType<typeof createHarness>,
  rows: Array<{ rowRef: string; valueDate: string; description: string; direction: 'in' | 'out'; amountCentavos: number }>,
) {
  return h.runOk({
    type: 'bankRow.import',
    input: { bankAccountId: 'bank-a-1', sourceName: 'synthetic-november.csv', rows },
  });
}

const ROW_40K = {
  rowRef: 'BNK-0017',
  valueDate: '2026-11-06',
  description: 'Incoming clearing synthetic customer',
  direction: 'in' as const,
  amountCentavos: 40_000,
};

describe('G17 — CSV re-import, mismatch, reconciliation and undo', () => {
  it('adds no second statement or rows when the same CSV is imported twice', () => {
    const h = createHarness();
    const first = importRows(h, [ROW_40K]);
    expect(first.documentId).not.toBe('');
    expect(first.warnings).toEqual([]);
    expect(h.state.bankRows).toHaveLength(1);
    expect(h.state.bankStatements).toHaveLength(1);

    const second = importRows(h, [ROW_40K]);
    expect(second.documentId).toBe('');
    expect(second.journalIds).toHaveLength(0);
    expect(second.warnings).toHaveLength(1);
    expect(h.state.bankRows).toHaveLength(1);
    expect(h.state.bankStatements).toHaveLength(1);
    expect(h.state.bankRows[0]?.status).toBe('unmatched');
  });

  it('leaves an amount mismatch unresolved and posts nothing', () => {
    const h = createHarness();
    const invoice = postInvoice(h);
    postClearingReceipt(h, invoice.documentId);

    importRows(h, [{ ...ROW_40K, rowRef: 'BNK-0018', amountCentavos: 39_999 }]);
    const row = h.state.bankRows.find((candidate) => candidate.rowRef === 'BNK-0018')!;
    const journalCount = h.state.journals.length;

    const mismatched = h.run({
      type: 'bankRow.match',
      input: {
        rowId: row.id,
        sourceType: 'customer_receipt',
        sourceId: h.state.receipts[0]!.id,
        reason: 'Amount appears close',
      },
    });
    expect(mismatched.ok).toBe(false);
    if (!mismatched.ok) expect(mismatched.error.code).toBe('AMOUNT_MISMATCH');
    expect(h.state.bankRows.find((candidate) => candidate.id === row.id)?.status).toBe('unmatched');
    expect(h.state.bankRows.find((candidate) => candidate.id === row.id)?.matchedSourceId).toBeNull();
    expect(h.state.journals.length).toBe(journalCount);
    expect(accountBalance(h.state, WORKSPACE_A, ACCOUNTS.incomingClearing, null, null).netDebitCentavos).toBe(40_000);
  });

  it('reconciles once, reverses the clearing once on undo, and preserves the audit history', () => {
    const h = createHarness();
    const invoice = postInvoice(h);
    const receipt = postClearingReceipt(h, invoice.documentId);
    importRows(h, [ROW_40K]);
    const row = h.state.bankRows.find((candidate) => candidate.rowRef === 'BNK-0017')!;

    expect(accountBalance(h.state, WORKSPACE_A, ACCOUNTS.incomingClearing, null, null).netDebitCentavos).toBe(40_000);

    const matched = h.runOk({
      type: 'bankRow.match',
      input: {
        rowId: row.id,
        sourceType: 'customer_receipt',
        sourceId: receipt.documentId,
        reason: 'Exact amount, clearing reference',
      },
    });
    expect(matched.journalIds).toHaveLength(1);
    const clearingJournal = h.state.journals.find((journal) => journal.id === matched.journalIds[0])!;
    expect(clearingJournal.lines.find((line) => line.accountId === ACCOUNTS.bank)?.debitCentavos).toBe(40_000);
    expect(clearingJournal.lines.find((line) => line.accountId === ACCOUNTS.incomingClearing)?.creditCentavos).toBe(
      40_000,
    );
    expect(accountBalance(h.state, WORKSPACE_A, ACCOUNTS.incomingClearing, null, null).netDebitCentavos).toBe(0);
    expect(accountBalance(h.state, WORKSPACE_A, ACCOUNTS.bank, null, null).netDebitCentavos).toBe(1_040_000);
    expect(h.state.bankRows.find((candidate) => candidate.id === row.id)?.status).toBe('reconciled');

    const rematch = h.run({
      type: 'bankRow.match',
      input: {
        rowId: row.id,
        sourceType: 'customer_receipt',
        sourceId: receipt.documentId,
        reason: 'Retry',
      },
    });
    expect(rematch.ok).toBe(false);
    if (!rematch.ok) expect(rematch.error.code).toBe('CONFLICT');

    const undone = h.runOk({
      type: 'bankRow.undo',
      input: { rowId: row.id, reversalDate: '2026-11-07', reason: 'Synthetic statement correction' },
    });
    expect(undone.journalIds).toHaveLength(1);
    const reversal = h.state.journals.find((journal) => journal.id === undone.journalIds[0])!;
    expect(reversal.reversalOf).toBe(clearingJournal.id);
    expect(h.state.journals.find((journal) => journal.id === clearingJournal.id)?.reversedBy).toBe(reversal.id);
    expect(accountBalance(h.state, WORKSPACE_A, ACCOUNTS.incomingClearing, null, null).netDebitCentavos).toBe(40_000);
    expect(accountBalance(h.state, WORKSPACE_A, ACCOUNTS.bank, null, null).netDebitCentavos).toBe(1_000_000);

    const undoneRow = h.state.bankRows.find((candidate) => candidate.id === row.id)!;
    expect(undoneRow.status).toBe('unmatched');
    expect(undoneRow.matchedSourceId).toBeNull();
    expect(undoneRow.undoJournalId).toBe(reversal.id);
    expect(undoneRow.undoReason).toBe('Synthetic statement correction');
    expect(undoneRow.history.map((entry) => entry.action)).toEqual(['imported', 'reconciled', 'undo']);
    expect(h.state.receipts[0]?.status).toBe('posted');

    const journalCount = h.state.journals.length;
    const secondUndo = h.run({
      type: 'bankRow.undo',
      input: { rowId: row.id, reversalDate: '2026-11-08', reason: 'Repeat undo' },
    });
    expect(secondUndo.ok).toBe(false);
    if (!secondUndo.ok) expect(secondUndo.error.code).toBe('CONFLICT');
    expect(h.state.journals.length).toBe(journalCount);
    expect(h.state.journals.filter((journal) => journal.reversalOf === clearingJournal.id)).toHaveLength(1);

    const importAgain = importRows(h, [ROW_40K]);
    expect(importAgain.documentId).toBe('');
    expect(h.state.bankRows).toHaveLength(1);
    expect(h.state.bankStatements).toHaveLength(1);
  });
});
