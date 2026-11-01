import type { CommandResult, DomainCommand } from './commandTypes';
import { masterRecords } from './masterCodes';
import { postJournal, recordAudit, type WriteContext } from './ledger';
import type { Account, Contact, Item, ProductCode, Role } from './schema';
import { requireAccountByRole, requireProduct, requireRole } from './shared/access';
import { parseDateOnly, todayInManila } from './shared/dates';
import { pushItem, updateItem, type StateDraft } from './shared/draft';
import { sumCentavos } from './shared/money';
import { err, ok, type Result } from './shared/result';
import {
  allocateCode,
  allocateMasterCode,
  isMasterKind,
  normalizeCode,
  numberingDefinition,
  numberingPolicy,
  updateNumberingPolicy,
} from './numbering';

const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'] as const;

export function createContact(
  draft: StateDraft,
  ctx: WriteContext,
  input: Extract<DomainCommand, { type: 'contact.create' }>['input'],
): Result<CommandResult> {
  const product = requireProduct(ctx, 'accounting');
  if (!product.ok) return product;
  const role = requireRole(ctx, 'accountant', 'ap_ar_clerk', 'company_admin');
  if (!role.ok) return role;
  if (input.name.trim().length === 0) return err('VALIDATION', 'Contact name is required.', 'name');
  if (input.roles.length === 0) return err('VALIDATION', 'Choose at least one contact role.', 'roles');
  const duplicate = ctx.state.contacts.some(
    (contact) =>
      contact.workspaceId === ctx.workspaceId &&
      contact.name.trim().toLowerCase() === input.name.trim().toLowerCase() &&
      contact.tin.trim() === input.tin.trim(),
  );
  if (duplicate) return err('DUPLICATE_ROW', 'A contact with this name and TIN already exists.', 'name');
  const contactNo = allocateCode(draft, ctx.workspaceId, 'contact');
  if (!contactNo.ok) return contactNo;
  const contact: Contact = {
    id: ctx.clock.newId('contact'),
    workspaceId: ctx.workspaceId,
    contactNo: contactNo.value,
    name: input.name.trim(),
    tin: input.tin.trim(),
    address: input.address.trim(),
    roles: [...input.roles],
    active: true,
  };
  pushItem(draft, 'contacts', contact);
  recordAudit(draft, ctx, {
    action: 'contact.create',
    recordType: 'contact',
    recordId: contact.id,
    detail: { name: contact.name, roles: contact.roles.join(',') },
  });
  return ok({
    summary: `Contact ${contact.name} created.`,
    documentType: 'contact',
    documentId: contact.id,
    journalIds: [],
    warnings: [],
  });
}

export function updateContact(
  draft: StateDraft,
  ctx: WriteContext,
  input: Extract<DomainCommand, { type: 'contact.update' }>['input'],
): Result<CommandResult> {
  const role = requireRole(ctx, 'accountant', 'ap_ar_clerk', 'company_admin');
  if (!role.ok) return role;
  const contact = ctx.state.contacts.find(
    (candidate) => candidate.id === input.contactId && candidate.workspaceId === ctx.workspaceId,
  );
  if (!contact) return err('NOT_FOUND', 'Contact not found in this workspace.');
  if (input.name.trim().length === 0) return err('VALIDATION', 'Contact name is required.', 'name');
  if (input.roles.length === 0) return err('VALIDATION', 'Choose at least one contact role.', 'roles');
  updateItem(
    draft,
    'contacts',
    (candidate) => candidate.id === contact.id,
    (candidate) => ({
      ...candidate,
      name: input.name.trim(),
      tin: input.tin.trim(),
      address: input.address.trim(),
      roles: [...input.roles],
      active: input.active,
    }),
  );
  recordAudit(draft, ctx, { action: 'contact.update', recordType: 'contact', recordId: contact.id });
  return ok({
    summary: `Contact ${input.name.trim()} updated.`,
    documentType: 'contact',
    documentId: contact.id,
    journalIds: [],
    warnings: [],
  });
}

export function createAccount(
  draft: StateDraft,
  ctx: WriteContext,
  input: Extract<DomainCommand, { type: 'account.create' }>['input'],
): Result<CommandResult> {
  const product = requireProduct(ctx, 'accounting');
  if (!product.ok) return product;
  const role = requireRole(ctx, 'accountant', 'company_admin');
  if (!role.ok) return role;
  if (input.name.trim().length === 0) return err('VALIDATION', 'Account name is required.', 'name');
  if (!ACCOUNT_TYPES.includes(input.type as (typeof ACCOUNT_TYPES)[number])) {
    return err('VALIDATION', 'Unknown account type.', 'type');
  }
  const accountCode = allocateMasterCode(draft, ctx.workspaceId, 'account', input.code);
  if (!accountCode.ok) return accountCode;
  const duplicate = ctx.state.accounts.some(
    (account) =>
      account.workspaceId === ctx.workspaceId &&
      normalizeCode(account.code) === normalizeCode(accountCode.value),
  );
  if (duplicate) return err('DUPLICATE_ROW', 'An account with this code already exists.', 'code');
  const account: Account = {
    id: ctx.clock.newId('acc'),
    workspaceId: ctx.workspaceId,
    code: accountCode.value.trim(),
    name: input.name.trim(),
    type: input.type as Account['type'],
    normalBalance: input.normalBalance,
    controlRole: null,
    active: true,
  };
  pushItem(draft, 'accounts', account);
  recordAudit(draft, ctx, { action: 'account.create', recordType: 'account', recordId: account.id });
  return ok({
    summary: `Account ${account.code} ${account.name} created.`,
    documentType: 'account',
    documentId: account.id,
    journalIds: [],
    warnings: ['New accounts start without a control role; automatic postings need an existing mapping.'],
  });
}

export function updateNumbering(
  draft: StateDraft,
  ctx: WriteContext,
  input: Extract<DomainCommand, { type: 'numbering.policyUpdate' }>['input'],
): Result<CommandResult> {
  const definition = numberingDefinition(input.kind);
  const product = requireProduct(ctx, definition.product);
  if (!product.ok) return product;
  const role =
    definition.product === 'payroll'
      ? requireRole(ctx, 'company_admin', 'payroll_officer')
      : definition.product === 'inventory'
        ? requireRole(ctx, 'company_admin', 'inventory_officer')
        : requireRole(ctx, 'company_admin', 'accountant');
  if (!role.ok) return role;
  const before = numberingPolicy(draft.state, ctx.workspaceId, input.kind);
  const beforeMasters = isMasterKind(input.kind) ? masterRecords(draft.state, ctx.workspaceId, input.kind) : [];
  const updated = updateNumberingPolicy(
    draft,
    ctx.workspaceId,
    input.kind,
    input,
    ctx.actorId,
    ctx.clock.nowIso,
    input.reason,
  );
  if (!updated.ok) return updated;
  recordAudit(draft, ctx, {
    action: 'numbering.policyUpdate',
    recordType: 'numbering_policy',
    recordId: updated.value.id,
    reason: input.reason.trim(),
    detail: {
      kind: input.kind,
      masterCodeChanges: JSON.stringify(isMasterKind(input.kind) ? masterRecords(draft.state, ctx.workspaceId, input.kind).filter((row) => row.code !== beforeMasters.find((old) => old.id === row.id)?.code).map((row) => ({ id: row.id, previousCode: beforeMasters.find((old) => old.id === row.id)?.code ?? '', code: row.code })) : []),
      previousPrefix: before.prefix,
      previousNextNumber: before.nextNumber,
      prefix: updated.value.prefix,
      nextNumber: updated.value.nextNumber,
      minDigits: updated.value.minDigits,
      increment: updated.value.increment,
    },
  });
  return ok({
    summary: `${definition.label} numbering policy applied. Next code: ${updated.value.prefix}${String(updated.value.nextNumber).padStart(updated.value.minDigits, '0')}.`,
    documentType: 'numbering_policy',
    documentId: updated.value.id,
    journalIds: [],
    warnings: [isMasterKind(input.kind) ? 'Current master codes now follow this policy. Internal IDs and posted document snapshots are preserved.' : 'Document numbers already issued stay unchanged.'],
  });
}

export function updateMembership(
  draft: StateDraft,
  ctx: WriteContext,
  input: Extract<DomainCommand, { type: 'membership.update' }>['input'],
): Result<CommandResult> {
  const role = requireRole(ctx, 'company_admin');
  if (!role.ok) return role;
  const user = ctx.state.users.find((candidate) => candidate.id === input.userId);
  if (!user) return err('NOT_FOUND', 'User not found.');
  const membership = ctx.state.memberships.find(
    (candidate) => candidate.userId === input.userId && candidate.workspaceId === ctx.workspaceId,
  );
  if (!membership) return err('NOT_FOUND', 'This user has no membership in the workspace.');
  if (input.userId === ctx.actorId && (!input.active || !input.roles.includes('company_admin'))) {
    return err('FORBIDDEN', 'You cannot remove your own active company-admin access.');
  }
  if (input.roles.length === 0) return err('VALIDATION', 'A member needs at least one role.', 'roles');
  const seats = ctx.state.seats.filter((seat) => seat.workspaceId === ctx.workspaceId);
  const seat = seats.find((candidate) => candidate.id === membership.seatId);
  if (!input.active && seat) {
    updateItem(draft, 'seats', (candidate) => candidate.id === seat.id, (candidate) => ({ ...candidate, assignedUserId: null }));
  }
  updateItem(
    draft,
    'memberships',
    (candidate) => candidate.userId === input.userId && candidate.workspaceId === ctx.workspaceId,
    (candidate) => ({
      ...candidate,
      roles: [...input.roles],
      payrollDetail: input.payrollDetail,
      archiveGrant: input.archiveGrant,
      active: input.active,
    }),
  );
  recordAudit(draft, ctx, {
    action: 'membership.update',
    recordType: 'membership',
    recordId: input.userId,
    detail: {
      roles: input.roles.join(','),
      payrollDetail: input.payrollDetail,
      archiveGrant: input.archiveGrant,
      active: input.active,
    },
  });
  return ok({
    summary: `${user.name}'s roles and grants updated.`,
    documentType: 'membership',
    documentId: input.userId,
    journalIds: [],
    warnings: ['Browser-local role checks are a mockup simulation, not production tenant security.'],
  });
}

export function updateEntitlement(
  draft: StateDraft,
  ctx: WriteContext,
  input: Extract<DomainCommand, { type: 'entitlement.update' }>['input'],
): Result<CommandResult> {
  const role = requireRole(ctx, 'company_admin');
  if (!role.ok) return role;
  if (input.expiresOn !== null) {
    const parsed = parseDateOnly(input.expiresOn, 'expiresOn');
    if (!parsed.ok) return parsed;
  }
  const entitlement = ctx.workspace.entitlements[input.product];
  const activatedOn = input.active
    ? entitlement.activatedOn ?? ctx.today
    : entitlement.activatedOn;
  updateItem(
    draft,
    'workspaces',
    (workspace) => workspace.id === ctx.workspaceId,
    (workspace) => ({
      ...workspace,
      entitlements: {
        ...workspace.entitlements,
        [input.product]: {
          ...workspace.entitlements[input.product],
          active: input.active,
          activatedOn,
          expiresOn: input.active ? input.expiresOn : workspace.entitlements[input.product].expiresOn,
        },
      },
    }),
  );
  recordAudit(draft, ctx, {
    action: 'entitlement.update',
    recordType: 'entitlement',
    recordId: `${ctx.workspaceId}:${input.product}`,
    detail: { product: input.product, active: input.active, expiresOn: input.expiresOn ?? 'none' },
  });
  return ok({
    summary: `${input.product} entitlement ${input.active ? 'enabled' : 'disabled'} for this workspace.`,
    documentType: 'entitlement',
    documentId: `${ctx.workspaceId}:${input.product}`,
    journalIds: [],
    warnings: [],
  });
}

export function setMaintenance(
  draft: StateDraft,
  ctx: WriteContext,
  input: Extract<DomainCommand, { type: 'maintenance.set' }>['input'],
): Result<CommandResult> {
  const role = requireRole(ctx, 'company_admin');
  if (!role.ok) return role;
  if (input.active === ctx.workspace.settings.maintenance.active) {
    return err('CONFLICT', `Maintenance mode is already ${input.active ? 'active' : 'off'}.`);
  }
  const windowLabel = input.windowLabel?.trim() || ctx.workspace.settings.maintenance.windowLabel;
  const maxDuration = input.maxDurationMinutes ?? ctx.workspace.settings.maintenance.maxDurationMinutes;
  if (!Number.isSafeInteger(maxDuration) || maxDuration <= 0) {
    return err('VALIDATION', 'Maximum duration must be a positive number of minutes.', 'maxDurationMinutes');
  }
  updateItem(
    draft,
    'workspaces',
    (workspace) => workspace.id === ctx.workspaceId,
    (workspace) => ({
      ...workspace,
      settings: {
        ...workspace.settings,
        maintenance: {
          ...workspace.settings.maintenance,
          active: input.active,
          windowLabel,
          scheduledFor: input.scheduledFor ?? workspace.settings.maintenance.scheduledFor,
          maxDurationMinutes: maxDuration,
          startedAt: input.active ? ctx.clock.nowIso : workspace.settings.maintenance.startedAt,
          startedBy: input.active ? ctx.actorId : workspace.settings.maintenance.startedBy,
          endedAt: input.active ? null : ctx.clock.nowIso,
          endedBy: input.active ? null : ctx.actorId,
          completionNote: input.active ? '' : input.note?.trim() || 'Maintenance mode ended.',
        },
      },
    }),
  );
  recordAudit(draft, ctx, {
    action: input.active ? 'maintenance.start' : 'maintenance.end',
    recordType: 'workspace',
    recordId: ctx.workspaceId,
    reason: input.note ?? null,
    detail: { windowLabel, maxDurationMinutes: maxDuration },
  });
  return ok({
    summary: input.active
      ? 'Maintenance mode enabled; ordinary writes are blocked, authorized export remains available.'
      : 'Maintenance mode ended.',
    documentType: 'workspace',
    documentId: ctx.workspaceId,
    journalIds: [],
    warnings: [],
  });
}

export function activateAccounting(
  draft: StateDraft,
  ctx: WriteContext,
  input: Extract<DomainCommand, { type: 'workspace.activateAccounting' }>['input'],
): Result<CommandResult> {
  const role = requireRole(ctx, 'company_admin');
  if (!role.ok) return role;
  const cutover = ctx.workspace.settings.cutover;
  if (!cutover) return err('INVALID_STATE', 'This workspace has no standalone cutover proposal.');
  if (cutover.status === 'activated') return err('CONFLICT', 'Accounting is already activated for this workspace.');
  const date = parseDateOnly(input.cutoverDate, 'cutoverDate');
  if (!date.ok) return date;
  if (input.reason.trim().length < 3) return err('VALIDATION', 'An activation reason is required.', 'reason');
  if (input.confirmOpeningValueCentavos !== cutover.inventoryOpeningValueCentavos) {
    return err(
      'AMOUNT_MISMATCH',
      `Confirm the approved opening value of ${cutover.inventoryOpeningValueCentavos} centavos exactly.`,
      'confirmOpeningValueCentavos',
    );
  }
  updateItem(
    draft,
    'workspaces',
    (workspace) => workspace.id === ctx.workspaceId,
    (workspace) => ({
      ...workspace,
      entitlements: {
        ...workspace.entitlements,
        accounting: {
          active: true,
          activatedOn: input.cutoverDate,
          expiresOn: workspace.entitlements.accounting.expiresOn,
        },
      },
      settings: {
        ...workspace.settings,
        cutover: {
          ...cutover,
          approvedDate: input.cutoverDate,
          approvedBy: ctx.actorId,
          status: 'activated',
          notes: `${cutover.notes} Activation reason: ${input.reason.trim()}`,
        },
      },
    }),
  );
  recordAudit(draft, ctx, {
    action: 'workspace.activateAccounting',
    recordType: 'workspace',
    recordId: ctx.workspaceId,
    reason: input.reason,
    detail: {
      cutoverDate: input.cutoverDate,
      openingValueCentavos: cutover.inventoryOpeningValueCentavos,
      historicalMovementsRetained: ctx.state.movements.filter((movement) => movement.workspaceId === ctx.workspaceId).length,
    },
  });
  return ok({
    summary: `Accounting activated at ${input.cutoverDate}; historical inventory source references are retained without replay.`,
    documentType: 'workspace',
    documentId: ctx.workspaceId,
    journalIds: [],
    warnings: [
      'Opening value must already be included in Accounting openings; this action does not post it a second time.',
    ],
  });
}

export function importMasters(
  draft: StateDraft,
  ctx: WriteContext,
  input: Extract<DomainCommand, { type: 'masters.import' }>['input'],
): Result<CommandResult> {
  const product = requireProduct(ctx, 'accounting');
  // Approved standalone onboarding may import its reconciled openings before
  // Accounting is activated; this is the only pre-activation Accounting write.
  if (!product.ok && ctx.workspace.settings.cutover?.status !== 'proposed') return product;
  const role = requireRole(ctx, 'accountant', 'company_admin');
  if (!role.ok) return role;
  if (input.approvalNote.trim().length < 3) {
    return err('VALIDATION', 'An approval note is required for a master/opening import.', 'approvalNote');
  }
  const date = parseDateOnly(input.postingDate, 'postingDate');
  if (!date.ok) return date;

  const existingOpening = ctx.state.journals.find(
    (journal) =>
      journal.workspaceId === ctx.workspaceId &&
      (journal.sourceType === 'opening' || journal.sourceType === 'opening_import'),
  );
  if (input.openings.length > 0 && existingOpening) {
    return err(
      'DUPLICATE_EFFECT',
      `Opening balances already exist (${existingOpening.journalNo}); importing them again would double-count equity and assets.`,
    );
  }

  for (const contact of input.contacts) {
    if (contact.name.trim().length === 0) return err('VALIDATION', 'Every imported contact needs a name.', 'contacts');
    if (contact.roles.length === 0) return err('VALIDATION', `Contact ${contact.name} needs a role.`, 'contacts');
    const duplicate = ctx.state.contacts.some(
      (candidate) =>
        candidate.workspaceId === ctx.workspaceId &&
        candidate.name.trim().toLowerCase() === contact.name.trim().toLowerCase(),
    );
    if (duplicate) return err('DUPLICATE_ROW', `Contact ${contact.name} already exists.`, 'contacts');
  }
  for (const item of input.items) {
    if (item.sku.trim().length === 0 || item.name.trim().length === 0 || item.baseUnit.trim().length === 0) {
      return err('VALIDATION', 'Every imported item needs SKU, name, and base unit.', 'items');
    }
    const duplicate = ctx.state.items.some(
      (candidate) =>
        candidate.workspaceId === ctx.workspaceId &&
        candidate.sku.toLowerCase() === item.sku.trim().toLowerCase(),
    );
    if (duplicate) return err('DUPLICATE_ROW', `Item ${item.sku} already exists.`, 'items');
  }

  let debitTotal = 0;
  let creditTotal = 0;
  for (const [index, line] of input.openings.entries()) {
    const account = ctx.state.accounts.find(
      (candidate) => candidate.id === line.accountId && candidate.workspaceId === ctx.workspaceId && candidate.active,
    );
    if (!account) return err('VALIDATION', `Opening line ${index + 1} account is not in this workspace.`, 'openings');
    if (!Number.isSafeInteger(line.debitCentavos) || !Number.isSafeInteger(line.creditCentavos)) {
      return err('VALIDATION', `Opening line ${index + 1} must be integer centavos.`, 'openings');
    }
    if (line.debitCentavos < 0 || line.creditCentavos < 0) {
      return err('VALIDATION', `Opening line ${index + 1} cannot be negative.`, 'openings');
    }
    if (line.debitCentavos > 0 && line.creditCentavos > 0) {
      return err('VALIDATION', `Opening line ${index + 1} cannot be both debit and credit.`, 'openings');
    }
    debitTotal += line.debitCentavos;
    creditTotal += line.creditCentavos;
  }
  if (input.openings.length > 0 && debitTotal !== creditTotal) {
    return err('VALIDATION', `Opening balances do not balance (${debitTotal} ≠ ${creditTotal}).`, 'openings');
  }
  if (input.openings.length > 0 && debitTotal === 0) {
    return err('VALIDATION', 'Opening balances are zero.', 'openings');
  }

  const inventoryAccount = requireAccountByRole(ctx.state, ctx.workspaceId, 'inventory');
  if (!inventoryAccount.ok) return inventoryAccount;
  const cogsAccount = requireAccountByRole(ctx.state, ctx.workspaceId, 'cogs');
  if (!cogsAccount.ok) return cogsAccount;

  for (const contact of input.contacts) {
    const contactNo = allocateCode(draft, ctx.workspaceId, 'contact');
    if (!contactNo.ok) return contactNo;
    pushItem(draft, 'contacts', {
      id: ctx.clock.newId('contact'),
      workspaceId: ctx.workspaceId,
      contactNo: contactNo.value,
      name: contact.name.trim(),
      tin: contact.tin.trim(),
      address: contact.address.trim(),
      roles: [...contact.roles],
      active: true,
    });
  }
  for (const item of input.items) {
    const itemNo = allocateCode(draft, ctx.workspaceId, 'item');
    if (!itemNo.ok) return itemNo;
    pushItem(draft, 'items', {
      id: ctx.clock.newId('item'),
      workspaceId: ctx.workspaceId,
      itemNo: itemNo.value,
      sku: item.sku.trim(),
      name: item.name.trim(),
      baseUnit: item.baseUnit.trim(),
      inventoryAccountId: inventoryAccount.value.id,
      cogsAccountId: cogsAccount.value.id,
      active: true,
    });
  }
  const journalIds: string[] = [];
  if (input.openings.length > 0) {
    const batchId = ctx.clock.newId('openings');
    const journal = postJournal(draft, ctx, {
      postingDate: input.postingDate,
      documentDate: input.postingDate,
      sourceType: 'opening_import',
      sourceId: batchId,
      effectKey: `opening-import:${batchId}`,
      memo: `Approved opening balances — ${input.approvalNote.trim()}`,
      lines: input.openings.map((line) => ({
        accountId: line.accountId,
        debitCentavos: line.debitCentavos,
        creditCentavos: line.creditCentavos,
      })),
      approvedBy: ctx.actorId,
    });
    if (!journal.ok) return journal;
    journalIds.push(journal.value.id);
  }
  recordAudit(draft, ctx, {
    action: 'masters.import',
    recordType: 'master_import',
    recordId: journalIds[0] ?? ctx.clock.newId('import'),
    reason: input.approvalNote,
    detail: { contacts: input.contacts.length, items: input.items.length, openings: input.openings.length },
  });
  return ok({
    summary: `Imported ${input.contacts.length} contact(s), ${input.items.length} item(s), ${input.openings.length} opening line(s).`,
    documentType: 'master_import',
    documentId: journalIds[0] ?? '',
    journalIds,
    warnings: [],
  });
}

export function toggleActiveProduct(
  draft: StateDraft,
  ctx: WriteContext,
  product: ProductCode,
  active: boolean,
): Result<CommandResult> {
  return updateEntitlement(draft, ctx, { product, active, expiresOn: null });
}

export function membershipRoles(
  state: WriteContext['state'],
  workspaceId: string,
  userId: string,
): Role[] {
  return state.memberships.find(
    (membership) => membership.workspaceId === workspaceId && membership.userId === userId,
  )?.roles ?? [];
}

export function mastersForWorkspace(state: WriteContext['state'], workspaceId: string): {
  contacts: Contact[];
  items: Item[];
} {
  return {
    contacts: state.contacts.filter((contact) => contact.workspaceId === workspaceId),
    items: state.items.filter((item) => item.workspaceId === workspaceId),
  };
}

export function defaultOpeningDate(): string {
  return todayInManila(new Date());
}

export function sumOpening(lines: WriteContext['state']['journals'][number]['lines']): {
  debit: number;
  credit: number;
} {
  return {
    debit: sumCentavos(lines.map((line) => line.debitCentavos)),
    credit: sumCentavos(lines.map((line) => line.creditCentavos)),
  };
}
