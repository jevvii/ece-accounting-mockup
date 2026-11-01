import { describe, expect, it } from 'vitest';
import { createBaseSeedState, createSeedState, WORKSPACE_A, WORKSPACE_B } from '../../src/fixtures/seed';
import { createMemoryStorage, loadState, STORAGE_KEY } from '../../src/adapters/storage';
import { codesForKind, MASTER_KINDS, numberingPolicy } from '../../src/domain/numbering';
import { createHarness } from './harness';
import { appStateSchema } from '../../src/domain/schema';

describe('master numbering policies are authoritative', () => {
  it('repairs saved legacy master codes without replacing transactions or posted snapshots', () => {
    const state = createSeedState();
    state.accounts[0]!.code = '1010';
    state.contacts[0]!.contactNo = 'OLD-CONTACT';
    state.employees[0]!.employeeNo = 'EMP-001';
    state.items[0]!.itemNo = 'OLD-ITEM';
    state.locations[0]!.code = 'OLD-LOCATION';
    state.assets[0]!.assetNo = 'FA-0001';
    state.bankAccounts[0]!.bankCode = 'OLD-BANK';
    const originalJournals = appStateSchema.parse(state).journals;
    const originalInvoices = structuredClone(state.invoices);
    const companyB = JSON.stringify(state.accounts.filter((row) => row.workspaceId === WORKSPACE_B));
    const ids = state.accounts.map((row) => row.id);
    const storage = createMemoryStorage({ [STORAGE_KEY]: JSON.stringify(state) });

    const result = loadState(storage);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.state.accounts[0]!.code).toBe('A100');
    expect(result.state.contacts[0]!.contactNo).toBe('C100');
    expect(result.state.employees[0]!.employeeNo).toBe('5000');
    expect(result.state.items[0]!.itemNo).toBe('I100');
    expect(result.state.locations[0]!.code).toBe('L100');
    expect(result.state.assets[0]!.assetNo).toBe('FA100');
    expect(result.state.bankAccounts[0]!.bankCode).toBe('B100');
    expect(result.state.accounts.map((row) => row.id)).toEqual(ids);
    expect(result.state.journals).toEqual(originalJournals);
    expect(result.state.invoices).toEqual(originalInvoices);
    expect(JSON.stringify(result.state.accounts.filter((row) => row.workspaceId === WORKSPACE_B))).toBe(companyB);
    expect(loadState(storage)).toEqual(result);
  });

  it('repairs the screenshot case and reserves the next account code above every current master', () => {
    const state = createBaseSeedState();
    const a = state.accounts.filter((row) => row.workspaceId === WORKSPACE_A);
    a.forEach((row, index) => { row.code = String(1010 + index); });
    state.numberingPolicies.find((row) => row.workspaceId === WORKSPACE_A && row.kind === 'account')!.nextNumber = 100;
    const result = loadState(createMemoryStorage({ [STORAGE_KEY]: JSON.stringify(state) }));
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(codesForKind(result.state, WORKSPACE_A, 'account')).toEqual(a.map((_, index) => `A${100 + index}`));
    expect(numberingPolicy(result.state, WORKSPACE_A, 'account').nextNumber).toBe(131);
  });

  it('applies changed master conventions to existing records and keeps postings unchanged', () => {
    const h = createHarness();
    const journals = JSON.stringify(h.state.journals);
    const ids = h.state.accounts.map((row) => row.id);
    h.runOk({ type: 'numbering.policyUpdate', input: {
      kind: 'account', prefix: 'GL', nextNumber: 500, minDigits: 4, increment: 5,
      manualOverride: false, reason: 'Accountant selected a common coding convention',
    }});
    const a = h.state.accounts.filter((row) => row.workspaceId === WORKSPACE_A);
    expect(a[0]!.code).toBe('GL0500');
    expect(a[1]!.code).toBe('GL0505');
    expect(numberingPolicy(h.state, WORKSPACE_A, 'account').nextNumber).toBe(655);
    expect(h.state.accounts.map((row) => row.id)).toEqual(ids);
    expect(JSON.stringify(h.state.journals)).toBe(journals);
    const created = h.runOk({ type: 'account.create', input: {
      code: '', name: 'Policy controlled account', type: 'asset', normalBalance: 'debit',
    }});
    expect(h.state.accounts.find((row) => row.id === created.documentId)?.code).toBe('GL0655');
  });

  it('rejects manual codes outside the policy and reserves a valid manual selection', () => {
    const h = createHarness();
    h.runOk({ type: 'numbering.policyUpdate', input: {
      kind: 'account', prefix: 'A', nextNumber: 100, minDigits: 0, increment: 1,
      manualOverride: true, reason: 'Allow selecting an unused code within policy',
    }});
    const before = h.state;
    const invalid = h.run({ type: 'account.create', input: {
      code: 'NOT-A-CODE', name: 'Invalid manual number', type: 'asset', normalBalance: 'debit',
    }});
    expect(invalid.ok).toBe(false);
    expect(h.state).toBe(before);
    const created = h.runOk({ type: 'account.create', input: {
      code: 'A900', name: 'Valid manual selection', type: 'asset', normalBalance: 'debit',
    }});
    expect(h.state.accounts.find((row) => row.id === created.documentId)?.code).toBe('A900');
    expect(numberingPolicy(h.state, WORKSPACE_A, 'account').nextNumber).toBe(901);
  });

  it('keeps every master policy authoritative in each company on persisted reload', () => {
    const state = createSeedState();
    const result = loadState(createMemoryStorage({ [STORAGE_KEY]: JSON.stringify(state) }));
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    for (const workspace of [WORKSPACE_A, WORKSPACE_B]) {
      for (const kind of MASTER_KINDS) {
        const policy = numberingPolicy(result.state, workspace, kind);
        for (const code of codesForKind(result.state, workspace, kind)) {
          expect(code.startsWith(policy.prefix)).toBe(true);
          const number = Number(code.slice(policy.prefix.length));
          expect(number).toBeGreaterThanOrEqual(policy.startNumber);
          expect((number - policy.startNumber) % policy.increment).toBe(0);
          expect(policy.nextNumber).toBeGreaterThan(number);
        }
      }
    }
  });

  it('aligns a stored counter to the configured increment instead of generating off-grid codes', () => {
    const state = createBaseSeedState();
    const policy = state.numberingPolicies.find((row) => row.workspaceId === WORKSPACE_A && row.kind === 'account')!;
    policy.increment = 5;
    policy.nextNumber = 1002;
    const result = loadState(createMemoryStorage({ [STORAGE_KEY]: JSON.stringify(state) }));
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(numberingPolicy(result.state, WORKSPACE_A, 'account').nextNumber).toBe(1005);
  });

  it('a changed starting number rebases existing masters even when old codes fit the wider new range', () => {
    const h = createHarness();
    h.runOk({ type: 'numbering.policyUpdate', input: {
      kind: 'account', prefix: 'A', nextNumber: 50, minDigits: 0, increment: 1,
      manualOverride: false, reason: 'Accountant selected a lower starting number',
    }});
    expect(codesForKind(h.state, WORKSPACE_A, 'account')).toEqual(Array.from({ length: 31 }, (_, index) => `A${50 + index}`));
    expect(numberingPolicy(h.state, WORKSPACE_A, 'account').nextNumber).toBe(81);
  });
});
