import { describe, expect, it } from 'vitest';
import { accountBalance } from '../../src/domain/ledger';
import {
  certificate2307Register,
  taxRegister,
  CERTIFICATE_GRACE_DAYS,
} from '../../src/domain/queries';
import { WORKSPACE_A } from '../../src/fixtures/seed';
import type { DomainCommand } from '../../src/domain/commandTypes';
import { ACCOUNTS, createHarness, creditTotal, debitTotal } from './harness';

const CUSTOMER = 'contact-a-cust-1';
const VENDOR = 'contact-a-vend-1';

type Harness = ReturnType<typeof createHarness>;
type BillInput = Extract<DomainCommand, { type: 'bill.create' }>['input'];

function vatInvoice(h: Harness, netCentavos = 100_000, date = '2026-11-05') {
  const created = h.runOk({
    type: 'invoice.create',
    input: {
      customerContactId: CUSTOMER,
      invoiceDate: date,
      dueDate: '2026-11-30',
      branch: 'HEAD OFFICE',
      department: 'SERVICES',
      taxTreatment: 'vat12',
      lines: [
        {
          description: 'Synthetic taxable service',
          quantityMilli: 1000,
          unitPriceCentavos: netCentavos,
          accountId: ACCOUNTS.revenue,
        },
      ],
    },
  });
  h.runOk({ type: 'invoice.post', input: { invoiceId: created.documentId } });
  return created.documentId;
}

function vatBill(
  h: Harness,
  supplierInvoiceNo: string,
  netCentavos = 100_000,
  billDate = '2026-11-04',
  ewtRateBp = 200,
) {
  const input: BillInput = {
    vendorContactId: VENDOR,
    supplierInvoiceNo,
    billDate,
    dueDate: '2026-11-30',
    lines: [
      {
        description: 'Synthetic taxable purchase',
        accountId: ACCOUNTS.adjustment,
        amountCentavos: netCentavos,
        taxTreatment: 'input_vat12',
        ewtRateBp,
      },
    ],
  };
  return h.runOk({ type: 'bill.create', input });
}

function payBill(h: Harness, billId: string, paymentDate = '2026-11-20') {
  const rfp = h.runOk({ type: 'rfp.create', input: { billId, amountCentavos: 112_000 } });
  h.runOk({ type: 'rfp.approve', input: { rfpId: rfp.documentId } }, { actorId: 'u-checker' });
  return h.runOk({
    type: 'payment.create',
    input: { rfpId: rfp.documentId, paymentDate, method: 'bank_direct', bankAccountId: 'bank-a-1' },
  });
}

describe('G12 — output VAT', () => {
  it('records 12% output VAT on a posted taxable invoice and backs it with a journal', () => {
    const h = createHarness();
    vatInvoice(h, 100_000);

    const invoice = h.state.invoices[0]!;
    expect(invoice.subtotalCentavos).toBe(100_000);
    expect(invoice.taxCentavos).toBe(12_000);
    expect(invoice.totalCentavos).toBe(112_000);
    expect(accountBalance(h.state, WORKSPACE_A, ACCOUNTS.ar, null, null).netDebitCentavos).toBe(112_000);
    expect(accountBalance(h.state, WORKSPACE_A, ACCOUNTS.outputVat, null, null).netDebitCentavos).toBe(-12_000);

    const register = taxRegister(h.state, WORKSPACE_A, '2026-11-01', '2026-11-30');
    expect(register.rows).toHaveLength(1);
    expect(register.rows[0]).toMatchObject({
      type: 'output_vat',
      direction: 'output',
      sourceType: 'invoice',
      sourceId: invoice.id,
      sourceNo: 'INV-0001',
      baseCentavos: 100_000,
      taxCentavos: 12_000,
      certificateState: 'not_required',
    });
    expect(register.summary.outputVatCentavos).toBe(12_000);
    expect(register.summary.inputVatCentavos).toBe(0);
    expect(register.summary.netVatPayableCentavos).toBe(12_000);
  });

  it('reduces output VAT with a taxable credit note instead of rewriting the invoice', () => {
    const h = createHarness();
    const invoiceId = vatInvoice(h, 100_000);
    h.runOk({
      type: 'creditNote.create',
      input: { invoiceId, creditDate: '2026-11-10', netCentavos: 50_000, reason: 'Synthetic VAT credit' },
    });

    const register = taxRegister(h.state, WORKSPACE_A, '2026-11-01', '2026-11-30');
    expect(register.rows).toHaveLength(2);
    const credit = register.rows.find((row) => row.sourceType === 'credit_note')!;
    expect(credit.sourceNo).toBe('CN-0001');
    expect(credit.baseCentavos).toBe(-50_000);
    expect(credit.taxCentavos).toBe(-6_000);
    expect(register.summary.outputVatCentavos).toBe(6_000);
    expect(h.state.invoices[0]?.taxCentavos).toBe(12_000);
  });
});

describe('G19 — input VAT and creditable EWT on payment', () => {
  it('pays 112,000 with 2,000 withheld, leaving 110,000 cash and a credit EWT payable', () => {
    const h = createHarness();
    const bill = vatBill(h, 'G19-BILL-1');
    const billId = bill.documentId;
    expect(h.state.bills[0]).toMatchObject({
      subtotalCentavos: 100_000,
      taxCentavos: 12_000,
      totalCentavos: 112_000,
      ewtCentavos: 2_000,
      status: 'posted',
    });
    expect(accountBalance(h.state, WORKSPACE_A, ACCOUNTS.ap, null, null).netDebitCentavos).toBe(-112_000);
    expect(accountBalance(h.state, WORKSPACE_A, ACCOUNTS.inputVat, null, null).netDebitCentavos).toBe(12_000);

    const payment = payBill(h, billId);
    const row = h.state.payments.find((candidate) => candidate.id === payment.documentId)!;
    expect(row.amountCentavos).toBe(112_000);
    expect(row.ewtCentavos).toBe(2_000);
    const journal = h.state.journals.find((candidate) => candidate.id === row.journalId)!;
    expect(journal.lines.find((line) => line.accountId === ACCOUNTS.ap)?.debitCentavos).toBe(112_000);
    expect(journal.lines.find((line) => line.accountId === ACCOUNTS.bank)?.creditCentavos).toBe(110_000);
    expect(journal.lines.find((line) => line.accountId === ACCOUNTS.ewtPayable)?.creditCentavos).toBe(2_000);
    expect(debitTotal(h, journal.id)).toBe(creditTotal(h, journal.id));

    expect(accountBalance(h.state, WORKSPACE_A, ACCOUNTS.bank, null, null).netDebitCentavos).toBe(890_000);
    expect(accountBalance(h.state, WORKSPACE_A, ACCOUNTS.ewtPayable, null, null).netDebitCentavos).toBe(-2_000);
    expect(h.state.bills[0]).toMatchObject({ paidCentavos: 112_000, outstandingCentavos: 0, status: 'paid' });

    const register = taxRegister(h.state, WORKSPACE_A, '2026-11-01', '2026-11-30');
    expect(register.summary.inputVatCentavos).toBe(12_000);
    expect(register.summary.ewtCreditableCentavos).toBe(2_000);
    expect(register.summary.outputVatCentavos).toBe(0);
    expect(register.summary.netVatPayableCentavos).toBe(-12_000);
    const ewt = register.rows.find((candidate) => candidate.type === 'ewt_creditable')!;
    expect(ewt).toMatchObject({
      direction: 'creditable',
      sourceType: 'payment',
      sourceNo: 'PAY-0001',
      baseCentavos: 100_000,
      taxCentavos: 2_000,
      certificateStatus: 'pending',
      certificateId: null,
      certificateState: 'pending',
      partyName: 'Metro Office Supply Demo Co.',
    });
    expect(register.summary.pendingCertificateCount).toBe(1);
    expect(register.summary.missingCertificateCount).toBe(0);
  });

  it('links a 2307 to creditable EWT and keeps final withholding out of the register', () => {
    const h = createHarness();
    const bill = vatBill(h, 'G19-BILL-2');
    payBill(h, bill.documentId);
    const ewt = h.state.taxRecords.find((record) => record.type === 'ewt_creditable')!;

    const certificate = h.runOk({
      type: 'certificate2307.create',
      input: {
        direction: 'issued',
        counterpartyContactId: VENDOR,
        certificateNo: '2307-0001',
        certificateDate: '2026-12-31',
        periodFrom: '2026-11-01',
        periodTo: '2026-11-30',
        sourceTaxRecordIds: [ewt.id],
      },
    });
    const linked = h.state.taxRecords.find((record) => record.id === ewt.id)!;
    expect(linked.certificateStatus).toBe('issued');
    expect(linked.certificateId).toBe(certificate.documentId);

    const register = certificate2307Register(h.state, WORKSPACE_A);
    expect(register).toHaveLength(1);
    expect(register[0]).toMatchObject({
      id: certificate.documentId,
      direction: 'issued',
      certificateNo: '2307-0001',
      counterpartyName: 'Metro Office Supply Demo Co.',
      baseCentavos: 100_000,
      creditableTaxCentavos: 2_000,
      sourceCount: 1,
      status: 'issued',
    });
    const taxRow = taxRegister(h.state, WORKSPACE_A, '2026-11-01', '2026-11-30').rows.find(
      (row) => row.id === ewt.id,
    )!;
    expect(taxRow.certificateState).toBe('linked');
    expect(taxRow.certificateNo).toBe('2307-0001');

    const fwt = h.runOk({
      type: 'taxRecord.createFinalWithholding',
      input: {
        partyContactId: 'contact-a-vend-2',
        taxDate: '2026-11-21',
        baseCentavos: 200_000,
        taxCentavos: 20_000,
        description: 'Synthetic final withholding on royalties',
      },
    });
    const finalRow = taxRegister(h.state, WORKSPACE_A, '2026-11-01', '2026-11-30').rows.find(
      (row) => row.id === fwt.documentId,
    )!;
    expect(finalRow.type).toBe('fwt_final');
    expect(finalRow.direction).toBe('final');
    expect(finalRow.certificateStatus).toBe('not_required');
    expect(finalRow.certificateState).toBe('not_required');
    expect(taxRegister(h.state, WORKSPACE_A, '2026-11-01', '2026-11-30').summary.fwtFinalCentavos).toBe(20_000);

    const invalid = h.run({
      type: 'certificate2307.create',
      input: {
        direction: 'issued',
        counterpartyContactId: 'contact-a-vend-2',
        certificateNo: '2307-0002',
        certificateDate: '2026-12-31',
        periodFrom: '2026-11-01',
        periodTo: '2026-11-30',
        sourceTaxRecordIds: [fwt.documentId],
      },
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.code).toBe('VALIDATION');
    expect(h.state.certificates2307).toHaveLength(1);
  });
});

describe('certificate gaps and duplicate controls', () => {
  it('moves an unlinked EWT record from pending to missing after the synthetic grace period', () => {
    const h = createHarness();
    const bill = vatBill(h, 'GAP-BILL-1', 100_000, '2026-11-20');
    payBill(h, bill.documentId, '2026-11-20');

    const withinGrace = taxRegister(h.state, WORKSPACE_A, '2026-11-01', '2026-11-30', {
      asOfDate: '2026-12-01',
    });
    expect(withinGrace.rows.find((row) => row.type === 'ewt_creditable')?.certificateState).toBe('pending');
    expect(withinGrace.summary.missingCertificateCount).toBe(0);

    const pastGrace = taxRegister(h.state, WORKSPACE_A, '2026-11-01', '2026-11-30', {
      asOfDate: '2026-12-25',
    });
    expect(pastGrace.rows.find((row) => row.type === 'ewt_creditable')?.certificateState).toBe('missing');
    expect(pastGrace.summary.pendingCertificateCount).toBe(0);
    expect(pastGrace.summary.missingCertificateCount).toBe(1);
    expect(CERTIFICATE_GRACE_DAYS).toBe(30);
  });

  it('refuses duplicate certificate numbers and reuse of an already-certified record', () => {
    const h = createHarness();
    const first = vatBill(h, 'DUP-BILL-1');
    payBill(h, first.documentId);
    const second = vatBill(h, 'DUP-BILL-2');
    payBill(h, second.documentId);
    const records = h.state.taxRecords.filter((record) => record.type === 'ewt_creditable');
    expect(records).toHaveLength(2);

    h.runOk({
      type: 'certificate2307.create',
      input: {
        direction: 'issued',
        counterpartyContactId: VENDOR,
        certificateNo: '2307-DUP',
        certificateDate: '2026-12-31',
        periodFrom: '2026-11-01',
        periodTo: '2026-11-30',
        sourceTaxRecordIds: [records[0]!.id],
      },
    });

    const duplicateNo = h.run({
      type: 'certificate2307.create',
      input: {
        direction: 'issued',
        counterpartyContactId: VENDOR,
        certificateNo: '2307-DUP',
        certificateDate: '2026-12-31',
        periodFrom: '2026-11-01',
        periodTo: '2026-11-30',
        sourceTaxRecordIds: [records[1]!.id],
      },
    });
    expect(duplicateNo.ok).toBe(false);
    if (!duplicateNo.ok) expect(duplicateNo.error.code).toBe('DUPLICATE_ROW');

    const reused = h.run({
      type: 'certificate2307.create',
      input: {
        direction: 'issued',
        counterpartyContactId: VENDOR,
        certificateNo: '2307-OTHER',
        certificateDate: '2026-12-31',
        periodFrom: '2026-11-01',
        periodTo: '2026-11-30',
        sourceTaxRecordIds: [records[0]!.id],
      },
    });
    expect(reused.ok).toBe(false);
    if (!reused.ok) expect(reused.error.code).toBe('CONFLICT');
    expect(h.state.certificates2307).toHaveLength(1);
    expect(h.state.taxRecords.find((record) => record.id === records[1]!.id)?.certificateStatus).toBe('pending');
  });
});

describe('tax register scope', () => {
  it('filters by period and excludes other companies', () => {
    const h = createHarness();
    vatInvoice(h, 100_000, '2026-10-15');
    expect(taxRegister(h.state, WORKSPACE_A, '2026-11-01', '2026-11-30').rows).toHaveLength(0);
    expect(taxRegister(h.state, WORKSPACE_A, '2026-10-01', '2026-10-31').rows).toHaveLength(1);

    const foreign = structuredClone(h.state.taxRecords[0]!);
    foreign.id = 'tax-ws-b';
    foreign.workspaceId = 'ws-b';
    const mixed = structuredClone(h.state);
    mixed.taxRecords.push(foreign);
    expect(taxRegister(mixed, WORKSPACE_A, '2026-10-01', '2026-10-31').rows).toHaveLength(1);
    expect(taxRegister(mixed, 'ws-b', '2026-10-01', '2026-10-31').summary.outputVatCentavos).toBe(12_000);
    expect(certificate2307Register(mixed, WORKSPACE_A)).toHaveLength(0);
  });
});
