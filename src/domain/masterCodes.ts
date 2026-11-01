import type { AppState } from './schema';
import type { NumberingPolicy } from './numbering';
import { formatNumber, normalizeCode } from './shared/numberingFormat';
import { err, ok, type Result } from './shared/result';

export const MASTER_KINDS = ['account', 'contact', 'employee', 'item', 'location', 'asset', 'bank_account'] as const;
export type MasterKind = (typeof MASTER_KINDS)[number];

export function isMasterKind(kind: string): kind is MasterKind {
  return MASTER_KINDS.some((candidate) => candidate === kind);
}

export function masterRecords(state: AppState, workspaceId: string, kind: MasterKind): Array<{ id: string; code: string }> {
  const scoped = <T extends { id: string; workspaceId: string }>(rows: T[], code: (row: T) => string) =>
    rows.filter((row) => row.workspaceId === workspaceId).map((row) => ({ id: row.id, code: code(row) }));
  switch (kind) {
    case 'account': return scoped(state.accounts, (row) => row.code);
    case 'contact': return scoped(state.contacts, (row) => row.contactNo);
    case 'employee': return scoped(state.employees, (row) => row.employeeNo);
    case 'item': return scoped(state.items, (row) => row.itemNo);
    case 'location': return scoped(state.locations, (row) => row.code);
    case 'asset': return scoped(state.assets, (row) => row.assetNo);
    case 'bank_account': return scoped(state.bankAccounts, (row) => row.bankCode);
  }
}

/** A valid code must be an exact output of the configured prefix/padding/sequence. */
export function masterCodeNumber(policy: NumberingPolicy, code: string): number | null {
  if (!code.startsWith(policy.prefix)) return null;
  const suffix = code.slice(policy.prefix.length);
  if (!/^\d+$/.test(suffix)) return null;
  const number = Number(suffix);
  if (!Number.isSafeInteger(number) || number < policy.startNumber ||
      (number - policy.startNumber) % policy.increment !== 0 || formatNumber(policy, number) !== code) return null;
  return number;
}

export interface MasterCodeChange {
  workspaceId: string;
  kind: MasterKind;
  recordId: string;
  previousCode: string;
  code: string;
}

function replaceCodes(state: AppState, workspaceId: string, kind: MasterKind, codes: Map<string, string>): AppState {
  const code = (row: { id: string; workspaceId: string }, current: string) =>
    row.workspaceId === workspaceId ? codes.get(row.id) ?? current : current;
  switch (kind) {
    case 'account': return { ...state, accounts: state.accounts.map((row) => ({ ...row, code: code(row, row.code) })) };
    case 'contact': return { ...state, contacts: state.contacts.map((row) => ({ ...row, contactNo: code(row, row.contactNo) })) };
    case 'employee': return { ...state, employees: state.employees.map((row) => ({ ...row, employeeNo: code(row, row.employeeNo) })) };
    case 'item': return { ...state, items: state.items.map((row) => ({ ...row, itemNo: code(row, row.itemNo) })) };
    case 'location': return { ...state, locations: state.locations.map((row) => ({ ...row, code: code(row, row.code) })) };
    case 'asset': return { ...state, assets: state.assets.map((row) => ({ ...row, assetNo: code(row, row.assetNo) })) };
    case 'bank_account': return { ...state, bankAccounts: state.bankAccounts.map((row) => ({ ...row, bankCode: code(row, row.bankCode) })) };
  }
}

/**
 * Reconcile current master labels only. IDs, document numbers, posted snapshots,
 * source effects, and external reference fields are never rewritten.
 * Load repair preserves valid reservations; an explicit policy rebase regenerates
 * the selected collection. The caller commits/audits the returned candidate.
 */
export function reconcileMasterCodes(
  state: AppState,
  scope?: { workspaceId: string; kind?: MasterKind; rebase?: boolean },
): Result<{ state: AppState; changes: MasterCodeChange[] }> {
  let candidate = state;
  const changes: MasterCodeChange[] = [];
  for (const workspace of state.workspaces) {
    if (scope && workspace.id !== scope.workspaceId) continue;
    for (const kind of scope?.kind ? [scope.kind] : MASTER_KINDS) {
      const policies = candidate.numberingPolicies.filter((row) => row.workspaceId === workspace.id && row.kind === kind);
      if (policies.length !== 1) return err('VALIDATION', `Exactly one ${kind} numbering policy is required for ${workspace.name}.`);
      const policy = policies[0]!;
      if (!/^[A-Za-z0-9]{0,8}$/.test(policy.prefix) ||
          !Number.isSafeInteger(policy.startNumber) || policy.startNumber <= 0 ||
          !Number.isSafeInteger(policy.nextNumber) || policy.nextNumber <= 0 ||
          !Number.isSafeInteger(policy.increment) || policy.increment <= 0 ||
          !Number.isInteger(policy.minDigits) || policy.minDigits < 0 || policy.minDigits > 12) {
        return err('VALIDATION', `The ${kind} numbering policy is invalid.`);
      }
      const records = masterRecords(candidate, workspace.id, kind);
      const reserved = new Set<string>();
      const pending: typeof records = [];
      let highest = policy.startNumber - policy.increment;
      for (const row of records) {
        const number = masterCodeNumber(policy, row.code);
        if (scope?.rebase || number === null || reserved.has(normalizeCode(row.code))) {
          pending.push(row);
        } else {
          reserved.add(normalizeCode(row.code));
          highest = Math.max(highest, number);
        }
      }
      const replacements = new Map<string, string>();
      let value = policy.startNumber;
      for (const row of pending) {
        while (Number.isSafeInteger(value) && reserved.has(normalizeCode(formatNumber(policy, value)))) {
          value += policy.increment;
        }
        if (!Number.isSafeInteger(value) || !Number.isSafeInteger(value + policy.increment)) {
          return err('VALIDATION', `The ${kind} numbering series is exhausted; existing state was preserved.`);
        }
        const generated = formatNumber(policy, value);
        replacements.set(row.id, generated);
        changes.push({ workspaceId: workspace.id, kind, recordId: row.id, previousCode: row.code, code: generated });
        reserved.add(normalizeCode(generated));
        highest = Math.max(highest, value);
        value += policy.increment;
      }
      const lowerBound = Math.max(policy.nextNumber, policy.startNumber, highest + policy.increment);
      const nextNumber = policy.startNumber + Math.ceil((lowerBound - policy.startNumber) / policy.increment) * policy.increment;
      if (!Number.isSafeInteger(nextNumber) || !Number.isSafeInteger(nextNumber + policy.increment)) {
        return err('VALIDATION', `The ${kind} numbering series is exhausted; existing state was preserved.`);
      }
      if (replacements.size > 0) candidate = replaceCodes(candidate, workspace.id, kind, replacements);
      if (nextNumber !== policy.nextNumber) {
        candidate = { ...candidate, numberingPolicies: candidate.numberingPolicies.map((row) =>
          row.workspaceId === workspace.id && row.kind === kind ? { ...row, nextNumber } : row) };
      }
    }
  }
  return ok({ state: candidate, changes });
}
