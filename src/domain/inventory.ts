import type { CommandResult, DomainCommand } from './commandTypes';
import { postJournal, recordAudit, type WriteContext } from './ledger';
import type { AppState, Item, Location, Movement } from './schema';
import { entitlementStatus, requireAccountByRole, requireProduct, requireRole } from './shared/access';
import { parseDateOnly } from './shared/dates';
import { pushItem, updateItem, type StateDraft } from './shared/draft';
import { effectRecordKey } from './ledger';
import { mulDivRound } from './shared/money';
import { err, ok, type Result } from './shared/result';
import { setRecordValue } from './shared/draft';
import { allocateCode, allocateMasterCode, normalizeCode } from './numbering';

export interface MovementPool {
  quantityMilli: number;
  valueCentavos: number;
}

export function inventoryItem(state: AppState, workspaceId: string, itemId: string): Item | undefined {
  return state.items.find((item) => item.id === itemId && item.workspaceId === workspaceId && item.active);
}

export function inventoryLocation(
  state: AppState,
  workspaceId: string,
  locationId: string,
): Location | undefined {
  return state.locations.find(
    (location) => location.id === locationId && location.workspaceId === workspaceId && location.active,
  );
}

export function movementPool(state: AppState, workspaceId: string, itemId: string): MovementPool {
  let quantityMilli = 0;
  let valueCentavos = 0;
  for (const movement of state.movements) {
    if (movement.workspaceId !== workspaceId || movement.itemId !== itemId) continue;
    quantityMilli += signedQuantity(movement);
    valueCentavos += signedValue(movement);
  }
  return { quantityMilli, valueCentavos };
}

function signedQuantity(movement: Movement): number {
  switch (movement.type) {
    case 'receipt':
    case 'customer_return':
    case 'count_gain':
      return movement.quantityMilli;
    case 'issue':
    case 'supplier_return':
    case 'count_loss':
      return -movement.quantityMilli;
    case 'transfer':
      return 0;
  }
}

function signedValue(movement: Movement): number {
  switch (movement.type) {
    case 'receipt':
    case 'customer_return':
    case 'count_gain':
      return movement.valueCentavos;
    case 'issue':
    case 'supplier_return':
    case 'count_loss':
      return -movement.valueCentavos;
    case 'transfer':
      return 0;
  }
}

export function locationQuantity(
  state: AppState,
  workspaceId: string,
  itemId: string,
  locationId: string,
): number {
  let quantity = 0;
  for (const movement of state.movements) {
    if (movement.workspaceId !== workspaceId || movement.itemId !== itemId) continue;
    switch (movement.type) {
      case 'receipt':
      case 'customer_return':
      case 'count_gain':
        if (movement.locationId === locationId) quantity += movement.quantityMilli;
        break;
      case 'issue':
      case 'supplier_return':
      case 'count_loss':
        if (movement.locationId === locationId) quantity -= movement.quantityMilli;
        break;
      case 'transfer':
        if (movement.locationId === locationId) quantity -= movement.quantityMilli;
        if (movement.toLocationId === locationId) quantity += movement.quantityMilli;
        break;
    }
  }
  return quantity;
}

export function averageUnitCost(pool: MovementPool): number {
  if (pool.quantityMilli <= 0) return 0;
  return mulDivRound(pool.valueCentavos, 1000, pool.quantityMilli);
}

/** Issue value uses exact residual consumption so the pool never strands a centavo. */
export function issueValue(pool: MovementPool, quantityMilli: number): number {
  if (quantityMilli === pool.quantityMilli) return pool.valueCentavos;
  return mulDivRound(pool.valueCentavos, quantityMilli, pool.quantityMilli);
}

function lastMovementDate(state: AppState, workspaceId: string, itemId: string): string | null {
  let latest: string | null = null;
  for (const movement of state.movements) {
    if (movement.workspaceId !== workspaceId || movement.itemId !== itemId) continue;
    if (latest === null || movement.occurredOn > latest) latest = movement.occurredOn;
  }
  return latest;
}

function nextSequence(state: AppState, workspaceId: string, itemId: string): number {
  let max = 0;
  for (const movement of state.movements) {
    if (movement.workspaceId !== workspaceId || movement.itemId !== itemId) continue;
    if (movement.sequence > max) max = movement.sequence;
  }
  return max + 1;
}

function accountingIsLive(ctx: WriteContext): boolean {
  return entitlementStatus(ctx.workspace.entitlements.accounting, ctx.today) === 'active';
}

function recordEffect(draft: StateDraft, ctx: WriteContext, effectKey: string, documentId: string): void {
  setRecordValue(draft, 'sourceEffects', effectRecordKey(ctx.workspaceId, effectKey), {
    kind: 'inventory_movement',
    documentId,
    at: ctx.clock.nowIso,
  });
}

function effectAlreadyPosted(ctx: WriteContext, effectKey: string): boolean {
  return ctx.state.sourceEffects[effectRecordKey(ctx.workspaceId, effectKey)] !== undefined;
}

function validateMovementBase(
  ctx: WriteContext,
  input: { itemId: string; occurredOn: string; quantityMilli: number; effectKey: string },
): Result<{ item: Item; occurredOn: string }> {
  const item = inventoryItem(ctx.state, ctx.workspaceId, input.itemId);
  if (!item) return err('VALIDATION', 'Select an active item in this workspace.', 'itemId');
  const date = parseDateOnly(input.occurredOn, 'occurredOn');
  if (!date.ok) return date;
  if (!Number.isSafeInteger(input.quantityMilli) || input.quantityMilli <= 0) {
    return err('VALIDATION', 'Movement quantity must be positive.', 'quantityMilli');
  }
  if (input.effectKey.trim().length === 0) {
    return err('VALIDATION', 'A movement effect key is required.', 'effectKey');
  }
  if (effectAlreadyPosted(ctx, input.effectKey)) {
    return err(
      'DUPLICATE_EFFECT',
      `Inventory effect ${input.effectKey} was already recorded; nothing was added.`,
    );
  }
  const latest = lastMovementDate(ctx.state, ctx.workspaceId, item.id);
  if (latest !== null && input.occurredOn < latest) {
    return err(
      'VALIDATION',
      `Movements for ${item.sku} must be entered in date order; the latest movement is ${latest}.`,
      'occurredOn',
    );
  }
  return ok({ item, occurredOn: input.occurredOn });
}

interface InternalReceiptInput {
  itemId: string;
  locationId: string;
  occurredOn: string;
  quantityMilli: number;
  unitCostCentavos: number;
  sourceType: string;
  sourceId: string;
  effectKey: string;
}

export function recordReceiptMovement(
  draft: StateDraft,
  ctx: WriteContext,
  input: InternalReceiptInput,
): Result<Movement> {
  const base = validateMovementBase(ctx, input);
  if (!base.ok) return base;
  if (!inventoryLocation(ctx.state, ctx.workspaceId, input.locationId)) {
    return err('VALIDATION', 'Select an active location in this workspace.', 'locationId');
  }
  if (!Number.isSafeInteger(input.unitCostCentavos) || input.unitCostCentavos < 0) {
    return err('VALIDATION', 'Unit cost must be zero or more centavos.', 'unitCostCentavos');
  }
  const value = mulDivRound(input.unitCostCentavos, input.quantityMilli, 1000);
  const movementNo = allocateCode(draft, ctx.workspaceId, 'inventory_movement');
  if (!movementNo.ok) return movementNo;
  const id = ctx.clock.newId('mv');
  const movement: Movement = {
    id,
    workspaceId: ctx.workspaceId,
    movementNo: movementNo.value,
    itemId: base.value.item.id,
    sequence: nextSequence(ctx.state, ctx.workspaceId, base.value.item.id),
    type: 'receipt',
    occurredOn: input.occurredOn,
    locationId: input.locationId,
    toLocationId: null,
    quantityMilli: input.quantityMilli,
    unitCostCentavos: input.unitCostCentavos,
    valueCentavos: value,
    unitCostAppliedCentavos: input.unitCostCentavos,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    effectKey: input.effectKey,
    referenceMovementId: null,
    approvedBy: ctx.actorId,
    reason: null,
    journalId: null,
    createdAt: ctx.clock.nowIso,
    createdBy: ctx.actorId,
  };

  if (accountingIsLive(ctx)) {
    const grni = requireAccountByRole(ctx.state, ctx.workspaceId, 'grni');
    if (!grni.ok) return grni;
    const journal = postJournal(draft, ctx, {
      postingDate: input.occurredOn,
      documentDate: input.occurredOn,
      sourceType: 'inventory_receipt',
      sourceId: id,
      effectKey: `movement:${input.effectKey}`,
      memo: `Stock receipt ${base.value.item.sku} × ${input.quantityMilli} milli-units`,
      lines: [
        { accountId: base.value.item.inventoryAccountId, debitCentavos: value, creditCentavos: 0 },
        { accountId: grni.value.id, debitCentavos: 0, creditCentavos: value },
      ],
    });
    if (!journal.ok) return journal;
    movement.journalId = journal.value.id;
  }
  pushItem(draft, 'movements', movement);
  recordEffect(draft, ctx, input.effectKey, id);
  recordAudit(draft, ctx, {
    action: 'inventory.receipt',
    recordType: 'movement',
    recordId: id,
    detail: { itemId: movement.itemId, quantityMilli: input.quantityMilli, valueCentavos: value },
  });
  return ok(movement);
}

interface InternalIssueInput {
  itemId: string;
  locationId: string;
  occurredOn: string;
  quantityMilli: number;
  purpose: string;
  sourceType: string;
  sourceId: string;
  effectKey: string;
}

export function recordIssueMovement(
  draft: StateDraft,
  ctx: WriteContext,
  input: InternalIssueInput,
): Result<Movement> {
  const base = validateMovementBase(ctx, input);
  if (!base.ok) return base;
  if (!inventoryLocation(ctx.state, ctx.workspaceId, input.locationId)) {
    return err('VALIDATION', 'Select an active location in this workspace.', 'locationId');
  }
  const pool = movementPool(ctx.state, ctx.workspaceId, base.value.item.id);
  if (input.quantityMilli > pool.quantityMilli) {
    return err(
      'INSUFFICIENT_STOCK',
      `Only ${pool.quantityMilli} milli-units of ${base.value.item.sku} are on hand; the issue was rejected.`,
      'quantityMilli',
    );
  }
  const atLocation = locationQuantity(ctx.state, ctx.workspaceId, base.value.item.id, input.locationId);
  if (input.quantityMilli > atLocation) {
    return err(
      'NEGATIVE_STOCK',
      `Location holds ${atLocation} milli-units of ${base.value.item.sku}; an issue of ${input.quantityMilli} would make it negative.`,
      'quantityMilli',
    );
  }
  const value = issueValue(pool, input.quantityMilli);
  const movementNo = allocateCode(draft, ctx.workspaceId, 'inventory_movement');
  if (!movementNo.ok) return movementNo;
  const id = ctx.clock.newId('mv');
  const movement: Movement = {
    id,
    workspaceId: ctx.workspaceId,
    movementNo: movementNo.value,
    itemId: base.value.item.id,
    sequence: nextSequence(ctx.state, ctx.workspaceId, base.value.item.id),
    type: 'issue',
    occurredOn: input.occurredOn,
    locationId: input.locationId,
    toLocationId: null,
    quantityMilli: input.quantityMilli,
    unitCostCentavos: null,
    valueCentavos: value,
    unitCostAppliedCentavos: pool.quantityMilli > 0 ? mulDivRound(value, 1000, input.quantityMilli) : 0,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    effectKey: input.effectKey,
    referenceMovementId: null,
    approvedBy: ctx.actorId,
    reason: input.purpose,
    journalId: null,
    createdAt: ctx.clock.nowIso,
    createdBy: ctx.actorId,
  };
  if (accountingIsLive(ctx)) {
    const cogs = requireAccountByRole(ctx.state, ctx.workspaceId, 'cogs');
    if (!cogs.ok) return cogs;
    const journal = postJournal(draft, ctx, {
      postingDate: input.occurredOn,
      documentDate: input.occurredOn,
      sourceType: 'inventory_issue',
      sourceId: id,
      effectKey: `movement:${input.effectKey}`,
      memo: `Stock issue ${base.value.item.sku} × ${input.quantityMilli} — ${input.purpose}`,
      lines: [
        { accountId: cogs.value.id, debitCentavos: value, creditCentavos: 0 },
        { accountId: base.value.item.inventoryAccountId, debitCentavos: 0, creditCentavos: value },
      ],
    });
    if (!journal.ok) return journal;
    movement.journalId = journal.value.id;
  }
  pushItem(draft, 'movements', movement);
  recordEffect(draft, ctx, input.effectKey, id);
  recordAudit(draft, ctx, {
    action: 'inventory.issue',
    recordType: 'movement',
    recordId: id,
    reason: input.purpose,
    detail: { itemId: movement.itemId, quantityMilli: input.quantityMilli, valueCentavos: value },
  });
  return ok(movement);
}

function movementById(state: AppState, workspaceId: string, id: string): Movement | undefined {
  return state.movements.find((movement) => movement.id === id && movement.workspaceId === workspaceId);
}

function baseMovement(
  ctx: WriteContext,
  movementNo: string,
  itemId: string,
  sequence: number,
  type: Movement['type'],
  occurredOn: string,
  locationId: string,
  toLocationId: string | null,
  quantityMilli: number,
  valueCentavos: number,
  unitCostAppliedCentavos: number | null,
  sourceType: string,
  sourceId: string,
  effectKey: string,
  referenceMovementId: string | null,
  reason: string | null,
): Movement {
  return {
    id: ctx.clock.newId('mv'),
    workspaceId: ctx.workspaceId,
    movementNo,
    itemId,
    sequence,
    type,
    occurredOn,
    locationId,
    toLocationId,
    quantityMilli,
    unitCostCentavos: null,
    valueCentavos,
    unitCostAppliedCentavos,
    sourceType,
    sourceId,
    effectKey,
    referenceMovementId,
    approvedBy: ctx.actorId,
    reason,
    journalId: null,
    createdAt: ctx.clock.nowIso,
    createdBy: ctx.actorId,
  };
}

export function recordTransferMovement(
  draft: StateDraft,
  ctx: WriteContext,
  input: {
    itemId: string;
    fromLocationId: string;
    toLocationId: string;
    occurredOn: string;
    quantityMilli: number;
    effectKey?: string;
  },
): Result<Movement> {
  // One generated effect per transfer command; a timestamp key would collide
  // for every transfer executed on the fixed demo clock.
  const effectKey = input.effectKey ?? `transfer:${ctx.clock.newId('transfer')}`;
  const base = validateMovementBase(ctx, { ...input, effectKey });
  if (!base.ok) return base;
  if (input.fromLocationId === input.toLocationId) {
    return err('VALIDATION', 'Choose two different locations for a transfer.', 'toLocationId');
  }
  if (!inventoryLocation(ctx.state, ctx.workspaceId, input.fromLocationId)) {
    return err('VALIDATION', 'Source location is not active in this workspace.', 'fromLocationId');
  }
  if (!inventoryLocation(ctx.state, ctx.workspaceId, input.toLocationId)) {
    return err('VALIDATION', 'Destination location is not active in this workspace.', 'toLocationId');
  }
  const atLocation = locationQuantity(ctx.state, ctx.workspaceId, input.itemId, input.fromLocationId);
  if (input.quantityMilli > atLocation) {
    return err(
      'NEGATIVE_STOCK',
      `Source location holds ${atLocation} milli-units; a transfer of ${input.quantityMilli} was rejected.`,
      'quantityMilli',
    );
  }
  const movementNo = allocateCode(draft, ctx.workspaceId, 'inventory_movement');
  if (!movementNo.ok) return movementNo;
  const movement = baseMovement(
    ctx,
    movementNo.value,
    input.itemId,
    nextSequence(ctx.state, ctx.workspaceId, input.itemId),
    'transfer',
    input.occurredOn,
    input.fromLocationId,
    input.toLocationId,
    input.quantityMilli,
    0,
    null,
    'transfer',
    ctx.clock.newId('transfer'),
    effectKey,
    null,
    null,
  );
  pushItem(draft, 'movements', movement);
  recordEffect(draft, ctx, effectKey, movement.id);
  recordAudit(draft, ctx, {
    action: 'inventory.transfer',
    recordType: 'movement',
    recordId: movement.id,
    detail: { itemId: movement.itemId, quantityMilli: input.quantityMilli },
  });
  return ok(movement);
}

export function recordCustomerReturn(
  draft: StateDraft,
  ctx: WriteContext,
  input: {
    itemId: string;
    locationId: string;
    occurredOn: string;
    quantityMilli: number;
    issueMovementId: string;
    reason: string;
    effectKey?: string;
  },
): Result<Movement> {
  const effectKey = input.effectKey ?? `customer-return:${ctx.clock.newId('crtn')}`;
  const base = validateMovementBase(ctx, { ...input, effectKey });
  if (!base.ok) return base;
  if (!inventoryLocation(ctx.state, ctx.workspaceId, input.locationId)) {
    return err('VALIDATION', 'Select an active location.', 'locationId');
  }
  const issue = movementById(ctx.state, ctx.workspaceId, input.issueMovementId);
  if (!issue || issue.type !== 'issue' || issue.itemId !== input.itemId) {
    return err('VALIDATION', 'A customer return must reference an issue of the same item.', 'issueMovementId');
  }
  if (input.quantityMilli > issue.quantityMilli) {
    return err('VALIDATION', 'Return quantity exceeds the referenced issue quantity.', 'quantityMilli');
  }
  const alreadyReturned = ctx.state.movements
    .filter(
      (movement) =>
        movement.workspaceId === ctx.workspaceId &&
        movement.type === 'customer_return' &&
        movement.sourceId === issue.id,
    )
    .reduce((total, movement) => total + movement.quantityMilli, 0);
  if (alreadyReturned + input.quantityMilli > issue.quantityMilli) {
    return err(
      'VALIDATION',
      `Only ${issue.quantityMilli - alreadyReturned} milli-units of this issue remain returnable.`,
      'quantityMilli',
    );
  }
  if (input.reason.trim().length < 3) return err('VALIDATION', 'A return reason is required.', 'reason');
  const unitCost = issue.unitCostAppliedCentavos ?? 0;
  const value = input.quantityMilli === issue.quantityMilli
    ? issue.valueCentavos
    : mulDivRound(issue.valueCentavos, input.quantityMilli, issue.quantityMilli);
  const movementNo = allocateCode(draft, ctx.workspaceId, 'inventory_movement');
  if (!movementNo.ok) return movementNo;
  const movement = baseMovement(
    ctx,
    movementNo.value,
    input.itemId,
    nextSequence(ctx.state, ctx.workspaceId, input.itemId),
    'customer_return',
    input.occurredOn,
    input.locationId,
    null,
    input.quantityMilli,
    value,
    unitCost,
    'customer_return',
    issue.id,
    effectKey,
    issue.id,
    input.reason,
  );
  if (accountingIsLive(ctx)) {
    const cogs = requireAccountByRole(ctx.state, ctx.workspaceId, 'cogs');
    if (!cogs.ok) return cogs;
    const journal = postJournal(draft, ctx, {
      postingDate: input.occurredOn,
      documentDate: input.occurredOn,
      sourceType: 'inventory_customer_return',
      sourceId: movement.id,
      effectKey: `movement:${effectKey}`,
      memo: `Customer return ${base.value.item.sku} × ${input.quantityMilli}`,
      lines: [
        { accountId: base.value.item.inventoryAccountId, debitCentavos: value, creditCentavos: 0 },
        { accountId: cogs.value.id, debitCentavos: 0, creditCentavos: value },
      ],
    });
    if (!journal.ok) return journal;
    movement.journalId = journal.value.id;
  }
  pushItem(draft, 'movements', movement);
  recordEffect(draft, ctx, effectKey, movement.id);
  recordAudit(draft, ctx, {
    action: 'inventory.customerReturn',
    recordType: 'movement',
    recordId: movement.id,
    reason: input.reason,
    detail: { issueMovementId: issue.id, quantityMilli: input.quantityMilli },
  });
  return ok(movement);
}

export function recordSupplierReturn(
  draft: StateDraft,
  ctx: WriteContext,
  input: {
    itemId: string;
    locationId: string;
    occurredOn: string;
    quantityMilli: number;
    receiptMovementId: string;
    reason: string;
    effectKey?: string;
  },
): Result<Movement> {
  const effectKey = input.effectKey ?? `supplier-return:${ctx.clock.newId('srtn')}`;
  const base = validateMovementBase(ctx, { ...input, effectKey });
  if (!base.ok) return base;
  if (!inventoryLocation(ctx.state, ctx.workspaceId, input.locationId)) {
    return err('VALIDATION', 'Select an active location.', 'locationId');
  }
  const receipt = movementById(ctx.state, ctx.workspaceId, input.receiptMovementId);
  if (!receipt || receipt.type !== 'receipt' || receipt.itemId !== input.itemId) {
    return err('VALIDATION', 'A supplier return must reference a receipt of the same item.', 'receiptMovementId');
  }
  if (input.quantityMilli > receipt.quantityMilli) {
    return err('VALIDATION', 'Return quantity exceeds the referenced receipt quantity.', 'quantityMilli');
  }
  const alreadyReturned = ctx.state.movements
    .filter(
      (movement) =>
        movement.workspaceId === ctx.workspaceId &&
        movement.type === 'supplier_return' &&
        movement.sourceId === receipt.id,
    )
    .reduce((total, movement) => total + movement.quantityMilli, 0);
  if (alreadyReturned + input.quantityMilli > receipt.quantityMilli) {
    return err(
      'VALIDATION',
      `Only ${receipt.quantityMilli - alreadyReturned} milli-units of this receipt remain returnable.`,
      'quantityMilli',
    );
  }
  const atLocation = locationQuantity(ctx.state, ctx.workspaceId, input.itemId, input.locationId);
  if (input.quantityMilli > atLocation) {
    return err(
      'NEGATIVE_STOCK',
      `Location holds ${atLocation} milli-units; the supplier return would make it negative.`,
      'quantityMilli',
    );
  }
  if (input.reason.trim().length < 3) return err('VALIDATION', 'A return reason is required.', 'reason');
  const unitCost = receipt.unitCostCentavos ?? 0;
  const value = input.quantityMilli === receipt.quantityMilli
    ? receipt.valueCentavos
    : mulDivRound(receipt.valueCentavos, input.quantityMilli, receipt.quantityMilli);
  const movementNo = allocateCode(draft, ctx.workspaceId, 'inventory_movement');
  if (!movementNo.ok) return movementNo;
  const movement = baseMovement(
    ctx,
    movementNo.value,
    input.itemId,
    nextSequence(ctx.state, ctx.workspaceId, input.itemId),
    'supplier_return',
    input.occurredOn,
    input.locationId,
    null,
    input.quantityMilli,
    value,
    unitCost,
    'supplier_return',
    receipt.id,
    effectKey,
    receipt.id,
    input.reason,
  );
  if (accountingIsLive(ctx)) {
    const grni = requireAccountByRole(ctx.state, ctx.workspaceId, 'grni');
    if (!grni.ok) return grni;
    const journal = postJournal(draft, ctx, {
      postingDate: input.occurredOn,
      documentDate: input.occurredOn,
      sourceType: 'inventory_supplier_return',
      sourceId: movement.id,
      effectKey: `movement:${effectKey}`,
      memo: `Supplier return ${base.value.item.sku} × ${input.quantityMilli}`,
      lines: [
        { accountId: grni.value.id, debitCentavos: value, creditCentavos: 0 },
        { accountId: base.value.item.inventoryAccountId, debitCentavos: 0, creditCentavos: value },
      ],
    });
    if (!journal.ok) return journal;
    movement.journalId = journal.value.id;
  }
  pushItem(draft, 'movements', movement);
  recordEffect(draft, ctx, effectKey, movement.id);
  recordAudit(draft, ctx, {
    action: 'inventory.supplierReturn',
    recordType: 'movement',
    recordId: movement.id,
    reason: input.reason,
    detail: { receiptMovementId: receipt.id, quantityMilli: input.quantityMilli },
  });
  return ok(movement);
}

export function recordCountMovement(
  draft: StateDraft,
  ctx: WriteContext,
  input: {
    itemId: string;
    locationId: string;
    occurredOn: string;
    countedQuantityMilli: number;
    unitCostCentavos?: number | null;
    reason: string;
    effectKey?: string;
  },
): Result<Movement | null> {
  const effectKey = input.effectKey ?? `count:${ctx.clock.newId('cnt')}`;
  if (!Number.isSafeInteger(input.countedQuantityMilli) || input.countedQuantityMilli < 0) {
    return err('VALIDATION', 'Counted quantity must be zero or more.', 'countedQuantityMilli');
  }
  const item = inventoryItem(ctx.state, ctx.workspaceId, input.itemId);
  if (!item) return err('VALIDATION', 'Select an active item in this workspace.', 'itemId');
  const date = parseDateOnly(input.occurredOn, 'occurredOn');
  if (!date.ok) return date;
  if (!inventoryLocation(ctx.state, ctx.workspaceId, input.locationId)) {
    return err('VALIDATION', 'Select an active location.', 'locationId');
  }
  if (input.reason.trim().length < 3) return err('VALIDATION', 'A count reason is required.', 'reason');
  if (effectAlreadyPosted(ctx, effectKey)) {
    return err('DUPLICATE_EFFECT', 'This count was already recorded.');
  }
  const latest = lastMovementDate(ctx.state, ctx.workspaceId, item.id);
  if (latest !== null && input.occurredOn < latest) {
    return err('VALIDATION', `Movements for ${item.sku} must be entered in date order.`, 'occurredOn');
  }
  const onHand = locationQuantity(ctx.state, ctx.workspaceId, item.id, input.locationId);
  const difference = input.countedQuantityMilli - onHand;
  if (difference === 0) return ok(null);
  const pool = movementPool(ctx.state, ctx.workspaceId, item.id);
  const unitCost = input.unitCostCentavos ?? averageUnitCost(pool);
  let value: number;
  if (difference > 0) {
    value = input.unitCostCentavos !== null && input.unitCostCentavos !== undefined
      ? mulDivRound(input.unitCostCentavos, difference, 1000)
      : mulDivRound(unitCost, difference, 1000);
  } else {
    value = issueValue(pool, -difference);
  }
  const type = difference > 0 ? 'count_gain' : 'count_loss';
  const movementNo = allocateCode(draft, ctx.workspaceId, 'inventory_movement');
  if (!movementNo.ok) return movementNo;
  const movement = baseMovement(
    ctx,
    movementNo.value,
    item.id,
    nextSequence(ctx.state, ctx.workspaceId, item.id),
    type,
    input.occurredOn,
    input.locationId,
    null,
    Math.abs(difference),
    value,
    unitCost,
    'stock_count',
    ctx.clock.newId('count'),
    effectKey,
    null,
    input.reason,
  );
  if (accountingIsLive(ctx)) {
    const adjustment = requireAccountByRole(ctx.state, ctx.workspaceId, 'inventory_adjustment');
    if (!adjustment.ok) return adjustment;
    const lines = difference > 0
      ? [
          { accountId: item.inventoryAccountId, debitCentavos: value, creditCentavos: 0 },
          { accountId: adjustment.value.id, debitCentavos: 0, creditCentavos: value },
        ]
      : [
          { accountId: adjustment.value.id, debitCentavos: value, creditCentavos: 0 },
          { accountId: item.inventoryAccountId, debitCentavos: 0, creditCentavos: value },
        ];
    const journal = postJournal(draft, ctx, {
      postingDate: input.occurredOn,
      documentDate: input.occurredOn,
      sourceType: 'inventory_count',
      sourceId: movement.id,
      effectKey: `movement:${effectKey}`,
      memo: `Stock count ${item.sku} — ${input.reason}`,
      lines,
    });
    if (!journal.ok) return journal;
    movement.journalId = journal.value.id;
  }
  pushItem(draft, 'movements', movement);
  recordEffect(draft, ctx, effectKey, movement.id);
  recordAudit(draft, ctx, {
    action: 'inventory.count',
    recordType: 'movement',
    recordId: movement.id,
    reason: input.reason,
    detail: { differenceMilli: difference, valueCentavos: value },
  });
  return ok(movement);
}

export function createItem(
  draft: StateDraft,
  ctx: WriteContext,
  input: Extract<DomainCommand, { type: 'item.create' }>['input'],
): Result<CommandResult> {
  const product = requireProduct(ctx, 'inventory');
  if (!product.ok) return product;
  const role = requireRole(ctx, 'inventory_officer', 'company_admin');
  if (!role.ok) return role;
  if (input.sku.trim().length === 0) return err('VALIDATION', 'SKU is required.', 'sku');
  if (input.name.trim().length === 0) return err('VALIDATION', 'Item name is required.', 'name');
  if (input.baseUnit.trim().length === 0) return err('VALIDATION', 'Base unit is required.', 'baseUnit');
  const duplicate = ctx.state.items.some(
    (item) => item.workspaceId === ctx.workspaceId && item.sku.toLowerCase() === input.sku.trim().toLowerCase(),
  );
  if (duplicate) return err('DUPLICATE_ROW', 'An item with this SKU already exists in this workspace.', 'sku');
  let inventoryAccount = input.inventoryAccountId
    ? ctx.state.accounts.find(
        (account) => account.id === input.inventoryAccountId && account.workspaceId === ctx.workspaceId && account.active,
      )
    : undefined;
  if (!inventoryAccount) {
    const fallback = requireAccountByRole(ctx.state, ctx.workspaceId, 'inventory');
    if (!fallback.ok) return fallback;
    inventoryAccount = fallback.value;
  }
  let cogsAccount = input.cogsAccountId
    ? ctx.state.accounts.find(
        (account) => account.id === input.cogsAccountId && account.workspaceId === ctx.workspaceId && account.active,
      )
    : undefined;
  if (!cogsAccount) {
    const fallback = requireAccountByRole(ctx.state, ctx.workspaceId, 'cogs');
    if (!fallback.ok) return fallback;
    cogsAccount = fallback.value;
  }
  const itemNo = allocateCode(draft, ctx.workspaceId, 'item');
  if (!itemNo.ok) return itemNo;
  const item: Item = {
    id: ctx.clock.newId('item'),
    workspaceId: ctx.workspaceId,
    itemNo: itemNo.value,
    sku: input.sku.trim(),
    name: input.name.trim(),
    baseUnit: input.baseUnit.trim(),
    inventoryAccountId: inventoryAccount.id,
    cogsAccountId: cogsAccount.id,
    active: true,
  };
  pushItem(draft, 'items', item);
  recordAudit(draft, ctx, { action: 'item.create', recordType: 'item', recordId: item.id });
  return ok({
    summary: `Item ${item.sku} created.`,
    documentType: 'item',
    documentId: item.id,
    journalIds: [],
    warnings: [],
  });
}

export function createLocation(
  draft: StateDraft,
  ctx: WriteContext,
  input: { code: string; name: string },
): Result<CommandResult> {
  const product = requireProduct(ctx, 'inventory');
  if (!product.ok) return product;
  const role = requireRole(ctx, 'inventory_officer', 'company_admin');
  if (!role.ok) return role;
  if (input.name.trim().length === 0) return err('VALIDATION', 'Location name is required.', 'name');
  const locationCode = allocateMasterCode(draft, ctx.workspaceId, 'location', input.code);
  if (!locationCode.ok) return locationCode;
  const duplicate = ctx.state.locations.some(
    (location) =>
      location.workspaceId === ctx.workspaceId &&
      normalizeCode(location.code) === normalizeCode(locationCode.value),
  );
  if (duplicate) return err('DUPLICATE_ROW', 'A location with this code already exists.', 'code');
  const location: Location = {
    id: ctx.clock.newId('loc'),
    workspaceId: ctx.workspaceId,
    code: locationCode.value.trim(),
    name: input.name.trim(),
    active: true,
  };
  pushItem(draft, 'locations', location);
  recordAudit(draft, ctx, { action: 'location.create', recordType: 'location', recordId: location.id });
  return ok({
    summary: `Location ${location.code} created.`,
    documentType: 'location',
    documentId: location.id,
    journalIds: [],
    warnings: [],
  });
}

export function movementToCommandResult(movement: Movement, summary: string): CommandResult {
  return {
    summary,
    documentType: 'movement',
    documentId: movement.id,
    journalIds: movement.journalId ? [movement.journalId] : [],
    warnings: movement.journalId ? [] : ['This movement is standalone; no accounting journal was posted.'],
  };
}

export function itemOnHand(state: AppState, workspaceId: string, itemId: string): MovementPool {
  return movementPool(state, workspaceId, itemId);
}

export function itemsForWorkspace(state: AppState, workspaceId: string): Item[] {
  return state.items.filter((item) => item.workspaceId === workspaceId);
}

export function locationsForWorkspace(state: AppState, workspaceId: string): Location[] {
  return state.locations.filter((location) => location.workspaceId === workspaceId);
}

export function movementsForWorkspace(state: AppState, workspaceId: string): Movement[] {
  return state.movements.filter((movement) => movement.workspaceId === workspaceId);
}

export function updateItemActive(
  draft: StateDraft,
  ctx: WriteContext,
  itemId: string,
  active: boolean,
): Result<CommandResult> {
  const updated = updateItem(
    draft,
    'items',
    (item) => item.id === itemId && item.workspaceId === ctx.workspaceId,
    (item) => ({ ...item, active }),
  );
  if (!updated) return err('NOT_FOUND', 'Item not found in this workspace.');
  recordAudit(draft, ctx, { action: 'item.updateActive', recordType: 'item', recordId: itemId });
  return ok({
    summary: `Item ${updated.sku} ${active ? 'reactivated' : 'deactivated'}.`,
    documentType: 'item',
    documentId: itemId,
    journalIds: [],
    warnings: [],
  });
}
