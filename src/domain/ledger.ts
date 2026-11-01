import type { AccessContext } from './shared/access';
import type { Clock } from './shared/clock';
import { periodIdFor } from './shared/dates';
import { pushItem, setRecordValue, updateItem, type StateDraft } from './shared/draft';
import { err, ok, type Result } from './shared/result';
import { allocateCode } from './numbering';
import type {
  Account,
  AppState,
  AuditEvent,
  BankRow,
  Journal,
  JournalLine,
  JournalProvenance,
  Payment,
  Period,
  Receipt,
  SourceBookKey,
} from './schema';

export interface WriteContext extends AccessContext {
  clock: Clock;
}

export interface JournalInputLine {
  accountId: string;
  debitCentavos: number;
  creditCentavos: number;
  memo?: string;
}

export interface JournalInput {
  postingDate: string;
  documentDate: string;
  sourceType: string;
  sourceId: string;
  effectKey: string;
  memo: string;
  lines: JournalInputLine[];
  approvedBy?: string | null;
  policySnapshot?: string | null;
  reversalOf?: string | null;
  clearingTargetType?: 'customer_receipt' | 'payment' | null;
  clearingTargetId?: string | null;
  sourceProvenance?: JournalProvenance;
}

export function effectRecordKey(workspaceId: string, effectKey: string): string {
  return `${workspaceId}:${effectKey}`;
}

export function findPeriod(state: AccessContext['state'], workspaceId: string, dateOnly: string): Period | undefined {
  const periodId = periodIdFor(workspaceId, dateOnly);
  return state.periods.find((period) => period.id === periodId);
}

export function assertPeriodOpen(ctx: WriteContext, dateOnly: string): Result<Period> {
  const period = findPeriod(ctx.state, ctx.workspaceId, dateOnly);
  if (!period) {
    return err(
      'INVALID_STATE',
      `No accounting period is configured for ${dateOnly.slice(0, 7)} in this workspace.`,
    );
  }
  if (period.status === 'closed') {
    return err(
      'CLOSED_PERIOD',
      `The accounting period ${period.year}-${String(period.month).padStart(2, '0')} is closed. Reopen it with a reason before posting.`,
    );
  }
  return ok(period);
}

export function journalDebitTotal(lines: JournalLine[]): number {
  return lines.reduce((total, line) => total + line.debitCentavos, 0);
}

export function journalCreditTotal(lines: JournalLine[]): number {
  return lines.reduce((total, line) => total + line.creditCentavos, 0);
}


export function recordAudit(
  draft: StateDraft,
  ctx: WriteContext,
  input: {
    action: string;
    recordType: string;
    recordId: string;
    reason?: string | null;
    detail?: Record<string, string | number | boolean | null>;
  },
): AuditEvent {
  const event: AuditEvent = {
    id: ctx.clock.newId('aud'),
    workspaceId: ctx.workspaceId,
    actorId: ctx.actorId,
    action: input.action,
    recordType: input.recordType,
    recordId: input.recordId,
    at: ctx.clock.nowIso,
    reason: input.reason ?? null,
    detail: input.detail ?? {},
  };
  pushItem(draft, 'auditEvents', event);
  return event;
}

export const DIRECT_SOURCE_BOOK: Record<string, SourceBookKey> = {
  invoice: 'sales',
  credit_note: 'sales',
  invoice_reversal: 'sales',
  customer_receipt: 'collections',
  receipt_return: 'collections',
  bill: 'purchases',
  bill_reversal: 'purchases',
  payment: 'cash_disbursements',
  employee_advance: 'cash_disbursements',
  advance_excess_settlement: 'cash_disbursements',
  customer_refund: 'cash_disbursements',
  payroll_payment: 'cash_disbursements',
  opening: 'journals',
  standalone_opening: 'journals',
  opening_import: 'journals',
  journal_draft: 'journals',
  payroll_run: 'journals',
  payroll_reversal: 'journals',
  depreciation: 'journals',
  inventory_receipt: 'journals',
  inventory_issue: 'journals',
  inventory_customer_return: 'journals',
  inventory_supplier_return: 'journals',
  inventory_count: 'journals',
  asset_acquisition: 'journals',
  advance_liquidation: 'journals',
};

export type ProvenanceState = {
  journals: Journal[];
  auditEvents?: AuditEvent[];
  bankRows?: BankRow[];
  bankStatementRows?: BankRow[];
  receipts?: Receipt[];
  customerReceipts?: Receipt[];
  payments?: Payment[];
  supplierPayments?: Payment[];
  [key: string]: unknown;
};

export function resolveJournalProvenance(
  state: ProvenanceState,
  journal: Journal,
  options?: { clearingTargetType?: 'customer_receipt' | 'payment' | null; clearingTargetId?: string | null },
): JournalProvenance {
  if (journal.sourceProvenance) {
    const cached = journal.sourceProvenance;
    if (cached.clearingTargetType && !cached.clearingTargetId) {
      const resolved = resolveJournalProvenance(state, { ...journal, sourceProvenance: undefined }, options);
      if (resolved.clearingTargetId && resolved.book === cached.book) return resolved;
    }
    return cached;
  }

  // Check reversal inheritance
  const isReversal =
    journal.reversalOf !== null ||
    journal.sourceType === 'journal_reversal' ||
    journal.sourceType === 'bank_clearing_undo';

  if (isReversal) {
    let targetId = journal.reversalOf;
    if (!targetId && journal.sourceType === 'bank_clearing_undo') {
      const rows = state.bankRows ?? state.bankStatementRows ?? [];
      const row = rows.find((r) => r.id === journal.sourceId && r.workspaceId === journal.workspaceId);
      if (row?.clearingJournalId) {
        targetId = row.clearingJournalId;
      }
    }
    if (!targetId) {
      const orig = state.journals.find(
        (j) => j.reversedBy === journal.id && j.workspaceId === journal.workspaceId,
      );
      if (orig) targetId = orig.id;
    }

    if (!targetId) {
      return {
        version: 1,
        book: 'journals',
        originSourceType: journal.sourceType,
        originSourceId: journal.sourceId,
        originJournalId: null,
        clearingTargetType: null,
        clearingTargetId: null,
        provisional: true,
        exceptionReason: 'Reversal target is missing; provisionally classified under Journals.',
      };
    }

    const visited = new Set<string>([journal.id]);
    let currTargetId = targetId;
    let rootJournal: Journal | null = null;

    while (currTargetId) {
      if (visited.has(currTargetId)) {
        return {
          version: 1,
          book: 'journals',
          originSourceType: journal.sourceType,
          originSourceId: journal.sourceId,
          originJournalId: null,
          clearingTargetType: null,
          clearingTargetId: null,
          provisional: true,
          exceptionReason: `Cyclic reversal reference detected involving "${currTargetId}"; provisionally classified under Journals.`,
        };
      }
      visited.add(currTargetId);
      const target = state.journals.find((j) => j.id === currTargetId);
      if (!target) {
        return {
          version: 1,
          book: 'journals',
          originSourceType: journal.sourceType,
          originSourceId: journal.sourceId,
          originJournalId: null,
          clearingTargetType: null,
          clearingTargetId: null,
          provisional: true,
          exceptionReason: `Reversal target "${currTargetId}" not found; provisionally classified under Journals.`,
        };
      }
      if (target.workspaceId !== journal.workspaceId) {
        return {
          version: 1,
          book: 'journals',
          originSourceType: journal.sourceType,
          originSourceId: journal.sourceId,
          originJournalId: null,
          clearingTargetType: null,
          clearingTargetId: null,
          provisional: true,
          exceptionReason: `Reversal target "${currTargetId}" belongs to a different workspace; provisionally classified under Journals.`,
        };
      }

      if (target.reversalOf) {
        currTargetId = target.reversalOf;
      } else {
        rootJournal = target;
        break;
      }
    }

    if (rootJournal) {
      const rootProv = resolveJournalProvenance(state, rootJournal);
      return {
        version: 1,
        book: rootProv.book,
        originSourceType: rootProv.originSourceType,
        originSourceId: rootProv.originSourceId,
        originJournalId: rootJournal.id,
        clearingTargetType: rootProv.clearingTargetType ?? null,
        clearingTargetId: rootProv.clearingTargetId ?? null,
        provisional: rootProv.provisional,
        exceptionReason: rootProv.exceptionReason,
      };
    }
  }

  // Special case bank_clearing
  if (journal.sourceType === 'bank_clearing') {
    const audit = state.auditEvents?.find((event) => event.workspaceId === journal.workspaceId &&
      event.action === 'bank.match' && event.recordId === journal.sourceId && event.detail.journalId === journal.id);
    const auditType = audit?.detail.sourceType === 'customer_receipt' || audit?.detail.sourceType === 'payment' ? audit.detail.sourceType : null;
    const auditId = typeof audit?.detail.sourceId === 'string' ? audit.detail.sourceId : null;
    let clearingTarget = options?.clearingTargetType ?? auditType;
    let clearingTargetId = options?.clearingTargetId ?? auditId;
    const matchedRow = (state.bankRows ?? state.bankStatementRows ?? []).find((row) =>
      row.workspaceId === journal.workspaceId && (row.id === journal.sourceId || row.clearingJournalId === journal.id));
    if (matchedRow?.matchedSourceId) clearingTargetId ??= matchedRow.matchedSourceId;

    if (!clearingTarget) {
      const rows = state.bankRows ?? state.bankStatementRows ?? [];
      const row = rows.find(
        (r) =>
          (r.id === journal.sourceId || r.clearingJournalId === journal.id) &&
          r.workspaceId === journal.workspaceId,
      );
      if (row?.matchedSourceType) {
        clearingTarget = row.matchedSourceType;
      }
    }

    if (!clearingTarget) {
      const payments = state.payments ?? state.supplierPayments ?? [];
      const hasPayment = payments.some(
        (p) =>
          (p.clearedJournalId === journal.id || p.id === journal.sourceId) &&
          p.workspaceId === journal.workspaceId,
      );
      if (hasPayment) clearingTarget = 'payment';
    }

    if (!clearingTarget) {
      const receipts = state.receipts ?? state.customerReceipts ?? [];
      const hasReceipt = receipts.some(
        (r) => r.id === journal.sourceId && r.workspaceId === journal.workspaceId,
      );
      if (hasReceipt) clearingTarget = 'customer_receipt';
    }

    if (clearingTarget === 'customer_receipt') {
      return {
        version: 1,
        book: 'collections',
        originSourceType: 'customer_receipt',
        originSourceId: clearingTargetId ?? journal.sourceId,
        originJournalId: null,
        clearingTargetType: 'customer_receipt',
        clearingTargetId,
        provisional: false,
        exceptionReason: null,
      };
    }

    if (clearingTarget === 'payment') {
      return {
        version: 1,
        book: 'cash_disbursements',
        originSourceType: 'payment',
        originSourceId: clearingTargetId ?? journal.sourceId,
        originJournalId: null,
        clearingTargetType: 'payment',
        clearingTargetId,
        provisional: false,
        exceptionReason: null,
      };
    }

    return {
      version: 1,
      book: 'journals',
      originSourceType: journal.sourceType,
      originSourceId: journal.sourceId,
      originJournalId: null,
      clearingTargetType: null,
      clearingTargetId: null,
      provisional: true,
      exceptionReason: 'Unresolved bank clearing target; provisionally classified under Journals.',
    };
  }

  // Direct mapping
  const directBook = DIRECT_SOURCE_BOOK[journal.sourceType];
  if (directBook) {
    return {
      version: 1,
      book: directBook,
      originSourceType: journal.sourceType,
      originSourceId: journal.sourceId,
      originJournalId: null,
      clearingTargetType: null,
      clearingTargetId: null,
      provisional: false,
      exceptionReason: null,
    };
  }

  // Unrecognized sourceType
  return {
    version: 1,
    book: 'journals',
    originSourceType: journal.sourceType,
    originSourceId: journal.sourceId,
    originJournalId: null,
    clearingTargetType: null,
    clearingTargetId: null,
    provisional: true,
    exceptionReason: `Unrecognized journal sourceType "${journal.sourceType}"; provisionally classified under Journals.`,
  };
}

export function backfillJournalProvenance(state: AppState): AppState {
  let changed = false;
  const journals = state.journals.map((journal) => {
    const provenance = resolveJournalProvenance(state, journal);
    if (provenance === journal.sourceProvenance) return journal;
    changed = true;
    return { ...journal, sourceProvenance: provenance };
  });
  return changed ? { ...state, journals } : state;
}

/**
 * Validate and append one posted journal. The caller must already have
 * authorized the business action. On error nothing has been written.
 */
export function postJournal(draft: StateDraft, ctx: WriteContext, input: JournalInput): Result<Journal> {
  if (input.lines.length < 2) {
    return err('VALIDATION', 'A journal needs at least two lines.');
  }
  const period = assertPeriodOpen(ctx, input.postingDate);
  if (!period.ok) return period;

  const existingEffect = ctx.state.sourceEffects[effectRecordKey(ctx.workspaceId, input.effectKey)];
  if (existingEffect) {
    return err(
      'DUPLICATE_EFFECT',
      `This business effect was already posted by ${existingEffect.documentId}.`,
    );
  }

  const accountsById = new Map<string, Account>();
  for (const account of ctx.state.accounts) {
    if (account.workspaceId === ctx.workspaceId) accountsById.set(account.id, account);
  }

  const lines: JournalLine[] = [];
  let debitTotal = 0;
  let creditTotal = 0;
  for (const raw of input.lines) {
    const account = accountsById.get(raw.accountId);
    if (!account) {
      return err('VALIDATION', `Account ${raw.accountId} does not belong to this workspace.`, 'accountId');
    }
    if (!account.active) {
      return err('VALIDATION', `Account ${account.code} is inactive.`, 'accountId');
    }
    if (!Number.isSafeInteger(raw.debitCentavos) || !Number.isSafeInteger(raw.creditCentavos)) {
      return err('VALIDATION', 'Journal amounts must be integer centavos.');
    }
    if (raw.debitCentavos < 0 || raw.creditCentavos < 0) {
      return err('VALIDATION', 'Journal amounts cannot be negative.');
    }
    if (raw.debitCentavos > 0 && raw.creditCentavos > 0) {
      return err('VALIDATION', `Line for ${account.code} cannot be both debit and credit.`);
    }
    if (raw.debitCentavos === 0 && raw.creditCentavos === 0) {
      return err('VALIDATION', `Line for ${account.code} has no amount.`);
    }
    debitTotal += raw.debitCentavos;
    creditTotal += raw.creditCentavos;
    if (!Number.isSafeInteger(debitTotal) || !Number.isSafeInteger(creditTotal)) {
      return err('VALIDATION', 'Journal total overflow.');
    }
    lines.push({
      accountId: account.id,
      accountCode: account.code,
      debitCentavos: raw.debitCentavos,
      creditCentavos: raw.creditCentavos,
      memo: raw.memo ?? input.memo,
    });
  }
  if (debitTotal !== creditTotal) {
    return err(
      'VALIDATION',
      `Journal is not balanced: debits ${debitTotal} ≠ credits ${creditTotal} centavos.`,
    );
  }
  if (debitTotal === 0) return err('VALIDATION', 'A journal cannot be zero-value.');

  const journalNo = allocateCode(draft, ctx.workspaceId, 'journal');
  if (!journalNo.ok) return journalNo;

  const dummyForProv: Journal = {
    id: 'pending',
    workspaceId: ctx.workspaceId,
    journalNo: journalNo.value,
    postingDate: input.postingDate,
    documentDate: input.documentDate,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    effectKey: input.effectKey,
    memo: input.memo,
    lines,
    status: 'posted',
    createdBy: ctx.actorId,
    createdAt: ctx.clock.nowIso,
    approvedBy: input.approvedBy ?? null,
    policySnapshot: input.policySnapshot ?? null,
    reversalOf: input.reversalOf ?? null,
    reversedBy: null,
  };

  const provenance = input.sourceProvenance ?? resolveJournalProvenance(
    { ...ctx.state, journals: draft.state.journals },
    dummyForProv,
    { clearingTargetType: input.clearingTargetType, clearingTargetId: input.clearingTargetId },
  );

  const journal: Journal = {
    ...dummyForProv,
    id: ctx.clock.newId('jv'),
    sourceProvenance: provenance,
  };
  pushItem(draft, 'journals', journal);
  setRecordValue(draft, 'sourceEffects', effectRecordKey(ctx.workspaceId, input.effectKey), {
    kind: input.sourceType,
    documentId: input.sourceId,
    at: ctx.clock.nowIso,
  });
  recordAudit(draft, ctx, {
    action: 'journal.post',
    recordType: 'journal',
    recordId: journal.id,
    detail: {
      journalNo: journal.journalNo,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      totalCentavos: debitTotal,
    },
  });
  return ok(journal);
}

/**
 * Post a linked reversal of a posted journal in an open period. The original
 * remains visible and immutable; both entries carry the reversal links.
 */
export function reverseJournal(
  draft: StateDraft,
  ctx: WriteContext,
  journalId: string,
  reversalDate: string,
  reason: string,
  sourceType = 'journal_reversal',
  sourceId?: string,
): Result<Journal> {
  const original = draft.state.journals.find(
    (journal) => journal.id === journalId && journal.workspaceId === ctx.workspaceId,
  );
  if (!original) return err('NOT_FOUND', 'Journal not found in this workspace.');
  if (original.reversedBy !== null) {
    return err('CONFLICT', `Journal ${original.journalNo} has already been reversed.`);
  }
  if (original.reversalOf !== null) {
    return err('CONFLICT', 'A reversal journal cannot itself be reversed; post an adjustment instead.');
  }
  if (reason.trim().length < 3) {
    return err('VALIDATION', 'A reversal reason is required.', 'reason');
  }
  const reversal = postJournal(draft, ctx, {
    postingDate: reversalDate,
    documentDate: reversalDate,
    sourceType,
    sourceId: sourceId ?? original.id,
    effectKey: `journal-reversal:${original.id}`,
    memo: `Reversal · ${original.memo} · ${reason}`,
    lines: original.lines.map((line) => ({
      accountId: line.accountId,
      debitCentavos: line.creditCentavos,
      creditCentavos: line.debitCentavos,
      memo: `Reversal: ${line.memo}`,
    })),
    approvedBy: ctx.actorId,
    reversalOf: original.id,
  });
  if (!reversal.ok) return reversal;
  updateItem(
    draft,
    'journals',
    (journal) => journal.id === original.id,
    (journal) => ({ ...journal, reversedBy: reversal.value.id }),
  );
  recordAudit(draft, ctx, {
    action: 'journal.reverse',
    recordType: 'journal',
    recordId: original.id,
    reason,
    detail: { reversalJournalId: reversal.value.id, reversalDate },
  });
  return reversal;
}

/** Debit-normal balance for one account across posted journals. */
export function accountBalance(
  state: AccessContext['state'],
  workspaceId: string,
  accountId: string,
  fromDate: string | null,
  toDate: string | null,
): { debitCentavos: number; creditCentavos: number; netDebitCentavos: number } {
  let debit = 0;
  let credit = 0;
  for (const journal of state.journals) {
    if (journal.workspaceId !== workspaceId) continue;
    if (fromDate !== null && journal.postingDate < fromDate) continue;
    if (toDate !== null && journal.postingDate > toDate) continue;
    for (const line of journal.lines) {
      if (line.accountId !== accountId) continue;
      debit += line.debitCentavos;
      credit += line.creditCentavos;
    }
  }
  return { debitCentavos: debit, creditCentavos: credit, netDebitCentavos: debit - credit };
}
