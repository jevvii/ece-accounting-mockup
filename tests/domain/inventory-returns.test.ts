import { describe, expect, it } from 'vitest';
import { accountBalance } from '../../src/domain/ledger';
import { locationQuantity, movementPool } from '../../src/domain/inventory';
import { WORKSPACE_A } from '../../src/fixtures/seed';
import { ACCOUNTS, createHarness, creditTotal, debitTotal } from './harness';

const ITEM = 'item-a-1';
const LOCATION = 'loc-a-main';

type Harness = ReturnType<typeof createHarness>;

function receive(h: Harness, quantityMilli: number, unitCostCentavos: number, date: string, key: string) {
  return h.runOk({
    type: 'movement.receipt',
    input: {
      itemId: ITEM,
      locationId: LOCATION,
      occurredOn: date,
      quantityMilli,
      unitCostCentavos,
      sourceType: 'synthetic_receipt',
      sourceId: key,
      effectKey: key,
    },
  });
}

function issue(h: Harness, quantityMilli: number, date: string, key: string) {
  return h.runOk({
    type: 'movement.issue',
    input: {
      itemId: ITEM,
      locationId: LOCATION,
      occurredOn: date,
      quantityMilli,
      purpose: 'Synthetic sale for returns test',
      sourceType: 'synthetic_issue',
      sourceId: key,
      effectKey: key,
    },
  });
}

function customerReturn(h: Harness, issueMovementId: string, quantityMilli: number, date: string) {
  return h.run({
    type: 'movement.customerReturn',
    input: { itemId: ITEM, locationId: LOCATION, occurredOn: date, quantityMilli, issueMovementId, reason: 'Synthetic customer return' },
  });
}

describe('customer returns — value follows the original issue', () => {
  it('returns two of five issued units at the issued cost and reverses COGS', () => {
    const h = createHarness({ actorId: 'u-inventory' });
    receive(h, 10_000, 10_000, '2026-11-01', 'ret-receipt');
    const issued = issue(h, 5_000, '2026-11-02', 'ret-issue');
    expect(h.state.movements.find((movement) => movement.id === issued.documentId)?.valueCentavos).toBe(50_000);

    const returned = customerReturn(h, issued.documentId, 2_000, '2026-11-03');
    expect(returned.ok).toBe(true);
    if (!returned.ok) return;
    const movement = h.state.movements.find((candidate) => candidate.id === returned.value.documentId)!;
    expect(movement.type).toBe('customer_return');
    expect(movement.sourceId).toBe(issued.documentId);
    expect(movement.quantityMilli).toBe(2_000);
    expect(movement.valueCentavos).toBe(20_000);
    expect(movement.unitCostAppliedCentavos).toBe(10_000);

    const journal = h.state.journals.find((candidate) => candidate.id === movement.journalId)!;
    expect(journal.lines.find((line) => line.accountId === ACCOUNTS.inventory)?.debitCentavos).toBe(20_000);
    expect(journal.lines.find((line) => line.accountId === ACCOUNTS.cogs)?.creditCentavos).toBe(20_000);
    expect(debitTotal(h, journal.id)).toBe(creditTotal(h, journal.id));

    expect(movementPool(h.state, WORKSPACE_A, ITEM)).toEqual({ quantityMilli: 7_000, valueCentavos: 70_000 });
    expect(accountBalance(h.state, WORKSPACE_A, ACCOUNTS.inventory, null, null).netDebitCentavos).toBe(70_000);
    expect(accountBalance(h.state, WORKSPACE_A, ACCOUNTS.cogs, null, null).netDebitCentavos).toBe(30_000);
  });

  it('caps cumulative returns at the issued quantity and refuses a non-issue reference', () => {
    const h = createHarness({ actorId: 'u-inventory' });
    receive(h, 10_000, 10_000, '2026-11-01', 'cap-receipt');
    const issued = issue(h, 5_000, '2026-11-02', 'cap-issue');
    const first = customerReturn(h, issued.documentId, 3_000, '2026-11-03');
    expect(first.ok).toBe(true);

    const tooMany = customerReturn(h, issued.documentId, 3_000, '2026-11-04');
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.error.code).toBe('VALIDATION');
    expect(h.state.movements.filter((movement) => movement.type === 'customer_return')).toHaveLength(1);

    const remaining = customerReturn(h, issued.documentId, 2_000, '2026-11-04');
    expect(remaining.ok).toBe(true);
    expect(movementPool(h.state, WORKSPACE_A, ITEM).quantityMilli).toBe(10_000);

    const receiptRow = h.state.movements.find((movement) => movement.type === 'receipt')!;
    const wrongReference = customerReturn(h, receiptRow.id, 1_000, '2026-11-05');
    expect(wrongReference.ok).toBe(false);
    if (!wrongReference.ok) expect(wrongReference.error.code).toBe('VALIDATION');
  });
});

describe('supplier returns — value follows the original receipt', () => {
  it('returns four of ten received units and debits GRNI', () => {
    const h = createHarness({ actorId: 'u-inventory' });
    const received = receive(h, 10_000, 12_000, '2026-11-01', 'sup-receipt');
    expect(h.state.movements.find((movement) => movement.id === received.documentId)?.valueCentavos).toBe(120_000);

    const returned = h.runOk({
      type: 'movement.supplierReturn',
      input: {
        itemId: ITEM,
        locationId: LOCATION,
        occurredOn: '2026-11-03',
        quantityMilli: 4_000,
        receiptMovementId: received.documentId,
        reason: 'Synthetic damaged delivery',
      },
    });
    const movement = h.state.movements.find((candidate) => candidate.id === returned.documentId)!;
    expect(movement.type).toBe('supplier_return');
    expect(movement.sourceId).toBe(received.documentId);
    expect(movement.valueCentavos).toBe(48_000);
    const journal = h.state.journals.find((candidate) => candidate.id === movement.journalId)!;
    expect(journal.lines.find((line) => line.accountId === ACCOUNTS.grni)?.debitCentavos).toBe(48_000);
    expect(journal.lines.find((line) => line.accountId === ACCOUNTS.inventory)?.creditCentavos).toBe(48_000);
    expect(movementPool(h.state, WORKSPACE_A, ITEM)).toEqual({ quantityMilli: 6_000, valueCentavos: 72_000 });
    expect(accountBalance(h.state, WORKSPACE_A, ACCOUNTS.inventory, null, null).netDebitCentavos).toBe(72_000);
    expect(accountBalance(h.state, WORKSPACE_A, ACCOUNTS.grni, null, null).netDebitCentavos).toBe(-72_000);
  });

  it('refuses more than remains returnable on the receipt', () => {
    const h = createHarness({ actorId: 'u-inventory' });
    const received = receive(h, 10_000, 12_000, '2026-11-01', 'sup-cap-receipt');
    h.runOk({
      type: 'movement.supplierReturn',
      input: {
        itemId: ITEM,
        locationId: LOCATION,
        occurredOn: '2026-11-02',
        quantityMilli: 6_000,
        receiptMovementId: received.documentId,
        reason: 'Synthetic first return',
      },
    });
    const excess = h.run({
      type: 'movement.supplierReturn',
      input: {
        itemId: ITEM,
        locationId: LOCATION,
        occurredOn: '2026-11-03',
        quantityMilli: 5_000,
        receiptMovementId: received.documentId,
        reason: 'Synthetic excess return',
      },
    });
    expect(excess.ok).toBe(false);
    if (!excess.ok) expect(excess.error.code).toBe('VALIDATION');
    expect(locationQuantity(h.state, WORKSPACE_A, ITEM, LOCATION)).toBe(4_000);
  });
});

describe('stock counts — absolute on-hand adjustment', () => {
  it('posts a loss and a gain against the inventory adjustment account', () => {
    const h = createHarness({ actorId: 'u-inventory' });
    receive(h, 10_000, 10_000, '2026-11-01', 'count-receipt');

    const loss = h.runOk({
      type: 'movement.count',
      input: { itemId: ITEM, locationId: LOCATION, occurredOn: '2026-11-02', countedQuantityMilli: 7_000, reason: 'Synthetic count shortfall' },
    });
    const lossMovement = h.state.movements.find((candidate) => candidate.id === loss.documentId)!;
    expect(lossMovement.type).toBe('count_loss');
    expect(lossMovement.quantityMilli).toBe(3_000);
    expect(lossMovement.valueCentavos).toBe(30_000);
    const lossJournal = h.state.journals.find((candidate) => candidate.id === lossMovement.journalId)!;
    expect(lossJournal.lines.find((line) => line.accountId === ACCOUNTS.adjustment)?.debitCentavos).toBe(30_000);
    expect(lossJournal.lines.find((line) => line.accountId === ACCOUNTS.inventory)?.creditCentavos).toBe(30_000);
    expect(movementPool(h.state, WORKSPACE_A, ITEM)).toEqual({ quantityMilli: 7_000, valueCentavos: 70_000 });

    const gain = h.runOk({
      type: 'movement.count',
      input: {
        itemId: ITEM,
        locationId: LOCATION,
        occurredOn: '2026-11-03',
        countedQuantityMilli: 9_000,
        unitCostCentavos: 12_000,
        reason: 'Synthetic count surplus',
      },
    });
    const gainMovement = h.state.movements.find((candidate) => candidate.id === gain.documentId)!;
    expect(gainMovement.type).toBe('count_gain');
    expect(gainMovement.quantityMilli).toBe(2_000);
    expect(gainMovement.valueCentavos).toBe(24_000);
    const gainJournal = h.state.journals.find((candidate) => candidate.id === gainMovement.journalId)!;
    expect(gainJournal.lines.find((line) => line.accountId === ACCOUNTS.inventory)?.debitCentavos).toBe(24_000);
    expect(gainJournal.lines.find((line) => line.accountId === ACCOUNTS.adjustment)?.creditCentavos).toBe(24_000);
    expect(movementPool(h.state, WORKSPACE_A, ITEM)).toEqual({ quantityMilli: 9_000, valueCentavos: 94_000 });
    expect(accountBalance(h.state, WORKSPACE_A, ACCOUNTS.inventory, null, null).netDebitCentavos).toBe(94_000);
  });

  it('records nothing when the count already matches and rejects invalid counts', () => {
    const h = createHarness({ actorId: 'u-inventory' });
    receive(h, 10_000, 10_000, '2026-11-01', 'count-match-receipt');
    const movements = h.state.movements.length;
    const exact = h.runOk({
      type: 'movement.count',
      input: { itemId: ITEM, locationId: LOCATION, occurredOn: '2026-11-02', countedQuantityMilli: 10_000, reason: 'Synthetic exact count' },
    });
    expect(exact.documentId).toBe('');
    expect(h.state.movements.length).toBe(movements);

    const negative = h.run({
      type: 'movement.count',
      input: { itemId: ITEM, locationId: LOCATION, occurredOn: '2026-11-02', countedQuantityMilli: -1, reason: 'Synthetic negative count' },
    });
    expect(negative.ok).toBe(false);
    if (!negative.ok) expect(negative.error.code).toBe('VALIDATION');

    const backdated = h.run({
      type: 'movement.count',
      input: { itemId: ITEM, locationId: LOCATION, occurredOn: '2026-10-01', countedQuantityMilli: 9_000, reason: 'Synthetic backdated count' },
    });
    expect(backdated.ok).toBe(false);
    if (!backdated.ok) expect(backdated.error.code).toBe('VALIDATION');

    const noReason = h.run({
      type: 'movement.count',
      input: { itemId: ITEM, locationId: LOCATION, occurredOn: '2026-11-03', countedQuantityMilli: 9_000, reason: 'x' },
    });
    expect(noReason.ok).toBe(false);
    if (!noReason.ok) expect(noReason.error.code).toBe('VALIDATION');
  });
});

describe('generated movement sequence conserves quantity and value', () => {
  it('keeps pool totals equal to signed movement totals across receipts, issues and transfers', () => {
    const h = createHarness({ actorId: 'u-inventory' });
    receive(h, 50_000, 11_000, '2026-11-01', 'gen-seed');
    let seed = 20261101;
    const next = (max: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % max;
    };
    for (let index = 0; index < 40; index += 1) {
      const date = new Date(Date.UTC(2026, 10, 2 + index)).toISOString().slice(0, 10);
      if (next(2) === 0) {
        receive(h, 1_000 + next(4) * 1_000, 9_000 + next(5) * 1_000, date, `gen-receipt-${index}`);
      } else {
        const available = locationQuantity(h.state, WORKSPACE_A, ITEM, LOCATION);
        if (available >= 1_000) {
          issue(h, 1_000, date, `gen-issue-${index}`);
        } else {
          receive(h, 1_000, 10_000, date, `gen-topup-${index}`);
        }
      }
      if (index % 9 === 8) {
        h.runOk({
          type: 'movement.transfer',
          input: {
            itemId: ITEM,
            fromLocationId: LOCATION,
            toLocationId: 'loc-a-branch',
            occurredOn: date,
            quantityMilli: Math.min(500, locationQuantity(h.state, WORKSPACE_A, ITEM, LOCATION)),
          },
        });
      }
    }

    const movements = h.state.movements.filter(
      (movement) => movement.workspaceId === WORKSPACE_A && movement.itemId === ITEM,
    );
    const signedQuantity = movements.reduce((total, movement) => {
      if (movement.type === 'receipt' || movement.type === 'customer_return' || movement.type === 'count_gain') {
        return total + movement.quantityMilli;
      }
      if (movement.type === 'issue' || movement.type === 'supplier_return' || movement.type === 'count_loss') {
        return total - movement.quantityMilli;
      }
      return total;
    }, 0);
    const signedValue = movements.reduce((total, movement) => {
      const sign =
        movement.type === 'receipt' || movement.type === 'customer_return' || movement.type === 'count_gain'
          ? 1
          : movement.type === 'transfer'
            ? 0
            : -1;
      return total + sign * movement.valueCentavos;
    }, 0);
    const pool = movementPool(h.state, WORKSPACE_A, ITEM);
    const locationTotal =
      locationQuantity(h.state, WORKSPACE_A, ITEM, LOCATION) +
      locationQuantity(h.state, WORKSPACE_A, ITEM, 'loc-a-branch');
    expect(pool.quantityMilli).toBe(signedQuantity);
    expect(pool.quantityMilli).toBe(locationTotal);
    expect(pool.valueCentavos).toBe(signedValue);
    expect(pool.valueCentavos).toBeGreaterThanOrEqual(0);
    expect(accountBalance(h.state, WORKSPACE_A, ACCOUNTS.inventory, null, null).netDebitCentavos).toBe(
      pool.valueCentavos,
    );
  });
});
