/**
 * Deliberate, deterministic version-1 to version-2 migration.
 *
 * The raw stored snapshot is never replaced unless the candidate validates and
 * is written by the adapter. Internal IDs, balances, document numbers, posted
 * snapshots, source-effect keys and idempotency receipts are copied unchanged.
 * Only public numbers that did not exist in v1 are backfilled, per company and
 * in stable record-id order.
 */
import {
  RECORD_KINDS,
  formatNumber,
  normalizeCode,
  numberingDefinition,
  numberingPolicyId,
  type NumberingPolicy,
  type RecordKind,
} from './numbering';
import { SCHEMA_VERSION, appStateSchema, type AppState } from './schema';
import { backfillJournalProvenance } from './ledger';
import { reconcileMasterCodes } from './masterCodes';

const MIGRATION_AT = '2026-01-01T00:00:00.000Z';

export type MigrationResult =
  | { ok: true; state: AppState; migrated: boolean }
  | { ok: false; reason: string; message: string };

type LooseRecord = Record<string, unknown> & { id?: unknown; workspaceId?: unknown };

function isObject(value: unknown): value is LooseRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function arrayField(state: LooseRecord, key: string): LooseRecord[] {
  const value = state[key];
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function stringField(row: LooseRecord, key: string): string {
  const value = row[key];
  return typeof value === 'string' ? value : '';
}

/** The collection and public field that each registry kind owns. */
const KIND_COLLECTION: Record<RecordKind, { collection: string; field: string }> = {
  account: { collection: 'accounts', field: 'code' },
  contact: { collection: 'contacts', field: 'contactNo' },
  employee: { collection: 'employees', field: 'employeeNo' },
  item: { collection: 'items', field: 'itemNo' },
  location: { collection: 'locations', field: 'code' },
  asset: { collection: 'assets', field: 'assetNo' },
  bank_account: { collection: 'bankAccounts', field: 'bankCode' },
  invoice: { collection: 'invoices', field: 'invoiceNo' },
  receipt: { collection: 'receipts', field: 'receiptNo' },
  credit_note: { collection: 'creditNotes', field: 'creditNo' },
  refund: { collection: 'refunds', field: 'refundNo' },
  purchase_order: { collection: 'purchaseOrders', field: 'poNo' },
  goods_receipt: { collection: 'goodsReceipts', field: 'receiptNo' },
  bill: { collection: 'bills', field: 'billNo' },
  payment_request: { collection: 'rfps', field: 'rfpNo' },
  payment: { collection: 'payments', field: 'paymentNo' },
  advance: { collection: 'advances', field: 'advanceNo' },
  liquidation: { collection: 'liquidations', field: 'liquidationNo' },
  inventory_movement: { collection: 'movements', field: 'movementNo' },
  payroll_run: { collection: 'payrollRuns', field: 'runNo' },
  payroll_worksheet: { collection: 'worksheets', field: 'worksheetNo' },
  journal: { collection: 'journals', field: 'journalNo' },
  journal_draft: { collection: 'journalDrafts', field: 'draftNo' },
  bank_statement: { collection: 'bankStatements', field: 'statementNo' },
  tax_record: { collection: 'taxRecords', field: 'publicNo' },
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchingNumbers(codes: string[], policy: NumberingPolicy): number[] {
  const pattern = new RegExp(`^${escapeRegExp(policy.prefix)}(\\d+)$`, 'i');
  const values: number[] = [];
  for (const code of codes) {
    const match = pattern.exec(code.trim());
    if (!match) continue;
    const value = Number(match[1]);
    if (Number.isSafeInteger(value) && value >= policy.startNumber) values.push(value);
  }
  return values;
}

function buildPolicy(
  workspaceId: string,
  kind: RecordKind,
  codes: string[],
): NumberingPolicy {
  const definition = numberingDefinition(kind);
  const base: NumberingPolicy = {
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
    updatedBy: 'migration',
    updatedAt: MIGRATION_AT,
    reason: 'Migrated from schema v1. Existing codes were preserved.',
  };
  const matching = matchingNumbers(codes, base);
  if (matching.length === 0) return base;
  const highest = Math.max(...matching);
  const nextNumber = highest + base.increment;
  return Number.isSafeInteger(nextNumber) ? { ...base, nextNumber } : base;
}

/**
 * Allocate one backfilled code from a policy, skipping every reserved code and
 * advancing the policy. Bounded; never loops forever on a corrupt series.
 */
function allocateForMigration(
  policy: NumberingPolicy,
  reserved: Set<string>,
): { code: string; policy: NumberingPolicy } | null {
  let value = policy.nextNumber;
  for (let attempts = 0; attempts < 10_000; attempts += 1) {
    if (!Number.isSafeInteger(value)) return null;
    const code = formatNumber(policy, value);
    if (!reserved.has(normalizeCode(code))) {
      const nextNumber = value + policy.increment;
      if (!Number.isSafeInteger(nextNumber) || nextNumber <= value) return null;
      return { code, policy: { ...policy, nextNumber } };
    }
    if (value > Number.MAX_SAFE_INTEGER - policy.increment) return null;
    value += policy.increment;
  }
  return null;
}

function finishMigration(state: AppState, migrated: boolean, at: string): MigrationResult {
  const repaired = reconcileMasterCodes(state);
  if (!repaired.ok) return { ok: false, reason: 'numbering_exhausted', message: repaired.error.message };
  if (repaired.value.state === state) return { ok: true, state, migrated };
  const next = repaired.value.state;
  const auditEvents = [...next.auditEvents];
  for (const workspace of next.workspaces) {
    const changes = repaired.value.changes.filter((row) => row.workspaceId === workspace.id);
    if (changes.length === 0) continue;
    auditEvents.push({
      id: `master-policy-reconciliation:${workspace.id}:${state.revision}`,
      workspaceId: workspace.id, actorId: 'system', action: 'numbering.masterReconciliation',
      recordType: 'numbering_policy', recordId: workspace.id, at,
      reason: 'Numbering policy is authoritative for current master codes.',
      detail: { changedCount: changes.length, changes: JSON.stringify(changes) },
    });
  }
  return { ok: true, state: { ...next, auditEvents, revision: next.revision + 1 }, migrated: true };
}

export function migrateStoredState(raw: unknown, at = '2026-11-01T00:00:00.000Z'): MigrationResult {
  if (!isObject(raw)) {
    return { ok: false, reason: 'invalid_shape', message: 'The stored snapshot is not an object.' };
  }
  const version = raw.schemaVersion;
  if (version === SCHEMA_VERSION) {
    const parsed = appStateSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        reason: 'invalid_shape',
        message: parsed.error.issues
          .slice(0, 4)
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; '),
      };
    }
    const backfilled = backfillJournalProvenance(parsed.data);
    return finishMigration(backfilled, backfilled !== parsed.data, at);
  }
  if (version !== 1) {
    return {
      ok: false,
      reason: 'unsupported_version',
      message:
        typeof version === 'number' && version > SCHEMA_VERSION
          ? `Stored schema version ${version} is newer than this build (${SCHEMA_VERSION}).`
          : `Stored schema version ${String(version)} is not supported (expected 1 or ${SCHEMA_VERSION}).`,
    };
  }

  const candidate = JSON.parse(JSON.stringify(raw)) as LooseRecord;
  const workspaces = arrayField(candidate, 'workspaces');
  if (workspaces.length === 0) {
    return { ok: false, reason: 'invalid_shape', message: 'The snapshot has no companies.' };
  }

  const policies: NumberingPolicy[] = [];
  for (const workspace of workspaces) {
    const workspaceId = stringField(workspace, 'id');
    if (!workspaceId) {
      return { ok: false, reason: 'invalid_shape', message: 'A company has no stable ID.' };
    }
    for (const kind of RECORD_KINDS) {
      const { collection, field } = KIND_COLLECTION[kind];
      const rows = arrayField(candidate, collection).filter(
        (row) => stringField(row, 'workspaceId') === workspaceId,
      );
      const codes = rows.map((row) => stringField(row, field)).filter(Boolean);
      let policy = buildPolicy(workspaceId, kind, codes);
      const reserved = new Set(rows.map((row) => stringField(row, field)).map(normalizeCode));
      for (const row of [...rows].sort((left, right) =>
        stringField(left, 'id').localeCompare(stringField(right, 'id')),
      )) {
        if (stringField(row, field).trim().length > 0) continue;
        const allocation = allocateForMigration(policy, reserved);
        if (!allocation) {
          return {
            ok: false,
            reason: 'numbering_exhausted',
            message: `Cannot backfill ${kind} codes for ${workspaceId}: the series is exhausted.`,
          };
        }
        row[field] = allocation.code;
        policy = allocation.policy;
        reserved.add(normalizeCode(allocation.code));
      }
      policies.push(policy);
    }
  }

  candidate.schemaVersion = SCHEMA_VERSION;
  candidate.numberingPolicies = policies;
  const parsed = appStateSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      reason: 'invalid_shape',
      message: parsed.error.issues
        .slice(0, 4)
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; '),
    };
  }
  const backfilled = backfillJournalProvenance(parsed.data);
  return finishMigration(backfilled, true, at);
}

/** Policies for a new seed, with counters placed above every reserved code. */
export function policiesForState(state: Omit<AppState, 'numberingPolicies'>): NumberingPolicy[] {
  const policies: NumberingPolicy[] = [];
  const loose = state as unknown as LooseRecord;
  for (const workspace of state.workspaces) {
    for (const kind of RECORD_KINDS) {
      const { collection, field } = KIND_COLLECTION[kind];
      const rows = arrayField(loose, collection).filter(
        (row) => stringField(row, 'workspaceId') === workspace.id,
      );
      policies.push(buildPolicy(workspace.id, kind, rows.map((row) => stringField(row, field))));
    }
  }
  return policies;
}
