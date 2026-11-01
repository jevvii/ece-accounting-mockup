import type { CommandResult, DomainCommand } from './commandTypes';
import { postJournal, recordAudit, reverseJournal, type WriteContext } from './ledger';
import type { BankAccount, BankRow } from './schema';
import { requireAccountByRole, requireProduct, requireRole } from './shared/access';
import { parseDateOnly } from './shared/dates';
import { pushItem, updateItem, type StateDraft } from './shared/draft';
import { err, ok, type Result } from './shared/result';
import { allocateCode } from './numbering';


export function bankRowFingerprint(input: {
  valueDate: string;
  direction: 'in' | 'out';
  amountCentavos: number;
  description: string;
}): string {
  return `${input.valueDate}|${input.direction}|${input.amountCentavos}|${input.description.trim().toLowerCase()}`;
}

export function importBankRows(
  draft: StateDraft,
  ctx: WriteContext,
  input: Extract<DomainCommand, { type: 'bankRow.import' }>['input'],
): Result<CommandResult> {
  const product = requireProduct(ctx, 'accounting');
  if (!product.ok) return product;
  const role = requireRole(ctx, 'accountant', 'ap_ar_clerk', 'company_admin');
  if (!role.ok) return role;
  const bank = ctx.state.bankAccounts.find(
    (candidate) => candidate.id === input.bankAccountId && candidate.workspaceId === ctx.workspaceId && candidate.active,
  );
  if (!bank) return err('VALIDATION', 'Select an active bank account.', 'bankAccountId');
  if (input.sourceName.trim().length === 0) return err('VALIDATION', 'CSV file name is required.', 'sourceName');
  if (input.rows.length === 0) return err('VALIDATION', 'The CSV contained no rows.', 'rows');

  const existingRows = ctx.state.bankRows.filter(
    (row) => row.workspaceId === ctx.workspaceId && row.bankAccountId === bank.id,
  );
  const seenRefs = new Set(existingRows.map((row) => row.rowRef));
  const seenFingerprints = new Set(existingRows.map((row) => bankRowFingerprint(row)));
  const accepted: Array<{
    rowRef: string;
    valueDate: string;
    description: string;
    direction: 'in' | 'out';
    amountCentavos: number;
  }> = [];
  const skipped: string[] = [];

  for (const [index, raw] of input.rows.entries()) {
    if (raw.rowRef.trim().length === 0) {
      return err('VALIDATION', `Row ${index + 2} has no reference.`, 'rows');
    }
    const date = parseDateOnly(raw.valueDate, 'rows');
    if (!date.ok) return err('VALIDATION', `Row ${index + 2}: ${date.error.message}`, 'rows');
    if (!Number.isSafeInteger(raw.amountCentavos) || raw.amountCentavos <= 0) {
      return err('VALIDATION', `Row ${index + 2} amount must be a positive centavo value.`, 'rows');
    }
    if (raw.direction !== 'in' && raw.direction !== 'out') {
      return err('VALIDATION', `Row ${index + 2} direction must be in or out.`, 'rows');
    }
    const rowRef = raw.rowRef.trim();
    const fingerprint = bankRowFingerprint(raw);
    if (seenRefs.has(rowRef) || seenFingerprints.has(fingerprint)) {
      skipped.push(rowRef);
      continue;
    }
    seenRefs.add(rowRef);
    seenFingerprints.add(fingerprint);
    accepted.push({ ...raw, rowRef, description: raw.description.trim() });
  }

  const statementId = ctx.clock.newId('bstmt');
  if (accepted.length === 0) {
    recordAudit(draft, ctx, {
      action: 'bank.importSkipped',
      recordType: 'bank_statement',
      recordId: input.sourceName,
      detail: { skipped: skipped.length, sourceName: input.sourceName },
    });
    return ok({
      summary: `No new bank rows imported; ${skipped.length} duplicate row(s) were ignored.`,
      documentType: 'bank_statement',
      documentId: '',
      journalIds: [],
      warnings: ['Every row in this file already exists for the selected bank account.'],
    });
  }
  const statementNo = allocateCode(draft, ctx.workspaceId, 'bank_statement');
  if (!statementNo.ok) return statementNo;
  pushItem(draft, 'bankStatements', {
    id: statementId,
    workspaceId: ctx.workspaceId,
    statementNo: statementNo.value,
    bankAccountId: bank.id,
    importedAt: ctx.clock.nowIso,
    sourceName: input.sourceName.trim(),
    rowCount: accepted.length,
    importedBy: ctx.actorId,
  });
  for (const row of accepted) {
    pushItem(draft, 'bankRows', {
      id: ctx.clock.newId('brow'),
      workspaceId: ctx.workspaceId,
      statementId,
      bankAccountId: bank.id,
      rowRef: row.rowRef,
      valueDate: row.valueDate,
      description: row.description,
      direction: row.direction,
      amountCentavos: row.amountCentavos,
      status: 'unmatched',
      matchedSourceType: null,
      matchedSourceId: null,
      matchReason: null,
      clearingJournalId: null,
      reconciledAt: null,
      reconciledBy: null,
      undoReason: null,
      undoJournalId: null,
      history: [
        {
          at: ctx.clock.nowIso,
          by: ctx.actorId,
          action: 'imported',
          note: `Imported from ${input.sourceName.trim()}`,
        },
      ],
    });
  }
  recordAudit(draft, ctx, {
    action: 'bank.import',
    recordType: 'bank_statement',
    recordId: statementId,
    detail: {
      statementNo: statementNo.value,
      bankAccountId: bank.id,
      imported: accepted.length,
      skipped: skipped.length,
      sourceName: input.sourceName,
    },
  });
  return ok({
    summary: `Imported ${accepted.length} bank row(s); ${skipped.length} duplicate row(s) ignored.`,
    documentType: 'bank_statement',
    documentId: statementId,
    journalIds: [],
    warnings: skipped.length > 0 ? [`Duplicate rows ignored: ${skipped.join(', ')}`] : [],
  });
}

function bankRowById(state: WriteContext['state'], workspaceId: string, rowId: string): BankRow | undefined {
  return state.bankRows.find((row) => row.id === rowId && row.workspaceId === workspaceId);
}

export function matchBankRow(
  draft: StateDraft,
  ctx: WriteContext,
  input: Extract<DomainCommand, { type: 'bankRow.match' }>['input'],
): Result<CommandResult> {
  const product = requireProduct(ctx, 'accounting');
  if (!product.ok) return product;
  const role = requireRole(ctx, 'accountant', 'ap_ar_clerk', 'company_admin');
  if (!role.ok) return role;
  const row = bankRowById(ctx.state, ctx.workspaceId, input.rowId);
  if (!row) return err('NOT_FOUND', 'Bank row not found in this workspace.');
  if (row.status !== 'unmatched') {
    return err('CONFLICT', 'This bank row is already matched. Undo the reconciliation before rematching.');
  }
  if (input.reason.trim().length < 3) return err('VALIDATION', 'A match reason is required.', 'reason');

  let journalId: string | null = null;
  if (input.sourceType === 'customer_receipt') {
    const receipt = ctx.state.receipts.find(
      (candidate) => candidate.id === input.sourceId && candidate.workspaceId === ctx.workspaceId,
    );
    if (!receipt) return err('NOT_FOUND', 'Receipt not found in this workspace.');
    if (receipt.status !== 'posted') return err('CONFLICT', 'A returned receipt cannot be matched.');
    if (row.direction !== 'in') return err('VALIDATION', 'An incoming receipt needs an inflow bank row.', 'sourceType');
    if (row.amountCentavos !== receipt.amountCentavos) {
      return err(
        'AMOUNT_MISMATCH',
        `Bank row is ${row.amountCentavos} centavos but the receipt is ${receipt.amountCentavos}; it remains unresolved.`,
        'sourceId',
      );
    }
    const alreadyMatched = ctx.state.bankRows.some(
      (candidate) => candidate.id !== row.id && candidate.matchedSourceId === receipt.id,
    );
    if (alreadyMatched) return err('CONFLICT', 'That receipt is already matched to another bank row.');
    if (receipt.method === 'incoming_clearing') {
      const clearing = requireAccountByRole(ctx.state, ctx.workspaceId, 'incoming_clearing');
      if (!clearing.ok) return clearing;
      const bank = ctx.state.bankAccounts.find((candidate) => candidate.id === row.bankAccountId);
      if (!bank) return err('INVALID_STATE', 'The bank account for this row no longer exists.');
      const journal = postJournal(draft, ctx, {
        postingDate: row.valueDate,
        documentDate: row.valueDate,
        sourceType: 'bank_clearing',
        sourceId: row.id,
        clearingTargetType: 'customer_receipt',
        clearingTargetId: receipt.id,
        effectKey: `bank-match:${row.id}`,
        memo: `Clear incoming receipt ${receipt.receiptNo} against bank row ${row.rowRef}`,
        lines: [
          { accountId: bank.ledgerAccountId, debitCentavos: row.amountCentavos, creditCentavos: 0 },
          { accountId: clearing.value.id, debitCentavos: 0, creditCentavos: row.amountCentavos },
        ],
      });
      if (!journal.ok) return journal;
      journalId = journal.value.id;
    }
  } else if (input.sourceType === 'payment') {
    const payment = ctx.state.payments.find(
      (candidate) => candidate.id === input.sourceId && candidate.workspaceId === ctx.workspaceId,
    );
    if (!payment) return err('NOT_FOUND', 'Payment not found in this workspace.');
    if (payment.status !== 'posted') {
      return err('CONFLICT', `Payment is already ${payment.status}; nothing was matched.`);
    }
    if (row.direction !== 'out') return err('VALIDATION', 'An outgoing payment needs an outflow bank row.', 'sourceType');
    const cashOut = payment.amountCentavos - payment.ewtCentavos;
    if (row.amountCentavos !== cashOut) {
      return err(
        'AMOUNT_MISMATCH',
        `Bank row is ${row.amountCentavos} centavos but the payment released ${cashOut}; it remains unresolved.`,
        'sourceId',
      );
    }
    const alreadyMatched = ctx.state.bankRows.some(
      (candidate) => candidate.id !== row.id && candidate.matchedSourceId === payment.id,
    );
    if (alreadyMatched) return err('CONFLICT', 'That payment is already matched to another bank row.');
    if (payment.method === 'outgoing_clearing' && payment.clearingAccountId) {
      const bank = ctx.state.bankAccounts.find((candidate) => candidate.id === row.bankAccountId);
      if (!bank) return err('INVALID_STATE', 'The bank account for this row no longer exists.');
      const journal = postJournal(draft, ctx, {
        postingDate: row.valueDate,
        documentDate: row.valueDate,
        sourceType: 'bank_clearing',
        sourceId: row.id,
        clearingTargetType: 'payment',
        clearingTargetId: payment.id,
        effectKey: `bank-match:${row.id}`,
        memo: `Clear outgoing payment ${payment.paymentNo} against bank row ${row.rowRef}`,
        lines: [
          { accountId: payment.clearingAccountId, debitCentavos: cashOut, creditCentavos: 0 },
          { accountId: bank.ledgerAccountId, debitCentavos: 0, creditCentavos: cashOut },
        ],
      });
      if (!journal.ok) return journal;
      journalId = journal.value.id;
      updateItem(
        draft,
        'payments',
        (candidate) => candidate.id === payment.id,
        (candidate) => ({
          ...candidate,
          status: 'cleared' as const,
          clearedJournalId: journal.value.id,
          bankRowId: row.id,
        }),
      );
    } else {
      updateItem(
        draft,
        'payments',
        (candidate) => candidate.id === payment.id,
        (candidate) => ({ ...candidate, status: 'cleared' as const, bankRowId: row.id }),
      );
    }
  } else {
    return err('VALIDATION', 'Unknown bank match source.', 'sourceType');
  }

  updateItem(
    draft,
    'bankRows',
    (candidate) => candidate.id === row.id,
    (candidate) => ({
      ...candidate,
      status: 'reconciled' as const,
      matchedSourceType: input.sourceType,
      matchedSourceId: input.sourceId,
      matchReason: input.reason,
      clearingJournalId: journalId,
      reconciledAt: ctx.clock.nowIso,
      reconciledBy: ctx.actorId,
      history: [
        ...candidate.history,
        {
          at: ctx.clock.nowIso,
          by: ctx.actorId,
          action: 'reconciled' as const,
          note: `${input.reason}${journalId ? ` · clearing ${journalId}` : ' · already in bank ledger'}`,
        },
      ],
    }),
  );
  recordAudit(draft, ctx, {
    action: 'bank.match',
    recordType: 'bank_row',
    recordId: row.id,
    reason: input.reason,
    detail: { sourceType: input.sourceType, sourceId: input.sourceId, journalId: journalId ?? 'none' },
  });
  return ok({
    summary: `Bank row ${row.rowRef} reconciled to ${input.sourceType} ${input.sourceId}.`,
    documentType: 'bank_row',
    documentId: row.id,
    journalIds: journalId ? [journalId] : [],
    warnings: journalId ? [] : ['No clearing journal was needed; the source already posted directly to this bank account.'],
  });
}

export function undoBankRow(
  draft: StateDraft,
  ctx: WriteContext,
  input: { rowId: string; reversalDate: string; reason: string },
): Result<CommandResult> {
  const role = requireRole(ctx, 'accountant', 'company_admin');
  if (!role.ok) return role;
  const row = bankRowById(ctx.state, ctx.workspaceId, input.rowId);
  if (!row) return err('NOT_FOUND', 'Bank row not found in this workspace.');
  if (row.status !== 'reconciled') return err('CONFLICT', 'Only a reconciled row can be undone.');
  if (input.reason.trim().length < 3) return err('VALIDATION', 'An undo reason is required.', 'reason');
  const date = parseDateOnly(input.reversalDate, 'reversalDate');
  if (!date.ok) return date;

  let reversalId: string | null = null;
  if (row.clearingJournalId) {
    const reversal = reverseJournal(
      draft,
      ctx,
      row.clearingJournalId,
      input.reversalDate,
      input.reason,
      'bank_clearing_undo',
      row.id,
    );
    if (!reversal.ok) return reversal;
    reversalId = reversal.value.id;
  }
  if (row.matchedSourceType === 'payment' && row.matchedSourceId) {
    updateItem(
      draft,
      'payments',
      (candidate) => candidate.id === row.matchedSourceId,
      (candidate) => ({ ...candidate, status: 'posted' as const, clearedJournalId: null, bankRowId: null }),
    );
  }
  updateItem(
    draft,
    'bankRows',
    (candidate) => candidate.id === row.id,
    (candidate) => ({
      ...candidate,
      status: 'unmatched' as const,
      matchedSourceType: null,
      matchedSourceId: null,
      matchReason: null,
      clearingJournalId: null,
      reconciledAt: null,
      reconciledBy: null,
      undoReason: input.reason,
      undoJournalId: reversalId,
      history: [
        ...candidate.history,
        {
          at: ctx.clock.nowIso,
          by: ctx.actorId,
          action: 'undo' as const,
          note: `${input.reason}${reversalId ? ` · reversed ${reversalId}` : ''}`,
        },
      ],
    }),
  );
  recordAudit(draft, ctx, {
    action: 'bank.undo',
    recordType: 'bank_row',
    recordId: row.id,
    reason: input.reason,
    detail: { reversalJournalId: reversalId ?? 'none', previousSourceId: row.matchedSourceId ?? '' },
  });
  return ok({
    summary: `Reconciliation of ${row.rowRef} undone; history retained.`,
    documentType: 'bank_row',
    documentId: row.id,
    journalIds: reversalId ? [reversalId] : [],
    warnings: [],
  });
}

export interface MatchSuggestion {
  row: BankRow;
  sourceType: 'customer_receipt' | 'payment';
  sourceId: string;
  label: string;
  amountCentavos: number;
  exact: boolean;
}

export function suggestMatches(state: WriteContext['state'], workspaceId: string): MatchSuggestion[] {
  const suggestions: MatchSuggestion[] = [];
  for (const row of state.bankRows) {
    if (row.workspaceId !== workspaceId || row.status !== 'unmatched') continue;
    if (row.direction === 'in') {
      for (const receipt of state.receipts) {
        if (
          receipt.workspaceId !== workspaceId ||
          receipt.status !== 'posted' ||
          state.bankRows.some((candidate) => candidate.matchedSourceId === receipt.id)
        ) {
          continue;
        }
        const exact = receipt.amountCentavos === row.amountCentavos;
        if (Math.abs(receipt.amountCentavos - row.amountCentavos) > 100_00) continue;
        suggestions.push({
          row,
          sourceType: 'customer_receipt',
          sourceId: receipt.id,
          label: `Receipt ${receipt.receiptNo}`,
          amountCentavos: receipt.amountCentavos,
          exact,
        });
      }
    } else {
      for (const payment of state.payments) {
        if (
          payment.workspaceId !== workspaceId ||
          payment.status !== 'posted' ||
          state.bankRows.some((candidate) => candidate.matchedSourceId === payment.id)
        ) {
          continue;
        }
        const cashOut = payment.amountCentavos - payment.ewtCentavos;
        const exact = cashOut === row.amountCentavos;
        if (Math.abs(cashOut - row.amountCentavos) > 100_00) continue;
        suggestions.push({
          row,
          sourceType: 'payment',
          sourceId: payment.id,
          label: `Payment ${payment.paymentNo}`,
          amountCentavos: cashOut,
          exact,
        });
      }
    }
  }
  return suggestions;
}

export function bankAccountsForWorkspace(state: WriteContext['state'], workspaceId: string): BankAccount[] {
  return state.bankAccounts.filter((account) => account.workspaceId === workspaceId && account.active);
}
