import { reconcileMasterCodes } from './masterCodes';
import type { AppState, User } from './schema';
import { parseAppState } from './schema';
import { migrateStoredState } from './migration';
import {
  RECORD_KINDS,
  codesForKind,
  formatNumber,
  normalizeCode,
  numberingPolicy,
} from './numbering';
import { stableStringify } from './shared/json';
import { err, ok, type Result } from './shared/result';

export const COMPANY_ARCHIVE_FORMAT = 'ece-accounting-company-archive';
export const LEGACY_COMPANY_ARCHIVE_FORMAT = 'fin-axis-company-archive';
export const ARCHIVE_FORMAT = COMPANY_ARCHIVE_FORMAT;
export const LEGACY_ARCHIVE_FORMAT = LEGACY_COMPANY_ARCHIVE_FORMAT;
export const ARCHIVE_VERSION = 2;
export const LEGACY_ARCHIVE_VERSION = 1;

export function companyArchiveFilename(workspaceId: string, createdAt: string): string {
  const stamp = createdAt.slice(0, 10);
  return `ece-accounting-company-${workspaceId}-${stamp}.json`;
}

type WorkspaceScopedKey =
  | 'contacts'
  | 'accounts'
  | 'periods'
  | 'journals'
  | 'auditEvents'
  | 'invoices'
  | 'receipts'
  | 'creditNotes'
  | 'refunds'
  | 'purchaseOrders'
  | 'goodsReceipts'
  | 'bills'
  | 'rfps'
  | 'payments'
  | 'advances'
  | 'liquidations'
  | 'bankAccounts'
  | 'bankStatements'
  | 'bankRows'
  | 'items'
  | 'locations'
  | 'movements'
  | 'employees'
  | 'deductionSchedules'
  | 'payrollPolicies'
  | 'timeImports'
  | 'payrollRuns'
  | 'worksheets'
  | 'assets'
  | 'depreciationPosts'
  | 'journalDrafts'
  | 'taxRecords'
  | 'certificates2307'
  | 'archiveLog'
  | 'memberships'
  | 'seats'
  | 'numberingPolicies';

export const ARCHIVE_COLLECTIONS: readonly WorkspaceScopedKey[] = [
  'contacts',
  'accounts',
  'periods',
  'journals',
  'auditEvents',
  'invoices',
  'receipts',
  'creditNotes',
  'refunds',
  'purchaseOrders',
  'goodsReceipts',
  'bills',
  'rfps',
  'payments',
  'advances',
  'liquidations',
  'bankAccounts',
  'bankStatements',
  'bankRows',
  'items',
  'locations',
  'movements',
  'employees',
  'deductionSchedules',
  'payrollPolicies',
  'timeImports',
  'payrollRuns',
  'worksheets',
  'assets',
  'depreciationPosts',
  'journalDrafts',
  'taxRecords',
  'certificates2307',
  'archiveLog',
  'memberships',
  'seats',
  'numberingPolicies',
];

export interface CompanyArchive {
  format: typeof COMPANY_ARCHIVE_FORMAT | typeof LEGACY_COMPANY_ARCHIVE_FORMAT;
  formatVersion: number;
  workspaceId: string;
  createdAt: string;
  createdBy: string;
  checksum: string;
  payload: {
    workspace: AppState['workspaces'][number];
    users: User[];
    collections: Record<string, unknown[]>;
    idempotency: Record<string, unknown>;
    sourceEffects: Record<string, unknown>;
  };
}

/** Payload without the checksum field, serialized with sorted keys. */
export function archiveSigningBody(
  archive: Omit<CompanyArchive, 'checksum'> | CompanyArchive,
): string {
  const { checksum: _checksum, ...rest } = archive as CompanyArchive;
  return stableStringify(rest);
}

export function buildCompanyArchive(
  state: AppState,
  workspaceId: string,
  createdBy: string,
  createdAt: string,
): Result<Omit<CompanyArchive, 'checksum'>> {
  const workspace = state.workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) return err('NOT_FOUND', 'Workspace not found for archive.');
  const collections: Record<string, unknown[]> = {};
  for (const key of ARCHIVE_COLLECTIONS) {
    collections[key] = state[key].filter(
      (record) => (record as { workspaceId?: string }).workspaceId === workspaceId,
    ) as unknown[];
  }
  const membershipUserIds = new Set(
    state.memberships
      .filter((membership) => membership.workspaceId === workspaceId)
      .map((membership) => membership.userId),
  );
  const users = state.users.filter(
    (user) =>
      membershipUserIds.has(user.id) ||
      state.journals.some((journal) => journal.workspaceId === workspaceId && journal.createdBy === user.id),
  );
  const idempotency: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state.idempotency)) {
    if (key.startsWith(`${workspaceId}:`)) idempotency[key] = value;
  }
  const sourceEffects: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state.sourceEffects)) {
    if (key.startsWith(`${workspaceId}:`)) sourceEffects[key] = value;
  }
  return ok({
    format: ARCHIVE_FORMAT,
    formatVersion: ARCHIVE_VERSION,
    workspaceId,
    createdAt,
    createdBy,
    payload: {
      workspace: structuredClone(workspace),
      users: structuredClone(users),
      collections,
      idempotency,
      sourceEffects,
    },
  });
}

export function archiveCounts(archive: CompanyArchive): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [key, value] of Object.entries(archive.payload.collections)) {
    counts[key] = Array.isArray(value) ? value.length : 0;
  }
  return counts;
}

export function archiveChecksumPrefix(checksum: string): string {
  return checksum.slice(0, 12);
}

/**
 * A company archive carries protected payroll detail. The privileged archive
 * grant is not enough on its own: the operator must also hold the explicit
 * payroll-detail grant, and be an active company administrator.
 */
export function canExportCompanyArchive(
  membership: Pick<AppState['memberships'][number], 'roles' | 'payrollDetail' | 'archiveGrant' | 'active'>,
): boolean {
  return (
    membership.active &&
    membership.archiveGrant &&
    membership.payrollDetail &&
    membership.roles.includes('company_admin')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isCompanyArchive(value: unknown): value is CompanyArchive {
  if (!isRecord(value)) return false;
  if (
    (value.format !== COMPANY_ARCHIVE_FORMAT && value.format !== LEGACY_COMPANY_ARCHIVE_FORMAT) ||
    (value.formatVersion !== ARCHIVE_VERSION && value.formatVersion !== LEGACY_ARCHIVE_VERSION)
  ) {
    return false;
  }
  if (typeof value.workspaceId !== 'string' || typeof value.checksum !== 'string') return false;
  if (!isRecord(value.payload)) return false;
  if (!isRecord(value.payload.workspace)) return false;
  if (!Array.isArray(value.payload.users)) return false;
  if (!isRecord(value.payload.collections)) return false;
  return true;
}

/**
 * Merge a verified company archive into the current state. Only records for
 * the archived workspace are replaced; other companies stay untouched.
 */
export function mergeCompanyArchive(
  current: AppState,
  archive: CompanyArchive,
  actorId: string,
  reason: string,
  now: string,
  logId: string,
): Result<AppState> {
  if (!isCompanyArchive(archive)) return err('VALIDATION', 'The archive file is not an ECE Accounting company archive.');
  if (archive.payload.workspace.id !== archive.workspaceId) {
    return err('VALIDATION', 'The archived workspace does not match the archive company identifier.');
  }

  // A company archive must never carry another company's records. Validate every
  // collection before mutating anything so a mixed file fails atomically.
  for (const key of ARCHIVE_COLLECTIONS) {
    if (key === 'numberingPolicies' && archive.formatVersion === LEGACY_ARCHIVE_VERSION) continue;
    const archived = archive.payload.collections[key];
    if (!Array.isArray(archived)) {
      return err('VALIDATION', `Archive is missing the ${key} collection.`);
    }
    for (const record of archived) {
      if (!isRecord(record) || record.workspaceId !== archive.workspaceId) {
        return err('VALIDATION', `Archive collection ${key} contains a record from another company.`);
      }
    }
  }
  for (const key of Object.keys(archive.payload.idempotency)) {
    if (!key.startsWith(`${archive.workspaceId}:`)) {
      return err('VALIDATION', 'Archive idempotency receipts contain another company.');
    }
  }
  for (const key of Object.keys(archive.payload.sourceEffects)) {
    if (!key.startsWith(`${archive.workspaceId}:`)) {
      return err('VALIDATION', 'Archive source effects contain another company.');
    }
  }

  let archivedWorkspace = archive.payload.workspace as AppState['workspaces'][number];
  let archivedCollections: Record<string, unknown[]> = archive.payload.collections;
  if (archive.formatVersion === LEGACY_ARCHIVE_VERSION) {
    // The caller verifies the legacy checksum before this function runs. Only
    // then do we migrate the archive's own snapshot, preserving every legacy ID,
    // balance, historical code and posted snapshot.
    const legacyCandidate = {
      schemaVersion: 1,
      revision: 1,
      workspaces: [structuredClone(archive.payload.workspace)],
      users: structuredClone(archive.payload.users),
      ...structuredClone(archive.payload.collections),
      idempotency: structuredClone(archive.payload.idempotency),
      sourceEffects: structuredClone(archive.payload.sourceEffects),
    };
    const migrated = migrateStoredState(legacyCandidate);
    if (!migrated.ok) {
      return err('VALIDATION', `Legacy archive could not be migrated: ${migrated.message}`);
    }
    archivedWorkspace = migrated.state.workspaces[0];
    archivedCollections = {};
    for (const key of ARCHIVE_COLLECTIONS) {
      archivedCollections[key] = migrated.state[key].filter(
        (record) => (record as { workspaceId?: string }).workspaceId === archive.workspaceId,
      ) as unknown[];
    }
  }

  const next: AppState = structuredClone(current);
  const workspaceIndex = next.workspaces.findIndex((workspace) => workspace.id === archive.workspaceId);
  if (workspaceIndex < 0) {
    return err('NOT_FOUND', 'The archived workspace is not present in this installation.');
  }
  next.workspaces[workspaceIndex] = structuredClone(archivedWorkspace);

  for (const key of ARCHIVE_COLLECTIONS) {
    const archived = archivedCollections[key] as unknown[];
    const retained = (next[key] as Array<{ workspaceId?: string }>).filter(
      (record) => record.workspaceId !== archive.workspaceId,
    );
    next[key] = [...retained, ...structuredClone(archived)] as never;
  }
  // Users are installation-wide identities. Add missing archive users but never
  // overwrite an existing identity, which could alter how another company sees it.
  for (const user of archive.payload.users) {
    if (!next.users.some((candidate) => candidate.id === user.id)) {
      next.users.push(structuredClone(user));
    }
  }
  for (const [key, value] of Object.entries(archive.payload.idempotency)) {
    next.idempotency[key] = value as AppState['idempotency'][string];
  }
  for (const [key, value] of Object.entries(archive.payload.sourceEffects)) {
    next.sourceEffects[key] = value as AppState['sourceEffects'][string];
  }
  next.archiveLog = [
    ...next.archiveLog,
    {
      id: logId,
      workspaceId: archive.workspaceId,
      action: 'restore',
      at: now,
      by: actorId,
      fileName: `company-${archive.workspaceId}-${archive.createdAt.slice(0, 10)}.json`,
      checksumPrefix: archiveChecksumPrefix(archive.checksum),
      reason,
      counts: archiveCounts(archive),
    },
  ];
  for (const kind of RECORD_KINDS) {
    const codes = codesForKind(next, archive.workspaceId, kind).map(normalizeCode);
    if (new Set(codes).size !== codes.length) {
      return err('VALIDATION', `Restored ${kind.replaceAll('_', ' ')} codes are not unique within the company.`);
    }
    const policy = numberingPolicy(next, archive.workspaceId, kind);
    const nextCode = formatNumber(policy, policy.nextNumber);
    if (policy.nextNumber > 0 && codes.includes(normalizeCode(nextCode))) {
      return err(
        'VALIDATION',
        `The ${kind.replaceAll('_', ' ')} counter would duplicate existing code ${nextCode}. Raise it above every reserved code.`,
      );
    }
  }
  const policyKeys = next.numberingPolicies
    .filter((policy) => policy.workspaceId === archive.workspaceId)
    .map((policy) => policy.kind);
  if (new Set(policyKeys).size !== policyKeys.length) {
    return err('VALIDATION', 'Restored numbering policies contain duplicate record kinds.');
  }
  next.revision = current.revision + 1;
  const parsed = parseAppState(next);
  if (!parsed.ok) {
    return err('VALIDATION', `Restored state failed validation: ${parsed.message}`);
  }
  const reconciled = reconcileMasterCodes(parsed.state, { workspaceId: archive.workspaceId });
  if (!reconciled.ok) return reconciled;
  return ok(reconciled.value.state);
}
