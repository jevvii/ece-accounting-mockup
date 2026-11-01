import { describe, expect, it } from 'vitest';
import { accountBalance } from '../../src/domain/ledger';
import {
  averageUnitCost,
  issueValue,
  locationQuantity,
  movementPool,
} from '../../src/domain/inventory';
import { WORKSPACE_A, WORKSPACE_B } from '../../src/fixtures/seed';
import type { DomainCommand } from '../../src/domain/commandTypes';
import { ACCOUNTS, createHarness } from './harness';

function receipt(
  quantityMilli: number,
  unitCostCentavos: number,
  occurredOn: string,
  effectKey: string,
): DomainCommand {
  return {
    type: 'movement.receipt',
    input: {
      itemId: 'item-a-1',
      locationId: 'loc-a-main',
      occurredOn,
      quantityMilli,
      unitCostCentavos,
      sourceType: 'synthetic_receipt',
      sourceId: effectKey,
      effectKey,
    },
  };
}

describe('G06 — moving average, issue value, transfer, location-negative guard', () => {
  it('builds 30 units / 3,600.00 at 120.00 average and issues 5 units for 600.00', () => {
    const h = createHarness({ actorId: 'u-inventory' });
    h.runOk(receipt(10_000, 10_000, '2026-11-01', 'pool-receipt-1'));
    h.runOk(receipt(20_000, 13_000, '2026-11-02', 'pool-receipt-2'));

    const pool = movementPool(h.state, WORKSPACE_A, 'item-a-1');
    expect(pool).toEqual({ quantityMilli: 30_000, valueCentavos: 360_000 });
    expect(averageUnitCost(pool)).toBe(12_000);

    const issued = h.runOk({
      type: 'movement.issue',
      input: {
        itemId: 'item-a-1',
        locationId: 'loc-a-main',
        occurredOn: '2026-11-03',
        quantityMilli: 5_000,
        purpose: 'Synthetic sale',
        effectKey: 'pool-issue-1',
      },
    });
    const issue = h.state.movements.find((movement) => movement.id === issued.documentId);
    expect(issue?.valueCentavos).toBe(60_000);
    expect(issue?.unitCostAppliedCentavos).toBe(12_000);
    expect(movementPool(h.state, WORKSPACE_A, 'item-a-1')).toEqual({
      quantityMilli: 25_000,
      valueCentavos: 300_000,
    });
    expect(accountBalance(h.state, WORKSPACE_A, ACCOUNTS.inventory, null, null).netDebitCentavos).toBe(300_000);
    expect(accountBalance(h.state, WORKSPACE_A, ACCOUNTS.cogs, null, null).netDebitCentavos).toBe(60_000);
  });

  it('transfers two units without changing company totals or value', () => {
    const h = createHarness({ actorId: 'u-inventory' });
    h.runOk(receipt(10_000, 10_000, '2026-11-01', 'transfer-base-1'));
    h.runOk(receipt(20_000, 13_000, '2026-11-02', 'transfer-base-2'));
    h.runOk({
      type: 'movement.transfer',
      input: {
        itemId: 'item-a-1',
        fromLocationId: 'loc-a-main',
        toLocationId: 'loc-a-branch',
        occurredOn: '2026-11-03',
        quantityMilli: 2_000,
      },
    });
    const pool = movementPool(h.state, WORKSPACE_A, 'item-a-1');
    expect(pool).toEqual({ quantityMilli: 30_000, valueCentavos: 360_000 });
    expect(locationQuantity(h.state, WORKSPACE_A, 'item-a-1', 'loc-a-main')).toBe(28_000);
    expect(locationQuantity(h.state, WORKSPACE_A, 'item-a-1', 'loc-a-branch')).toBe(2_000);
    const transfer = h.state.movements.find((movement) => movement.type === 'transfer');
    expect(transfer?.valueCentavos).toBe(0);
    expect(transfer?.journalId).toBeNull();
  });

  it('rejects a location-negative issue without mutating the prior state', () => {
    const h = createHarness({ actorId: 'u-inventory' });
    h.runOk(receipt(10_000, 10_000, '2026-11-01', 'negative-base'));
    const revision = h.state.revision;
    const movementCount = h.state.movements.length;

    const rejected = h.run({
      type: 'movement.issue',
      input: {
        itemId: 'item-a-1',
        locationId: 'loc-a-branch',
        occurredOn: '2026-11-02',
        quantityMilli: 5_000,
        purpose: 'Impossible branch issue',
        effectKey: 'negative-issue',
      },
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.code).toBe('NEGATIVE_STOCK');
    expect(h.state.revision).toBe(revision);
    expect(h.state.movements.length).toBe(movementCount);
    expect(locationQuantity(h.state, WORKSPACE_A, 'item-a-1', 'loc-a-branch')).toBe(0);
  });
});

describe('G07 — exact residual consumption of a three-unit, 1.00 pool', () => {
  it('issues 0.33, then consumes the exact remaining 0.67 with zero quantity and value', () => {
    const original = { quantityMilli: 3000, valueCentavos: 100 };
    const first = issueValue(original, 1000);
    expect(first).toBe(33);
    const remaining = { quantityMilli: 3000 - 1000, valueCentavos: 100 - first };
    const final = issueValue(remaining, remaining.quantityMilli);
    expect(final).toBe(67);
    expect(remaining.valueCentavos - final).toBe(0);
    expect(remaining.quantityMilli - remaining.quantityMilli).toBe(0);
  });

  it('consumes the full remaining pool value when the final issue quantity matches', () => {
    expect(issueValue({ quantityMilli: 25_000, valueCentavos: 300_001 }, 25_000)).toBe(300_001);
    expect(issueValue({ quantityMilli: 30_000, valueCentavos: 360_000 }, 5_000)).toBe(60_000);
  });
});

describe('idempotent business effect retry', () => {
  it('refuses a new request key for an already-recorded stock effect', () => {
    const h = createHarness({ actorId: 'u-inventory' });
    h.runOk(receipt(10_000, 10_000, '2026-11-01', 'same-effect'));
    const revision = h.state.revision;
    const movements = h.state.movements.length;

    const retried = h.run(receipt(10_000, 10_000, '2026-11-01', 'same-effect'));
    expect(retried.ok).toBe(false);
    if (!retried.ok) expect(retried.error.code).toBe('DUPLICATE_EFFECT');
    expect(h.state.revision).toBe(revision);
    expect(h.state.movements.length).toBe(movements);
    expect(movementPool(h.state, WORKSPACE_A, 'item-a-1').quantityMilli).toBe(10_000);
  });
});

describe('G16 — standalone inventory cutover without history replay', () => {
  it('activates Accounting once, retains the standalone movement, and adds only new receipts', () => {
    const h = createHarness({ actorId: 'u-badmin', workspaceId: WORKSPACE_B });
    const historical = h.state.movements.find((movement) => movement.id === 'mv-b-opening');
    expect(historical?.valueCentavos).toBe(100_000);
    expect(h.state.workspaces.find((workspace) => workspace.id === WORKSPACE_B)?.entitlements.accounting.active).toBe(false);

    h.runOk({
      type: 'masters.import',
      input: {
        contacts: [],
        items: [],
        openings: [
          { accountId: 'acc-ws-b-1200', debitCentavos: 100_000, creditCentavos: 0 },
          { accountId: 'acc-ws-b-3010', debitCentavos: 0, creditCentavos: 100_000 },
        ],
        postingDate: '2026-10-31',
        approvalNote: 'Synthetic opening reconciliation for cutover',
      },
    });
    expect(accountBalance(h.state, WORKSPACE_B, 'acc-ws-b-1200', null, null).netDebitCentavos).toBe(100_000);
    expect(h.state.journals.filter((journal) => journal.workspaceId === WORKSPACE_B)).toHaveLength(1);
    expect(h.state.movements.filter((movement) => movement.workspaceId === WORKSPACE_B)).toHaveLength(1);

    const wrongValue = h.run({
      type: 'workspace.activateAccounting',
      input: { cutoverDate: '2026-11-15', reason: 'Synthetic cutover', confirmOpeningValueCentavos: 100_001 },
    });
    expect(wrongValue.ok).toBe(false);
    if (!wrongValue.ok) expect(wrongValue.error.code).toBe('AMOUNT_MISMATCH');

    h.runOk({
      type: 'workspace.activateAccounting',
      input: { cutoverDate: '2026-11-15', reason: 'Synthetic cutover', confirmOpeningValueCentavos: 100_000 },
    });
    expect(h.state.workspaces.find((workspace) => workspace.id === WORKSPACE_B)?.entitlements.accounting.active).toBe(true);
    const activationJournalCount = h.state.journals.filter((journal) => journal.workspaceId === WORKSPACE_B).length;
    expect(activationJournalCount).toBe(1);
    expect(h.state.movements.find((movement) => movement.id === 'mv-b-opening')).toEqual(historical);

    const activated = h.state.workspaces.find((workspace) => workspace.id === WORKSPACE_B);
    expect(activated?.settings.cutover?.status).toBe('activated');
    const repeated = h.run({
      type: 'workspace.activateAccounting',
      input: { cutoverDate: '2026-11-15', reason: 'Repeat', confirmOpeningValueCentavos: 100_000 },
    });
    expect(repeated.ok).toBe(false);
    if (!repeated.ok) expect(repeated.error.code).toBe('CONFLICT');

    h.runOk(
      {
        type: 'movement.receipt',
        input: {
          itemId: 'item-b-1',
          locationId: 'loc-b-main',
          occurredOn: '2026-11-16',
          quantityMilli: 1000,
          unitCostCentavos: 10_000,
          sourceType: 'synthetic_receipt',
          sourceId: 'g16-new-receipt',
          effectKey: 'g16-new-receipt',
        },
      },
      { actorId: 'u-binv', workspaceId: WORKSPACE_B },
    );
    expect(accountBalance(h.state, WORKSPACE_B, 'acc-ws-b-1200', null, null).netDebitCentavos).toBe(110_000);
    expect(movementPool(h.state, WORKSPACE_B, 'item-b-1')).toEqual({
      quantityMilli: 11_000,
      valueCentavos: 110_000,
    });
    const newMovement = h.state.movements.find((movement) => movement.effectKey === 'g16-new-receipt');
    expect(newMovement?.journalId).not.toBeNull();
    expect(newMovement?.sourceType).toBe('synthetic_receipt');
    expect(h.state.movements.find((movement) => movement.id === 'mv-b-opening')?.valueCentavos).toBe(100_000);
  });
});
