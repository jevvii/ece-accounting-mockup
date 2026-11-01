import type { CommandResult, DomainCommand } from './commandTypes';
import { findPeriod, postJournal, recordAudit, reverseJournal, type WriteContext } from './ledger';
import type { Certificate2307, JournalDraft, Period } from './schema';
import { requireProduct, requireRole } from './shared/access';
import { parseDateOnly } from './shared/dates';
import { pushItem, updateItem, type StateDraft } from './shared/draft';
import { sumCentavos } from './shared/money';
import { err, ok, type Result } from './shared/result';
import { allocateCode } from './numbering';


export function createJournalDraft(
  draft: StateDraft,
  ctx: WriteContext,
  input: Extract<DomainCommand, { type: 'journalDraft.create' }>['input'],
): Result<CommandResult> {
  const product = requireProduct(ctx, 'accounting');
  if (!product.ok) return product;
  const role = requireRole(ctx, 'accountant', 'ap_ar_clerk', 'company_admin');
  if (!role.ok) return role;
  const date = parseDateOnly(input.journalDate, 'journalDate');
  if (!date.ok) return date;
  if (input.memo.trim().length === 0) return err('VALIDATION', 'A journal memo is required.', 'memo');
  if (input.lines.length < 2) return err('VALIDATION', 'A journal needs at least two lines.', 'lines');
  let debitTotal = 0;
  let creditTotal = 0;
  for (const [index, line] of input.lines.entries()) {
    const account = ctx.state.accounts.find(
      (candidate) => candidate.id === line.accountId && candidate.workspaceId === ctx.workspaceId && candidate.active,
    );
    if (!account) return err('VALIDATION', `Line ${index + 1} account is not active in this workspace.`, 'lines');
    if (!Number.isSafeInteger(line.debitCentavos) || !Number.isSafeInteger(line.creditCentavos)) {
      return err('VALIDATION', `Line ${index + 1} amounts must be integer centavos.`, 'lines');
    }
    if (line.debitCentavos < 0 || line.creditCentavos < 0) {
      return err('VALIDATION', `Line ${index + 1} amounts cannot be negative.`, 'lines');
    }
    if (line.debitCentavos > 0 && line.creditCentavos > 0) {
      return err('VALIDATION', `Line ${index + 1} cannot be both debit and credit.`, 'lines');
    }
    if (line.debitCentavos === 0 && line.creditCentavos === 0) {
      return err('VALIDATION', `Line ${index + 1} has no amount.`, 'lines');
    }
    debitTotal += line.debitCentavos;
    creditTotal += line.creditCentavos;
  }
  if (debitTotal !== creditTotal) {
    return err(
      'VALIDATION',
      `Journal draft is not balanced: debits ${debitTotal} ≠ credits ${creditTotal} centavos.`,
    );
  }
  const draftNo = allocateCode(draft, ctx.workspaceId, 'journal_draft');
  if (!draftNo.ok) return draftNo;
  const journalDraft: JournalDraft = {
    id: ctx.clock.newId('jvd'),
    workspaceId: ctx.workspaceId,
    draftNo: draftNo.value,
    journalDate: input.journalDate,
    memo: input.memo.trim(),
    lines: input.lines.map((line) => ({ ...line })),
    status: 'draft',
    createdBy: ctx.actorId,
    createdAt: ctx.clock.nowIso,
    approvedBy: null,
    approvedAt: null,
    rejectionReason: null,
    journalId: null,
  };
  pushItem(draft, 'journalDrafts', journalDraft);
  recordAudit(draft, ctx, {
    action: 'journalDraft.create',
    recordType: 'journal_draft',
    recordId: journalDraft.id,
    detail: { draftNo: journalDraft.draftNo, totalCentavos: debitTotal },
  });
  return ok({
    summary: `Journal draft ${journalDraft.draftNo} created; a second user must approve it.`,
    documentType: 'journal_draft',
    documentId: journalDraft.id,
    journalIds: [],
    warnings: [],
  });
}

export function approveJournalDraft(
  draft: StateDraft,
  ctx: WriteContext,
  input: { draftId: string },
): Result<CommandResult> {
  const role = requireRole(ctx, 'accountant', 'company_admin');
  if (!role.ok) return role;
  const journalDraft = ctx.state.journalDrafts.find(
    (candidate) => candidate.id === input.draftId && candidate.workspaceId === ctx.workspaceId,
  );
  if (!journalDraft) return err('NOT_FOUND', 'Journal draft not found in this workspace.');
  if (journalDraft.status !== 'draft') {
    return err('CONFLICT', `Journal draft is already ${journalDraft.status}.`);
  }
  if (journalDraft.createdBy === ctx.actorId) {
    return err('FORBIDDEN', 'Journal maker and approver must be different users.');
  }
  updateItem(
    draft,
    'journalDrafts',
    (candidate) => candidate.id === journalDraft.id,
    (candidate) => ({ ...candidate, status: 'approved', approvedBy: ctx.actorId, approvedAt: ctx.clock.nowIso }),
  );
  recordAudit(draft, ctx, {
    action: 'journalDraft.approve',
    recordType: 'journal_draft',
    recordId: journalDraft.id,
    detail: { draftNo: journalDraft.draftNo },
  });
  return ok({
    summary: `Journal draft ${journalDraft.draftNo} approved.`,
    documentType: 'journal_draft',
    documentId: journalDraft.id,
    journalIds: [],
    warnings: [],
  });
}

export function postJournalDraft(
  draft: StateDraft,
  ctx: WriteContext,
  input: { draftId: string },
): Result<CommandResult> {
  const product = requireProduct(ctx, 'accounting');
  if (!product.ok) return product;
  const role = requireRole(ctx, 'accountant', 'company_admin');
  if (!role.ok) return role;
  const journalDraft = ctx.state.journalDrafts.find(
    (candidate) => candidate.id === input.draftId && candidate.workspaceId === ctx.workspaceId,
  );
  if (!journalDraft) return err('NOT_FOUND', 'Journal draft not found in this workspace.');
  if (journalDraft.status !== 'approved') {
    return err('CONFLICT', 'Journal draft must be approved by a different user before posting.');
  }
  const journal = postJournal(draft, ctx, {
    postingDate: journalDraft.journalDate,
    documentDate: journalDraft.journalDate,
    sourceType: 'journal_draft',
    sourceId: journalDraft.id,
    effectKey: `journal-draft:${journalDraft.id}`,
    memo: journalDraft.memo,
    lines: journalDraft.lines.map((line) => ({ ...line })),
    approvedBy: journalDraft.approvedBy,
  });
  if (!journal.ok) return journal;
  updateItem(
    draft,
    'journalDrafts',
    (candidate) => candidate.id === journalDraft.id,
    (candidate) => ({ ...candidate, status: 'posted', journalId: journal.value.id }),
  );
  recordAudit(draft, ctx, {
    action: 'journalDraft.post',
    recordType: 'journal_draft',
    recordId: journalDraft.id,
    detail: { journalId: journal.value.id },
  });
  return ok({
    summary: `Journal draft ${journalDraft.draftNo} posted as ${journal.value.journalNo}.`,
    documentType: 'journal_draft',
    documentId: journalDraft.id,
    journalIds: [journal.value.id],
    warnings: [],
  });
}

export function rejectJournalDraft(
  draft: StateDraft,
  ctx: WriteContext,
  input: { draftId: string; reason: string },
): Result<CommandResult> {
  const role = requireRole(ctx, 'accountant', 'company_admin');
  if (!role.ok) return role;
  const journalDraft = ctx.state.journalDrafts.find(
    (candidate) => candidate.id === input.draftId && candidate.workspaceId === ctx.workspaceId,
  );
  if (!journalDraft) return err('NOT_FOUND', 'Journal draft not found in this workspace.');
  if (journalDraft.status !== 'draft' && journalDraft.status !== 'approved') {
    return err('CONFLICT', `Journal draft is already ${journalDraft.status}.`);
  }
  if (journalDraft.createdBy === ctx.actorId) {
    return err('FORBIDDEN', 'Journal maker and reviewer must be different users.');
  }
  if (input.reason.trim().length < 3) return err('VALIDATION', 'A rejection reason is required.', 'reason');
  updateItem(
    draft,
    'journalDrafts',
    (candidate) => candidate.id === journalDraft.id,
    (candidate) => ({ ...candidate, status: 'rejected', rejectionReason: input.reason }),
  );
  recordAudit(draft, ctx, {
    action: 'journalDraft.reject',
    recordType: 'journal_draft',
    recordId: journalDraft.id,
    reason: input.reason,
  });
  return ok({
    summary: `Journal draft ${journalDraft.draftNo} rejected.`,
    documentType: 'journal_draft',
    documentId: journalDraft.id,
    journalIds: [],
    warnings: [],
  });
}

export function reversePostedJournal(
  draft: StateDraft,
  ctx: WriteContext,
  input: { journalId: string; reversalDate: string; reason: string },
): Result<CommandResult> {
  const role = requireRole(ctx, 'accountant', 'company_admin');
  if (!role.ok) return role;
  const journal = ctx.state.journals.find(
    (candidate) => candidate.id === input.journalId && candidate.workspaceId === ctx.workspaceId,
  );
  if (!journal) return err('NOT_FOUND', 'Journal not found in this workspace.');
  const reversal = reverseJournal(draft, ctx, journal.id, input.reversalDate, input.reason);
  if (!reversal.ok) return reversal;
  return ok({
    summary: `Journal ${journal.journalNo} reversed; the original entry remains visible.`,
    documentType: 'journal',
    documentId: journal.id,
    journalIds: [reversal.value.id],
    warnings: [],
  });
}

function periodFor(
  state: WriteContext['state'],
  workspaceId: string,
  year: number,
  month: number,
): Period | undefined {
  return state.periods.find(
    (period) => period.workspaceId === workspaceId && period.year === year && period.month === month,
  );
}

export function closePeriod(
  draft: StateDraft,
  ctx: WriteContext,
  input: { year: number; month: number; reason: string },
): Result<CommandResult> {
  const product = requireProduct(ctx, 'accounting');
  if (!product.ok) return product;
  const role = requireRole(ctx, 'accountant', 'company_admin');
  if (!role.ok) return role;
  const period = periodFor(ctx.state, ctx.workspaceId, input.year, input.month);
  if (!period) return err('NOT_FOUND', 'That accounting period does not exist in this workspace.');
  if (period.status === 'closed') return err('CONFLICT', 'The period is already closed.');
  if (input.reason.trim().length < 3) return err('VALIDATION', 'A close reason is required.', 'reason');
  updateItem(
    draft,
    'periods',
    (candidate) => candidate.id === period.id,
    (candidate) => ({
      ...candidate,
      status: 'closed',
      closedBy: ctx.actorId,
      closedAt: ctx.clock.nowIso,
      closeReason: input.reason,
    }),
  );
  recordAudit(draft, ctx, {
    action: 'period.close',
    recordType: 'period',
    recordId: period.id,
    reason: input.reason,
    detail: { year: input.year, month: input.month },
  });
  return ok({
    summary: `Period ${input.year}-${String(input.month).padStart(2, '0')} closed.`,
    documentType: 'period',
    documentId: period.id,
    journalIds: [],
    warnings: [],
  });
}

export function reopenPeriod(
  draft: StateDraft,
  ctx: WriteContext,
  input: { year: number; month: number; reason: string },
): Result<CommandResult> {
  const role = requireRole(ctx, 'company_admin');
  if (!role.ok) return role;
  const period = periodFor(ctx.state, ctx.workspaceId, input.year, input.month);
  if (!period) return err('NOT_FOUND', 'That accounting period does not exist in this workspace.');
  if (period.status === 'open') return err('CONFLICT', 'The period is already open.');
  if (input.reason.trim().length < 3) return err('VALIDATION', 'A reopen reason is required.', 'reason');
  updateItem(
    draft,
    'periods',
    (candidate) => candidate.id === period.id,
    (candidate) => ({
      ...candidate,
      status: 'open',
      reopenedBy: ctx.actorId,
      reopenedAt: ctx.clock.nowIso,
      reopenReason: input.reason,
    }),
  );
  recordAudit(draft, ctx, {
    action: 'period.reopen',
    recordType: 'period',
    recordId: period.id,
    reason: input.reason,
    detail: { year: input.year, month: input.month },
  });
  return ok({
    summary: `Period ${input.year}-${String(input.month).padStart(2, '0')} reopened with an audit reason.`,
    documentType: 'period',
    documentId: period.id,
    journalIds: [],
    warnings: [],
  });
}

export function createFinalWithholding(
  draft: StateDraft,
  ctx: WriteContext,
  input: Extract<DomainCommand, { type: 'taxRecord.createFinalWithholding' }>['input'],
): Result<CommandResult> {
  const product = requireProduct(ctx, 'accounting');
  if (!product.ok) return product;
  const role = requireRole(ctx, 'accountant', 'company_admin');
  if (!role.ok) return role;
  const vendor = ctx.state.contacts.find(
    (contact) => contact.id === input.partyContactId && contact.workspaceId === ctx.workspaceId && contact.active,
  );
  if (!vendor) return err('VALIDATION', 'Select an active payee contact.', 'partyContactId');
  const date = parseDateOnly(input.taxDate, 'taxDate');
  if (!date.ok) return date;
  if (!Number.isSafeInteger(input.baseCentavos) || input.baseCentavos <= 0) {
    return err('VALIDATION', 'Withholding base must be greater than zero.', 'baseCentavos');
  }
  if (!Number.isSafeInteger(input.taxCentavos) || input.taxCentavos <= 0) {
    return err('VALIDATION', 'Final tax must be greater than zero.', 'taxCentavos');
  }
  if (input.description.trim().length === 0) return err('VALIDATION', 'A description is required.', 'description');
  const id = ctx.clock.newId('tax');
  const taxNo = allocateCode(draft, ctx.workspaceId, 'tax_record');
  if (!taxNo.ok) return taxNo;
  pushItem(draft, 'taxRecords', {
    id,
    workspaceId: ctx.workspaceId,
    publicNo: taxNo.value,
    type: 'fwt_final',
    sourceType: 'manual_final_withholding',
    sourceId: id,
    taxDate: input.taxDate,
    partyContactId: vendor.id,
    baseCentavos: input.baseCentavos,
    taxCentavos: input.taxCentavos,
    direction: 'final',
    certificateStatus: 'not_required',
    certificateId: null,
    description: input.description.trim(),
  });
  recordAudit(draft, ctx, {
    action: 'taxRecord.finalWithholding',
    recordType: 'tax_record',
    recordId: id,
    detail: { baseCentavos: input.baseCentavos, taxCentavos: input.taxCentavos },
  });
  return ok({
    summary: `Final withholding record saved; it is not a Form 2307 entry.`,
    documentType: 'tax_record',
    documentId: id,
    journalIds: [],
    warnings: ['Final withholding is reported separately and never added to the creditable 2307 register.'],
  });
}

export function createCertificate2307(
  draft: StateDraft,
  ctx: WriteContext,
  input: Extract<DomainCommand, { type: 'certificate2307.create' }>['input'],
): Result<CommandResult> {
  const product = requireProduct(ctx, 'accounting');
  if (!product.ok) return product;
  const role = requireRole(ctx, 'accountant', 'company_admin');
  if (!role.ok) return role;
  const counterparty = ctx.state.contacts.find(
    (contact) => contact.id === input.counterpartyContactId && contact.workspaceId === ctx.workspaceId,
  );
  if (!counterparty) return err('VALIDATION', 'Counterparty is not in this workspace.', 'counterpartyContactId');
  const certificateDate = parseDateOnly(input.certificateDate, 'certificateDate');
  if (!certificateDate.ok) return certificateDate;
  const from = parseDateOnly(input.periodFrom, 'periodFrom');
  if (!from.ok) return from;
  const to = parseDateOnly(input.periodTo, 'periodTo');
  if (!to.ok) return to;
  if (input.periodTo < input.periodFrom) return err('VALIDATION', 'Certificate period is reversed.', 'periodTo');
  if (input.certificateNo.trim().length === 0) return err('VALIDATION', 'Certificate number is required.', 'certificateNo');
  if (input.sourceTaxRecordIds.length === 0) {
    return err('VALIDATION', 'Select at least one creditable withholding record.', 'sourceTaxRecordIds');
  }
  const records = input.sourceTaxRecordIds.map((recordId) =>
    ctx.state.taxRecords.find((record) => record.id === recordId && record.workspaceId === ctx.workspaceId),
  );
  for (const record of records) {
    if (!record) return err('NOT_FOUND', 'A selected withholding record does not exist.');
    if (record.type !== 'ewt_creditable') {
      return err('VALIDATION', 'Only creditable EWT records can appear on a 2307 certificate.', 'sourceTaxRecordIds');
    }
    if (record.partyContactId !== counterparty.id) {
      return err('VALIDATION', 'All selected records must belong to the chosen counterparty.', 'sourceTaxRecordIds');
    }
    if (record.certificateId !== null) {
      return err('CONFLICT', 'A selected withholding record is already on another certificate.', 'sourceTaxRecordIds');
    }
  }
  const creditable = sumCentavos(records.map((record) => record?.taxCentavos ?? 0));
  if (creditable <= 0) return err('VALIDATION', 'Selected records add up to no creditable tax.', 'sourceTaxRecordIds');
  const duplicate = ctx.state.certificates2307.some(
    (certificate) =>
      certificate.workspaceId === ctx.workspaceId &&
      certificate.direction === input.direction &&
      certificate.certificateNo.trim().toLowerCase() === input.certificateNo.trim().toLowerCase(),
  );
  if (duplicate) return err('DUPLICATE_ROW', 'This certificate number already exists for the direction.', 'certificateNo');

  const id = ctx.clock.newId('cert');
  const certificate: Certificate2307 = {
    id,
    workspaceId: ctx.workspaceId,
    direction: input.direction,
    counterpartyContactId: counterparty.id,
    certificateNo: input.certificateNo.trim(),
    certificateDate: input.certificateDate,
    periodFrom: input.periodFrom,
    periodTo: input.periodTo,
    creditableTaxCentavos: creditable,
    sourceTaxRecordIds: [...input.sourceTaxRecordIds],
    status: input.direction === 'issued' ? 'issued' : 'received',
    createdBy: ctx.actorId,
    createdAt: ctx.clock.nowIso,
  };
  pushItem(draft, 'certificates2307', certificate);
  for (const recordId of input.sourceTaxRecordIds) {
    updateItem(
      draft,
      'taxRecords',
      (candidate) => candidate.id === recordId,
      (candidate) => ({
        ...candidate,
        certificateStatus: input.direction === 'issued' ? 'issued' : 'received',
        certificateId: id,
      }),
    );
  }
  recordAudit(draft, ctx, {
    action: 'certificate2307.create',
    recordType: 'certificate_2307',
    recordId: id,
    detail: { certificateNo: certificate.certificateNo, creditable, sourceCount: input.sourceTaxRecordIds.length },
  });
  return ok({
    summary: `Certificate ${certificate.certificateNo} recorded for ${creditable} centavos of creditable withholding.`,
    documentType: 'certificate_2307',
    documentId: id,
    journalIds: [],
    warnings: ['This is a register entry in a synthetic mockup; nothing is filed with the BIR.'],
  });
}

export function journalForPeriodOpen(state: WriteContext['state'], workspaceId: string, date: string): boolean {
  return findPeriod(state, workspaceId, date)?.status === 'open';
}
