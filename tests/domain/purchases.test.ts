import { describe, expect, it } from 'vitest';
import { accountBalance } from '../../src/domain/ledger';
import { WORKSPACE_A } from '../../src/fixtures/seed';
import type { DomainCommand } from '../../src/domain/commandTypes';
import { ACCOUNTS, createHarness, debitTotal, creditTotal } from './harness';

const VENDOR = 'contact-a-vend-1';
const EMPLOYEE = 'emp-a-001';

function billInput(
  overrides: Partial<Extract<DomainCommand, { type: 'bill.create' }>['input']> = {},
): Extract<DomainCommand, { type: 'bill.create' }>['input'] {
  return {
    vendorContactId: VENDOR,
    supplierInvoiceNo: 'SI-0001',
    billDate: '2026-11-01',
    dueDate: '2026-11-30',
    lines: [
      {
        description: 'Synthetic operating expense',
        accountId: ACCOUNTS.adjustment,
        amountCentavos: 50_000,
        taxTreatment: 'none',
      },
    ],
    ...overrides,
  };
}

function approvedPayment(h: ReturnType<typeof createHarness>, billId: string, amountCentavos: number) {
  const rfp = h.runOk({ type: 'rfp.create', input: { billId, amountCentavos } }, { actorId: 'u-maker' });
  h.runOk({ type: 'rfp.approve', input: { rfpId: rfp.documentId } }, { actorId: 'u-checker' });
  return rfp;
}

describe('G03 — expense bill, maker/checker RFP, outgoing clearing, bank match', () => {
  it('keeps the expense at 500.00 and blocks the maker from self-approval', () => {
    const h = createHarness({ actorId: 'u-maker' });
    const bill = h.runOk({ type: 'bill.create', input: billInput() });
    const stored = h.state.bills.find((candidate) => candidate.id === bill.documentId);
    expect(stored?.totalCentavos).toBe(50_000);
    expect(stored?.status).toBe('posted');

    const rfp = h.runOk({ type: 'rfp.create', input: { billId: bill.documentId, amountCentavos: 50_000 } });
    const selfApproval = h.run({ type: 'rfp.approve', input: { rfpId: rfp.documentId } });
    expect(selfApproval.ok).toBe(false);
    if (!selfApproval.ok) expect(selfApproval.error.code).toBe('FORBIDDEN');
    expect(h.state.rfps.find((candidate) => candidate.id === rfp.documentId)?.status).toBe('pending');

    h.runOk({ type: 'rfp.approve', input: { rfpId: rfp.documentId } }, { actorId: 'u-checker' });
    const payment = h.runOk(
      {
        type: 'payment.create',
        input: { rfpId: rfp.documentId, paymentDate: '2026-11-05', method: 'outgoing_clearing' },
      },
      { actorId: 'u-accountant' },
    );
    const paymentRow = h.state.payments.find((candidate) => candidate.id === payment.documentId);
    expect(paymentRow?.ewtCentavos).toBe(0);
    expect(paymentRow?.method).toBe('outgoing_clearing');
    const payJournal = h.state.journals.find((journal) => journal.id === payment.journalIds[0]);
    expect(payJournal?.lines.find((line) => line.accountId === ACCOUNTS.ap)?.debitCentavos).toBe(50_000);
    expect(payJournal?.lines.find((line) => line.accountId === ACCOUNTS.outgoingClearing)?.creditCentavos).toBe(50_000);

    h.runOk({
      type: 'bankRow.import',
      input: {
        bankAccountId: 'bank-a-1',
        sourceName: 'november.csv',
        rows: [
          {
            rowRef: 'BNK-1',
            valueDate: '2026-11-06',
            description: 'Outgoing payment synthetic',
            direction: 'out',
            amountCentavos: 50_000,
          },
        ],
      },
    });
    const bankRow = h.state.bankRows.find((row) => row.rowRef === 'BNK-1');
    h.runOk({
      type: 'bankRow.match',
      input: {
        rowId: bankRow!.id,
        sourceType: 'payment',
        sourceId: payment.documentId,
        reason: 'Exact amount and reference',
      },
    });
    expect(h.state.payments.find((candidate) => candidate.id === payment.documentId)?.status).toBe('cleared');
    expect(h.state.bankRows.find((row) => row.rowRef === 'BNK-1')?.status).toBe('reconciled');
    expect(accountBalance(h.state, WORKSPACE_A, ACCOUNTS.outgoingClearing, null, null).netDebitCentavos).toBe(0);
    expect(accountBalance(h.state, WORKSPACE_A, ACCOUNTS.bank, null, null).netDebitCentavos).toBe(950_000);
    expect(accountBalance(h.state, WORKSPACE_A, ACCOUNTS.adjustment, null, null).netDebitCentavos).toBe(50_000);
  });
});

describe('G04 / G05 — employee advances liquidate without payroll deduction', () => {
  it('returns 200.00 unused from a 1,000.00 advance against 800.00 expenses', () => {
    const h = createHarness();
    const advance = h.runOk({
      type: 'advance.create',
      input: { employeeId: EMPLOYEE, advanceDate: '2026-11-02', amountCentavos: 100_000, bankAccountId: 'bank-a-1' },
    });
    const liquidation = h.runOk({
      type: 'advance.liquidate',
      input: {
        advanceId: advance.documentId,
        liquidationDate: '2026-11-08',
        expenses: [{ accountId: ACCOUNTS.adjustment, description: 'Site supplies', amountCentavos: 80_000 }],
        unusedReturnCentavos: 20_000,
        excessReimbursementCentavos: 0,
        bankAccountId: 'bank-a-1',
      },
    });
    expect(h.state.advances.find((row) => row.id === advance.documentId)?.status).toBe('closed');
    expect(h.state.advances.find((row) => row.id === advance.documentId)?.liquidatedCentavos).toBe(80_000);
    expect(h.state.advances.find((row) => row.id === advance.documentId)?.returnedCentavos).toBe(20_000);
    expect(accountBalance(h.state, WORKSPACE_A, ACCOUNTS.employeeAdvance, null, null).netDebitCentavos).toBe(0);
    expect(accountBalance(h.state, WORKSPACE_A, ACCOUNTS.adjustment, null, null).netDebitCentavos).toBe(80_000);
    expect(accountBalance(h.state, WORKSPACE_A, ACCOUNTS.bank, null, null).netDebitCentavos).toBe(920_000);
    expect(liquidation.journalIds).toHaveLength(1);
    expect(h.state.payrollRuns).toHaveLength(0);
    expect(h.state.liquidations.find((row) => row.advanceId === advance.documentId)?.expenses).toHaveLength(1);
  });

  it('settles a 200.00 advance excess exactly once when expenses exceed the advance', () => {
    const h = createHarness();
    const advance = h.runOk({
      type: 'advance.create',
      input: { employeeId: EMPLOYEE, advanceDate: '2026-11-02', amountCentavos: 100_000, bankAccountId: 'bank-a-1' },
    });
    const liquidation = h.runOk({
      type: 'advance.liquidate',
      input: {
        advanceId: advance.documentId,
        liquidationDate: '2026-11-09',
        expenses: [{ accountId: ACCOUNTS.adjustment, description: 'Emergency repair', amountCentavos: 120_000 }],
        unusedReturnCentavos: 0,
        excessReimbursementCentavos: 20_000,
        bankAccountId: 'bank-a-1',
      },
    });
    expect(liquidation.journalIds).toHaveLength(2);
    const [first, second] = liquidation.journalIds.map((id) => h.state.journals.find((journal) => journal.id === id));
    expect(debitTotal(h, first!.id)).toBe(120_000);
    expect(first?.lines.find((line) => line.accountId === ACCOUNTS.employeeAdvance)?.creditCentavos).toBe(100_000);
    expect(first?.lines.find((line) => line.accountId === ACCOUNTS.employeePayable)?.creditCentavos).toBe(20_000);
    expect(debitTotal(h, second!.id)).toBe(20_000);
    expect(creditTotal(h, second!.id)).toBe(20_000);
    expect(second?.lines.find((line) => line.accountId === ACCOUNTS.bank)?.creditCentavos).toBe(20_000);
    expect(accountBalance(h.state, WORKSPACE_A, ACCOUNTS.employeePayable, null, null).netDebitCentavos).toBe(0);
    expect(accountBalance(h.state, WORKSPACE_A, ACCOUNTS.employeeAdvance, null, null).netDebitCentavos).toBe(0);
    expect(accountBalance(h.state, WORKSPACE_A, ACCOUNTS.adjustment, null, null).netDebitCentavos).toBe(120_000);

    const journalCount = h.state.journals.length;
    const revision = h.state.revision;
    const again = h.run({
      type: 'advance.liquidate',
      input: {
        advanceId: advance.documentId,
        liquidationDate: '2026-11-10',
        expenses: [{ accountId: ACCOUNTS.adjustment, description: 'Duplicate', amountCentavos: 120_000 }],
        unusedReturnCentavos: 0,
        excessReimbursementCentavos: 20_000,
        bankAccountId: 'bank-a-1',
      },
    });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe('CONFLICT');
    expect(h.state.journals.length).toBe(journalCount);
    expect(h.state.revision).toBe(revision);
  });
});

describe('G19 — illustrative input VAT and creditable withholding', () => {
  it('posts AP 1,120.00 and settlement cash 1,100.00 with EWT 20.00, then a 2307 reference', () => {
    const h = createHarness();
    const bill = h.runOk({
      type: 'bill.create',
      input: billInput({
        supplierInvoiceNo: 'SI-VAT-1',
        lines: [
          {
            description: 'Synthetic professional fee',
            accountId: ACCOUNTS.adjustment,
            amountCentavos: 100_000,
            taxTreatment: 'input_vat12',
            ewtRateBp: 200,
          },
        ],
      }),
    });
    const storedBill = h.state.bills.find((candidate) => candidate.id === bill.documentId);
    expect(storedBill?.subtotalCentavos).toBe(100_000);
    expect(storedBill?.taxCentavos).toBe(12_000);
    expect(storedBill?.totalCentavos).toBe(112_000);
    expect(storedBill?.ewtCentavos).toBe(2_000);
    const billJournal = h.state.journals.find((journal) => journal.id === bill.journalIds[0]);
    expect(billJournal?.lines.find((line) => line.accountId === ACCOUNTS.adjustment)?.debitCentavos).toBe(100_000);
    expect(billJournal?.lines.find((line) => line.accountId === ACCOUNTS.inputVat)?.debitCentavos).toBe(12_000);
    expect(billJournal?.lines.find((line) => line.accountId === ACCOUNTS.ap)?.creditCentavos).toBe(112_000);

    const rfp = approvedPayment(h, bill.documentId, 112_000);
    const payment = h.runOk({
      type: 'payment.create',
      input: {
        rfpId: rfp.documentId,
        paymentDate: '2026-11-20',
        method: 'bank_direct',
        bankAccountId: 'bank-a-1',
      },
    });
    const paymentRow = h.state.payments.find((candidate) => candidate.id === payment.documentId);
    expect(paymentRow?.ewtCentavos).toBe(2_000);
    const payJournal = h.state.journals.find((journal) => journal.id === payment.journalIds[0]);
    expect(payJournal?.lines.find((line) => line.accountId === ACCOUNTS.ap)?.debitCentavos).toBe(112_000);
    expect(payJournal?.lines.find((line) => line.accountId === ACCOUNTS.bank)?.creditCentavos).toBe(110_000);
    expect(payJournal?.lines.find((line) => line.accountId === ACCOUNTS.ewtPayable)?.creditCentavos).toBe(2_000);
    expect(debitTotal(h, payJournal!.id)).toBe(112_000);
    expect(creditTotal(h, payJournal!.id)).toBe(112_000);

    const ewt = h.state.taxRecords.find((record) => record.type === 'ewt_creditable');
    expect(ewt?.taxCentavos).toBe(2_000);
    expect(ewt?.sourceType).toBe('payment');
    expect(ewt?.sourceId).toBe(payment.documentId);

    const certificate = h.runOk({
      type: 'certificate2307.create',
      input: {
        direction: 'issued',
        counterpartyContactId: VENDOR,
        certificateNo: '2307-0001',
        certificateDate: '2026-11-25',
        periodFrom: '2026-11-01',
        periodTo: '2026-11-30',
        sourceTaxRecordIds: [ewt!.id],
      },
    });
    const storedCertificate = h.state.certificates2307.find((row) => row.id === certificate.documentId);
    expect(storedCertificate?.creditableTaxCentavos).toBe(2_000);
    expect(storedCertificate?.sourceTaxRecordIds).toEqual([ewt!.id]);
    expect(h.state.taxRecords.find((record) => record.id === ewt!.id)?.certificateStatus).toBe('issued');

    const finalWithholding = h.runOk({
      type: 'taxRecord.createFinalWithholding',
      input: {
        partyContactId: VENDOR,
        taxDate: '2026-11-26',
        baseCentavos: 100_000,
        taxCentavos: 10_000,
        description: 'Synthetic final withholding',
      },
    });
    const finalRecord = h.state.taxRecords.find((record) => record.id === finalWithholding.documentId);
    expect(finalRecord?.type).toBe('fwt_final');
    expect(finalRecord?.certificateStatus).toBe('not_required');

    const invalidCertificate = h.run({
      type: 'certificate2307.create',
      input: {
        direction: 'issued',
        counterpartyContactId: VENDOR,
        certificateNo: '2307-0002',
        certificateDate: '2026-11-27',
        periodFrom: '2026-11-01',
        periodTo: '2026-11-30',
        sourceTaxRecordIds: [finalWithholding.documentId],
      },
    });
    expect(invalidCertificate.ok).toBe(false);
    if (!invalidCertificate.ok) expect(invalidCertificate.error.code).toBe('VALIDATION');
    expect(h.state.certificates2307).toHaveLength(1);
  });

  it('holds a duplicate supplier invoice without posting expense twice', () => {
    const h = createHarness();
    h.runOk({ type: 'bill.create', input: billInput() });
    const duplicate = h.runOk({ type: 'bill.create', input: billInput() });
    const held = h.state.bills.find((candidate) => candidate.id === duplicate.documentId);
    expect(held?.status).toBe('held');
    expect(held?.duplicateFlag).toBe(true);
    expect(held?.journalId).toBeNull();
    expect(duplicate.journalIds).toHaveLength(0);
    expect(accountBalance(h.state, WORKSPACE_A, ACCOUNTS.adjustment, null, null).netDebitCentavos).toBe(50_000);
    expect(accountBalance(h.state, WORKSPACE_A, ACCOUNTS.ap, null, null).netDebitCentavos).toBe(-50_000);
  });
});

describe('payment release after independent approval', () => {
  it('lets the request maker release an approved payment without re-approval', () => {
    const h = createHarness();
    const bill = h.runOk({ type: 'bill.create', input: billInput() });
    const rfp = h.runOk({ type: 'rfp.create', input: { billId: bill.documentId, amountCentavos: 50_000 } });
    h.runOk({ type: 'rfp.approve', input: { rfpId: rfp.documentId } }, { actorId: 'u-checker' });
    expect(h.state.rfps.find((candidate) => candidate.id === rfp.documentId)?.approvedBy).toBe('u-checker');

    const payment = h.runOk({
      type: 'payment.create',
      input: { rfpId: rfp.documentId, paymentDate: '2026-11-05', method: 'outgoing_clearing' },
    });
    expect(h.state.payments.find((candidate) => candidate.id === payment.documentId)?.status).toBe('posted');
    expect(h.state.rfps.find((candidate) => candidate.id === rfp.documentId)?.status).toBe('paid');
    expect(accountBalance(h.state, WORKSPACE_A, ACCOUNTS.ap, null, null).netDebitCentavos).toBe(0);
  });

  it('still refuses execution before the checker approves', () => {
    const h = createHarness();
    const bill = h.runOk({ type: 'bill.create', input: billInput() });
    const rfp = h.runOk({ type: 'rfp.create', input: { billId: bill.documentId, amountCentavos: 50_000 } });
    const early = h.run({
      type: 'payment.create',
      input: { rfpId: rfp.documentId, paymentDate: '2026-11-05', method: 'outgoing_clearing' },
    });
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.error.code).toBe('CONFLICT');
    expect(h.state.payments).toHaveLength(0);
  });
});
