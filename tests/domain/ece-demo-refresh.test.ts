import { describe, expect, it, vi } from 'vitest';
import {
  createBaseSeedState,
  createSeedState,
  DEMO_FIXTURE_VERSION,
  DEMO_NOW,
  DEMO_TODAY,
  WORKSPACE_A,
  WORKSPACE_B,
} from '../../src/fixtures/seed';
import {
  computeDatasetDigest,
  createMemoryStorage,
  resetState,
  STORAGE_KEY,
  validateStateSnapshot,
} from '../../src/adapters/storage';
import { trialBalance } from '../../src/domain/queries';
import { executeCommand } from '../../src/domain/commands';
import { createFixedClock } from '../../src/domain/shared/clock';
import {
  allocateCode,
  codesForKind,
  formatNumber,
  isMasterKind,
  MASTER_KINDS,
  numberingPolicy,
  previewCodes,
  validatePolicyInput,
} from '../../src/domain/numbering';
import { createDraft } from '../../src/domain/shared/draft';
import type { CommandEnvelope } from '../../src/domain/commandTypes';

describe('ECE04 — Refreshed Connected Demo Dataset & Master Conventions', () => {
  it('1. Connected createSeedState() is deterministic and versioned ece-accounting-demo-v1', () => {
    const seed1 = createSeedState();
    const seed2 = createSeedState();

    expect(seed1.demoFixtureVersion).toBe(DEMO_FIXTURE_VERSION);
    expect(seed1.demoFixtureVersion).toBe('ece-accounting-demo-v1');
    expect(seed2.demoFixtureVersion).toBe('ece-accounting-demo-v1');

    const digest1 = computeDatasetDigest(seed1);
    const digest2 = computeDatasetDigest(seed2);

    expect(digest1).toBe(digest2);
    expect(digest1).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(seed1)).toBe(JSON.stringify(seed2));
  });

  it('2. All 7 master-data conventions have zero dashes and safe counters above seeded data', () => {
    const seed = createSeedState();

    for (const kind of MASTER_KINDS) {
      const policy = numberingPolicy(seed, WORKSPACE_A, kind);
      expect(policy.prefix).not.toContain('-');
      expect(isMasterKind(kind)).toBe(true);

      const existingCodes = codesForKind(seed, WORKSPACE_A, kind);
      expect(existingCodes.length).toBeGreaterThan(0);

      // Verify policy.nextNumber is strictly above every matching numeric suffix
      const pattern = new RegExp(`^${policy.prefix}(\\d+)$`, 'i');
      for (const code of existingCodes) {
        const match = pattern.exec(code);
        if (match) {
          const num = Number(match[1]);
          expect(policy.nextNumber).toBeGreaterThan(num);
        }
      }

      // Allocating the next code allocates above seeded data without collision
      const draft = createDraft(seed);
      const allocated = allocateCode(draft, WORKSPACE_A, kind);
      expect(allocated.ok).toBe(true);
      if (allocated.ok) {
        expect(existingCodes).not.toContain(allocated.value);
        expect(allocated.value).toBe(formatNumber(policy, policy.nextNumber));
      }
    }

    // Specific expected next codes in Company A:
    // Accounts: A131 (seeded A100..A130)
    expect(numberingPolicy(seed, WORKSPACE_A, 'account').nextNumber).toBe(131);
    // Contacts: C104 (seeded C100..C103)
    expect(numberingPolicy(seed, WORKSPACE_A, 'contact').nextNumber).toBe(104);
    // Employees: 5003 (seeded 5000..5002)
    expect(numberingPolicy(seed, WORKSPACE_A, 'employee').nextNumber).toBe(5003);
    // Items: I102 (seeded I100..I101)
    expect(numberingPolicy(seed, WORKSPACE_A, 'item').nextNumber).toBe(102);
    // Locations: L102 (seeded L100..L101)
    expect(numberingPolicy(seed, WORKSPACE_A, 'location').nextNumber).toBe(102);
    // Assets: FA101 (seeded FA100)
    expect(numberingPolicy(seed, WORKSPACE_A, 'asset').nextNumber).toBe(101);
    // Bank accounts: B101 (seeded B100)
    expect(numberingPolicy(seed, WORKSPACE_A, 'bank_account').nextNumber).toBe(101);
  });

  it('3. All 5 Trial Balance source books are populated, nonzero, and balanced in Company A', () => {
    const seed = createSeedState();
    const tb = trialBalance(seed, WORKSPACE_A, null, '2026-11-30');

    expect(tb.balanced).toBe(true);
    expect(tb.includedJournalCount).toBeGreaterThanOrEqual(14);

    const expectedBooks = ['sales', 'collections', 'purchases', 'cash_disbursements', 'journals'] as const;
    for (const book of expectedBooks) {
      const bookTotal = tb.bookTotals[book];
      expect(bookTotal, `Book ${book} totals defined`).toBeDefined();
      expect(bookTotal.debitCentavos, `Book ${book} has nonzero debit`).toBeGreaterThan(0);
      expect(bookTotal.creditCentavos, `Book ${book} has nonzero credit`).toBeGreaterThan(0);
      expect(bookTotal.debitCentavos, `Book ${book} is debit-credit balanced`).toBe(bookTotal.creditCentavos);
    }

    expect(tb.grossTotals.debitCentavos).toBeGreaterThan(0);
    expect(tb.grossTotals.debitCentavos).toBe(tb.grossTotals.creditCentavos);
    expect(tb.classificationExceptions).toHaveLength(0);

    // Every journal in candidate state must be balanced and have valid sourceProvenance
    for (const j of seed.journals) {
      const debits = j.lines.reduce((sum, l) => sum + l.debitCentavos, 0);
      const credits = j.lines.reduce((sum, l) => sum + l.creditCentavos, 0);
      expect(debits).toBe(credits);
      expect(debits).toBeGreaterThan(0);
      expect(j.sourceProvenance).toBeDefined();
      expect(j.sourceProvenance?.version).toBe(1);
    }
  });

  it('4. Company B has independent numbering counters (5002, I101, L101) and standalone inventory with zero GL journals', () => {
    const seed = createSeedState();

    expect(numberingPolicy(seed, WORKSPACE_B, 'employee').nextNumber).toBe(5002);
    expect(numberingPolicy(seed, WORKSPACE_B, 'item').nextNumber).toBe(101);
    expect(numberingPolicy(seed, WORKSPACE_B, 'location').nextNumber).toBe(101);

    // Movements in Company B
    const bMovements = seed.movements.filter((m) => m.workspaceId === WORKSPACE_B);
    expect(bMovements.length).toBeGreaterThanOrEqual(1);
    expect(bMovements[0]?.movementNo).toBe('MVT-0001');

    // Zero GL journals in Company B (standalone inventory precedes accounting activation)
    const bJournals = seed.journals.filter((j) => j.workspaceId === WORKSPACE_B);
    expect(bJournals).toHaveLength(0);

    const wsB = seed.workspaces.find((w) => w.id === WORKSPACE_B)!;
    expect(wsB.entitlements.accounting.active).toBe(false);
    expect(wsB.entitlements.inventory.active).toBe(true);
    expect(wsB.entitlements.payroll.active).toBe(true);
  });

  it('5. Master code enforcement: rejects dashed prefixes, duplicates, unauthorized edits, preview no-op, and prospective series', () => {
    const seed = createSeedState();

    // 1. Rejects dashed prefixes on master data
    for (const kind of MASTER_KINDS) {
      const invalid = validatePolicyInput(seed, WORKSPACE_A, kind, {
        prefix: `${kind.slice(0, 2).toUpperCase()}-`,
        nextNumber: 500,
        minDigits: 0,
        increment: 1,
        manualOverride: false,
      });
      expect(invalid.ok).toBe(false);
      if (!invalid.ok) {
        expect(invalid.error.message).toMatch(/without dashes/i);
      }
    }

    // 2. Denies unauthorized actor u-maker from configuring numbering policies
    const clock = createFixedClock({ nowIso: DEMO_NOW, today: DEMO_TODAY, seed: 'auth-test' });
    const envelope: CommandEnvelope = {
      workspaceId: WORKSPACE_A,
      actorId: 'u-maker',
      idempotencyKey: 'unauth-policy-change',
      expectedRevision: seed.revision,
      command: {
        type: 'numbering.policyUpdate',
        input: {
          kind: 'account',
          prefix: 'A',
          nextNumber: 200,
          minDigits: 0,
          increment: 1,
          manualOverride: false,
          reason: 'Unauthorized test',
        },
      },
    };
    const denied = executeCommand(seed, envelope, clock);
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.error.code).toBe('FORBIDDEN');
    }

    // 3. previewCodes does NOT consume a number
    const beforePreview = numberingPolicy(seed, WORKSPACE_A, 'account').nextNumber;
    const preview = previewCodes(seed, WORKSPACE_A, 'account', 3);
    expect(preview).toEqual(['A131', 'A132', 'A133']);
    expect(numberingPolicy(seed, WORKSPACE_A, 'account').nextNumber).toBe(beforePreview);

    // 4. Authoritative employee numbering policy change to an unused range (prefix 'E', minDigits 4, nextNumber 9000)
    const adminEnvelope: CommandEnvelope = {
      workspaceId: WORKSPACE_A,
      actorId: 'u-owner',
      idempotencyKey: 'prospective-policy-change',
      expectedRevision: seed.revision,
      command: {
        type: 'numbering.policyUpdate',
        input: {
          kind: 'employee',
          prefix: 'E',
          nextNumber: 9000,
          minDigits: 4,
          increment: 1,
          manualOverride: false,
          reason: 'Apply a common series to employee masters',
        },
      },
    };
    const policyUpdated = executeCommand(seed, adminEnvelope, clock);
    expect(policyUpdated.ok).toBe(true);
    if (policyUpdated.ok) {
      const updatedState = policyUpdated.value.state;
      // Company A's current masters follow the policy; Company B stays independent.
      expect(updatedState.employees.filter((e) => e.workspaceId === WORKSPACE_A).map((e) => e.employeeNo)).toEqual(['E9000', 'E9001', 'E9002']);
      expect(updatedState.employees.filter((e) => e.workspaceId === WORKSPACE_B).map((e) => e.employeeNo)).toEqual(seed.employees.filter((e) => e.workspaceId === WORKSPACE_B).map((e) => e.employeeNo));

      // Next allocation follows the recoded reservations.
      const draft = createDraft(updatedState);
      const allocated = allocateCode(draft, WORKSPACE_A, 'employee');
      expect(allocated.ok).toBe(true);
      if (allocated.ok) expect(allocated.value).toBe('E9003');
    }
  });

  it('6. Atomic resetState: atomic setItem, preserves other storage keys, recovers on write failure, aborts on corrupt candidate', () => {
    // 1. Preserves unrelated storage keys and does NOT call removeItem or clear
    const initialStorage: Record<string, string> = {
      [STORAGE_KEY]: JSON.stringify(createBaseSeedState()),
      'unrelated-key': 'keep-me',
      'user-profile:theme': 'brutalist-dark',
    };
    const storage = createMemoryStorage(initialStorage);

    const removeItemSpy = vi.spyOn(storage, 'removeItem');
    const setItemSpy = vi.spyOn(storage, 'setItem');

    const result = resetState(storage);
    expect(result.ok).toBe(true);
    expect(result.saved).toBe(true);
    expect(result.state.demoFixtureVersion).toBe(DEMO_FIXTURE_VERSION);

    // Verify removeItem was NEVER called
    expect(removeItemSpy).not.toHaveBeenCalled();
    // Verify setItem was called exactly once for STORAGE_KEY
    expect(setItemSpy).toHaveBeenCalledTimes(1);
    expect(setItemSpy).toHaveBeenCalledWith(STORAGE_KEY, expect.any(String));

    // Verify unrelated keys are 100% preserved
    expect(storage.getItem('unrelated-key')).toBe('keep-me');
    expect(storage.getItem('user-profile:theme')).toBe('brutalist-dark');

    // 2. Write failure safety: when setItem throws, previous snapshot remains intact and saved: false returned
    const savedSnapshot = storage.getItem(STORAGE_KEY)!;
    const failingStorage = {
      getItem: (key: string) => (key === STORAGE_KEY ? savedSnapshot : null),
      setItem: () => {
        throw new Error('QuotaExceededError: LocalStorage quota exceeded');
      },
      removeItem: () => {
        throw new Error('Should not be called');
      },
    };

    const failResult = resetState(failingStorage);
    expect(failResult.ok).toBe(false);
    expect(failResult.saved).toBe(false);
    expect(failResult.error).toContain('QuotaExceededError');
    // Prior stored snapshot is 100% intact
    expect(failingStorage.getItem(STORAGE_KEY)).toBe(savedSnapshot);

    // 3. Validation safety: when candidateFactory produces an unbalanced snapshot, resetState aborts before touching storage
    const touchedStorage = createMemoryStorage({ [STORAGE_KEY]: savedSnapshot });
    const touchedSetItemSpy = vi.spyOn(touchedStorage, 'setItem');

    const corruptFactory = () => {
      const corrupt = createBaseSeedState();
      // Unbalance opening journal: Dr 1,000,000 != Cr 2,000,000
      corrupt.journals[0]!.lines[0]!.debitCentavos = 999_999_999;
      return corrupt;
    };

    const corruptResult = resetState(touchedStorage, corruptFactory);
    expect(corruptResult.ok).toBe(false);
    expect(corruptResult.saved).toBe(false);
    expect(corruptResult.error).toContain('not balanced');
    // Storage setItem was NEVER called
    expect(touchedSetItemSpy).not.toHaveBeenCalled();
    // Prior saved snapshot is 100% intact
    expect(touchedStorage.getItem(STORAGE_KEY)).toBe(savedSnapshot);
  });

  it('7. validateStateSnapshot validates balanced journals and numbering reservations', () => {
    const valid = createSeedState();
    const result = validateStateSnapshot(valid);
    expect(result.ok).toBe(true);

    // Unbalanced journal
    const unbalanced = structuredClone(valid);
    unbalanced.journals[0]!.lines[0]!.debitCentavos += 1;
    const unbalancedResult = validateStateSnapshot(unbalanced);
    expect(unbalancedResult.ok).toBe(false);
    if (!unbalancedResult.ok) expect(unbalancedResult.error).toContain('not balanced');

    // Missing sourceProvenance
    const missingProv = structuredClone(valid);
    delete (missingProv.journals[0] as unknown as Record<string, unknown>).sourceProvenance;
    const provResult = validateStateSnapshot(missingProv);
    expect(provResult.ok).toBe(false);

    // Numbering reservation collision (policy nextNumber <= existing code suffix)
    const collided = structuredClone(valid);
    const pol = collided.numberingPolicies.find((p) => p.workspaceId === WORKSPACE_A && p.kind === 'invoice')!;
    pol.nextNumber = 1; // INV-0001 already exists in ws-a
    const collisionResult = validateStateSnapshot(collided);
    expect(collisionResult.ok).toBe(false);
    if (!collisionResult.ok) expect(collisionResult.error).toContain('not strictly greater than existing code suffix');
  });
});
