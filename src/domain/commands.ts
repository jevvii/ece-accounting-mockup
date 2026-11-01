import type { CommandEnvelope, CommandResult, DomainCommand } from './commandTypes';
import { MAINTENANCE_ALLOWED_COMMANDS } from './commandTypes';
import type { AppState } from './schema';
import type { Clock } from './shared/clock';
import { createDraft } from './shared/draft';
import { payloadDigest } from './shared/json';
import { err, ok, type Result } from './shared/result';
import { resolveAccess, requireProduct, requireRole } from './shared/access';
import type { WriteContext } from './ledger';
import {
  createInvoice,
  createReceipt,
  createCreditNote,
  createRefund,
  postInvoice,
  returnReceipt,
  reverseInvoice,
  updateInvoice,
} from './billing';
import {
  approveRfp,
  createAdvance,
  createBill,
  createGoodsReceipt,
  createPayment,
  createPurchaseOrder,
  createRfp,
  liquidateAdvance,
  rejectRfp,
} from './purchases';
import { importBankRows, matchBankRow, undoBankRow } from './cash';
import {
  createItem,
  createLocation,
  movementToCommandResult,
  recordCountMovement,
  recordCustomerReturn,
  recordIssueMovement,
  recordSupplierReturn,
  recordTransferMovement,
  recordReceiptMovement,
} from './inventory';
import {
  approvePayroll,
  calculatePayroll,
  createEmployee,
  importTime,
  payPayroll,
  postPayroll,
  reversePayroll,
  saveWorksheet,
  updatePayrollPolicy,
} from './payroll';
import {
  approveDepreciation,
  calculateDepreciation,
  createAsset,
  postDepreciation,
} from './assets';
import {
  approveJournalDraft,
  closePeriod,
  createCertificate2307,
  createFinalWithholding,
  createJournalDraft,
  postJournalDraft,
  rejectJournalDraft,
  reopenPeriod,
  reversePostedJournal,
} from './other';
import {
  activateAccounting,
  createAccount,
  createContact,
  importMasters,
  setMaintenance,
  updateContact,
  updateEntitlement,
  updateMembership,
  updateNumbering,
} from './admin';
import { isCompanyArchive, mergeCompanyArchive } from './archive';

export interface ExecutionOutcome {
  state: AppState;
  result: CommandResult;
}

function commandPayload(envelope: CommandEnvelope): string {
  return payloadDigest({
    workspaceId: envelope.workspaceId,
    actorId: envelope.actorId,
    command: envelope.command,
  });
}

function requireInventoryWrite(ctx: WriteContext) {
  const product = requireProduct(ctx, 'inventory');
  if (!product.ok) return product;
  return requireRole(ctx, 'inventory_officer', 'company_admin', 'accountant');
}

function dispatch(draft: ReturnType<typeof createDraft>, ctx: WriteContext, command: DomainCommand): Result<CommandResult> {
  switch (command.type) {
    case 'invoice.create':
      return createInvoice(draft, ctx, command.input);
    case 'invoice.update':
      return updateInvoice(draft, ctx, command.input);
    case 'invoice.post':
      return postInvoice(draft, ctx, command.input);
    case 'invoice.reverse':
      return reverseInvoice(draft, ctx, command.input);
    case 'receipt.create':
      return createReceipt(draft, ctx, command.input);
    case 'receipt.return':
      return returnReceipt(draft, ctx, command.input);
    case 'creditNote.create':
      return createCreditNote(draft, ctx, command.input);
    case 'refund.create':
      return createRefund(draft, ctx, command.input);
    case 'po.create':
      return createPurchaseOrder(draft, ctx, command.input);
    case 'goodsReceipt.create':
      return createGoodsReceipt(draft, ctx, command.input);
    case 'bill.create':
      return createBill(draft, ctx, command.input);
    case 'rfp.create':
      return createRfp(draft, ctx, command.input);
    case 'rfp.approve':
      return approveRfp(draft, ctx, command.input);
    case 'rfp.reject':
      return rejectRfp(draft, ctx, command.input);
    case 'payment.create':
      return createPayment(draft, ctx, command.input);
    case 'advance.create':
      return createAdvance(draft, ctx, command.input);
    case 'advance.liquidate':
      return liquidateAdvance(draft, ctx, command.input);
    case 'bankRow.import':
      return importBankRows(draft, ctx, command.input);
    case 'bankRow.match':
      return matchBankRow(draft, ctx, command.input);
    case 'bankRow.undo':
      return undoBankRow(draft, ctx, command.input);
    case 'item.create':
      return createItem(draft, ctx, command.input);
    case 'location.create':
      return createLocation(draft, ctx, command.input);
    case 'movement.receipt': {
      const role = requireInventoryWrite(ctx);
      if (!role.ok) return role;
      const movement = recordReceiptMovement(draft, ctx, {
        itemId: command.input.itemId,
        locationId: command.input.locationId,
        occurredOn: command.input.occurredOn,
        quantityMilli: command.input.quantityMilli,
        unitCostCentavos: command.input.unitCostCentavos,
        sourceType: command.input.sourceType ?? 'manual_receipt',
        sourceId: command.input.sourceId ?? ctx.clock.newId('source'),
        effectKey: command.input.effectKey ?? `manual-receipt:${ctx.clock.newId('mrec')}`,
      });
      if (!movement.ok) return movement;
      return ok(movementToCommandResult(movement.value, 'Stock receipt recorded.'));
    }
    case 'movement.issue': {
      const role = requireInventoryWrite(ctx);
      if (!role.ok) return role;
      const movement = recordIssueMovement(draft, ctx, {
        itemId: command.input.itemId,
        locationId: command.input.locationId,
        occurredOn: command.input.occurredOn,
        quantityMilli: command.input.quantityMilli,
        purpose: command.input.purpose,
        sourceType: command.input.sourceType ?? 'manual_issue',
        sourceId: command.input.sourceId ?? ctx.clock.newId('source'),
        effectKey: command.input.effectKey ?? `manual-issue:${ctx.clock.newId('miss')}`,
      });
      if (!movement.ok) return movement;
      return ok(movementToCommandResult(movement.value, 'Stock issue recorded.'));
    }
    case 'movement.transfer': {
      const role = requireInventoryWrite(ctx);
      if (!role.ok) return role;
      const movement = recordTransferMovement(draft, ctx, command.input);
      if (!movement.ok) return movement;
      return ok(movementToCommandResult(movement.value, 'Stock transfer recorded; values are unchanged.'));
    }
    case 'movement.customerReturn': {
      const role = requireInventoryWrite(ctx);
      if (!role.ok) return role;
      const movement = recordCustomerReturn(draft, ctx, command.input);
      if (!movement.ok) return movement;
      return ok(movementToCommandResult(movement.value, 'Customer return recorded against its issue.'));
    }
    case 'movement.supplierReturn': {
      const role = requireInventoryWrite(ctx);
      if (!role.ok) return role;
      const movement = recordSupplierReturn(draft, ctx, command.input);
      if (!movement.ok) return movement;
      return ok(movementToCommandResult(movement.value, 'Supplier return recorded against its receipt.'));
    }
    case 'movement.count': {
      const role = requireInventoryWrite(ctx);
      if (!role.ok) return role;
      const movement = recordCountMovement(draft, ctx, command.input);
      if (!movement.ok) return movement;
      if (movement.value === null) {
        return ok({
          summary: 'Count matches the recorded location quantity; no gain or loss was posted.',
          documentType: 'movement',
          documentId: '',
          journalIds: [],
          warnings: [],
        });
      }
      return ok(movementToCommandResult(movement.value, 'Stock count adjustment recorded.'));
    }
    case 'employee.create':
      return createEmployee(draft, ctx, command.input);
    case 'payrollPolicy.update':
      return updatePayrollPolicy(draft, ctx, command.input);
    case 'time.import':
      return importTime(draft, ctx, command.input);
    case 'payroll.calculate':
      return calculatePayroll(draft, ctx, command.input);
    case 'payroll.approve':
      return approvePayroll(draft, ctx, command.input);
    case 'payroll.post':
      return postPayroll(draft, ctx, command.input);
    case 'payroll.pay':
      return payPayroll(draft, ctx, command.input);
    case 'payroll.reverse':
      return reversePayroll(draft, ctx, command.input);
    case 'worksheet.save':
      return saveWorksheet(draft, ctx, command.input);
    case 'asset.create':
      return createAsset(draft, ctx, command.input);
    case 'depreciation.calculate':
      return calculateDepreciation(draft, ctx, command.input);
    case 'depreciation.approve':
      return approveDepreciation(draft, ctx, command.input);
    case 'depreciation.post':
      return postDepreciation(draft, ctx, command.input);
    case 'journalDraft.create':
      return createJournalDraft(draft, ctx, command.input);
    case 'journalDraft.approve':
      return approveJournalDraft(draft, ctx, command.input);
    case 'journalDraft.post':
      return postJournalDraft(draft, ctx, command.input);
    case 'journalDraft.reject':
      return rejectJournalDraft(draft, ctx, command.input);
    case 'journal.reverse':
      return reversePostedJournal(draft, ctx, command.input);
    case 'period.close':
      return closePeriod(draft, ctx, command.input);
    case 'period.reopen':
      return reopenPeriod(draft, ctx, command.input);
    case 'taxRecord.createFinalWithholding':
      return createFinalWithholding(draft, ctx, command.input);
    case 'certificate2307.create':
      return createCertificate2307(draft, ctx, command.input);
    case 'contact.create':
      return createContact(draft, ctx, command.input);
    case 'contact.update':
      return updateContact(draft, ctx, command.input);
    case 'account.create':
      return createAccount(draft, ctx, command.input);
    case 'membership.update':
      return updateMembership(draft, ctx, command.input);
    case 'entitlement.update':
      return updateEntitlement(draft, ctx, command.input);
    case 'maintenance.set':
      return setMaintenance(draft, ctx, command.input);
    case 'numbering.policyUpdate':
      return updateNumbering(draft, ctx, command.input);
    case 'workspace.activateAccounting':
      return activateAccounting(draft, ctx, command.input);
    case 'masters.import':
      return importMasters(draft, ctx, command.input);
    case 'archive.restore':
      return err('VALIDATION', 'Archive restore is applied through the archive control, not the ordinary command path.');
  }
}

/**
 * The single typed write seam. Every mutation goes through here, so the
 * idempotency receipt, revision check, maintenance gate, and audit trail are
 * applied uniformly.
 */
export function executeCommand(
  state: AppState,
  envelope: CommandEnvelope,
  clock: Clock,
): Result<ExecutionOutcome> {
  if (envelope.idempotencyKey.trim().length === 0) {
    return err('VALIDATION', 'An idempotency key is required for every command.');
  }
  if (envelope.workspaceId.trim().length === 0 || envelope.actorId.trim().length === 0) {
    return err('VALIDATION', 'Workspace and actor are required.');
  }
  const accessResult = resolveAccess(state, envelope.actorId, envelope.workspaceId, clock.today);
  if (!accessResult.ok) return accessResult;
  const access = accessResult.value;

  const receiptKey = `${envelope.workspaceId}:${envelope.idempotencyKey}`;
  const payloadHash = commandPayload(envelope);
  const existingReceipt = state.idempotency[receiptKey];
  if (existingReceipt) {
    if (existingReceipt.payloadHash !== payloadHash) {
      return err(
        'IDEMPOTENCY_CONFLICT',
        'This idempotency key was already used with a different payload. The original result was kept unchanged.',
        'idempotencyKey',
      );
    }
    if (existingReceipt.commandType !== envelope.command.type) {
      return err(
        'IDEMPOTENCY_CONFLICT',
        'This idempotency key belongs to a different command type.',
        'idempotencyKey',
      );
    }
    const stored = JSON.parse(existingReceipt.resultJson) as CommandResult;
    return ok({ state, result: stored });
  }

  if (envelope.expectedRevision !== undefined && envelope.expectedRevision !== state.revision) {
    return err(
      'STALE_REVISION',
      `The workspace changed since this screen loaded (expected revision ${envelope.expectedRevision}, current ${state.revision}). Refresh and try again.`,
    );
  }

  if (state.workspaces.find((workspace) => workspace.id === envelope.workspaceId)?.settings.maintenance.active) {
    if (!MAINTENANCE_ALLOWED_COMMANDS.has(envelope.command.type)) {
      return err(
        'MAINTENANCE_ACTIVE',
        'Maintenance mode is active. Ordinary writes are blocked; authorized export remains available.',
      );
    }
  }

  if (envelope.command.type === 'archive.restore') {
    const { archive, reason, expectedChecksum } = envelope.command.input;
    if (!access.membership.archiveGrant) {
      return err('FORBIDDEN', 'You do not have the archive-restore grant in this workspace.');
    }
    const role = requireRole(access, 'company_admin');
    if (!role.ok) return role;
    if (!isCompanyArchive(archive)) {
      return err('VALIDATION', 'The selected file is not an ECE Accounting company archive.');
    }
    if (archive.workspaceId !== envelope.workspaceId) {
      return err('FORBIDDEN', 'A company archive can only be restored into its own workspace.');
    }
    if (archive.checksum !== expectedChecksum) {
      return err('VALIDATION', 'Archive checksum does not match the reviewed checksum.');
    }
    if (reason.trim().length < 3) return err('VALIDATION', 'A restore reason is required.', 'reason');
    const merged = mergeCompanyArchive(state, archive, envelope.actorId, reason, clock.nowIso, clock.newId('restore'));
    if (!merged.ok) return merged;
    const result: CommandResult = {
      summary: `Archive restored for ${access.workspace.name}; other companies were not replaced.`,
      documentType: 'archive',
      documentId: archive.checksum,
      journalIds: [],
      warnings: ['Restore replaces the archived company’s records with the file contents. Review counts first.'],
    };
    const next: AppState = {
      ...merged.value,
      idempotency: {
        ...merged.value.idempotency,
        [receiptKey]: {
          key: receiptKey,
          payloadHash,
          commandType: envelope.command.type,
          resultJson: JSON.stringify(result),
          at: clock.nowIso,
        },
      },
      revision: merged.value.revision + 1,
    };
    return ok({ state: next, result });
  }

  const draft = createDraft(state);
  const ctx: WriteContext = { ...access, clock };
  const result = dispatch(draft, ctx, envelope.command);
  if (!result.ok) return result;

  draft.state.revision = state.revision + 1;
  draft.state.idempotency = {
    ...draft.state.idempotency,
    [receiptKey]: {
      key: receiptKey,
      payloadHash,
      commandType: envelope.command.type,
      resultJson: JSON.stringify(result.value),
      at: clock.nowIso,
    },
  };
  return ok({ state: draft.state, result: result.value });
}
