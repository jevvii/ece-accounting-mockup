import { describe, expect, it } from 'vitest';
import { createBaseSeedState, createSeedState, WORKSPACE_A, WORKSPACE_B } from '../../src/fixtures/seed';
import { createHarness } from './harness';
import { allocateCode, numberingPolicy, previewCodes, type RecordKind } from '../../src/domain/numbering';
import { createDraft } from '../../src/domain/shared/draft';
import { migrateStoredState } from '../../src/domain/migration';

function policyCommand(kind: RecordKind, nextNumber: number, extra: Record<string, unknown> = {}) {
  return {
    type: 'numbering.policyUpdate' as const,
    input: {
      kind,
      prefix: kind === 'account' ? 'A' : kind === 'asset' ? 'FA' : '',
      nextNumber,
      minDigits: 0,
      increment: 1,
      manualOverride: false,
      reason: 'Synthetic remediation test',
      ...extra,
    },
  };
}

function v1Snapshot(): Record<string, unknown> {
  const state = JSON.parse(JSON.stringify(createBaseSeedState())) as Record<string, unknown>;
  state.schemaVersion = 1;
  delete state.numberingPolicies;
  const contacts = state.contacts as Array<Record<string, unknown>>;
  const items = state.items as Array<Record<string, unknown>>;
  const movements = state.movements as Array<Record<string, unknown>>;
  const statements = state.bankStatements as Array<Record<string, unknown>>;
  const worksheets = state.worksheets as Array<Record<string, unknown>>;
  const liquidations = state.liquidations as Array<Record<string, unknown>>;
  const bankAccounts = state.bankAccounts as Array<Record<string, unknown>>;
  const taxRecords = state.taxRecords as Array<Record<string, unknown>>;
  for (const row of contacts) delete row.contactNo;
  for (const row of items) delete row.itemNo;
  for (const row of movements) delete row.movementNo;
  for (const row of statements) delete row.statementNo;
  for (const row of worksheets) delete row.worksheetNo;
  for (const row of liquidations) delete row.liquidationNo;
  for (const row of bankAccounts) delete row.bankCode;
  for (const row of taxRecords) delete row.publicNo;
  return state;
}

describe('R05 — one per-company numbering service', () => {
  it('allocates configured A100/A101 accounts and 5000/5001 employees after an explicit empty-namespace policy', () => {
    const seed = createSeedState();
    seed.accounts = seed.accounts.filter((row) => row.workspaceId !== WORKSPACE_A);
    seed.employees = seed.employees.filter((row) => row.workspaceId !== WORKSPACE_A);
    const h = createHarness({ state: seed });
    h.runOk(policyCommand('account', 100));
    h.runOk(policyCommand('employee', 5000));
    const firstAccount = h.runOk({
      type: 'account.create',
      input: { code: '', name: 'Synthetic first account', type: 'asset', normalBalance: 'debit' },
    });
    const secondAccount = h.runOk({
      type: 'account.create',
      input: { code: '', name: 'Synthetic second account', type: 'asset', normalBalance: 'debit' },
    });
    const firstEmployee = h.runOk({
      type: 'employee.create',
      input: {
        employeeNo: '',
        name: 'Synthetic employee one',
        monthlySalaryCentavos: 1_500_000,
        hiredOn: '2026-11-01',
        deductionScheduleId: 'ded-a-1',
        branch: 'Main',
        department: 'Operations',
      },
    });
    const secondEmployee = h.runOk({
      type: 'employee.create',
      input: {
        employeeNo: '',
        name: 'Synthetic employee two',
        monthlySalaryCentavos: 1_500_000,
        hiredOn: '2026-11-01',
        deductionScheduleId: 'ded-a-1',
        branch: 'Main',
        department: 'Operations',
      },
    });
    expect(h.state.accounts.find((row) => row.id === firstAccount.documentId)?.code).toBe('A100');
    expect(h.state.accounts.find((row) => row.id === secondAccount.documentId)?.code).toBe('A101');
    expect(h.state.employees.find((row) => row.id === firstEmployee.documentId)?.employeeNo).toBe('5000');
    expect(h.state.employees.find((row) => row.id === secondEmployee.documentId)?.employeeNo).toBe('5001');
    expect(previewCodes(h.state, WORKSPACE_A, 'account')).toEqual(['A102', 'A103', 'A104']);
  });

  it('applies explicit padding to existing masters and keeps company-local counters', () => {
    const h = createHarness();
    h.runOk(policyCommand('account', 100, { minDigits: 4 }));
    const created = h.runOk({
      type: 'account.create',
      input: { code: '', name: 'Padded account', type: 'asset', normalBalance: 'debit' },
    });
    expect(h.state.accounts.find((row) => row.id === created.documentId)?.code).toBe('A0131');
    const existing = h.state.accounts.find((row) => row.id === created.documentId)!;
    h.runOk(policyCommand('account', 200, { minDigits: 6, prefix: 'ACCT' }));
    expect(h.state.accounts.find((row) => row.id === created.documentId)?.code).toBe('ACCT000231');
    expect(existing.code).toBe('A0131');
    const next = h.runOk({
      type: 'account.create',
      input: { code: '', name: 'Changed convention', type: 'asset', normalBalance: 'debit' },
    });
    expect(h.state.accounts.find((row) => row.id === next.documentId)?.code).toBe('ACCT000232');
    const b = createHarness({ workspaceId: WORKSPACE_B, actorId: 'u-badmin' });
    const bEmployee = b.runOk({
      type: 'employee.create',
      input: {
        employeeNo: '',
        name: 'Company B employee',
        monthlySalaryCentavos: 1_500_000,
        hiredOn: '2026-11-01',
        deductionScheduleId: 'ded-b-1',
        branch: 'Main',
        department: 'Operations',
      },
    });
    expect(b.state.employees.find((row) => row.id === bEmployee.documentId)?.employeeNo).toBe('5002');
  });

  it('reconciles master starts and rejects manual duplicates or exhaustion without consuming a code', () => {
    const h = createHarness();
    const before = numberingPolicy(h.state, WORKSPACE_A, 'account').nextNumber;
    const occupied = h.run(policyCommand('account', 131, { minDigits: 0, prefix: 'A' }));
    // Master policy changes reconcile existing codes and reserve a safe next value.
    expect(occupied.ok).toBe(true);
    const collision = h.run(policyCommand('account', 101));
    expect(collision.ok).toBe(true);
    expect(numberingPolicy(h.state, WORKSPACE_A, 'account').nextNumber).toBe(132);
    h.runOk(policyCommand('account', 131, { manualOverride: true }));
    const duplicate = h.run({
      type: 'account.create',
      input: { code: 'A131', name: 'Manual duplicate', type: 'asset', normalBalance: 'debit' },
    });
    expect(duplicate.ok).toBe(false);
    const exhaustedState = structuredClone(h.state);
    const exhaustedPolicy = exhaustedState.numberingPolicies.find(
      (policy) => policy.workspaceId === WORKSPACE_A && policy.kind === 'account',
    )!;
    exhaustedPolicy.nextNumber = Number.MAX_SAFE_INTEGER;
    exhaustedPolicy.manualOverride = false;
    h.setState(exhaustedState);
    const beforeExhaustion = numberingPolicy(h.state, WORKSPACE_A, 'account').nextNumber;
    const exhausted = h.run({
      type: 'account.create',
      input: { code: '', name: 'No room', type: 'asset', normalBalance: 'debit' },
    });
    expect(exhausted.ok).toBe(false);
    expect(numberingPolicy(h.state, WORKSPACE_A, 'account').nextNumber).toBe(beforeExhaustion);
    expect(beforeExhaustion).toBeGreaterThanOrEqual(before);
  });

  it('disallows dashed prefixes on master data kinds while permitting them on documents', () => {
    const h = createHarness();
    const accountDashed = h.run(policyCommand('account', 200, { prefix: 'ACCT-' }));
    expect(accountDashed.ok).toBe(false);
    if (!accountDashed.ok) {
      expect(accountDashed.error.code).toBe('VALIDATION');
      expect(accountDashed.error.field).toBe('prefix');
      expect(accountDashed.error.message).toMatch(/without dashes/);
    }

    const assetDashed = h.run(policyCommand('asset', 200, { prefix: 'FA-' }));
    expect(assetDashed.ok).toBe(false);
    if (!assetDashed.ok) {
      expect(assetDashed.error.code).toBe('VALIDATION');
      expect(assetDashed.error.field).toBe('prefix');
      expect(assetDashed.error.message).toMatch(/without dashes/);
    }

    const invoiceDashed = h.run(policyCommand('invoice', 200, { prefix: 'INV-' }));
    expect(invoiceDashed.ok).toBe(true);
  });

  it('allocates in the command draft, so idempotent and same-source retries do not duplicate codes', () => {
    const h = createHarness();
    const first = h.runOk(
      {
        type: 'movement.receipt',
        input: {
          itemId: 'item-a-1',
          locationId: 'loc-a-main',
          occurredOn: '2026-11-01',
          quantityMilli: 1000,
          unitCostCentavos: 1000,
          effectKey: 'synthetic:numbering-retry',
        },
      },
      { key: 'same-key' },
    );
    const movement = h.state.movements.find((row) => row.id === first.documentId)!;
    const nextAfterFirst = numberingPolicy(h.state, WORKSPACE_A, 'inventory_movement').nextNumber;
    const retriedSameKey = h.runOk(
      {
        type: 'movement.receipt',
        input: {
          itemId: 'item-a-1',
          locationId: 'loc-a-main',
          occurredOn: '2026-11-01',
          quantityMilli: 1000,
          unitCostCentavos: 1000,
          effectKey: 'synthetic:numbering-retry',
        },
      },
      { key: 'same-key' },
    );
    expect(retriedSameKey.documentId).toBe(first.documentId);
    expect(h.state.movements.filter(
      (row) => row.workspaceId === WORKSPACE_A && row.movementNo === movement.movementNo,
    )).toHaveLength(1);
    expect(numberingPolicy(h.state, WORKSPACE_A, 'inventory_movement').nextNumber).toBe(nextAfterFirst);

    const retriedNewKey = h.run(
      {
        type: 'movement.receipt',
        input: {
          itemId: 'item-a-1',
          locationId: 'loc-a-main',
          occurredOn: '2026-11-01',
          quantityMilli: 1000,
          unitCostCentavos: 1000,
          effectKey: 'synthetic:numbering-retry',
        },
      },
      { key: 'new-request-key' },
    );
    expect(retriedNewKey.ok).toBe(false);
    expect(numberingPolicy(h.state, WORKSPACE_A, 'inventory_movement').nextNumber).toBe(nextAfterFirst);
  });

  it('allocates two distinct journal codes inside one compound posting command', () => {
    const h = createHarness();
    for (const [index, code] of ['Synthetic machine one', 'Synthetic machine two'].entries()) {
      h.runOk({
        type: 'asset.create',
        input: {
          companyVendorBrand: `Demo vendor ${index}`,
          purchaseDate: '2026-11-01',
          description: code,
          serialNo: `SN-${index}`,
          assetAccountId: 'acc-ws-a-1500',
          costCentavos: 120_000,
          usefulLifeYears: 5,
          residualValueCentavos: 0,
          depreciationStart: '2026-11-01',
          convention: 'full_month',
          depreciationExpenseAccountId: 'acc-ws-a-6050',
          accumulatedDepreciationAccountId: 'acc-ws-a-1590',
          sourceType: 'direct_purchase',
          sourceId: null,
          postAcquisition: false,
        },
      });
    }
    h.runOk({ type: 'depreciation.calculate', input: { period: '2026-11' } });
    h.runOk({ type: 'depreciation.approve', input: { period: '2026-11' } }, { actorId: 'u-checker' });
    const posted = h.runOk({ type: 'depreciation.post', input: { period: '2026-11' } });
    expect(new Set(posted.journalIds).size).toBe(posted.journalIds.length);
    const codes = posted.journalIds.map(
      (id) => h.state.journals.find((journal) => journal.id === id)?.journalNo,
    );
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('enforces privileged policy changes and product-specific standalone ownership', () => {
    const h = createHarness({ actorId: 'u-maker' });
    const denied = h.run(policyCommand('account', 200));
    expect(denied.ok).toBe(false);
    const clerk = createHarness({ actorId: 'u-payroll' });
    const payrollPolicy = clerk.runOk(policyCommand('employee', 6000));
    expect(payrollPolicy.summary).toContain('Employees numbering');
    const accountingDenied = clerk.run(policyCommand('account', 200));
    expect(accountingDenied.ok).toBe(false);
    const b = createHarness({ workspaceId: WORKSPACE_B, actorId: 'u-bpayroll' });
    expect(b.state.workspaces.find((row) => row.id === WORKSPACE_B)?.entitlements.accounting.active).toBe(false);
    const standalone = b.runOk(policyCommand('employee', 6000));
    expect(standalone.documentType).toBe('numbering_policy');
  });
});

describe('R05 — deterministic v1 to v2 migration', () => {
  it('reconciles current master codes while preserving IDs, posted snapshots, balances, source keys and idempotency', () => {
    const raw = v1Snapshot();
    raw.accounts = (raw.accounts as Array<Record<string, unknown>>).map((account) => ({
      ...account,
      code: account.id === 'acc-ws-a-1020' ? '1020' : account.code,
    }));
    const opening = ((raw.journals as Array<Record<string, unknown>>).find(
      (row) => row.id === 'jv-a-opening',
    )!.lines as Array<Record<string, unknown>>);
    opening[0].accountCode = '1020';
    opening[1].accountCode = '3010';
    const result = migrateStoredState(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.migrated).toBe(true);
    expect(result.state.schemaVersion).toBe(2);
    expect(result.state.accounts.find((row) => row.id === 'acc-ws-a-1020')?.code).toBe('A101');
    expect(result.state.employees.find((row) => row.id === 'emp-a-001')?.employeeNo).toBe('5000');
    expect(result.state.journals.find((row) => row.id === 'jv-a-opening')?.journalNo).toBe('JV-00001');
    expect(result.state.journals.find((row) => row.id === 'jv-a-opening')?.lines[0].accountCode).toBe('1020');
    expect(result.state.sourceEffects[`${WORKSPACE_A}:opening:initial-equity`]).toBeDefined();
    expect(result.state.contacts.find((row) => row.id === 'contact-a-cust-1')?.contactNo).toBeTruthy();
    expect(result.state.items.find((row) => row.id === 'item-a-1')?.itemNo).toBeTruthy();
    expect(result.state.bankAccounts.find((row) => row.id === 'bank-a-1')?.bankCode).toBeTruthy();
    expect(result.state.numberingPolicies.length).toBeGreaterThan(0);
    const again = migrateStoredState(raw);
    expect(again.ok).toBe(true);
    if (again.ok) expect(JSON.stringify(again.state)).toBe(JSON.stringify(result.state));
  });

  it('reports newer or corrupt snapshots without replacing raw data', () => {
    const future = migrateStoredState({ schemaVersion: 99 });
    expect(future.ok).toBe(false);
    if (!future.ok) expect(future.reason).toBe('unsupported_version');
    const shape = migrateStoredState({ schemaVersion: 1, workspaces: [] });
    expect(shape.ok).toBe(false);
    if (!shape.ok) expect(shape.reason).toBe('invalid_shape');
    expect(allocateCode(createDraft(createSeedState()), WORKSPACE_A, 'account').ok).toBe(true);
  });
});
