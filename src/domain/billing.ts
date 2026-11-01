import type { DomainCommand, CommandResult } from './commandTypes';
import { postJournal, recordAudit, reverseJournal, type WriteContext } from './ledger';
import type { AppState, Contact, Invoice, InvoiceLine, Receipt } from './schema';
import { requireAccountByRole, requireProduct, requireRole, resolveAccess } from './shared/access';
import { parseDateOnly } from './shared/dates';
import { pushItem, setRecordValue, updateItem, type StateDraft } from './shared/draft';
import { applyBasisPoints, mulDivRound, sumCentavos } from './shared/money';
import { err, ok, type Result } from './shared/result';
import { allocateCode } from './numbering';

const VAT_BP = 1200;

type InvoiceCreateInput = Extract<DomainCommand, { type: 'invoice.create' }>['input'];


export function contactWithRole(
  ctx: WriteContext | { state: AppState; workspaceId: string },
  contactId: string,
  role: 'customer' | 'vendor',
): Contact | undefined {
  return ctx.state.contacts.find(
    (contact) =>
      contact.id === contactId &&
      contact.workspaceId === ctx.workspaceId &&
      contact.active &&
      contact.roles.includes(role),
  );
}

function revenueAccount(ctx: WriteContext, accountId: string) {
  const account = ctx.state.accounts.find(
    (candidate) => candidate.id === accountId && candidate.workspaceId === ctx.workspaceId,
  );
  if (!account) return err('VALIDATION', 'The selected revenue account does not belong to this workspace.', 'accountId');
  if (!account.active) return err('VALIDATION', `Revenue account ${account.code} is inactive.`, 'accountId');
  if (account.type !== 'revenue') {
    return err('VALIDATION', `Account ${account.code} is not a revenue account.`, 'accountId');
  }
  return ok(account);
}

function buildInvoiceLines(ctx: WriteContext, input: InvoiceCreateInput): Result<InvoiceLine[]> {
  if (input.lines.length === 0) return err('VALIDATION', 'At least one invoice line is required.', 'lines');
  const lines: InvoiceLine[] = [];
  for (const [index, raw] of input.lines.entries()) {
    if (raw.description.trim().length === 0) {
      return err('VALIDATION', `Line ${index + 1} needs a description.`, `lines.${index}.description`);
    }
    if (!Number.isSafeInteger(raw.quantityMilli) || raw.quantityMilli <= 0) {
      return err('VALIDATION', `Line ${index + 1} quantity must be positive.`, `lines.${index}.quantityMilli`);
    }
    if (!Number.isSafeInteger(raw.unitPriceCentavos) || raw.unitPriceCentavos < 0) {
      return err('VALIDATION', `Line ${index + 1} rate must be zero or more.`, `lines.${index}.unitPriceCentavos`);
    }
    const account = revenueAccount(ctx, raw.accountId);
    if (!account.ok) return account;
    lines.push({
      id: ctx.clock.newId('invline'),
      description: raw.description.trim(),
      quantityMilli: raw.quantityMilli,
      unitPriceCentavos: raw.unitPriceCentavos,
      accountId: account.value.id,
      amountCentavos: mulDivRound(raw.unitPriceCentavos, raw.quantityMilli, 1000),
    });
  }
  return ok(lines);
}

function invoiceAmounts(
  lines: InvoiceLine[],
  taxTreatment: 'none' | 'vat12',
): { subtotal: number; tax: number; total: number } {
  const subtotal = sumCentavos(lines.map((line) => line.amountCentavos));
  const tax = taxTreatment === 'vat12' ? applyBasisPoints(subtotal, VAT_BP) : 0;
  return { subtotal, tax, total: subtotal + tax };
}

function validateInvoiceInput(ctx: WriteContext, input: InvoiceCreateInput): Result<{
  customer: Contact;
  lines: InvoiceLine[];
  amounts: { subtotal: number; tax: number; total: number };
}> {
  const customer = contactWithRole(ctx, input.customerContactId, 'customer');
  if (!customer) {
    return err('VALIDATION', 'Select an active customer contact from this workspace.', 'customerContactId');
  }
  const invoiceDate = parseDateOnly(input.invoiceDate, 'invoiceDate');
  if (!invoiceDate.ok) return invoiceDate;
  const dueDate = parseDateOnly(input.dueDate, 'dueDate');
  if (!dueDate.ok) return dueDate;
  if (input.dueDate < input.invoiceDate) {
    return err('VALIDATION', 'Due date cannot be before the invoice date.', 'dueDate');
  }
  if (input.taxTreatment !== 'none' && input.taxTreatment !== 'vat12') {
    return err('VALIDATION', 'Unknown tax treatment.', 'taxTreatment');
  }
  const lines = buildInvoiceLines(ctx, input);
  if (!lines.ok) return lines;
  return ok({ customer, lines: lines.value, amounts: invoiceAmounts(lines.value, input.taxTreatment) });
}

export function createInvoice(
  draft: StateDraft,
  ctx: WriteContext,
  input: InvoiceCreateInput,
): Result<CommandResult> {
  const product = requireProduct(ctx, 'accounting');
  if (!product.ok) return product;
  const role = requireRole(ctx, 'accountant', 'ap_ar_clerk', 'company_admin');
  if (!role.ok) return role;
  const validated = validateInvoiceInput(ctx, input);
  if (!validated.ok) return validated;
  const ar = requireAccountByRole(ctx.state, ctx.workspaceId, 'ar');
  if (!ar.ok) return ar;
  let taxAccountId: string | null = null;
  if (input.taxTreatment === 'vat12') {
    const taxAccount = requireAccountByRole(ctx.state, ctx.workspaceId, 'output_vat');
    if (!taxAccount.ok) return taxAccount;
    taxAccountId = taxAccount.value.id;
  }

  const invoiceNo = allocateCode(draft, ctx.workspaceId, 'invoice');
  if (!invoiceNo.ok) return invoiceNo;
  const id = ctx.clock.newId('inv');
  const invoice: Invoice = {
    id,
    workspaceId: ctx.workspaceId,
    invoiceNo: invoiceNo.value,
    customerContactId: validated.value.customer.id,
    customerSnapshot: {
      name: validated.value.customer.name,
      tin: validated.value.customer.tin,
      address: validated.value.customer.address,
    },
    branch: input.branch.trim(),
    department: input.department.trim(),
    invoiceDate: input.invoiceDate,
    dueDate: input.dueDate,
    status: 'draft',
    taxTreatment: input.taxTreatment,
    lines: validated.value.lines,
    subtotalCentavos: validated.value.amounts.subtotal,
    taxCentavos: validated.value.amounts.tax,
    totalCentavos: validated.value.amounts.total,
    paidCentavos: 0,
    outstandingCentavos: 0,
    arAccountId: ar.value.id,
    revenueAccountId: validated.value.lines[0]?.accountId ?? '',
    taxAccountId,
    journalId: null,
    stockIssueMovementId: input.stockIssueMovementId ?? null,
    createdAt: ctx.clock.nowIso,
    createdBy: ctx.actorId,
    postedAt: null,
    revision: 1,
  };
  pushItem(draft, 'invoices', invoice);
  recordAudit(draft, ctx, {
    action: 'invoice.createDraft',
    recordType: 'invoice',
    recordId: id,
    detail: { invoiceNo: invoice.invoiceNo, totalCentavos: invoice.totalCentavos },
  });
  return ok({
    summary: `Draft invoice ${invoice.invoiceNo} created.`,
    documentType: 'invoice',
    documentId: id,
    journalIds: [],
    warnings: [],
  });
}

export function updateInvoice(
  draft: StateDraft,
  ctx: WriteContext,
  input: { invoiceId: string; input: InvoiceCreateInput },
): Result<CommandResult> {
  const role = requireRole(ctx, 'accountant', 'ap_ar_clerk', 'company_admin');
  if (!role.ok) return role;
  const existing = ctx.state.invoices.find(
    (invoice) => invoice.id === input.invoiceId && invoice.workspaceId === ctx.workspaceId,
  );
  if (!existing) return err('NOT_FOUND', 'Invoice not found in this workspace.');
  if (existing.status !== 'draft') {
    return err('CONFLICT', 'Only a draft invoice can be edited. Posted financial fields are immutable.');
  }
  const validated = validateInvoiceInput(ctx, input.input);
  if (!validated.ok) return validated;
  let taxAccountId: string | null = null;
  if (input.input.taxTreatment === 'vat12') {
    const taxAccount = requireAccountByRole(ctx.state, ctx.workspaceId, 'output_vat');
    if (!taxAccount.ok) return taxAccount;
    taxAccountId = taxAccount.value.id;
  }
  const updated = updateItem(
    draft,
    'invoices',
    (invoice) => invoice.id === existing.id,
    (invoice) => ({
      ...invoice,
      customerContactId: validated.value.customer.id,
      customerSnapshot: {
        name: validated.value.customer.name,
        tin: validated.value.customer.tin,
        address: validated.value.customer.address,
      },
      branch: input.input.branch.trim(),
      department: input.input.department.trim(),
      invoiceDate: input.input.invoiceDate,
      dueDate: input.input.dueDate,
      taxTreatment: input.input.taxTreatment,
      lines: validated.value.lines,
      subtotalCentavos: validated.value.amounts.subtotal,
      taxCentavos: validated.value.amounts.tax,
      totalCentavos: validated.value.amounts.total,
      revenueAccountId: validated.value.lines[0]?.accountId ?? invoice.revenueAccountId,
      taxAccountId,
      stockIssueMovementId: input.input.stockIssueMovementId ?? null,
      revision: invoice.revision + 1,
    }),
  );
  if (!updated) return err('NOT_FOUND', 'Invoice not found.');
  recordAudit(draft, ctx, {
    action: 'invoice.updateDraft',
    recordType: 'invoice',
    recordId: existing.id,
    detail: { revision: updated.revision, totalCentavos: updated.totalCentavos },
  });
  return ok({
    summary: `Draft invoice ${updated.invoiceNo} updated.`,
    documentType: 'invoice',
    documentId: updated.id,
    journalIds: [],
    warnings: [],
  });
}

export function postInvoice(
  draft: StateDraft,
  ctx: WriteContext,
  input: { invoiceId: string },
): Result<CommandResult> {
  const product = requireProduct(ctx, 'accounting');
  if (!product.ok) return product;
  const role = requireRole(ctx, 'accountant', 'ap_ar_clerk', 'company_admin');
  if (!role.ok) return role;
  const invoice = ctx.state.invoices.find(
    (candidate) => candidate.id === input.invoiceId && candidate.workspaceId === ctx.workspaceId,
  );
  if (!invoice) return err('NOT_FOUND', 'Invoice not found in this workspace.');
  if (invoice.status !== 'draft') {
    return err('CONFLICT', `Invoice ${invoice.invoiceNo} is already ${invoice.status}; posting did not run.`);
  }
  if (invoice.stockIssueMovementId !== null) {
    const movement = ctx.state.movements.find((candidate) => candidate.id === invoice.stockIssueMovementId);
    if (!movement || movement.workspaceId !== ctx.workspaceId || movement.type !== 'issue') {
      return err('VALIDATION', 'The linked stock issue is not a valid issue movement in this workspace.');
    }
    const alreadyLinked = ctx.state.invoices.some(
      (candidate) => candidate.id !== invoice.id && candidate.stockIssueMovementId === invoice.stockIssueMovementId,
    );
    if (alreadyLinked) {
      return err('CONFLICT', 'That stock issue is already linked to another invoice; stock must not be issued twice.');
    }
  }
  const taxAccount = invoice.taxAccountId
    ? ctx.state.accounts.find((account) => account.id === invoice.taxAccountId)
    : undefined;
  if (invoice.taxCentavos > 0 && !taxAccount) {
    return err('POLICY_INCOMPLETE', 'Output VAT account mapping is missing.');
  }

  const lines = invoice.lines.map((line) => ({
    accountId: line.accountId,
    debitCentavos: 0,
    creditCentavos: line.amountCentavos,
    memo: line.description,
  }));
  const journal = postJournal(draft, ctx, {
    postingDate: invoice.invoiceDate,
    documentDate: invoice.invoiceDate,
    sourceType: 'invoice',
    sourceId: invoice.id,
    effectKey: `invoice-post:${invoice.id}`,
    memo: `Sales invoice ${invoice.invoiceNo} — ${invoice.customerSnapshot.name}`,
    lines: [
      { accountId: invoice.arAccountId, debitCentavos: invoice.totalCentavos, creditCentavos: 0 },
      ...lines,
      ...(invoice.taxCentavos > 0 && taxAccount
        ? [
            {
              accountId: taxAccount.id,
              debitCentavos: 0,
              creditCentavos: invoice.taxCentavos,
              memo: 'Output VAT — demo 12% profile',
            },
          ]
        : []),
    ],
    policySnapshot:
      invoice.taxTreatment === 'vat12'
        ? 'DEMO TAX PROFILE: 12% output VAT — illustrative wiring test, not a claim of current statutory applicability.'
        : 'DEMO TAX PROFILE: zero VAT synthetic profile.',
  });
  if (!journal.ok) return journal;

  updateItem(
    draft,
    'invoices',
    (candidate) => candidate.id === invoice.id,
    (candidate) => ({
      ...candidate,
      status: 'posted',
      journalId: journal.value.id,
      outstandingCentavos: candidate.totalCentavos,
      postedAt: ctx.clock.nowIso,
      revision: candidate.revision + 1,
    }),
  );
  if (invoice.taxCentavos > 0) {
    const taxNo = allocateCode(draft, ctx.workspaceId, 'tax_record');
    if (!taxNo.ok) return taxNo;
    pushItem(draft, 'taxRecords', {
      id: ctx.clock.newId('tax'),
      workspaceId: ctx.workspaceId,
      publicNo: taxNo.value,
      type: 'output_vat',
      sourceType: 'invoice',
      sourceId: invoice.id,
      taxDate: invoice.invoiceDate,
      partyContactId: invoice.customerContactId,
      baseCentavos: invoice.subtotalCentavos,
      taxCentavos: invoice.taxCentavos,
      direction: 'output',
      certificateStatus: 'not_required',
      certificateId: null,
      description: `Output VAT on ${invoice.invoiceNo} (illustrative 12%)`,
    });
  }
  recordAudit(draft, ctx, {
    action: 'invoice.post',
    recordType: 'invoice',
    recordId: invoice.id,
    detail: { journalId: journal.value.id, totalCentavos: invoice.totalCentavos },
  });
  return ok({
    summary: `Invoice ${invoice.invoiceNo} posted with journal ${journal.value.journalNo}.`,
    documentType: 'invoice',
    documentId: invoice.id,
    journalIds: [journal.value.id],
    warnings: [],
  });
}

export function reverseInvoice(
  draft: StateDraft,
  ctx: WriteContext,
  input: { invoiceId: string; reversalDate: string; reason: string },
): Result<CommandResult> {
  const role = requireRole(ctx, 'accountant');
  if (!role.ok) return role;
  const invoice = ctx.state.invoices.find(
    (candidate) => candidate.id === input.invoiceId && candidate.workspaceId === ctx.workspaceId,
  );
  if (!invoice) return err('NOT_FOUND', 'Invoice not found in this workspace.');
  if (invoice.status === 'draft' || invoice.status === 'reversed') {
    return err('CONFLICT', 'Only a posted, unpaid invoice can be reversed. Use a credit note for paid invoices.');
  }
  if (invoice.paidCentavos > 0) {
    return err(
      'CONFLICT',
      'This invoice has receipts. Record a credit note or refund instead of reversing the original invoice.',
    );
  }
  if (!invoice.journalId) return err('INVALID_STATE', 'Invoice has no posted journal to reverse.');
  const notes = ctx.state.creditNotes.filter((note) => note.invoiceId === invoice.id);
  if (notes.length > 0) {
    return err('CONFLICT', 'This invoice already has credit notes; post an adjustment instead.');
  }
  const reversal = reverseJournal(draft, ctx, invoice.journalId, input.reversalDate, input.reason, 'invoice_reversal', invoice.id);
  if (!reversal.ok) return reversal;
  updateItem(
    draft,
    'invoices',
    (candidate) => candidate.id === invoice.id,
    (candidate) => ({
      ...candidate,
      status: 'reversed',
      outstandingCentavos: 0,
      revision: candidate.revision + 1,
    }),
  );
  recordAudit(draft, ctx, {
    action: 'invoice.reverse',
    recordType: 'invoice',
    recordId: invoice.id,
    reason: input.reason,
    detail: { reversalJournalId: reversal.value.id },
  });
  return ok({
    summary: `Invoice ${invoice.invoiceNo} reversed; original and linked reversal preserved.`,
    documentType: 'invoice',
    documentId: invoice.id,
    journalIds: [reversal.value.id],
    warnings: [],
  });
}

function allocateInvoice(
  state: AppState,
  workspaceId: string,
  invoiceId: string,
  amount: number,
): Invoice | undefined {
  const invoice = state.invoices.find(
    (candidate) => candidate.id === invoiceId && candidate.workspaceId === workspaceId,
  );
  if (!invoice) return undefined;
  const paid = invoice.paidCentavos + amount;
  const outstanding = invoice.totalCentavos - paid;
  return {
    ...invoice,
    paidCentavos: paid,
    outstandingCentavos: outstanding,
    status: outstanding === 0 ? 'paid' : 'partially_paid',
    revision: invoice.revision + 1,
  };
}

export function createReceipt(
  draft: StateDraft,
  ctx: WriteContext,
  input: Extract<DomainCommand, { type: 'receipt.create' }>['input'],
): Result<CommandResult> {
  const product = requireProduct(ctx, 'accounting');
  if (!product.ok) return product;
  const role = requireRole(ctx, 'accountant', 'ap_ar_clerk', 'company_admin');
  if (!role.ok) return role;
  const customer = contactWithRole(ctx, input.customerContactId, 'customer');
  if (!customer) return err('VALIDATION', 'Select an active customer contact.', 'customerContactId');
  const date = parseDateOnly(input.receiptDate, 'receiptDate');
  if (!date.ok) return date;
  if (!Number.isSafeInteger(input.amountCentavos) || input.amountCentavos <= 0) {
    return err('VALIDATION', 'Receipt amount must be greater than zero.', 'amountCentavos');
  }
  const bank = ctx.state.bankAccounts.find(
    (account) => account.id === input.bankAccountId && account.workspaceId === ctx.workspaceId,
  );
  if (!bank) return err('VALIDATION', 'Select a bank account in this workspace.', 'bankAccountId');
  if (input.method !== 'bank_deposit' && input.method !== 'incoming_clearing') {
    return err('VALIDATION', 'Unknown receipt method.', 'method');
  }

  const ar = requireAccountByRole(ctx.state, ctx.workspaceId, 'ar');
  if (!ar.ok) return ar;
  const unappliedAccount = requireAccountByRole(ctx.state, ctx.workspaceId, 'unapplied_receipts');
  if (!unappliedAccount.ok) return unappliedAccount;

  let allocatedTotal = 0;
  const invoiceUpdates: Invoice[] = [];
  const seen = new Set<string>();
  for (const allocation of input.allocations) {
    if (!Number.isSafeInteger(allocation.amountCentavos) || allocation.amountCentavos <= 0) {
      return err('VALIDATION', 'Each allocation must be greater than zero.', 'allocations');
    }
    if (seen.has(allocation.invoiceId)) {
      return err('VALIDATION', 'The same invoice appears twice in one receipt allocation.', 'allocations');
    }
    seen.add(allocation.invoiceId);
    const invoice = ctx.state.invoices.find(
      (candidate) => candidate.id === allocation.invoiceId && candidate.workspaceId === ctx.workspaceId,
    );
    if (!invoice) return err('VALIDATION', 'An allocated invoice is not in this workspace.', 'allocations');
    if (invoice.status === 'draft' || invoice.status === 'reversed') {
      return err('CONFLICT', `Invoice ${invoice.invoiceNo} is not open for settlement.`);
    }
    if (invoice.customerContactId !== customer.id) {
      return err('VALIDATION', `Invoice ${invoice.invoiceNo} belongs to a different customer.`, 'allocations');
    }
    if (allocation.amountCentavos > invoice.outstandingCentavos) {
      return err(
        'VALIDATION',
        `Allocation to ${invoice.invoiceNo} exceeds its outstanding balance of ${invoice.outstandingCentavos} centavos.`,
        'allocations',
      );
    }
    const updated = allocateInvoice(ctx.state, ctx.workspaceId, invoice.id, allocation.amountCentavos);
    if (updated) invoiceUpdates.push(updated);
    allocatedTotal += allocation.amountCentavos;
  }
  if (allocatedTotal > input.amountCentavos) {
    return err('VALIDATION', 'Allocations cannot exceed the receipt amount.', 'allocations');
  }
  const unapplied = input.amountCentavos - allocatedTotal;

  const id = ctx.clock.newId('rcpt');
  const receiptNo = allocateCode(draft, ctx.workspaceId, 'receipt');
  if (!receiptNo.ok) return receiptNo;
  const depositAccountId = input.method === 'bank_deposit' ? bank.ledgerAccountId : null;
  const clearing = input.method === 'incoming_clearing'
    ? requireAccountByRole(ctx.state, ctx.workspaceId, 'incoming_clearing')
    : null;
  if (clearing && !clearing.ok) return clearing;
  const debitAccountId = input.method === 'bank_deposit' ? depositAccountId : clearing?.value.id;
  if (!debitAccountId) return err('POLICY_INCOMPLETE', 'The receipt deposit account is not configured.');

  const journal = postJournal(draft, ctx, {
    postingDate: input.receiptDate,
    documentDate: input.receiptDate,
    sourceType: 'customer_receipt',
    sourceId: id,
    effectKey: `receipt-post:${id}`,
    memo: `Customer receipt ${receiptNo.value} — ${customer.name}`,
    lines: [
      { accountId: debitAccountId, debitCentavos: input.amountCentavos, creditCentavos: 0 },
      ...(allocatedTotal > 0
        ? [{ accountId: ar.value.id, debitCentavos: 0, creditCentavos: allocatedTotal }]
        : []),
      ...(unapplied > 0
        ? [{ accountId: unappliedAccount.value.id, debitCentavos: 0, creditCentavos: unapplied }]
        : []),
    ],
  });
  if (!journal.ok) return journal;

  const receipt: Receipt = {
    id,
    workspaceId: ctx.workspaceId,
    receiptNo: receiptNo.value,
    customerContactId: customer.id,
    receiptDate: input.receiptDate,
    amountCentavos: input.amountCentavos,
    allocations: input.allocations.map((allocation) => ({ ...allocation })),
    unappliedCentavos: unapplied,
    method: input.method,
    bankAccountId: bank.id,
    reference: input.reference.trim(),
    status: 'posted',
    journalId: journal.value.id,
    returnedOn: null,
    returnReason: null,
    returnJournalId: null,
    createdAt: ctx.clock.nowIso,
    createdBy: ctx.actorId,
  };
  pushItem(draft, 'receipts', receipt);
  for (const updated of invoiceUpdates) {
    updateItem(draft, 'invoices', (candidate) => candidate.id === updated.id, () => updated);
  }
  recordAudit(draft, ctx, {
    action: 'receipt.post',
    recordType: 'customer_receipt',
    recordId: id,
    detail: {
      receiptNo: receiptNo.value,
      amountCentavos: input.amountCentavos,
      allocatedCentavos: allocatedTotal,
      unappliedCentavos: unapplied,
      journalId: journal.value.id,
    },
  });
  return ok({
    summary: `Receipt ${receiptNo.value} posted; ${allocatedTotal} centavos allocated, ${unapplied} unapplied.`,
    documentType: 'customer_receipt',
    documentId: id,
    journalIds: [journal.value.id],
    warnings: unapplied > 0 ? ['Part of this receipt remains unapplied and is a customer credit.'] : [],
  });
}

export function returnReceipt(
  draft: StateDraft,
  ctx: WriteContext,
  input: { receiptId: string; returnDate: string; reason: string },
): Result<CommandResult> {
  const role = requireRole(ctx, 'accountant', 'ap_ar_clerk');
  if (!role.ok) return role;
  const receipt = ctx.state.receipts.find(
    (candidate) => candidate.id === input.receiptId && candidate.workspaceId === ctx.workspaceId,
  );
  if (!receipt) return err('NOT_FOUND', 'Receipt not found in this workspace.');
  if (receipt.status !== 'posted') return err('CONFLICT', 'Only a posted receipt can be returned.');
  if (input.reason.trim().length < 3) return err('VALIDATION', 'A returned-payment reason is required.', 'reason');
  const laterRefund = ctx.state.refunds.some(
    (refund) =>
      refund.workspaceId === ctx.workspaceId &&
      refund.customerContactId === receipt.customerContactId &&
      refund.refundDate >= receipt.receiptDate,
  );
  if (laterRefund) {
    return err('CONFLICT', 'A refund exists for this customer after the receipt; resolve the refund trail first.');
  }
  const reversal = reverseJournal(
    draft,
    ctx,
    receipt.journalId,
    input.returnDate,
    input.reason,
    'receipt_return',
    receipt.id,
  );
  if (!reversal.ok) return reversal;
  for (const allocation of receipt.allocations) {
    const invoice = ctx.state.invoices.find((candidate) => candidate.id === allocation.invoiceId);
    if (!invoice || invoice.status === 'reversed') {
      return err('CONFLICT', 'A settled invoice was reversed; returned-payment correction needs manual review.');
    }
    updateItem(
      draft,
      'invoices',
      (candidate) => candidate.id === invoice.id,
      (candidate) => ({
        ...candidate,
        paidCentavos: Math.max(0, candidate.paidCentavos - allocation.amountCentavos),
        outstandingCentavos: candidate.outstandingCentavos + allocation.amountCentavos,
        status: candidate.paidCentavos - allocation.amountCentavos <= 0 ? 'posted' : 'partially_paid',
        revision: candidate.revision + 1,
      }),
    );
  }
  updateItem(
    draft,
    'receipts',
    (candidate) => candidate.id === receipt.id,
    (candidate) => ({
      ...candidate,
      status: 'returned',
      returnedOn: input.returnDate,
      returnReason: input.reason,
      returnJournalId: reversal.value.id,
    }),
  );
  recordAudit(draft, ctx, {
    action: 'receipt.return',
    recordType: 'customer_receipt',
    recordId: receipt.id,
    reason: input.reason,
    detail: { reversalJournalId: reversal.value.id },
  });
  return ok({
    summary: `Receipt ${receipt.receiptNo} marked returned; settlement links and reversal preserved.`,
    documentType: 'customer_receipt',
    documentId: receipt.id,
    journalIds: [reversal.value.id],
    warnings: [],
  });
}

export function createCreditNote(
  draft: StateDraft,
  ctx: WriteContext,
  input: { invoiceId: string; creditDate: string; netCentavos: number; reason: string },
): Result<CommandResult> {
  const role = requireRole(ctx, 'accountant', 'ap_ar_clerk');
  if (!role.ok) return role;
  const invoice = ctx.state.invoices.find(
    (candidate) => candidate.id === input.invoiceId && candidate.workspaceId === ctx.workspaceId,
  );
  if (!invoice) return err('NOT_FOUND', 'Invoice not found in this workspace.');
  if (invoice.status === 'draft' || invoice.status === 'reversed') {
    return err('CONFLICT', 'A credit note needs a posted invoice.');
  }
  const date = parseDateOnly(input.creditDate, 'creditDate');
  if (!date.ok) return date;
  if (!Number.isSafeInteger(input.netCentavos) || input.netCentavos <= 0) {
    return err('VALIDATION', 'Credit net amount must be greater than zero.', 'netCentavos');
  }
  if (input.reason.trim().length < 3) return err('VALIDATION', 'A credit reason is required.', 'reason');
  const tax = invoice.taxTreatment === 'vat12' ? applyBasisPoints(input.netCentavos, VAT_BP) : 0;
  const total = input.netCentavos + tax;
  if (total > invoice.outstandingCentavos) {
    return err(
      'VALIDATION',
      'Credit note exceeds the invoice outstanding balance; use a refund/other adjustment review for the excess.',
      'netCentavos',
    );
  }
  const ar = requireAccountByRole(ctx.state, ctx.workspaceId, 'ar');
  if (!ar.ok) return ar;
  const revenue = ctx.state.accounts.find((account) => account.id === invoice.revenueAccountId);
  if (!revenue) return err('INVALID_STATE', 'Invoice revenue account no longer exists.');
  const outputVat = invoice.taxAccountId
    ? ctx.state.accounts.find((account) => account.id === invoice.taxAccountId)
    : undefined;
  if (tax > 0 && !outputVat) return err('POLICY_INCOMPLETE', 'Output VAT account is missing.');

  const id = ctx.clock.newId('cnote');
  const creditNo = allocateCode(draft, ctx.workspaceId, 'credit_note');
  if (!creditNo.ok) return creditNo;
  const journal = postJournal(draft, ctx, {
    postingDate: input.creditDate,
    documentDate: input.creditDate,
    sourceType: 'credit_note',
    sourceId: id,
    effectKey: `credit-note-post:${id}`,
    memo: `Credit note ${creditNo.value} against ${invoice.invoiceNo} — ${input.reason}`,
    lines: [
      { accountId: revenue.id, debitCentavos: input.netCentavos, creditCentavos: 0 },
      ...(tax > 0 && outputVat
        ? [{ accountId: outputVat.id, debitCentavos: tax, creditCentavos: 0 }]
        : []),
      { accountId: ar.value.id, debitCentavos: 0, creditCentavos: total },
    ],
  });
  if (!journal.ok) return journal;

  pushItem(draft, 'creditNotes', {
    id,
    workspaceId: ctx.workspaceId,
    creditNo: creditNo.value,
    invoiceId: invoice.id,
    customerContactId: invoice.customerContactId,
    creditDate: input.creditDate,
    amountCentavos: input.netCentavos,
    taxCentavos: tax,
    reason: input.reason,
    status: 'posted',
    journalId: journal.value.id,
    createdAt: ctx.clock.nowIso,
    createdBy: ctx.actorId,
  });
  updateItem(
    draft,
    'invoices',
    (candidate) => candidate.id === invoice.id,
    (candidate) => {
      const outstanding = candidate.outstandingCentavos - total;
      return {
        ...candidate,
        outstandingCentavos: outstanding,
        status: outstanding === 0 && candidate.paidCentavos + total >= candidate.totalCentavos ? 'paid' : candidate.status,
        revision: candidate.revision + 1,
      };
    },
  );
  if (tax > 0) {
    const taxNo = allocateCode(draft, ctx.workspaceId, 'tax_record');
    if (!taxNo.ok) return taxNo;
    pushItem(draft, 'taxRecords', {
      id: ctx.clock.newId('tax'),
      workspaceId: ctx.workspaceId,
      publicNo: taxNo.value,
      type: 'output_vat',
      sourceType: 'credit_note',
      sourceId: id,
      taxDate: input.creditDate,
      partyContactId: invoice.customerContactId,
      baseCentavos: -input.netCentavos,
      taxCentavos: -tax,
      direction: 'output',
      certificateStatus: 'not_required',
      certificateId: null,
      description: `Output VAT credit on ${creditNo.value}`,
    });
  }
  recordAudit(draft, ctx, {
    action: 'creditNote.post',
    recordType: 'credit_note',
    recordId: id,
    reason: input.reason,
    detail: { journalId: journal.value.id, totalCentavos: total },
  });
  return ok({
    summary: `Credit note ${creditNo.value} posted for ${total} centavos.`,
    documentType: 'credit_note',
    documentId: id,
    journalIds: [journal.value.id],
    warnings: [],
  });
}

export function createRefund(
  draft: StateDraft,
  ctx: WriteContext,
  input: Extract<DomainCommand, { type: 'refund.create' }>['input'],
): Result<CommandResult> {
  const role = requireRole(ctx, 'accountant');
  if (!role.ok) return role;
  const customer = contactWithRole(ctx, input.customerContactId, 'customer');
  if (!customer) return err('VALIDATION', 'Select an active customer contact.', 'customerContactId');
  const date = parseDateOnly(input.refundDate, 'refundDate');
  if (!date.ok) return date;
  if (!Number.isSafeInteger(input.amountCentavos) || input.amountCentavos <= 0) {
    return err('VALIDATION', 'Refund amount must be greater than zero.', 'amountCentavos');
  }
  if (input.reason.trim().length < 3) return err('VALIDATION', 'A refund reason is required.', 'reason');
  const bank = ctx.state.bankAccounts.find(
    (account) => account.id === input.bankAccountId && account.workspaceId === ctx.workspaceId,
  );
  if (!bank) return err('VALIDATION', 'Select a bank account in this workspace.', 'bankAccountId');

  const unappliedBalance = ctx.state.receipts
    .filter(
      (receipt) =>
        receipt.workspaceId === ctx.workspaceId &&
        receipt.customerContactId === customer.id &&
        receipt.status === 'posted',
    )
    .reduce((total, receipt) => total + receipt.unappliedCentavos, 0) -
    ctx.state.refunds
      .filter(
        (refund) => refund.workspaceId === ctx.workspaceId && refund.customerContactId === customer.id,
      )
      .reduce((total, refund) => total + refund.amountCentavos, 0);
  if (input.amountCentavos > unappliedBalance) {
    return err(
      'VALIDATION',
      `Refund exceeds the customer’s unapplied balance of ${unappliedBalance} centavos.`,
      'amountCentavos',
    );
  }
  const unappliedAccount = requireAccountByRole(ctx.state, ctx.workspaceId, 'unapplied_receipts');
  if (!unappliedAccount.ok) return unappliedAccount;
  const id = ctx.clock.newId('refund');
  const refundNo = allocateCode(draft, ctx.workspaceId, 'refund');
  if (!refundNo.ok) return refundNo;
  const journal = postJournal(draft, ctx, {
    postingDate: input.refundDate,
    documentDate: input.refundDate,
    sourceType: 'customer_refund',
    sourceId: id,
    effectKey: `refund-post:${id}`,
    memo: `Customer refund ${refundNo.value} — ${customer.name}`,
    lines: [
      { accountId: unappliedAccount.value.id, debitCentavos: input.amountCentavos, creditCentavos: 0 },
      { accountId: bank.ledgerAccountId, debitCentavos: 0, creditCentavos: input.amountCentavos },
    ],
  });
  if (!journal.ok) return journal;
  pushItem(draft, 'refunds', {
    id,
    workspaceId: ctx.workspaceId,
    refundNo: refundNo.value,
    customerContactId: customer.id,
    refundDate: input.refundDate,
    amountCentavos: input.amountCentavos,
    bankAccountId: bank.id,
    reason: input.reason,
    journalId: journal.value.id,
    createdAt: ctx.clock.nowIso,
    createdBy: ctx.actorId,
  });
  recordAudit(draft, ctx, {
    action: 'refund.post',
    recordType: 'customer_refund',
    recordId: id,
    reason: input.reason,
    detail: { journalId: journal.value.id, amountCentavos: input.amountCentavos },
  });
  return ok({
    summary: `Refund ${refundNo.value} posted from unapplied customer receipts.`,
    documentType: 'customer_refund',
    documentId: id,
    journalIds: [journal.value.id],
    warnings: [],
  });
}

/** Helper used by tests and reports: sum credited amounts per invoice. */
export function invoiceCreditTotal(state: AppState, invoiceId: string): number {
  return state.creditNotes
    .filter((note) => note.invoiceId === invoiceId && note.status === 'posted')
    .reduce((total, note) => total + note.amountCentavos + note.taxCentavos, 0);
}

export function ensureActorAccess(state: AppState, actorId: string, workspaceId: string, today: string) {
  return resolveAccess(state, actorId, workspaceId, today);
}

export function applyInvoiceAllocation(
  draft: StateDraft,
  workspaceId: string,
  invoiceId: string,
  amount: number,
): void {
  updateItem(
    draft,
    'invoices',
    (candidate) => candidate.id === invoiceId && candidate.workspaceId === workspaceId,
    (candidate) => allocateInvoice(draft.state, workspaceId, invoiceId, amount) ?? candidate,
  );
}

export function markEffect(draft: StateDraft, workspaceId: string, key: string, documentId: string, at: string): void {
  setRecordValue(draft, 'sourceEffects', `${workspaceId}:${key}`, {
    kind: 'helper',
    documentId,
    at,
  });
}
