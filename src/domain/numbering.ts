/**
 * One per-company business-code registry and allocator.
 *
 * Public codes are display/search values only. Relationships, ledger mappings
 * and source effects keep using immutable internal IDs. Allocation updates the
 * command draft in place, so a failed command never consumes a code and a
 * compound command sees earlier allocations from the same draft.
 */
import type { AppState } from './schema';
import type { StateDraft } from './shared/draft';
import { err, ok, type Result } from './shared/result';
import { formatNumber, normalizeCode } from './shared/numberingFormat';
import { isMasterKind, masterCodeNumber, masterRecords, reconcileMasterCodes, type MasterKind } from './masterCodes';
export { formatNumber, normalizeCode } from './shared/numberingFormat';
export { MASTER_KINDS, isMasterKind, type MasterKind } from './masterCodes';

export const RECORD_KINDS = [
  'account',
  'contact',
  'employee',
  'item',
  'location',
  'asset',
  'bank_account',
  'invoice',
  'receipt',
  'credit_note',
  'refund',
  'purchase_order',
  'goods_receipt',
  'bill',
  'payment_request',
  'payment',
  'advance',
  'liquidation',
  'inventory_movement',
  'payroll_run',
  'payroll_worksheet',
  'journal',
  'journal_draft',
  'bank_statement',
  'tax_record',
] as const;

export type RecordKind = (typeof RECORD_KINDS)[number];

export interface NumberingPolicy {
  id: string;
  workspaceId: string;
  kind: RecordKind;
  prefix: string;
  startNumber: number;
  nextNumber: number;
  minDigits: number;
  increment: number;
  manualOverride: boolean;
  version: number;
  updatedBy: string;
  updatedAt: string;
  reason: string;
}

export interface NumberingKindDefinition {
  kind: RecordKind;
  label: string;
  prefix: string;
  startNumber: number;
  minDigits: number;
  increment: number;
  product: 'accounting' | 'payroll' | 'inventory';
}

export const NUMBERING_KINDS: readonly NumberingKindDefinition[] = [
  { kind: 'account', label: 'Accounts', prefix: 'A', startNumber: 100, minDigits: 0, increment: 1, product: 'accounting' },
  { kind: 'contact', label: 'Contacts', prefix: 'C', startNumber: 100, minDigits: 0, increment: 1, product: 'accounting' },
  { kind: 'employee', label: 'Employees', prefix: '', startNumber: 5000, minDigits: 0, increment: 1, product: 'payroll' },
  { kind: 'item', label: 'Inventory items', prefix: 'I', startNumber: 100, minDigits: 0, increment: 1, product: 'inventory' },
  { kind: 'location', label: 'Locations', prefix: 'L', startNumber: 100, minDigits: 0, increment: 1, product: 'inventory' },
  { kind: 'asset', label: 'Fixed assets', prefix: 'FA', startNumber: 100, minDigits: 0, increment: 1, product: 'accounting' },
  { kind: 'bank_account', label: 'Bank accounts', prefix: 'B', startNumber: 100, minDigits: 0, increment: 1, product: 'accounting' },
  { kind: 'invoice', label: 'Sales invoices', prefix: 'INV-', startNumber: 1, minDigits: 4, increment: 1, product: 'accounting' },
  { kind: 'receipt', label: 'Customer receipts', prefix: 'OR-', startNumber: 1, minDigits: 4, increment: 1, product: 'accounting' },
  { kind: 'credit_note', label: 'Credit notes', prefix: 'CN-', startNumber: 1, minDigits: 4, increment: 1, product: 'accounting' },
  { kind: 'refund', label: 'Refunds', prefix: 'RF-', startNumber: 1, minDigits: 4, increment: 1, product: 'accounting' },
  { kind: 'purchase_order', label: 'Purchase orders', prefix: 'PO-', startNumber: 1, minDigits: 4, increment: 1, product: 'accounting' },
  { kind: 'goods_receipt', label: 'Goods receipts', prefix: 'GR-', startNumber: 1, minDigits: 4, increment: 1, product: 'accounting' },
  { kind: 'bill', label: 'Supplier bills', prefix: 'BILL-', startNumber: 1, minDigits: 4, increment: 1, product: 'accounting' },
  { kind: 'payment_request', label: 'Payment requests', prefix: 'RFP-', startNumber: 1, minDigits: 4, increment: 1, product: 'accounting' },
  { kind: 'payment', label: 'Payments', prefix: 'PAY-', startNumber: 1, minDigits: 4, increment: 1, product: 'accounting' },
  { kind: 'advance', label: 'Employee advances', prefix: 'ADV-', startNumber: 1, minDigits: 4, increment: 1, product: 'accounting' },
  { kind: 'liquidation', label: 'Advance liquidations', prefix: 'LQ-', startNumber: 1, minDigits: 4, increment: 1, product: 'accounting' },
  { kind: 'inventory_movement', label: 'Inventory movements', prefix: 'MVT-', startNumber: 1, minDigits: 4, increment: 1, product: 'inventory' },
  { kind: 'payroll_run', label: 'Payroll runs', prefix: 'PR-', startNumber: 1, minDigits: 4, increment: 1, product: 'payroll' },
  { kind: 'payroll_worksheet', label: 'Payroll worksheets', prefix: 'WS-', startNumber: 1, minDigits: 4, increment: 1, product: 'payroll' },
  { kind: 'journal', label: 'General journals', prefix: 'JV-', startNumber: 1, minDigits: 5, increment: 1, product: 'accounting' },
  { kind: 'journal_draft', label: 'Journal drafts', prefix: 'JD-', startNumber: 1, minDigits: 4, increment: 1, product: 'accounting' },
  { kind: 'bank_statement', label: 'Bank statements', prefix: 'BS-', startNumber: 1, minDigits: 4, increment: 1, product: 'accounting' },
  { kind: 'tax_record', label: 'Tax register entries', prefix: 'TAX-', startNumber: 1, minDigits: 4, increment: 1, product: 'accounting' },
] as const;

const DEFINITION_BY_KIND = new Map<RecordKind, NumberingKindDefinition>(
  NUMBERING_KINDS.map((definition) => [definition.kind, definition]),
);

export function numberingDefinition(kind: RecordKind): NumberingKindDefinition {
  return DEFINITION_BY_KIND.get(kind)!;
}

export function isRecordKind(value: string): value is RecordKind {
  return DEFINITION_BY_KIND.has(value as RecordKind);
}

export function numberingPolicyId(workspaceId: string, kind: RecordKind): string {
  return `np-${workspaceId}-${kind}`;
}

export function defaultNumberingPolicy(workspaceId: string, kind: RecordKind): NumberingPolicy {
  const definition = numberingDefinition(kind);
  return {
    id: numberingPolicyId(workspaceId, kind),
    workspaceId,
    kind,
    prefix: definition.prefix,
    startNumber: definition.startNumber,
    nextNumber: definition.startNumber,
    minDigits: definition.minDigits,
    increment: definition.increment,
    manualOverride: false,
    version: 1,
    updatedBy: 'system',
    updatedAt: '2026-01-01T00:00:00.000Z',
    reason: 'Default demo convention.',
  };
}

export function numberingPolicy(
  state: Pick<AppState, 'numberingPolicies'>,
  workspaceId: string,
  kind: RecordKind,
): NumberingPolicy {
  return (
    state.numberingPolicies.find(
      (policy) => policy.workspaceId === workspaceId && policy.kind === kind,
    ) ?? defaultNumberingPolicy(workspaceId, kind)
  );
}

export function codesForKind(state: AppState, workspaceId: string, kind: RecordKind): string[] {
  const rows = <T>(items: T[], get: (item: T) => string) =>
    items
      .filter((item) => (item as { workspaceId?: string }).workspaceId === workspaceId)
      .map(get)
      .filter((code) => typeof code === 'string' && code.length > 0);
  switch (kind) {
    case 'account':
      return masterRecords(state, workspaceId, 'account').map((row) => row.code);
    case 'contact':
      return masterRecords(state, workspaceId, 'contact').map((row) => row.code);
    case 'employee':
      return masterRecords(state, workspaceId, 'employee').map((row) => row.code);
    case 'item':
      return masterRecords(state, workspaceId, 'item').map((row) => row.code);
    case 'location':
      return masterRecords(state, workspaceId, 'location').map((row) => row.code);
    case 'asset':
      return masterRecords(state, workspaceId, 'asset').map((row) => row.code);
    case 'bank_account':
      return masterRecords(state, workspaceId, 'bank_account').map((row) => row.code);
    case 'invoice':
      return rows(state.invoices, (row) => row.invoiceNo);
    case 'receipt':
      return rows(state.receipts, (row) => row.receiptNo);
    case 'credit_note':
      return rows(state.creditNotes, (row) => row.creditNo);
    case 'refund':
      return rows(state.refunds, (row) => row.refundNo);
    case 'purchase_order':
      return rows(state.purchaseOrders, (row) => row.poNo);
    case 'goods_receipt':
      return rows(state.goodsReceipts, (row) => row.receiptNo);
    case 'bill':
      return rows(state.bills, (row) => row.billNo);
    case 'payment_request':
      return rows(state.rfps, (row) => row.rfpNo);
    case 'payment':
      return rows(state.payments, (row) => row.paymentNo);
    case 'advance':
      return rows(state.advances, (row) => row.advanceNo);
    case 'liquidation':
      return rows(state.liquidations, (row) => row.liquidationNo);
    case 'inventory_movement':
      return rows(state.movements, (row) => row.movementNo);
    case 'payroll_run':
      return rows(state.payrollRuns, (row) => row.runNo);
    case 'payroll_worksheet':
      return rows(state.worksheets, (row) => row.worksheetNo);
    case 'journal':
      return rows(state.journals, (row) => row.journalNo);
    case 'journal_draft':
      return rows(state.journalDrafts, (row) => row.draftNo);
    case 'bank_statement':
      return rows(state.bankStatements, (row) => row.statementNo);
    case 'tax_record':
      return rows(state.taxRecords, (row) => row.publicNo);
  }
}

export function reservedCodes(state: AppState, workspaceId: string, kind: RecordKind): Set<string> {
  return new Set(codesForKind(state, workspaceId, kind).map(normalizeCode));
}

/** Pure preview of the next codes, skipping already-reserved values. */
export function previewCodes(
  state: Pick<AppState, 'numberingPolicies'>,
  workspaceId: string,
  kind: RecordKind,
  count = 3,
): string[] {
  const policy = numberingPolicy(state, workspaceId, kind);
  const reserved = reservedCodes(state as AppState, workspaceId, kind);
  const codes: string[] = [];
  let value = policy.nextNumber;
  for (let attempts = 0; attempts < 10_000 && codes.length < count; attempts += 1) {
    if (!Number.isSafeInteger(value)) break;
    const code = formatNumber(policy, value);
    if (!reserved.has(normalizeCode(code))) codes.push(code);
    if (value > Number.MAX_SAFE_INTEGER - policy.increment) break;
    value += policy.increment;
  }
  return codes;
}

export interface PolicyInput {
  prefix: string;
  /** Master updates use this as the starting value; the next free counter is then derived. Documents use the next unissued number. */
  nextNumber: number;
  minDigits: number;
  increment: number;
  manualOverride: boolean;
}

export function validatePolicyInput(
  state: AppState,
  workspaceId: string,
  kind: RecordKind,
  input: PolicyInput,
): Result<PolicyInput> {
  const prefix = input.prefix.trim();
  if (isMasterKind(kind)) {
    if (!/^[A-Za-z0-9]{0,8}$/.test(prefix)) {
      return err('VALIDATION', 'Master data prefix must be 0 to 8 letters or digits without dashes.', 'prefix');
    }
  } else if (!/^[A-Za-z0-9_-]{0,8}$/.test(prefix)) {
    return err('VALIDATION', 'Prefix must be 0 to 8 letters, digits, dashes, or underscores.', 'prefix');
  }
  if (!Number.isSafeInteger(input.nextNumber) || input.nextNumber <= 0) {
    return err('VALIDATION', 'Next number must be a positive safe integer.', 'nextNumber');
  }
  if (!Number.isSafeInteger(input.increment) || input.increment <= 0) {
    return err('VALIDATION', 'Increment must be a positive safe integer.', 'increment');
  }
  if (!Number.isSafeInteger(input.minDigits) || input.minDigits < 0 || input.minDigits > 12) {
    return err('VALIDATION', 'Minimum digits must be a whole number from 0 to 12.', 'minDigits');
  }
  const sample = formatNumber({ prefix, minDigits: input.minDigits }, input.nextNumber);
  if (sample.length > 40) {
    return err('VALIDATION', 'The generated code would be longer than 40 characters.', 'prefix');
  }
  const reserved = reservedCodes(state, workspaceId, kind);
  const firstCode = formatNumber({ prefix, minDigits: input.minDigits }, input.nextNumber);
  if (!isMasterKind(kind) && reserved.has(normalizeCode(firstCode))) {
    return err(
      'VALIDATION',
      `Code ${firstCode} is already in use. Choose a next number above every reserved code.`,
      'nextNumber',
    );
  }
  if (input.nextNumber > Number.MAX_SAFE_INTEGER - input.increment) {
    return err('VALIDATION', 'This series cannot advance without exceeding the safe-integer limit.', 'nextNumber');
  }
  return ok({ ...input, prefix });
}

/** Allocate and advance the series in the command draft. */
export function allocateCode(
  draft: StateDraft,
  workspaceId: string,
  kind: RecordKind,
): Result<string> {
  const policy = numberingPolicy(draft.state, workspaceId, kind);
  const reserved = reservedCodes(draft.state, workspaceId, kind);
  let value = policy.nextNumber;
  for (let attempts = 0; attempts < 10_000; attempts += 1) {
    if (!Number.isSafeInteger(value)) {
      return err('VALIDATION', `The ${kind.replaceAll('_', ' ')} series is exhausted.`);
    }
    const code = formatNumber(policy, value);
    if (!reserved.has(normalizeCode(code))) {
      const nextNumber = value + policy.increment;
      if (!Number.isSafeInteger(nextNumber) || nextNumber <= value) {
        return err('VALIDATION', `The ${kind.replaceAll('_', ' ')} series is exhausted.`);
      }
      const existing = draft.state.numberingPolicies.find(
        (candidate) => candidate.workspaceId === workspaceId && candidate.kind === kind,
      );
      const updated: NumberingPolicy = { ...policy, nextNumber };
      draft.state.numberingPolicies = existing
        ? draft.state.numberingPolicies.map((candidate) =>
            candidate.workspaceId === workspaceId && candidate.kind === kind ? updated : candidate,
          )
        : [...draft.state.numberingPolicies, updated];
      return ok(code);
    }
    if (value > Number.MAX_SAFE_INTEGER - policy.increment) {
      return err('VALIDATION', `The ${kind.replaceAll('_', ' ')} series is exhausted.`);
    }
    value += policy.increment;
  }
  return err('VALIDATION', `No collision-free ${kind.replaceAll('_', ' ')} code was found.`);
}

export function updateNumberingPolicy(
  draft: StateDraft,
  workspaceId: string,
  kind: RecordKind,
  input: PolicyInput,
  actorId: string,
  at: string,
  reason: string,
): Result<NumberingPolicy> {
  if (reason.trim().length < 3) {
    return err('VALIDATION', 'A reason is required for a numbering policy change.', 'reason');
  }
  const validated = validatePolicyInput(draft.state, workspaceId, kind, input);
  if (!validated.ok) return validated;
  const current = numberingPolicy(draft.state, workspaceId, kind);
  const updated: NumberingPolicy = {
    ...current,
    prefix: validated.value.prefix,
    startNumber: validated.value.nextNumber,
    nextNumber: validated.value.nextNumber,
    minDigits: validated.value.minDigits,
    increment: validated.value.increment,
    manualOverride: validated.value.manualOverride,
    version: current.version + 1,
    updatedBy: actorId,
    updatedAt: at,
    reason: reason.trim(),
  };
  draft.state.numberingPolicies = draft.state.numberingPolicies.some(
    (policy) => policy.workspaceId === workspaceId && policy.kind === kind,
  )
    ? draft.state.numberingPolicies.map((policy) =>
        policy.workspaceId === workspaceId && policy.kind === kind ? updated : policy,
      )
    : [...draft.state.numberingPolicies, updated];
  if (isMasterKind(kind)) {
    const rebase = current.prefix !== updated.prefix || current.startNumber !== updated.startNumber ||
      current.minDigits !== updated.minDigits || current.increment !== updated.increment;
    const reconciled = reconcileMasterCodes(draft.state, { workspaceId, kind, rebase });
    if (!reconciled.ok) return reconciled;
    draft.state = reconciled.value.state;
    return ok(numberingPolicy(draft.state, workspaceId, kind));
  }
  return ok(updated);
}

/** Manual selection chooses an unused code within the same authoritative series. */
export function allocateMasterCode(draft: StateDraft, workspaceId: string, kind: MasterKind, input = ''): Result<string> {
  const policy = numberingPolicy(draft.state, workspaceId, kind);
  if (!policy.manualOverride || !input.trim()) return allocateCode(draft, workspaceId, kind);
  const code = input.trim();
  const number = masterCodeNumber(policy, code);
  if (number === null) return err('VALIDATION', `Code must follow the ${policy.prefix || 'numeric'} series, starting at ${policy.startNumber} with increment ${policy.increment}.`);
  if (reservedCodes(draft.state, workspaceId, kind).has(normalizeCode(code))) return err('DUPLICATE_ROW', 'This master code is already reserved.');
  const nextNumber = Math.max(policy.nextNumber, number + policy.increment);
  if (!Number.isSafeInteger(nextNumber) || !Number.isSafeInteger(nextNumber + policy.increment)) return err('VALIDATION', 'The numbering series is exhausted.');
  draft.state.numberingPolicies = draft.state.numberingPolicies.map((row) => row.workspaceId === workspaceId && row.kind === kind ? { ...row, nextNumber } : row);
  return ok(code);
}
