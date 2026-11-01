import type { CommandResult, DomainCommand } from './commandTypes';
import { postJournal, recordAudit, type WriteContext } from './ledger';
import type { Bill, BillLine, GoodsReceipt, PurchaseOrder, Rfp } from './schema';
import { requireAccountByRole, requireProduct, requireRole } from './shared/access';
import { parseDateOnly } from './shared/dates';
import { pushItem, updateItem, type StateDraft } from './shared/draft';
import { applyBasisPoints, mulDivRound, sumCentavos } from './shared/money';
import { err, ok, type Result } from './shared/result';
import { allocateCode } from './numbering';
import { contactWithRole } from './billing';
import { recordReceiptMovement } from './inventory';

const INPUT_VAT_BP = 1200;


export function createPurchaseOrder(
  draft: StateDraft,
  ctx: WriteContext,
  input: Extract<DomainCommand, { type: 'po.create' }>['input'],
): Result<CommandResult> {
  const product = requireProduct(ctx, 'accounting');
  if (!product.ok) return product;
  const role = requireRole(ctx, 'accountant', 'ap_ar_clerk', 'company_admin');
  if (!role.ok) return role;
  const vendor = contactWithRole(ctx, input.vendorContactId, 'vendor');
  if (!vendor) return err('VALIDATION', 'Select an active vendor contact.', 'vendorContactId');
  const date = parseDateOnly(input.poDate, 'poDate');
  if (!date.ok) return date;
  if (input.lines.length === 0) return err('VALIDATION', 'At least one purchase order line is required.', 'lines');
  const lines = [];
  for (const [index, raw] of input.lines.entries()) {
    if (raw.description.trim().length === 0) return err('VALIDATION', `Line ${index + 1} needs a description.`, 'lines');
    if (!Number.isSafeInteger(raw.quantityMilli) || raw.quantityMilli <= 0) {
      return err('VALIDATION', `Line ${index + 1} quantity must be positive.`, 'lines');
    }
    if (!Number.isSafeInteger(raw.unitCostCentavos) || raw.unitCostCentavos < 0) {
      return err('VALIDATION', `Line ${index + 1} unit cost must be zero or more.`, 'lines');
    }
    const account = ctx.state.accounts.find(
      (candidate) => candidate.id === raw.accountId && candidate.workspaceId === ctx.workspaceId && candidate.active,
    );
    if (!account) return err('VALIDATION', `Line ${index + 1} account is not in this workspace.`, 'lines');
    if (raw.itemId) {
      const item = ctx.state.items.find(
        (candidate) => candidate.id === raw.itemId && candidate.workspaceId === ctx.workspaceId && candidate.active,
      );
      if (!item) return err('VALIDATION', `Line ${index + 1} item is not active in this workspace.`, 'lines');
    }
    lines.push({
      id: ctx.clock.newId('poline'),
      itemId: raw.itemId ?? null,
      description: raw.description.trim(),
      quantityMilli: raw.quantityMilli,
      unitCostCentavos: raw.unitCostCentavos,
      accountId: account.id,
      receivedMilli: 0,
      billedMilli: 0,
    });
  }
  const poNo = allocateCode(draft, ctx.workspaceId, 'purchase_order');
  if (!poNo.ok) return poNo;
  const po: PurchaseOrder = {
    id: ctx.clock.newId('po'),
    workspaceId: ctx.workspaceId,
    poNo: poNo.value,
    vendorContactId: vendor.id,
    poDate: input.poDate,
    status: 'open',
    lines,
    createdBy: ctx.actorId,
    createdAt: ctx.clock.nowIso,
  };
  pushItem(draft, 'purchaseOrders', po);
  recordAudit(draft, ctx, {
    action: 'po.create',
    recordType: 'purchase_order',
    recordId: po.id,
    detail: { poNo: po.poNo, vendor: vendor.name },
  });
  return ok({
    summary: `Purchase order ${po.poNo} created for ${vendor.name}.`,
    documentType: 'purchase_order',
    documentId: po.id,
    journalIds: [],
    warnings: [],
  });
}

export function createGoodsReceipt(
  draft: StateDraft,
  ctx: WriteContext,
  input: Extract<DomainCommand, { type: 'goodsReceipt.create' }>['input'],
): Result<CommandResult> {
  const product = requireProduct(ctx, 'inventory');
  if (!product.ok) return product;
  const role = requireRole(ctx, 'inventory_officer', 'accountant', 'ap_ar_clerk', 'company_admin');
  if (!role.ok) return role;
  const po = ctx.state.purchaseOrders.find(
    (candidate) => candidate.id === input.poId && candidate.workspaceId === ctx.workspaceId,
  );
  if (!po) return err('NOT_FOUND', 'Purchase order not found in this workspace.');
  if (po.status === 'closed') return err('CONFLICT', 'This purchase order is fully received and closed.');
  const date = parseDateOnly(input.receiptDate, 'receiptDate');
  if (!date.ok) return date;
  const location = ctx.state.locations.find(
    (candidate) => candidate.id === input.locationId && candidate.workspaceId === ctx.workspaceId && candidate.active,
  );
  if (!location) return err('VALIDATION', 'Select an active receiving location.', 'locationId');
  if (input.lines.length === 0) return err('VALIDATION', 'Add at least one received line.', 'lines');

  const id = ctx.clock.newId('gr');
  const receiptNoResult = allocateCode(draft, ctx.workspaceId, 'goods_receipt');
  if (!receiptNoResult.ok) return receiptNoResult;
  const receiptNo = receiptNoResult.value;
  const prepared: GoodsReceipt['lines'] = [];
  const movements: Array<{ poLineId: string; quantityMilli: number }> = [];

  for (const [index, raw] of input.lines.entries()) {
    const poLine = po.lines.find((line) => line.id === raw.poLineId);
    if (!poLine) return err('VALIDATION', `Line ${index + 1} does not belong to ${po.poNo}.`, 'lines');
    if (!poLine.itemId) {
      return err('VALIDATION', `Line ${index + 1} is a service line; goods receipt requires a stock item.`, 'lines');
    }
    if (!Number.isSafeInteger(raw.quantityMilli) || raw.quantityMilli <= 0) {
      return err('VALIDATION', `Line ${index + 1} quantity must be positive.`, 'lines');
    }
    const remaining = poLine.quantityMilli - poLine.receivedMilli;
    if (raw.quantityMilli > remaining) {
      return err(
        'VALIDATION',
        `Line ${index + 1} exceeds the ${remaining} milli-units still open on ${po.poNo}.`,
        'lines',
      );
    }
    const movement = recordReceiptMovement(draft, ctx, {
      itemId: poLine.itemId,
      locationId: location.id,
      occurredOn: input.receiptDate,
      quantityMilli: raw.quantityMilli,
      unitCostCentavos: poLine.unitCostCentavos,
      sourceType: 'goods_receipt',
      sourceId: id,
      effectKey: `goods-receipt:${id}:${poLine.id}`,
    });
    if (!movement.ok) return movement;
    prepared.push({
      poLineId: poLine.id,
      itemId: poLine.itemId,
      quantityMilli: raw.quantityMilli,
      unitCostCentavos: poLine.unitCostCentavos,
      movementId: movement.value.id,
    });
    movements.push({ poLineId: poLine.id, quantityMilli: raw.quantityMilli });
  }

  const receipt: GoodsReceipt = {
    id,
    workspaceId: ctx.workspaceId,
    receiptNo,
    poId: po.id,
    vendorContactId: po.vendorContactId,
    receiptDate: input.receiptDate,
    lines: prepared,
    createdBy: ctx.actorId,
    createdAt: ctx.clock.nowIso,
  };
  pushItem(draft, 'goodsReceipts', receipt);
  for (const movement of movements) {
    updateItem(
      draft,
      'purchaseOrders',
      (candidate) => candidate.id === po.id,
      (candidate) => {
        const lines = candidate.lines.map((line) =>
          line.id === movement.poLineId
            ? { ...line, receivedMilli: line.receivedMilli + movement.quantityMilli }
            : line,
        );
        const closed = lines.every((line) => line.receivedMilli >= line.quantityMilli);
        return { ...candidate, lines, status: closed ? 'closed' : 'partially_received' };
      },
    );
  }
  recordAudit(draft, ctx, {
    action: 'goodsReceipt.create',
    recordType: 'goods_receipt',
    recordId: receipt.id,
    detail: { receiptNo, poNo: po.poNo, lineCount: prepared.length },
  });
  return ok({
    summary: `Goods receipt ${receiptNo} recorded against ${po.poNo}.`,
    documentType: 'goods_receipt',
    documentId: receipt.id,
    journalIds: [],
    warnings: [],
  });
}

function sumAlreadyBilled(state: WriteContext['state'], grId: string, itemId: string, ignoreBillId?: string): number {
  let total = 0;
  for (const bill of state.bills) {
    if (bill.id === ignoreBillId) continue;
    for (const line of bill.lines) {
      if (line.stockReceiptId === grId && line.itemId === itemId) {
        total += line.quantityMilli ?? 0;
      }
    }
  }
  return total;
}

export function createBill(
  draft: StateDraft,
  ctx: WriteContext,
  input: Extract<DomainCommand, { type: 'bill.create' }>['input'],
): Result<CommandResult> {
  const product = requireProduct(ctx, 'accounting');
  if (!product.ok) return product;
  const role = requireRole(ctx, 'accountant', 'ap_ar_clerk', 'company_admin');
  if (!role.ok) return role;
  const vendor = contactWithRole(ctx, input.vendorContactId, 'vendor');
  if (!vendor) return err('VALIDATION', 'Select an active vendor contact.', 'vendorContactId');
  if (input.supplierInvoiceNo.trim().length === 0) {
    return err('VALIDATION', 'Supplier invoice number is required.', 'supplierInvoiceNo');
  }
  const billDate = parseDateOnly(input.billDate, 'billDate');
  if (!billDate.ok) return billDate;
  const dueDate = parseDateOnly(input.dueDate, 'dueDate');
  if (!dueDate.ok) return dueDate;
  if (input.dueDate < input.billDate) return err('VALIDATION', 'Due date cannot precede bill date.', 'dueDate');
  if (input.lines.length === 0) return err('VALIDATION', 'At least one bill line is required.', 'lines');

  const ap = requireAccountByRole(ctx.state, ctx.workspaceId, 'ap');
  if (!ap.ok) return ap;
  const inputVat = requireAccountByRole(ctx.state, ctx.workspaceId, 'input_vat');
  if (!inputVat.ok) return inputVat;
  const grni = requireAccountByRole(ctx.state, ctx.workspaceId, 'grni');
  if (!grni.ok) return grni;

  const duplicate = ctx.state.bills.find(
    (bill) =>
      bill.workspaceId === ctx.workspaceId &&
      bill.vendorContactId === vendor.id &&
      bill.supplierInvoiceNo.trim().toLowerCase() === input.supplierInvoiceNo.trim().toLowerCase() &&
      bill.status !== 'reversed',
  );

  const id = ctx.clock.newId('bill');
  const lines: BillLine[] = [];
  for (const [index, raw] of input.lines.entries()) {
    if (raw.description.trim().length === 0) {
      return err('VALIDATION', `Line ${index + 1} needs a description.`, 'lines');
    }
    if (!Number.isSafeInteger(raw.amountCentavos) || raw.amountCentavos <= 0) {
      return err('VALIDATION', `Line ${index + 1} amount must be greater than zero.`, 'lines');
    }
    const account = ctx.state.accounts.find(
      (candidate) => candidate.id === raw.accountId && candidate.workspaceId === ctx.workspaceId && candidate.active,
    );
    if (!account) return err('VALIDATION', `Line ${index + 1} account is not active in this workspace.`, 'lines');
    if (raw.taxTreatment !== 'none' && raw.taxTreatment !== 'input_vat12') {
      return err('VALIDATION', `Line ${index + 1} tax treatment is unknown.`, 'lines');
    }
    const ewtRateBp = raw.ewtRateBp ?? 0;
    if (!Number.isSafeInteger(ewtRateBp) || ewtRateBp < 0 || ewtRateBp > 10000) {
      return err('VALIDATION', `Line ${index + 1} withholding rate must be 0–10000 basis points.`, 'lines');
    }
    let quantityMilli: number | null = raw.quantityMilli ?? null;
    if (raw.stockReceiptId) {
      const receipt = ctx.state.goodsReceipts.find(
        (candidate) => candidate.id === raw.stockReceiptId && candidate.workspaceId === ctx.workspaceId,
      );
      if (!receipt) return err('VALIDATION', `Line ${index + 1} goods receipt is not in this workspace.`, 'lines');
      const receiptLine = raw.itemId ? receipt.lines.find((line) => line.itemId === raw.itemId) : undefined;
      if (!receiptLine) {
        return err('VALIDATION', `Line ${index + 1} does not match a received item on that goods receipt.`, 'lines');
      }
      const quantity = quantityMilli ?? receiptLine.quantityMilli;
      quantityMilli = quantity;
      if (quantity <= 0) return err('VALIDATION', `Line ${index + 1} quantity must be positive.`, 'lines');
      const alreadyBilled = sumAlreadyBilled(ctx.state, receipt.id, receiptLine.itemId);
      if (quantity + alreadyBilled > receiptLine.quantityMilli) {
        return err(
          'VALIDATION',
          `Line ${index + 1} bills more than the ${receiptLine.quantityMilli - alreadyBilled} milli-units still unbilled on that receipt.`,
          'lines',
        );
      }
      const expected = receiptLine.movementId
        ? mulDivRound(receiptLine.unitCostCentavos, quantity, 1000)
        : 0;
      if (raw.amountCentavos !== expected) {
        return err(
          'AMOUNT_MISMATCH',
          `Line ${index + 1} amount must equal the received value of ${expected} centavos.`,
          'lines',
        );
      }
    }
    lines.push({
      id: ctx.clock.newId('billline'),
      description: raw.description.trim(),
      accountId: account.id,
      amountCentavos: raw.amountCentavos,
      taxTreatment: raw.taxTreatment,
      taxCentavos: raw.taxTreatment === 'input_vat12' ? applyBasisPoints(raw.amountCentavos, INPUT_VAT_BP) : 0,
      stockReceiptId: raw.stockReceiptId ?? null,
      itemId: raw.itemId ?? null,
      quantityMilli,
      ewtRateBp,
    });
  }

  const subtotal = sumCentavos(lines.map((line) => line.amountCentavos));
  const tax = sumCentavos(lines.map((line) => line.taxCentavos));
  const ewt = sumCentavos(lines.map((line) => applyBasisPoints(line.amountCentavos, line.ewtRateBp)));
  const total = subtotal + tax;
  const billNo = allocateCode(draft, ctx.workspaceId, 'bill');
  if (!billNo.ok) return billNo;
  const bill: Bill = {
    id,
    workspaceId: ctx.workspaceId,
    billNo: billNo.value,
    supplierInvoiceNo: input.supplierInvoiceNo.trim(),
    vendorContactId: vendor.id,
    vendorSnapshot: { name: vendor.name, tin: vendor.tin, address: vendor.address },
    billDate: input.billDate,
    dueDate: input.dueDate,
    lines,
    subtotalCentavos: subtotal,
    taxCentavos: tax,
    totalCentavos: total,
    ewtCentavos: ewt,
    paidCentavos: 0,
    outstandingCentavos: duplicate ? 0 : total,
    status: duplicate ? 'held' : 'posted',
    journalId: null,
    createdBy: ctx.actorId,
    createdAt: ctx.clock.nowIso,
    duplicateFlag: Boolean(duplicate),
    revision: 1,
  };

  if (duplicate) {
    pushItem(draft, 'bills', bill);
    recordAudit(draft, ctx, {
      action: 'bill.heldDuplicate',
      recordType: 'bill',
      recordId: id,
      detail: { duplicateOf: duplicate.id, supplierInvoiceNo: bill.supplierInvoiceNo },
    });
    return ok({
      summary: `Duplicate supplier invoice ${bill.supplierInvoiceNo} held as ${bill.billNo}; no expense or payable was posted.`,
      documentType: 'bill',
      documentId: id,
      journalIds: [],
      warnings: ['A bill with this supplier invoice number already exists. Resolve the duplicate before posting.'],
    });
  }

  const stockValue = sumCentavos(
    lines.filter((line) => line.stockReceiptId !== null).map((line) => line.amountCentavos),
  );
  const journal = postJournal(draft, ctx, {
    postingDate: input.billDate,
    documentDate: input.billDate,
    sourceType: 'bill',
    sourceId: id,
    effectKey: `bill-post:${id}`,
    memo: `Supplier bill ${bill.billNo} — ${vendor.name} (${bill.supplierInvoiceNo})`,
    lines: [
      ...lines
        .filter((line) => line.stockReceiptId === null)
        .map((line) => ({
          accountId: line.accountId,
          debitCentavos: line.amountCentavos,
          creditCentavos: 0,
          memo: line.description,
        })),
      ...(stockValue > 0
        ? [{ accountId: grni.value.id, debitCentavos: stockValue, creditCentavos: 0, memo: 'Stock received' }]
        : []),
      ...(tax > 0
        ? [{ accountId: inputVat.value.id, debitCentavos: tax, creditCentavos: 0 }]
        : []),
      { accountId: ap.value.id, debitCentavos: 0, creditCentavos: total },
    ],
  });
  if (!journal.ok) return journal;
  bill.journalId = journal.value.id;
  pushItem(draft, 'bills', bill);

  for (const line of lines) {
    if (!line.stockReceiptId || !line.itemId) continue;
    const receipt = ctx.state.goodsReceipts.find((candidate) => candidate.id === line.stockReceiptId);
    if (!receipt) continue;
    const receiptLine = receipt.lines.find((candidate) => candidate.itemId === line.itemId);
    if (!receiptLine) continue;
    updateItem(
      draft,
      'purchaseOrders',
      (po) => po.id === receipt.poId,
      (po) => ({
        ...po,
        lines: po.lines.map((poLine) =>
          poLine.id === receiptLine.poLineId
            ? { ...poLine, billedMilli: poLine.billedMilli + (line.quantityMilli ?? 0) }
            : poLine,
        ),
      }),
    );
  }
  if (tax > 0) {
    const taxNo = allocateCode(draft, ctx.workspaceId, 'tax_record');
    if (!taxNo.ok) return taxNo;
    pushItem(draft, 'taxRecords', {
      id: ctx.clock.newId('tax'),
      workspaceId: ctx.workspaceId,
      publicNo: taxNo.value,
      type: 'input_vat',
      sourceType: 'bill',
      sourceId: id,
      taxDate: input.billDate,
      partyContactId: vendor.id,
      baseCentavos: subtotal,
      taxCentavos: tax,
      direction: 'input',
      certificateStatus: 'pending',
      certificateId: null,
      description: `Input VAT on ${bill.billNo} (illustrative 12%)`,
    });
  }
  recordAudit(draft, ctx, {
    action: 'bill.post',
    recordType: 'bill',
    recordId: id,
    detail: { billNo: bill.billNo, totalCentavos: total, ewtCentavos: ewt, journalId: journal.value.id },
  });
  return ok({
    summary: `Bill ${bill.billNo} posted; ${total} centavos payable.`,
    documentType: 'bill',
    documentId: id,
    journalIds: [journal.value.id],
    warnings: ewt > 0 ? [`Expected creditable withholding at settlement: ${ewt} centavos.`] : [],
  });
}

export function createRfp(
  draft: StateDraft,
  ctx: WriteContext,
  input: { billId: string; amountCentavos: number },
): Result<CommandResult> {
  const product = requireProduct(ctx, 'accounting');
  if (!product.ok) return product;
  const role = requireRole(ctx, 'accountant', 'ap_ar_clerk', 'company_admin');
  if (!role.ok) return role;
  const bill = ctx.state.bills.find(
    (candidate) => candidate.id === input.billId && candidate.workspaceId === ctx.workspaceId,
  );
  if (!bill) return err('NOT_FOUND', 'Bill not found in this workspace.');
  if (bill.status !== 'posted' && bill.status !== 'partially_paid') {
    return err('CONFLICT', 'Only an open posted bill can be requested for payment.');
  }
  if (!Number.isSafeInteger(input.amountCentavos) || input.amountCentavos <= 0) {
    return err('VALIDATION', 'Requested amount must be greater than zero.', 'amountCentavos');
  }
  const alreadyRequested = ctx.state.rfps
    .filter(
      (rfp) =>
        rfp.workspaceId === ctx.workspaceId &&
        rfp.billId === bill.id &&
        (rfp.status === 'pending' || rfp.status === 'approved'),
    )
    .reduce((total, rfp) => total + rfp.amountCentavos, 0);
  if (input.amountCentavos + alreadyRequested > bill.outstandingCentavos) {
    return err(
      'VALIDATION',
      `Request exceeds the bill’s open payable after existing requests (${bill.outstandingCentavos - alreadyRequested} centavos).`,
      'amountCentavos',
    );
  }
  const rfpNo = allocateCode(draft, ctx.workspaceId, 'payment_request');
  if (!rfpNo.ok) return rfpNo;
  const rfp: Rfp = {
    id: ctx.clock.newId('rfp'),
    workspaceId: ctx.workspaceId,
    rfpNo: rfpNo.value,
    billId: bill.id,
    amountCentavos: input.amountCentavos,
    status: 'pending',
    requestedBy: ctx.actorId,
    requestedAt: ctx.clock.nowIso,
    approvedBy: null,
    approvedAt: null,
    rejectionReason: null,
    paymentId: null,
  };
  pushItem(draft, 'rfps', rfp);
  recordAudit(draft, ctx, {
    action: 'rfp.create',
    recordType: 'rfp',
    recordId: rfp.id,
    detail: { billNo: bill.billNo, amountCentavos: input.amountCentavos },
  });
  return ok({
    summary: `Payment request ${rfp.rfpNo} submitted for ${input.amountCentavos} centavos; a different user must approve it.`,
    documentType: 'rfp',
    documentId: rfp.id,
    journalIds: [],
    warnings: [],
  });
}

export function approveRfp(
  draft: StateDraft,
  ctx: WriteContext,
  input: { rfpId: string },
): Result<CommandResult> {
  const role = requireRole(ctx, 'accountant', 'company_admin');
  if (!role.ok) return role;
  const rfp = ctx.state.rfps.find(
    (candidate) => candidate.id === input.rfpId && candidate.workspaceId === ctx.workspaceId,
  );
  if (!rfp) return err('NOT_FOUND', 'Payment request not found in this workspace.');
  if (rfp.status !== 'pending') return err('CONFLICT', `Payment request is already ${rfp.status}.`);
  if (rfp.requestedBy === ctx.actorId) {
    return err('FORBIDDEN', 'Maker and checker must be different users; you cannot approve your own request.');
  }
  const updated = updateItem(
    draft,
    'rfps',
    (candidate) => candidate.id === rfp.id,
    (candidate) => ({
      ...candidate,
      status: 'approved',
      approvedBy: ctx.actorId,
      approvedAt: ctx.clock.nowIso,
    }),
  );
  if (!updated) return err('NOT_FOUND', 'Payment request not found.');
  recordAudit(draft, ctx, {
    action: 'rfp.approve',
    recordType: 'rfp',
    recordId: rfp.id,
    detail: { approvedBy: ctx.actorId },
  });
  return ok({
    summary: `Payment request ${rfp.rfpNo} approved.`,
    documentType: 'rfp',
    documentId: rfp.id,
    journalIds: [],
    warnings: [],
  });
}

export function rejectRfp(
  draft: StateDraft,
  ctx: WriteContext,
  input: { rfpId: string; reason: string },
): Result<CommandResult> {
  const role = requireRole(ctx, 'accountant', 'company_admin');
  if (!role.ok) return role;
  const rfp = ctx.state.rfps.find(
    (candidate) => candidate.id === input.rfpId && candidate.workspaceId === ctx.workspaceId,
  );
  if (!rfp) return err('NOT_FOUND', 'Payment request not found in this workspace.');
  if (rfp.status !== 'pending') return err('CONFLICT', `Payment request is already ${rfp.status}.`);
  if (rfp.requestedBy === ctx.actorId) {
    return err('FORBIDDEN', 'Maker and checker must be different users; you cannot decide your own request.');
  }
  if (input.reason.trim().length < 3) return err('VALIDATION', 'A rejection reason is required.', 'reason');
  updateItem(
    draft,
    'rfps',
    (candidate) => candidate.id === rfp.id,
    (candidate) => ({ ...candidate, status: 'rejected', rejectionReason: input.reason }),
  );
  recordAudit(draft, ctx, {
    action: 'rfp.reject',
    recordType: 'rfp',
    recordId: rfp.id,
    reason: input.reason,
  });
  return ok({
    summary: `Payment request ${rfp.rfpNo} rejected.`,
    documentType: 'rfp',
    documentId: rfp.id,
    journalIds: [],
    warnings: [],
  });
}

export function createPayment(
  draft: StateDraft,
  ctx: WriteContext,
  input: Extract<DomainCommand, { type: 'payment.create' }>['input'],
): Result<CommandResult> {
  const product = requireProduct(ctx, 'accounting');
  if (!product.ok) return product;
  const role = requireRole(ctx, 'accountant', 'company_admin');
  if (!role.ok) return role;
  const rfp = ctx.state.rfps.find(
    (candidate) => candidate.id === input.rfpId && candidate.workspaceId === ctx.workspaceId,
  );
  if (!rfp) return err('NOT_FOUND', 'Payment request not found in this workspace.');
  if (rfp.status !== 'approved') return err('CONFLICT', 'The payment request must be approved by a different user first.');
  // Approval already proves a different user reviewed the request; the maker may
  // release the payment afterwards. Only a missing approval blocks execution.
  const bill = ctx.state.bills.find(
    (candidate) => candidate.id === rfp.billId && candidate.workspaceId === ctx.workspaceId,
  );
  if (!bill) return err('NOT_FOUND', 'The bill behind this request no longer exists.');
  if (bill.status !== 'posted' && bill.status !== 'partially_paid') {
    return err('CONFLICT', 'This bill is not open for payment.');
  }
  if (rfp.amountCentavos > bill.outstandingCentavos) {
    return err('CONFLICT', 'The approved request now exceeds the bill’s outstanding balance.');
  }
  const date = parseDateOnly(input.paymentDate, 'paymentDate');
  if (!date.ok) return date;
  const ap = requireAccountByRole(ctx.state, ctx.workspaceId, 'ap');
  if (!ap.ok) return ap;
  const ewtPayable = requireAccountByRole(ctx.state, ctx.workspaceId, 'ewt_payable');
  if (!ewtPayable.ok) return ewtPayable;

  const alreadyWithheld = ctx.state.payments
    .filter((payment) => payment.billId === bill.id && payment.status !== 'reversed')
    .reduce((total, payment) => total + payment.ewtCentavos, 0);
  const ewtRemaining = Math.max(0, bill.ewtCentavos - alreadyWithheld);
  const ewtCentavos = rfp.amountCentavos === bill.outstandingCentavos
    ? ewtRemaining
    : mulDivRound(ewtRemaining, rfp.amountCentavos, bill.outstandingCentavos);
  const cashOut = rfp.amountCentavos - ewtCentavos;
  if (cashOut <= 0) return err('VALIDATION', 'Withholding consumes the whole payment; review the withholding profile.');

  let debitAccountId: string;
  let bankAccountId: string | null = null;
  let clearingAccountId: string | null = null;
  if (input.method === 'bank_direct') {
    if (!input.bankAccountId) return err('VALIDATION', 'Select the bank account for a direct payment.', 'bankAccountId');
    const bank = ctx.state.bankAccounts.find(
      (candidate) => candidate.id === input.bankAccountId && candidate.workspaceId === ctx.workspaceId,
    );
    if (!bank) return err('VALIDATION', 'Bank account is not in this workspace.', 'bankAccountId');
    bankAccountId = bank.id;
    debitAccountId = bank.ledgerAccountId;
  } else if (input.method === 'outgoing_clearing') {
    const clearing = requireAccountByRole(ctx.state, ctx.workspaceId, 'outgoing_clearing');
    if (!clearing.ok) return clearing;
    if (input.bankAccountId) {
      const bank = ctx.state.bankAccounts.find(
        (candidate) => candidate.id === input.bankAccountId && candidate.workspaceId === ctx.workspaceId,
      );
      if (!bank) return err('VALIDATION', 'Bank account is not in this workspace.', 'bankAccountId');
      bankAccountId = bank.id;
    }
    clearingAccountId = clearing.value.id;
    debitAccountId = clearing.value.id;
  } else {
    return err('VALIDATION', 'Unknown payment method.', 'method');
  }

  const id = ctx.clock.newId('pay');
  const paymentNoResult = allocateCode(draft, ctx.workspaceId, 'payment');
  if (!paymentNoResult.ok) return paymentNoResult;
  const paymentNo = paymentNoResult.value;
  const journal = postJournal(draft, ctx, {
    postingDate: input.paymentDate,
    documentDate: input.paymentDate,
    sourceType: 'payment',
    sourceId: id,
    effectKey: `payment-post:${id}`,
    memo: `Payment ${paymentNo} to ${bill.vendorSnapshot.name} — ${bill.billNo}`,
    lines: [
      { accountId: ap.value.id, debitCentavos: rfp.amountCentavos, creditCentavos: 0 },
      { accountId: debitAccountId, debitCentavos: 0, creditCentavos: cashOut },
      ...(ewtCentavos > 0
        ? [{ accountId: ewtPayable.value.id, debitCentavos: 0, creditCentavos: ewtCentavos }]
        : []),
    ],
    approvedBy: rfp.approvedBy,
  });
  if (!journal.ok) return journal;

  pushItem(draft, 'payments', {
    id,
    workspaceId: ctx.workspaceId,
    paymentNo,
    rfpId: rfp.id,
    billId: bill.id,
    vendorContactId: bill.vendorContactId,
    paymentDate: input.paymentDate,
    amountCentavos: rfp.amountCentavos,
    ewtCentavos,
    method: input.method,
    clearingAccountId,
    bankAccountId,
    status: 'posted',
    journalId: journal.value.id,
    clearedJournalId: null,
    bankRowId: null,
    createdBy: ctx.actorId,
    approvedBy: rfp.approvedBy ?? ctx.actorId,
    createdAt: ctx.clock.nowIso,
  });
  updateItem(
    draft,
    'bills',
    (candidate) => candidate.id === bill.id,
    (candidate) => {
      const paid = candidate.paidCentavos + rfp.amountCentavos;
      const outstanding = candidate.totalCentavos - paid;
      return {
        ...candidate,
        paidCentavos: paid,
        outstandingCentavos: outstanding,
        status: outstanding === 0 ? 'paid' : 'partially_paid',
        revision: candidate.revision + 1,
      };
    },
  );
  updateItem(
    draft,
    'rfps',
    (candidate) => candidate.id === rfp.id,
    (candidate) => ({ ...candidate, status: 'paid', paymentId: id }),
  );
  if (ewtCentavos > 0) {
    const taxNo = allocateCode(draft, ctx.workspaceId, 'tax_record');
    if (!taxNo.ok) return taxNo;
    pushItem(draft, 'taxRecords', {
      id: ctx.clock.newId('tax'),
      workspaceId: ctx.workspaceId,
      publicNo: taxNo.value,
      type: 'ewt_creditable',
      sourceType: 'payment',
      sourceId: id,
      taxDate: input.paymentDate,
      partyContactId: bill.vendorContactId,
      baseCentavos: rfp.amountCentavos - bill.taxCentavos,
      taxCentavos: ewtCentavos,
      direction: 'creditable',
      certificateStatus: 'pending',
      certificateId: null,
      description: `Creditable withholding on payment ${paymentNo}`,
    });
  }
  recordAudit(draft, ctx, {
    action: 'payment.post',
    recordType: 'payment',
    recordId: id,
    detail: { paymentNo, billNo: bill.billNo, cashOut, ewtCentavos, method: input.method },
  });
  return ok({
    summary: `Payment ${paymentNo} posted: ${cashOut} centavos cash, ${ewtCentavos} withheld.`,
    documentType: 'payment',
    documentId: id,
    journalIds: [journal.value.id],
    warnings: [],
  });
}

export function createAdvance(
  draft: StateDraft,
  ctx: WriteContext,
  input: Extract<DomainCommand, { type: 'advance.create' }>['input'],
): Result<CommandResult> {
  const product = requireProduct(ctx, 'accounting');
  if (!product.ok) return product;
  const role = requireRole(ctx, 'accountant', 'ap_ar_clerk', 'company_admin');
  if (!role.ok) return role;
  const employee = ctx.state.employees.find(
    (candidate) => candidate.id === input.employeeId && candidate.workspaceId === ctx.workspaceId && candidate.status === 'active',
  );
  if (!employee) return err('VALIDATION', 'Select an active employee.', 'employeeId');
  const date = parseDateOnly(input.advanceDate, 'advanceDate');
  if (!date.ok) return date;
  if (!Number.isSafeInteger(input.amountCentavos) || input.amountCentavos <= 0) {
    return err('VALIDATION', 'Advance amount must be greater than zero.', 'amountCentavos');
  }
  const bank = ctx.state.bankAccounts.find(
    (candidate) => candidate.id === input.bankAccountId && candidate.workspaceId === ctx.workspaceId,
  );
  if (!bank) return err('VALIDATION', 'Select a bank account in this workspace.', 'bankAccountId');
  const advanceAccount = requireAccountByRole(ctx.state, ctx.workspaceId, 'employee_advance');
  if (!advanceAccount.ok) return advanceAccount;

  const id = ctx.clock.newId('adv');
  const advanceNoResult = allocateCode(draft, ctx.workspaceId, 'advance');
  if (!advanceNoResult.ok) return advanceNoResult;
  const advanceNo = advanceNoResult.value;
  const journal = postJournal(draft, ctx, {
    postingDate: input.advanceDate,
    documentDate: input.advanceDate,
    sourceType: 'employee_advance',
    sourceId: id,
    effectKey: `advance-post:${id}`,
    memo: `Cash advance ${advanceNo} — ${employee.name}`,
    lines: [
      { accountId: advanceAccount.value.id, debitCentavos: input.amountCentavos, creditCentavos: 0 },
      { accountId: bank.ledgerAccountId, debitCentavos: 0, creditCentavos: input.amountCentavos },
    ],
  });
  if (!journal.ok) return journal;
  pushItem(draft, 'advances', {
    id,
    workspaceId: ctx.workspaceId,
    advanceNo,
    employeeId: employee.id,
    advanceDate: input.advanceDate,
    amountCentavos: input.amountCentavos,
    liquidatedCentavos: 0,
    returnedCentavos: 0,
    status: 'open',
    journalId: journal.value.id,
    createdBy: ctx.actorId,
    createdAt: ctx.clock.nowIso,
  });
  recordAudit(draft, ctx, {
    action: 'advance.post',
    recordType: 'employee_advance',
    recordId: id,
    detail: { advanceNo, amountCentavos: input.amountCentavos },
  });
  return ok({
    summary: `Advance ${advanceNo} released to ${employee.name}.`,
    documentType: 'employee_advance',
    documentId: id,
    journalIds: [journal.value.id],
    warnings: ['Cash advances are not payroll deductions; liquidation is tracked separately.'],
  });
}

export function liquidateAdvance(
  draft: StateDraft,
  ctx: WriteContext,
  input: Extract<DomainCommand, { type: 'advance.liquidate' }>['input'],
): Result<CommandResult> {
  const role = requireRole(ctx, 'accountant', 'ap_ar_clerk', 'company_admin');
  if (!role.ok) return role;
  const advance = ctx.state.advances.find(
    (candidate) => candidate.id === input.advanceId && candidate.workspaceId === ctx.workspaceId,
  );
  if (!advance) return err('NOT_FOUND', 'Advance not found in this workspace.');
  if (advance.status !== 'open') return err('CONFLICT', 'This advance is already closed.');
  const date = parseDateOnly(input.liquidationDate, 'liquidationDate');
  if (!date.ok) return date;
  if (input.expenses.length === 0) return err('VALIDATION', 'Add at least one supported expense.', 'expenses');
  const expenses = [];
  for (const [index, expense] of input.expenses.entries()) {
    if (!Number.isSafeInteger(expense.amountCentavos) || expense.amountCentavos <= 0) {
      return err('VALIDATION', `Expense ${index + 1} must be greater than zero.`, 'expenses');
    }
    if (expense.description.trim().length === 0) {
      return err('VALIDATION', `Expense ${index + 1} needs a description.`, 'expenses');
    }
    const account = ctx.state.accounts.find(
      (candidate) => candidate.id === expense.accountId && candidate.workspaceId === ctx.workspaceId && candidate.active,
    );
    if (!account) return err('VALIDATION', `Expense ${index + 1} account is not in this workspace.`, 'expenses');
    expenses.push({
      accountId: account.id,
      description: expense.description.trim(),
      amountCentavos: expense.amountCentavos,
    });
  }
  const unused = input.unusedReturnCentavos;
  const excess = input.excessReimbursementCentavos;
  if (!Number.isSafeInteger(unused) || unused < 0) return err('VALIDATION', 'Unused return must be zero or more.', 'unusedReturnCentavos');
  if (!Number.isSafeInteger(excess) || excess < 0) {
    return err('VALIDATION', 'Excess reimbursement must be zero or more.', 'excessReimbursementCentavos');
  }
  const expenseTotal = sumCentavos(expenses.map((expense) => expense.amountCentavos));
  if (advance.amountCentavos + excess !== expenseTotal + unused) {
    return err(
      'AMOUNT_MISMATCH',
      `Advance ${advance.amountCentavos} + excess ${excess} must equal expenses ${expenseTotal} + unused return ${unused}.`,
    );
  }
  const bank = ctx.state.bankAccounts.find(
    (candidate) => candidate.id === input.bankAccountId && candidate.workspaceId === ctx.workspaceId,
  );
  if ((unused > 0 || excess > 0) && !bank) {
    return err('VALIDATION', 'Select a bank account for the cash settlement.', 'bankAccountId');
  }
  const advanceAccount = requireAccountByRole(ctx.state, ctx.workspaceId, 'employee_advance');
  if (!advanceAccount.ok) return advanceAccount;
  const payableAccount = requireAccountByRole(ctx.state, ctx.workspaceId, 'employee_payable');
  if (!payableAccount.ok) return payableAccount;

  const id = ctx.clock.newId('liq');
  const journal = postJournal(draft, ctx, {
    postingDate: input.liquidationDate,
    documentDate: input.liquidationDate,
    sourceType: 'advance_liquidation',
    sourceId: id,
    effectKey: `advance-liquidation:${id}`,
    memo: `Liquidation of ${advance.advanceNo}`,
    lines: [
      ...expenses.map((expense) => ({
        accountId: expense.accountId,
        debitCentavos: expense.amountCentavos,
        creditCentavos: 0,
        memo: expense.description,
      })),
      ...(unused > 0 && bank
        ? [{ accountId: bank.ledgerAccountId, debitCentavos: unused, creditCentavos: 0, memo: 'Unused cash returned' }]
        : []),
      { accountId: advanceAccount.value.id, debitCentavos: 0, creditCentavos: advance.amountCentavos },
      ...(excess > 0
        ? [{ accountId: payableAccount.value.id, debitCentavos: 0, creditCentavos: excess, memo: 'Excess due to employee' }]
        : []),
    ],
  });
  if (!journal.ok) return journal;
  const journalIds = [journal.value.id];
  if (excess > 0 && bank) {
    const settlement = postJournal(draft, ctx, {
      postingDate: input.liquidationDate,
      documentDate: input.liquidationDate,
      sourceType: 'advance_excess_settlement',
      sourceId: id,
      effectKey: `advance-excess:${id}`,
      memo: `Reimburse excess advance expense — ${advance.advanceNo}`,
      lines: [
        { accountId: payableAccount.value.id, debitCentavos: excess, creditCentavos: 0 },
        { accountId: bank.ledgerAccountId, debitCentavos: 0, creditCentavos: excess },
      ],
    });
    if (!settlement.ok) return settlement;
    journalIds.push(settlement.value.id);
  }
  const liquidationNo = allocateCode(draft, ctx.workspaceId, 'liquidation');
  if (!liquidationNo.ok) return liquidationNo;
  pushItem(draft, 'liquidations', {
    id,
    workspaceId: ctx.workspaceId,
    liquidationNo: liquidationNo.value,
    advanceId: advance.id,
    liquidationDate: input.liquidationDate,
    expenses,
    expenseTotalCentavos: expenseTotal,
    unusedReturnCentavos: unused,
    excessReimbursementCentavos: excess,
    journalIds,
    createdBy: ctx.actorId,
    createdAt: ctx.clock.nowIso,
  });
  updateItem(
    draft,
    'advances',
    (candidate) => candidate.id === advance.id,
    (candidate) => ({
      ...candidate,
      liquidatedCentavos: expenseTotal,
      returnedCentavos: unused,
      status: 'closed',
    }),
  );
  recordAudit(draft, ctx, {
    action: 'advance.liquidate',
    recordType: 'advance_liquidation',
    recordId: id,
    detail: { advanceNo: advance.advanceNo, expenseTotal, unused, excess, journalIds: journalIds.length },
  });
  return ok({
    summary: `Advance ${advance.advanceNo} liquidated; ${expenseTotal} centavos supported, ${unused} returned, ${excess} reimbursed.`,
    documentType: 'advance_liquidation',
    documentId: id,
    journalIds,
    warnings: [],
  });
}

export function expectedWithholding(state: WriteContext['state'], billId: string): number {
  const bill = state.bills.find((candidate) => candidate.id === billId);
  return bill?.ewtCentavos ?? 0;
}

export function billsForWorkspace(state: WriteContext['state'], workspaceId: string): Bill[] {
  return state.bills.filter((bill) => bill.workspaceId === workspaceId);
}
