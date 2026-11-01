import { describe, expect, it } from 'vitest';
import {
  accessibleWorkspaces,
  entitlementStatus,
  hasPayrollDetail,
  requirePayrollDetail,
  requireProduct,
  resolveAccess,
} from '../../src/domain/shared/access';
import { executeCommand } from '../../src/domain/commands';
import { createFixedClock } from '../../src/domain/shared/clock';
import { payrollDetailVisible } from '../../src/domain/payroll';
import { stockValuation } from '../../src/domain/queries';
import type { AppState } from '../../src/domain/schema';
import type { WriteContext } from '../../src/domain/ledger';
import {
  DEMO_NOW,
  DEMO_TODAY,
  createSeedState,
  WORKSPACE_A,
  WORKSPACE_B,
} from '../../src/fixtures/seed';
import { createHarness } from './harness';

function context(state: AppState, actorId: string, workspaceId: string, today = DEMO_TODAY): WriteContext {
  const access = resolveAccess(state, actorId, workspaceId, today);
  if (!access.ok) throw new Error(access.error.message);
  return {
    ...access.value,
    clock: createFixedClock({ nowIso: DEMO_NOW, today, seed: 'access' }),
  };
}

describe('membership, roles and product entitlements', () => {
  it('switches only between companies where the actor has an active membership', () => {
    const state = createSeedState();
    expect(accessibleWorkspaces(state, 'u-accountant').map((workspace) => workspace.id)).toEqual([WORKSPACE_A]);
    expect(accessibleWorkspaces(state, 'u-owner').map((workspace) => workspace.id)).toEqual([WORKSPACE_A]);
    expect(accessibleWorkspaces(state, 'u-badmin').map((workspace) => workspace.id)).toEqual([WORKSPACE_B]);
    expect(accessibleWorkspaces(state, 'u-payroll').map((workspace) => workspace.id)).toEqual([WORKSPACE_A]);
  });

  it('rejects a workspace with no membership and an inactive membership', () => {
    const state = createSeedState();
    expect(resolveAccess(state, 'u-badmin', WORKSPACE_A, DEMO_TODAY).ok).toBe(false);
    const inactive = createSeedState();
    const membership = inactive.memberships.find((candidate) => candidate.userId === 'u-maker')!;
    membership.active = false;
    const denied = resolveAccess(inactive, 'u-maker', WORKSPACE_A, DEMO_TODAY);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe('FORBIDDEN');
  });

  it('separates the payroll-detail grant from admin and accounting roles', () => {
    const state = createSeedState();
    expect(hasPayrollDetail(state.memberships.find((membership) => membership.userId === 'u-accountant')!)).toBe(false);
    expect(hasPayrollDetail(state.memberships.find((membership) => membership.userId === 'u-owner')!)).toBe(true);
    expect(hasPayrollDetail(state.memberships.find((membership) => membership.userId === 'u-payroll')!)).toBe(true);

    const accountant = context(state, 'u-accountant', WORKSPACE_A);
    expect(payrollDetailVisible(accountant)).toBe(false);
    const denied = requirePayrollDetail(accountant);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe('FORBIDDEN');

    const payrollOfficer = context(state, 'u-payroll', WORKSPACE_A);
    expect(payrollDetailVisible(payrollOfficer)).toBe(true);
    expect(requirePayrollDetail(payrollOfficer).ok).toBe(true);
  });

  it('reports active, inactive and expired entitlements distinctly', () => {
    const state = createSeedState();
    const workspaceB = state.workspaces.find((workspace) => workspace.id === WORKSPACE_B)!;
    expect(entitlementStatus(workspaceB.entitlements.accounting, DEMO_TODAY)).toBe('inactive');
    expect(entitlementStatus(workspaceB.entitlements.payroll, DEMO_TODAY)).toBe('active');
    expect(entitlementStatus(workspaceB.entitlements.payroll, '2027-01-02')).toBe('expired');

    const active = context(state, 'u-bpayroll', WORKSPACE_B);
    expect(requireProduct(active, 'payroll').ok).toBe(true);
    const accounting = requireProduct(active, 'accounting');
    expect(accounting.ok).toBe(false);
    if (!accounting.ok) expect(accounting.error.code).toBe('NOT_ENTITLED');

    const expired = context(state, 'u-bpayroll', WORKSPACE_B, '2027-01-02');
    const expiredProduct = requireProduct(expired, 'payroll');
    expect(expiredProduct.ok).toBe(false);
    if (!expiredProduct.ok) expect(expiredProduct.error.code).toBe('ENTITLEMENT_EXPIRED');
  });

  it('keeps data readable after payroll expiry while refusing a write', () => {
    const state = createSeedState();
    const today = '2027-01-02';
    const clock = createFixedClock({ nowIso: '2027-01-02T09:00:00.000Z', today, seed: 'expired' });
    const valuationBefore = stockValuation(state, WORKSPACE_B);
    const revision = state.revision;

    const timeImport = executeCommand(
      state,
      {
        workspaceId: WORKSPACE_B,
        actorId: 'u-bpayroll',
        idempotencyKey: 'expired-payroll',
        command: {
          type: 'time.import',
          input: { sourceName: 'expired.csv', rows: [{ employeeId: 'emp-b-001', bucket: 'ordinary_ot', minutes: 60 }] },
        },
      },
      clock,
    );
    expect(timeImport.ok).toBe(false);
    if (!timeImport.ok) expect(timeImport.error.code).toBe('ENTITLEMENT_EXPIRED');
    expect(state.revision).toBe(revision);
    expect(state.timeImports).toHaveLength(0);
    expect(stockValuation(state, WORKSPACE_B)).toEqual(valuationBefore);
  });

  it('runs standalone inventory and payroll without an Accounting entitlement', () => {
    const h = createHarness({ actorId: 'u-binv', workspaceId: WORKSPACE_B });
    h.runOk({
      type: 'movement.receipt',
      input: {
        itemId: 'item-b-1',
        locationId: 'loc-b-main',
        occurredOn: '2026-10-21',
        quantityMilli: 500,
        unitCostCentavos: 10_000,
        sourceType: 'synthetic_receipt',
        sourceId: 'standalone-b',
        effectKey: 'standalone-b',
      },
    });
    expect(h.state.movements.some((movement) => movement.effectKey === 'standalone-b')).toBe(true);
    expect(h.state.workspaces.find((workspace) => workspace.id === WORKSPACE_B)?.entitlements.accounting.active).toBe(
      false,
    );

    const payroll = createHarness({ actorId: 'u-bpayroll', workspaceId: WORKSPACE_B });
    const imported = payroll.runOk({
      type: 'time.import',
      input: { sourceName: 'b-standalone.csv', rows: [{ employeeId: 'emp-b-001', bucket: 'ordinary_ot', minutes: 60 }] },
    });
    const calculated = payroll.runOk({ type: 'payroll.calculate', input: { timeImportId: imported.documentId } });
    const run = payroll.state.payrollRuns.find((candidate) => candidate.id === calculated.documentId)!;
    expect(run.lines).toHaveLength(2);
    expect(run.journalId).toBeNull();
    const blockedPost = payroll.run(
      { type: 'payroll.post', input: { runId: run.id } },
      { actorId: 'u-badmin' },
    );
    expect(blockedPost.ok).toBe(false);
    if (!blockedPost.ok) expect(blockedPost.error.code).toBe('NOT_ENTITLED');
  });
});
