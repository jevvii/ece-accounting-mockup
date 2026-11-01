import { createBaseSeedState, createSeedState } from '../fixtures/seed';
import { appStateSchema, type AppState } from '../domain/schema';
import { migrateStoredState } from '../domain/migration';
import { codesForKind } from '../domain/numbering';
import { reconcileMasterCodes } from '../domain/masterCodes';
import { backfillJournalProvenance } from '../domain/ledger';
import { stableStringify } from '../domain/shared/json';

export const STORAGE_KEY = 'fin-axis-mockup:app-state:v1';

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type StorageLike = KeyValueStorage | Storage;

export function defaultStorage(): StorageLike | null {
  if (typeof window !== 'undefined' && window.localStorage) {
    return window.localStorage;
  }
  return null;
}

export type CorruptReason =
  | 'invalid_json'
  | 'unsupported_version'
  | 'invalid_shape'
  | 'numbering_exhausted';

export type LoadResult =
  | { status: 'ok'; state: AppState; source: 'existing' | 'seed'; persisted: boolean }
  | {
      status: 'corrupt';
      reason: CorruptReason;
      message: string;
      raw: string;
    };

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Validate a candidate snapshot in memory before committing to storage.
 * Verifies schema, balanced journals with sourceProvenance, and numbering reservations.
 */
export function validateStateSnapshot(candidate: AppState): { ok: true; state: AppState } | { ok: false; error: string } {
  const parsed = appStateSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    };
  }

  const reconciled = reconcileMasterCodes(parsed.data);
  if (!reconciled.ok) return { ok: false, error: reconciled.error.message };
  candidate = reconciled.value.state;

  for (const j of candidate.journals) {
    let debits = 0;
    let credits = 0;
    for (const line of j.lines) {
      debits += line.debitCentavos;
      credits += line.creditCentavos;
    }
    if (debits !== credits || debits <= 0) {
      return {
        ok: false,
        error: `Journal ${j.journalNo} (${j.id}) is not balanced: Dr ${debits} != Cr ${credits}`,
      };
    }
    if (!j.sourceProvenance || !j.sourceProvenance.book) {
      return {
        ok: false,
        error: `Journal ${j.journalNo} (${j.id}) lacks valid sourceProvenance`,
      };
    }
  }

  for (const policy of candidate.numberingPolicies) {
    const codes = codesForKind(candidate, policy.workspaceId, policy.kind);
    const pattern = new RegExp(`^${escapeRegExp(policy.prefix)}(\\d+)$`, 'i');
    for (const code of codes) {
      const match = pattern.exec(code.trim());
      if (!match) continue;
      const num = Number(match[1]);
      if (Number.isSafeInteger(num) && policy.nextNumber <= num) {
        return {
          ok: false,
          error: `Numbering policy for ${policy.kind} in ${policy.workspaceId} nextNumber ${policy.nextNumber} is not strictly greater than existing code suffix ${num} (${code})`,
        };
      }
    }
  }

  return { ok: true, state: candidate };
}

/**
 * Deterministic 128-bit hex digest over the canonical demo dataset tables.
 */
export function computeDatasetDigest(state: AppState): string {
  const canonical = {
    workspaces: state.workspaces,
    accounts: state.accounts,
    contacts: state.contacts,
    employees: state.employees,
    items: state.items,
    locations: state.locations,
    assets: state.assets,
    bankAccounts: state.bankAccounts,
    invoices: state.invoices,
    creditNotes: state.creditNotes,
    customerReceipts: state.receipts,
    supplierBills: state.bills,
    supplierPayments: state.payments,
    employeeAdvances: state.advances,
    payrollRuns: state.payrollRuns,
    inventoryMovements: state.movements,
    journals: state.journals,
    numberingPolicies: state.numberingPolicies,
  };
  const text = stableStringify(canonical);
  let h1 = 0x811c9dc5;
  let h2 = 0x1000193;
  let h3 = 0xc2b2ae35;
  let h4 = 0x27d4eb2f;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ code, 0x85ebca6b) >>> 0;
    h3 = Math.imul(h3 ^ code, 0x5bd1e995) >>> 0;
    h4 = Math.imul(h4 ^ code, 0x1b873593) >>> 0;
  }
  return [
    h1.toString(16).padStart(8, '0'),
    h2.toString(16).padStart(8, '0'),
    h3.toString(16).padStart(8, '0'),
    h4.toString(16).padStart(8, '0'),
  ].join('');
}

/**
 * Read the browser-local snapshot. A corrupt or unknown snapshot is reported
 * with its raw text and is never silently replaced by seed data.
 */
export function loadState(storage: StorageLike): LoadResult {
  const raw = storage.getItem(STORAGE_KEY);
  if (raw === null) {
    const seed = createSeedState();
    let persisted = true;
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(seed));
    } catch {
      persisted = false;
    }
    return { status: 'ok', state: seed, source: 'seed', persisted };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return {
      status: 'corrupt',
      reason: 'invalid_json',
      message: 'Stored data is not valid JSON. Export the raw data before resetting.',
      raw,
    };
  }
  const migrated = migrateStoredState(parsed, new Date().toISOString());
  if (!migrated.ok) {
    return {
      status: 'corrupt',
      reason: migrated.reason as CorruptReason,
      message: migrated.message,
      raw,
    };
  }
  if (migrated.migrated) {
    // The old raw snapshot stays in place until the validated v2 candidate is
    // written. If the write fails, the next load migrates the same raw data
    // deterministically; nothing is silently discarded.
    const saved = saveState(storage, migrated.state);
    return { status: 'ok', state: migrated.state, source: 'existing', persisted: saved.ok };
  }
  return { status: 'ok', state: migrated.state, source: 'existing', persisted: true };
}

export function saveState(
  storage: StorageLike,
  state: AppState,
): { ok: true } | { ok: false; message: string } {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(state));
    return { ok: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown storage error';
    return {
      ok: false,
      message: `The snapshot was not saved (${detail}). The visible state was not advanced.`,
    };
  }
}

export interface ResetResult {
  ok: boolean;
  state: AppState;
  saved: boolean;
  error?: string;
  message?: string;
}

/**
 * Atomic validate-before-save reset.
 * Constructs and validates replacement candidate in memory before replacing STORAGE_KEY.
 * Never calls removeItem before setItem, never calls localStorage.clear().
 * If setItem fails or validation fails, leaves the prior stored snapshot intact.
 */
export function resetState(
  storage: StorageLike | null = defaultStorage(),
  candidateFactory: () => AppState = createSeedState,
): ResetResult {
  let candidate: AppState;
  try {
    candidate = backfillJournalProvenance(candidateFactory());
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      state: createBaseSeedState(),
      saved: false,
      error: `Failed to construct replacement state: ${error}`,
      message: `Failed to construct replacement state: ${error}`,
    };
  }

  const validated = validateStateSnapshot(candidate);
  if (!validated.ok) {
    return {
      ok: false,
      state: candidate,
      saved: false,
      error: `Validation failed: ${validated.error}`,
      message: `Validation failed: ${validated.error}`,
    };
  }

  let replacement = validated.state;
  if (storage) {
    let raw: string | null;
    try { raw = storage.getItem(STORAGE_KEY); }
    catch { return { ok: false, state: replacement, saved: false, error: 'The previous revision could not be read; reset was not committed.' }; }
    if (raw !== null) {
      let previous: unknown;
      try { previous = JSON.parse(raw); } catch { previous = null; }
      const revision = typeof previous === 'object' && previous !== null && 'revision' in previous ? previous.revision : null;
      if (typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0) {
        if (revision === Number.MAX_SAFE_INTEGER) return { ok: false, state: replacement, saved: false, error: 'The revision counter is exhausted; reset was not committed.' };
        replacement = { ...replacement, revision: Math.max(revision + 1, replacement.revision) };
      }
    }
  }
  let payload: string;
  try {
    payload = JSON.stringify(replacement);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      state: validated.state,
      saved: false,
      error: `Serialization failed: ${error}`,
      message: `Serialization failed: ${error}`,
    };
  }

  if (!storage) {
    return {
      ok: true,
      state: replacement,
      saved: false,
      error: 'Storage adapter is not available.',
      message: 'Storage adapter is not available.',
    };
  }

  try {
    storage.setItem(STORAGE_KEY, payload);
    return {
      ok: true,
      state: replacement,
      saved: true,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      state: replacement,
      saved: false,
      error: `Reset failed (${detail}). The previous saved state was preserved.`,
      message: `Reset failed (${detail}). The previous saved state was preserved.`,
    };
  }
}

export function isStateStorageEvent(key: string | null): boolean {
  return key === STORAGE_KEY;
}

/**
 * Notify the current tab when another tab writes the snapshot. The application
 * must stop writing and ask the operator to reload; it never merges silently.
 */
export function watchExternalWrites(onExternalWrite: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const handler = (event: StorageEvent): void => {
    if (isStateStorageEvent(event.key)) onExternalWrite();
  };
  window.addEventListener('storage', handler);
  return () => window.removeEventListener('storage', handler);
}

/** In-memory storage used by tests and the recovery screen preview. */
export function createMemoryStorage(initial?: Record<string, string>): KeyValueStorage {
  const values = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}
