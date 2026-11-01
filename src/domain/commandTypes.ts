import type { ProductCode, Role, TaxBracket, TimeBucket } from './schema';
import type { RecordKind } from './numbering';

export interface CommandResult {
  summary: string;
  documentType: string;
  documentId: string;
  journalIds: string[];
  warnings: string[];
}

export interface InvoiceLineInput {
  description: string;
  quantityMilli: number;
  unitPriceCentavos: number;
  accountId: string;
}

export interface AllocationInput {
  invoiceId: string;
  amountCentavos: number;
}

export interface BillLineInput {
  description: string;
  accountId: string;
  amountCentavos: number;
  taxTreatment: 'none' | 'input_vat12';
  stockReceiptId?: string | null;
  itemId?: string | null;
  quantityMilli?: number | null;
  ewtRateBp?: number;
}

export interface BankCsvRowInput {
  rowRef: string;
  valueDate: string;
  description: string;
  direction: 'in' | 'out';
  amountCentavos: number;
}

export interface TimeRowInput {
  employeeId: string;
  bucket: TimeBucket;
  minutes: number;
}

export interface MasterContactInput {
  name: string;
  tin: string;
  address: string;
  roles: Array<'customer' | 'vendor'>;
}

export interface MasterItemInput {
  sku: string;
  name: string;
  baseUnit: string;
}

export interface OpeningBalanceInput {
  accountId: string;
  debitCentavos: number;
  creditCentavos: number;
}

export interface WorksheetInputs {
  [key: string]: string | number;
}

export type DomainCommand =
  | {
      type: 'invoice.create';
      input: {
        customerContactId: string;
        invoiceDate: string;
        dueDate: string;
        branch: string;
        department: string;
        taxTreatment: 'none' | 'vat12';
        lines: InvoiceLineInput[];
        stockIssueMovementId?: string | null;
      };
    }
  | { type: 'invoice.update'; input: { invoiceId: string; input: Extract<DomainCommand, { type: 'invoice.create' }>['input'] } }
  | { type: 'invoice.post'; input: { invoiceId: string } }
  | { type: 'invoice.reverse'; input: { invoiceId: string; reversalDate: string; reason: string } }
  | {
      type: 'receipt.create';
      input: {
        customerContactId: string;
        receiptDate: string;
        amountCentavos: number;
        bankAccountId: string;
        method: 'bank_deposit' | 'incoming_clearing';
        reference: string;
        allocations: AllocationInput[];
      };
    }
  | { type: 'receipt.return'; input: { receiptId: string; returnDate: string; reason: string } }
  | { type: 'creditNote.create'; input: { invoiceId: string; creditDate: string; netCentavos: number; reason: string } }
  | {
      type: 'refund.create';
      input: {
        customerContactId: string;
        refundDate: string;
        amountCentavos: number;
        bankAccountId: string;
        reason: string;
      };
    }
  | {
      type: 'po.create';
      input: {
        vendorContactId: string;
        poDate: string;
        lines: Array<{
          itemId?: string | null;
          description: string;
          quantityMilli: number;
          unitCostCentavos: number;
          accountId: string;
        }>;
      };
    }
  | {
      type: 'goodsReceipt.create';
      input: {
        poId: string;
        receiptDate: string;
        locationId: string;
        lines: Array<{ poLineId: string; quantityMilli: number }>;
      };
    }
  | {
      type: 'bill.create';
      input: {
        vendorContactId: string;
        supplierInvoiceNo: string;
        billDate: string;
        dueDate: string;
        lines: BillLineInput[];
      };
    }
  | { type: 'rfp.create'; input: { billId: string; amountCentavos: number } }
  | { type: 'rfp.approve'; input: { rfpId: string } }
  | { type: 'rfp.reject'; input: { rfpId: string; reason: string } }
  | {
      type: 'payment.create';
      input: {
        rfpId: string;
        paymentDate: string;
        method: 'outgoing_clearing' | 'bank_direct';
        bankAccountId?: string | null;
      };
    }
  | {
      type: 'advance.create';
      input: {
        employeeId: string;
        advanceDate: string;
        amountCentavos: number;
        bankAccountId: string;
      };
    }
  | {
      type: 'advance.liquidate';
      input: {
        advanceId: string;
        liquidationDate: string;
        expenses: Array<{ accountId: string; description: string; amountCentavos: number }>;
        unusedReturnCentavos: number;
        excessReimbursementCentavos: number;
        bankAccountId: string;
      };
    }
  | {
      type: 'bankRow.import';
      input: {
        bankAccountId: string;
        sourceName: string;
        rows: BankCsvRowInput[];
      };
    }
  | {
      type: 'bankRow.match';
      input: {
        rowId: string;
        sourceType: 'customer_receipt' | 'payment';
        sourceId: string;
        reason: string;
      };
    }
  | { type: 'bankRow.undo'; input: { rowId: string; reversalDate: string; reason: string } }
  | {
      type: 'item.create';
      input: {
        sku: string;
        name: string;
        baseUnit: string;
        inventoryAccountId?: string | null;
        cogsAccountId?: string | null;
      };
    }
  | { type: 'location.create'; input: { code: string; name: string } }
  | {
      type: 'movement.receipt';
      input: {
        itemId: string;
        locationId: string;
        occurredOn: string;
        quantityMilli: number;
        unitCostCentavos: number;
        sourceType?: string;
        sourceId?: string;
        effectKey?: string;
      };
    }
  | {
      type: 'movement.issue';
      input: {
        itemId: string;
        locationId: string;
        occurredOn: string;
        quantityMilli: number;
        purpose: string;
        sourceType?: string;
        sourceId?: string;
        effectKey?: string;
      };
    }
  | {
      type: 'movement.transfer';
      input: {
        itemId: string;
        fromLocationId: string;
        toLocationId: string;
        occurredOn: string;
        quantityMilli: number;
      };
    }
  | {
      type: 'movement.customerReturn';
      input: {
        itemId: string;
        locationId: string;
        occurredOn: string;
        quantityMilli: number;
        issueMovementId: string;
        reason: string;
      };
    }
  | {
      type: 'movement.supplierReturn';
      input: {
        itemId: string;
        locationId: string;
        occurredOn: string;
        quantityMilli: number;
        receiptMovementId: string;
        reason: string;
      };
    }
  | {
      type: 'movement.count';
      input: {
        itemId: string;
        locationId: string;
        occurredOn: string;
        countedQuantityMilli: number;
        unitCostCentavos?: number | null;
        reason: string;
      };
    }
  | {
      type: 'employee.create';
      input: {
        employeeNo: string;
        name: string;
        monthlySalaryCentavos: number;
        hiredOn: string;
        deductionScheduleId: string;
        branch: string;
        department: string;
      };
    }
  | {
      type: 'payrollPolicy.update';
      input: {
        policyId: string;
        hoursPerMonth: number;
        periodStart: string;
        periodEnd: string;
        payDate: string;
        approvalDeadline: string;
        periodWorkingDays: number;
        annualTaxSchedule?: TaxBracket[];
      };
    }
  | { type: 'time.import'; input: { sourceName: string; rows: TimeRowInput[] } }
  | { type: 'payroll.calculate'; input: { timeImportId: string } }
  | { type: 'payroll.approve'; input: { runId: string } }
  | { type: 'payroll.post'; input: { runId: string } }
  | { type: 'payroll.pay'; input: { runId: string; paymentDate: string; bankAccountId: string } }
  | { type: 'payroll.reverse'; input: { runId: string; reversalDate: string; reason: string } }
  | {
      type: 'worksheet.save';
      input: {
        kind: '13th_month' | 'annualization' | 'final_pay' | '2316';
        employeeId?: string | null;
        label: string;
        inputs: WorksheetInputs;
      };
    }
  | {
      type: 'asset.create';
      input: {
        companyVendorBrand: string;
        purchaseDate: string;
        description: string;
        supplierContactId?: string | null;
        serialNo: string;
        assetAccountId: string;
        costCentavos: number;
        usefulLifeYears: number;
        residualValueCentavos: number;
        depreciationStart: string;
        convention: 'full_month' | 'daily_prorated';
        depreciationExpenseAccountId: string;
        accumulatedDepreciationAccountId: string;
        sourceType: 'direct_purchase' | 'opening' | 'stock_reclass';
        sourceId?: string | null;
        postAcquisition: boolean;
      };
    }
  | { type: 'depreciation.calculate'; input: { period: string } }
  | { type: 'depreciation.approve'; input: { period: string } }
  | { type: 'depreciation.post'; input: { period: string } }
  | {
      type: 'journalDraft.create';
      input: {
        journalDate: string;
        memo: string;
        lines: Array<{ accountId: string; debitCentavos: number; creditCentavos: number }>;
      };
    }
  | { type: 'journalDraft.approve'; input: { draftId: string } }
  | { type: 'journalDraft.post'; input: { draftId: string } }
  | { type: 'journalDraft.reject'; input: { draftId: string; reason: string } }
  | { type: 'journal.reverse'; input: { journalId: string; reversalDate: string; reason: string } }
  | { type: 'period.close'; input: { year: number; month: number; reason: string } }
  | { type: 'period.reopen'; input: { year: number; month: number; reason: string } }
  | {
      type: 'taxRecord.createFinalWithholding';
      input: {
        partyContactId: string;
        taxDate: string;
        baseCentavos: number;
        taxCentavos: number;
        description: string;
      };
    }
  | {
      type: 'certificate2307.create';
      input: {
        direction: 'issued' | 'received';
        counterpartyContactId: string;
        certificateNo: string;
        certificateDate: string;
        periodFrom: string;
        periodTo: string;
        sourceTaxRecordIds: string[];
      };
    }
  | {
      type: 'contact.create';
      input: MasterContactInput;
    }
  | {
      type: 'contact.update';
      input: MasterContactInput & { contactId: string; active: boolean };
    }
  | {
      type: 'account.create';
      input: { code: string; name: string; type: string; normalBalance: 'debit' | 'credit' };
    }
  | {
      type: 'membership.update';
      input: {
        userId: string;
        roles: Role[];
        payrollDetail: boolean;
        archiveGrant: boolean;
        active: boolean;
      };
    }
  | {
      type: 'entitlement.update';
      input: { product: ProductCode; active: boolean; expiresOn: string | null };
    }
  | {
      type: 'maintenance.set';
      input: {
        active: boolean;
        windowLabel?: string;
        scheduledFor?: string;
        maxDurationMinutes?: number;
        note?: string;
      };
    }
  | {
      type: 'workspace.activateAccounting';
      input: { cutoverDate: string; reason: string; confirmOpeningValueCentavos: number };
    }
  | {
      type: 'masters.import';
      input: {
        contacts: MasterContactInput[];
        items: MasterItemInput[];
        openings: OpeningBalanceInput[];
        postingDate: string;
        approvalNote: string;
      };
    }
  | {
      type: 'numbering.policyUpdate';
      input: {
        kind: RecordKind;
        prefix: string;
        nextNumber: number;
        minDigits: number;
        increment: number;
        manualOverride: boolean;
        reason: string;
      };
    }
  | {
      type: 'archive.restore';
      input: { archive: unknown; reason: string; expectedChecksum: string };
    };

export type CommandType = DomainCommand['type'];

export interface CommandEnvelope {
  workspaceId: string;
  actorId: string;
  idempotencyKey: string;
  expectedRevision?: number;
  command: DomainCommand;
}

export const MAINTENANCE_ALLOWED_COMMANDS: ReadonlySet<CommandType> = new Set<CommandType>([
  // Turning maintenance off must remain possible; every ordinary writer,
  // including a privileged archive restore, is blocked while it is active.
  'maintenance.set',
]);
