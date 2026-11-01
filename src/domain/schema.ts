import { z } from 'zod';
import { isValidDateOnly } from './shared/dates';
import { RECORD_KINDS } from './numbering';

export const SCHEMA_VERSION = 2;

const id = z.string().min(1);
const dateOnly = z.string().refine(isValidDateOnly, 'must be a real YYYY-MM-DD date');
const timestamp = z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'must be an ISO timestamp');
const centavos = z.number().int();
const nonNegativeCentavos = centavos.min(0);
const positiveInt = z.number().int().positive();
const nonNegativeInt = z.number().int().min(0);

export const productSchema = z.enum(['accounting', 'payroll', 'inventory']);
export const roleSchema = z.enum([
  'company_admin',
  'accountant',
  'ap_ar_clerk',
  'payroll_officer',
  'inventory_officer',
]);
export const movementTypeSchema = z.enum([
  'receipt',
  'issue',
  'transfer',
  'customer_return',
  'supplier_return',
  'count_gain',
  'count_loss',
]);
export const timeBucketSchema = z.enum([
  'ordinary_regular',
  'ordinary_night',
  'ordinary_ot',
  'ordinary_night_ot',
  'rest_day',
  'rest_day_ot',
  'rest_day_night_ot',
  'special_nonworking',
  'special_nonworking_rest',
  'special_nonworking_ot',
  'special_nonworking_rest_ot',
  'special_nonworking_night_ot',
  'special_nonworking_rest_night_ot',
  'regular_holiday',
  'regular_holiday_rest',
  'regular_holiday_ot',
  'regular_holiday_rest_ot',
  'regular_holiday_night_ot',
  'regular_holiday_rest_night_ot',
]);

export const userSchema = z.object({
  id,
  name: z.string().min(1),
  title: z.string().min(1),
});

export const seatSchema = z.object({
  id,
  workspaceId: id,
  label: z.string().min(1),
  assignedUserId: id.nullable(),
});

export const membershipSchema = z.object({
  userId: id,
  workspaceId: id,
  roles: z.array(roleSchema).min(1),
  payrollDetail: z.boolean(),
  archiveGrant: z.boolean(),
  active: z.boolean(),
  seatId: id.nullable(),
});

export const entitlementSchema = z.object({
  active: z.boolean(),
  activatedOn: dateOnly.nullable(),
  expiresOn: dateOnly.nullable(),
});

export const maintenanceSchema = z.object({
  active: z.boolean(),
  windowLabel: z.string(),
  scheduledFor: z.string(),
  maxDurationMinutes: positiveInt,
  startedAt: timestamp.nullable(),
  startedBy: id.nullable(),
  endedAt: timestamp.nullable(),
  endedBy: id.nullable(),
  completionNote: z.string(),
});

export const cutoverSchema = z.object({
  proposedDate: dateOnly,
  approvedDate: dateOnly.nullable(),
  approvedBy: id.nullable(),
  inventoryOpeningValueCentavos: nonNegativeCentavos,
  status: z.enum(['proposed', 'activated']),
  notes: z.string(),
});

export const workspaceSchema = z.object({
  id,
  name: z.string().min(1),
  legalName: z.string().min(1),
  tin: z.string(),
  fiscalYearStartMonth: z.number().int().min(1).max(12),
  entitlements: z.object({
    accounting: entitlementSchema,
    payroll: entitlementSchema,
    inventory: entitlementSchema,
  }),
  settings: z.object({
    maintenance: maintenanceSchema,
    payrollPolicyId: id.nullable(),
    cutover: cutoverSchema.nullable(),
    archiveNote: z.string(),
  }),
});

export const contactSchema = z.object({
  id,
  workspaceId: id,
  contactNo: z.string().min(1),
  name: z.string().min(1),
  tin: z.string(),
  address: z.string(),
  roles: z.array(z.enum(['customer', 'vendor'])).min(1),
  active: z.boolean(),
});

export const accountSchema = z.object({
  id,
  workspaceId: id,
  code: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(['asset', 'liability', 'equity', 'revenue', 'expense']),
  normalBalance: z.enum(['debit', 'credit']),
  controlRole: z.string().nullable(),
  active: z.boolean(),
});

export const periodSchema = z.object({
  id,
  workspaceId: id,
  year: z.number().int().min(2000).max(2200),
  month: z.number().int().min(1).max(12),
  status: z.enum(['open', 'closed']),
  closedBy: id.nullable(),
  closedAt: timestamp.nullable(),
  closeReason: z.string().nullable(),
  reopenedBy: id.nullable(),
  reopenedAt: timestamp.nullable(),
  reopenReason: z.string().nullable(),
});

export const SOURCE_BOOK_KEYS = ['sales', 'collections', 'purchases', 'cash_disbursements', 'journals'] as const;
export type SourceBookKey = (typeof SOURCE_BOOK_KEYS)[number];

export const SOURCE_BOOK_LABELS: Record<SourceBookKey, string> = {
  sales: 'Sales Report',
  collections: 'Collections',
  purchases: 'Purchases',
  cash_disbursements: 'Cash Disbursements',
  journals: 'Journals',
};

export const journalProvenanceSchema = z.object({
  version: z.literal(1),
  book: z.enum(SOURCE_BOOK_KEYS),
  originSourceType: z.string(),
  originSourceId: z.string(),
  originJournalId: z.string().nullable().default(null),
  clearingTargetType: z.enum(['customer_receipt', 'payment']).nullable().default(null),
  clearingTargetId: z.string().nullable().default(null).optional(),
  provisional: z.boolean().default(false),
  exceptionReason: z.string().nullable().default(null),
});
export type JournalProvenance = z.infer<typeof journalProvenanceSchema>;

export const journalLineSchema = z.object({
  accountId: id,
  accountCode: z.string().min(1),
  debitCentavos: nonNegativeCentavos,
  creditCentavos: nonNegativeCentavos,
  memo: z.string(),
});

export const journalSchema = z.object({
  id,
  workspaceId: id,
  journalNo: z.string().min(1),
  postingDate: dateOnly,
  documentDate: dateOnly,
  sourceType: z.string().min(1),
  sourceId: z.string().min(1),
  effectKey: z.string().min(1),
  memo: z.string(),
  lines: z.array(journalLineSchema).min(2),
  status: z.literal('posted'),
  createdBy: id,
  createdAt: timestamp,
  approvedBy: id.nullable(),
  policySnapshot: z.string().nullable(),
  reversalOf: id.nullable(),
  reversedBy: id.nullable(),
  sourceProvenance: journalProvenanceSchema.optional(),
});

export const auditEventSchema = z.object({
  id,
  workspaceId: id,
  actorId: id,
  action: z.string().min(1),
  recordType: z.string().min(1),
  recordId: z.string().min(1),
  at: timestamp,
  reason: z.string().nullable(),
  detail: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
});

export const invoiceLineSchema = z.object({
  id,
  description: z.string().min(1),
  quantityMilli: positiveInt,
  unitPriceCentavos: nonNegativeCentavos,
  accountId: id,
  amountCentavos: nonNegativeCentavos,
});

export const invoiceSchema = z.object({
  id,
  workspaceId: id,
  invoiceNo: z.string().min(1),
  customerContactId: id,
  customerSnapshot: z.object({ name: z.string(), tin: z.string(), address: z.string() }),
  branch: z.string(),
  department: z.string(),
  invoiceDate: dateOnly,
  dueDate: dateOnly,
  status: z.enum(['draft', 'posted', 'partially_paid', 'paid', 'reversed']),
  taxTreatment: z.enum(['none', 'vat12']),
  lines: z.array(invoiceLineSchema).min(1),
  subtotalCentavos: nonNegativeCentavos,
  taxCentavos: nonNegativeCentavos,
  totalCentavos: nonNegativeCentavos,
  paidCentavos: nonNegativeCentavos,
  outstandingCentavos: nonNegativeCentavos,
  arAccountId: id,
  revenueAccountId: id,
  taxAccountId: id.nullable(),
  journalId: id.nullable(),
  stockIssueMovementId: id.nullable(),
  createdAt: timestamp,
  createdBy: id,
  postedAt: timestamp.nullable(),
  revision: nonNegativeInt,
});

export const receiptSchema = z.object({
  id,
  workspaceId: id,
  receiptNo: z.string().min(1),
  customerContactId: id,
  receiptDate: dateOnly,
  amountCentavos: positiveInt,
  allocations: z.array(z.object({ invoiceId: id, amountCentavos: positiveInt })),
  unappliedCentavos: nonNegativeCentavos,
  method: z.enum(['bank_deposit', 'incoming_clearing']),
  bankAccountId: id,
  reference: z.string(),
  status: z.enum(['posted', 'returned']),
  journalId: id,
  returnedOn: dateOnly.nullable(),
  returnReason: z.string().nullable(),
  returnJournalId: id.nullable(),
  createdAt: timestamp,
  createdBy: id,
});

export const creditNoteSchema = z.object({
  id,
  workspaceId: id,
  creditNo: z.string().min(1),
  invoiceId: id,
  customerContactId: id,
  creditDate: dateOnly,
  amountCentavos: positiveInt,
  taxCentavos: nonNegativeCentavos,
  reason: z.string().min(1),
  status: z.enum(['posted', 'reversed']),
  journalId: id,
  createdAt: timestamp,
  createdBy: id,
});

export const refundSchema = z.object({
  id,
  workspaceId: id,
  refundNo: z.string().min(1),
  customerContactId: id,
  refundDate: dateOnly,
  amountCentavos: positiveInt,
  bankAccountId: id,
  reason: z.string().min(1),
  journalId: id,
  createdAt: timestamp,
  createdBy: id,
});

export const poLineSchema = z.object({
  id,
  itemId: id.nullable(),
  description: z.string().min(1),
  quantityMilli: positiveInt,
  unitCostCentavos: nonNegativeCentavos,
  accountId: id,
  receivedMilli: nonNegativeInt,
  billedMilli: nonNegativeInt,
});

export const purchaseOrderSchema = z.object({
  id,
  workspaceId: id,
  poNo: z.string().min(1),
  vendorContactId: id,
  poDate: dateOnly,
  status: z.enum(['open', 'partially_received', 'closed']),
  lines: z.array(poLineSchema).min(1),
  createdBy: id,
  createdAt: timestamp,
});

export const goodsReceiptSchema = z.object({
  id,
  workspaceId: id,
  receiptNo: z.string().min(1),
  poId: id,
  vendorContactId: id,
  receiptDate: dateOnly,
  lines: z
    .array(
      z.object({
        poLineId: id,
        itemId: id,
        quantityMilli: positiveInt,
        unitCostCentavos: nonNegativeCentavos,
        movementId: id,
      }),
    )
    .min(1),
  createdBy: id,
  createdAt: timestamp,
});

export const billLineSchema = z.object({
  id,
  description: z.string().min(1),
  accountId: id,
  amountCentavos: nonNegativeCentavos,
  taxTreatment: z.enum(['none', 'input_vat12']),
  taxCentavos: nonNegativeCentavos,
  stockReceiptId: id.nullable(),
  itemId: id.nullable(),
  quantityMilli: nonNegativeInt.nullable(),
  ewtRateBp: nonNegativeInt,
});

export const billSchema = z.object({
  id,
  workspaceId: id,
  billNo: z.string().min(1),
  supplierInvoiceNo: z.string().min(1),
  vendorContactId: id,
  vendorSnapshot: z.object({ name: z.string(), tin: z.string(), address: z.string() }),
  billDate: dateOnly,
  dueDate: dateOnly,
  lines: z.array(billLineSchema).min(1),
  subtotalCentavos: nonNegativeCentavos,
  taxCentavos: nonNegativeCentavos,
  totalCentavos: nonNegativeCentavos,
  ewtCentavos: nonNegativeCentavos,
  paidCentavos: nonNegativeCentavos,
  outstandingCentavos: nonNegativeCentavos,
  status: z.enum(['posted', 'partially_paid', 'paid', 'held', 'reversed']),
  journalId: id.nullable(),
  createdBy: id,
  createdAt: timestamp,
  duplicateFlag: z.boolean(),
  revision: nonNegativeInt,
});

export const rfpSchema = z.object({
  id,
  workspaceId: id,
  rfpNo: z.string().min(1),
  billId: id,
  amountCentavos: positiveInt,
  status: z.enum(['pending', 'approved', 'rejected', 'paid', 'cancelled']),
  requestedBy: id,
  requestedAt: timestamp,
  approvedBy: id.nullable(),
  approvedAt: timestamp.nullable(),
  rejectionReason: z.string().nullable(),
  paymentId: id.nullable(),
});

export const paymentSchema = z.object({
  id,
  workspaceId: id,
  paymentNo: z.string().min(1),
  rfpId: id,
  billId: id,
  vendorContactId: id,
  paymentDate: dateOnly,
  amountCentavos: positiveInt,
  ewtCentavos: nonNegativeCentavos,
  method: z.enum(['outgoing_clearing', 'bank_direct']),
  clearingAccountId: id.nullable(),
  bankAccountId: id.nullable(),
  status: z.enum(['posted', 'cleared', 'reversed']),
  journalId: id,
  clearedJournalId: id.nullable(),
  bankRowId: id.nullable(),
  createdBy: id,
  approvedBy: id,
  createdAt: timestamp,
});

export const advanceSchema = z.object({
  id,
  workspaceId: id,
  advanceNo: z.string().min(1),
  employeeId: id,
  advanceDate: dateOnly,
  amountCentavos: positiveInt,
  liquidatedCentavos: nonNegativeCentavos,
  returnedCentavos: nonNegativeCentavos,
  status: z.enum(['open', 'closed']),
  journalId: id,
  createdBy: id,
  createdAt: timestamp,
});

export const liquidationSchema = z.object({
  id,
  workspaceId: id,
  liquidationNo: z.string().min(1),
  advanceId: id,
  liquidationDate: dateOnly,
  expenses: z
    .array(z.object({ accountId: id, description: z.string().min(1), amountCentavos: positiveInt }))
    .min(1),
  expenseTotalCentavos: positiveInt,
  unusedReturnCentavos: nonNegativeCentavos,
  excessReimbursementCentavos: nonNegativeCentavos,
  journalIds: z.array(id),
  createdBy: id,
  createdAt: timestamp,
});

export const bankAccountSchema = z.object({
  id,
  workspaceId: id,
  bankCode: z.string().min(1),
  name: z.string().min(1),
  bankName: z.string().min(1),
  accountNoMasked: z.string(),
  ledgerAccountId: id,
  active: z.boolean(),
});

export const bankStatementSchema = z.object({
  id,
  workspaceId: id,
  statementNo: z.string().min(1),
  bankAccountId: id,
  importedAt: timestamp,
  sourceName: z.string().min(1),
  rowCount: positiveInt,
  importedBy: id,
});

export const bankRowSchema = z.object({
  id,
  workspaceId: id,
  statementId: id,
  bankAccountId: id,
  rowRef: z.string().min(1),
  valueDate: dateOnly,
  description: z.string(),
  direction: z.enum(['in', 'out']),
  amountCentavos: positiveInt,
  status: z.enum(['unmatched', 'matched', 'reconciled']),
  matchedSourceType: z.enum(['customer_receipt', 'payment']).nullable(),
  matchedSourceId: id.nullable(),
  matchReason: z.string().nullable(),
  clearingJournalId: id.nullable(),
  reconciledAt: timestamp.nullable(),
  reconciledBy: id.nullable(),
  undoReason: z.string().nullable(),
  undoJournalId: id.nullable(),
  history: z.array(
    z.object({
      at: timestamp,
      by: id,
      action: z.enum(['imported', 'matched', 'reconciled', 'undo']),
      note: z.string(),
    }),
  ),
});

export const itemSchema = z.object({
  id,
  workspaceId: id,
  itemNo: z.string().min(1),
  sku: z.string().min(1),
  name: z.string().min(1),
  baseUnit: z.string().min(1),
  inventoryAccountId: id,
  cogsAccountId: id,
  active: z.boolean(),
});

export const locationSchema = z.object({
  id,
  workspaceId: id,
  code: z.string().min(1),
  name: z.string().min(1),
  active: z.boolean(),
});

export const movementSchema = z.object({
  id,
  workspaceId: id,
  movementNo: z.string().min(1),
  itemId: id,
  sequence: positiveInt,
  type: movementTypeSchema,
  occurredOn: dateOnly,
  locationId: id,
  toLocationId: id.nullable(),
  quantityMilli: positiveInt,
  unitCostCentavos: nonNegativeCentavos.nullable(),
  valueCentavos: nonNegativeCentavos,
  unitCostAppliedCentavos: nonNegativeCentavos.nullable(),
  sourceType: z.string().min(1),
  sourceId: z.string().min(1),
  effectKey: z.string().min(1),
  referenceMovementId: id.nullable(),
  approvedBy: id.nullable(),
  reason: z.string().nullable(),
  journalId: id.nullable(),
  createdAt: timestamp,
  createdBy: id,
});

export const timeMatrixRuleSchema = z.object({
  code: timeBucketSchema,
  label: z.string().min(1),
  dayFactorBp: positiveInt,
  otFactorBp: positiveInt.nullable(),
  nightFactorBp: positiveInt.nullable(),
  includedInBase: z.boolean(),
});

export const taxBracketSchema = z.object({
  upToCentavos: nonNegativeCentavos.nullable(),
  rateBp: nonNegativeInt,
});

export const payrollPolicySchema = z.object({
  id,
  workspaceId: id,
  version: z.string().min(1),
  effectiveFrom: dateOnly,
  effectiveTo: dateOnly.nullable(),
  status: z.enum(['demo_approved', 'draft']),
  hoursPerMonth: positiveInt,
  standardMinutesPerDay: positiveInt,
  periodWorkingDays: positiveInt,
  payFrequency: z.literal('semi_monthly'),
  periodStart: dateOnly,
  periodEnd: dateOnly,
  payDate: dateOnly,
  approvalDeadline: dateOnly,
  timeMatrix: z.array(timeMatrixRuleSchema).min(1),
  annualTaxSchedule: z.array(taxBracketSchema).min(1),
  thirteenthMonthDivisor: positiveInt,
  rounding: z.literal('half_up_centavo'),
  notes: z.string(),
});

export const employeeSchema = z.object({
  id,
  workspaceId: id,
  employeeNo: z.string().min(1),
  name: z.string().min(1),
  monthlySalaryCentavos: positiveInt,
  status: z.enum(['active', 'inactive']),
  hiredOn: dateOnly,
  separatedOn: dateOnly.nullable(),
  deductionScheduleId: id,
  branch: z.string(),
  department: z.string(),
});

export const deductionScheduleSchema = z.object({
  id,
  workspaceId: id,
  version: z.string().min(1),
  label: z.string().min(1),
  status: z.enum(['demo_approved', 'draft']),
  employeeSssCentavos: nonNegativeCentavos,
  employeePhilhealthCentavos: nonNegativeCentavos,
  employeePagibigCentavos: nonNegativeCentavos,
  employeeTaxCentavos: nonNegativeCentavos,
  employerSssCentavos: nonNegativeCentavos,
  employerPhilhealthCentavos: nonNegativeCentavos,
  employerPagibigCentavos: nonNegativeCentavos,
});

export const timeImportSchema = z.object({
  id,
  workspaceId: id,
  sourceName: z.string().min(1),
  importedAt: timestamp,
  importedBy: id,
  rows: z.array(z.object({ employeeId: id, bucket: timeBucketSchema, minutes: nonNegativeInt })),
  errors: z.array(z.string()),
});

export const payrollBucketLineSchema = z.object({
  code: timeBucketSchema,
  label: z.string(),
  minutes: nonNegativeInt,
  totalValueCentavos: nonNegativeCentavos,
  baseIncludedCentavos: nonNegativeCentavos,
  payableCentavos: nonNegativeCentavos,
});

export const payrollLineSchema = z.object({
  employeeId: id,
  employeeName: z.string(),
  monthlySalaryCentavos: nonNegativeCentavos,
  basePayCentavos: nonNegativeCentavos,
  buckets: z.array(payrollBucketLineSchema),
  grossCentavos: nonNegativeCentavos,
  employeeSssCentavos: nonNegativeCentavos,
  employeePhilhealthCentavos: nonNegativeCentavos,
  employeePagibigCentavos: nonNegativeCentavos,
  employeeTaxCentavos: nonNegativeCentavos,
  totalDeductionsCentavos: nonNegativeCentavos,
  netCentavos: nonNegativeCentavos,
  employerSssCentavos: nonNegativeCentavos,
  employerPhilhealthCentavos: nonNegativeCentavos,
  employerPagibigCentavos: nonNegativeCentavos,
  totalEmployerCentavos: nonNegativeCentavos,
  employerCostCentavos: nonNegativeCentavos,
});

export const payrollTotalsSchema = z.object({
  grossCentavos: nonNegativeCentavos,
  employeeDeductionsCentavos: nonNegativeCentavos,
  netCentavos: nonNegativeCentavos,
  employerContributionsCentavos: nonNegativeCentavos,
  employerCostCentavos: nonNegativeCentavos,
  employeeSssCentavos: nonNegativeCentavos,
  employeePhilhealthCentavos: nonNegativeCentavos,
  employeePagibigCentavos: nonNegativeCentavos,
  employeeTaxCentavos: nonNegativeCentavos,
});

export const payrollRunSchema = z.object({
  id,
  workspaceId: id,
  runNo: z.string().min(1),
  policyId: id,
  periodStart: dateOnly,
  periodEnd: dateOnly,
  payDate: dateOnly,
  status: z.enum(['calculated', 'approved', 'posted', 'paid', 'reversed']),
  timeImportId: id,
  lines: z.array(payrollLineSchema),
  totals: payrollTotalsSchema,
  errors: z.array(z.string()),
  calculatedAt: timestamp,
  calculatedBy: id,
  approvedBy: id.nullable(),
  approvedAt: timestamp.nullable(),
  journalId: id.nullable(),
  paymentJournalId: id.nullable(),
  reversedBy: id.nullable(),
  createdAt: timestamp,
});

export const worksheetSchema = z.object({
  id,
  workspaceId: id,
  worksheetNo: z.string().min(1),
  kind: z.enum(['13th_month', 'annualization', 'final_pay', '2316']),
  employeeId: id.nullable(),
  label: z.string(),
  inputs: z.record(z.string(), z.union([z.string(), z.number()])),
  result: z.record(z.string(), z.union([z.string(), z.number()])),
  createdAt: timestamp,
  createdBy: id,
});

export const assetSchema = z.object({
  id,
  workspaceId: id,
  assetNo: z.string().min(1),
  companyVendorBrand: z.string().min(1),
  purchaseDate: dateOnly,
  description: z.string().min(1),
  supplierContactId: id.nullable(),
  serialNo: z.string(),
  assetAccountId: id,
  costCentavos: positiveInt,
  usefulLifeYears: positiveInt,
  residualValueCentavos: nonNegativeCentavos,
  depreciationStart: dateOnly,
  convention: z.enum(['full_month', 'daily_prorated']),
  depreciationExpenseAccountId: id,
  accumulatedDepreciationAccountId: id,
  status: z.enum(['active', 'fully_depreciated']),
  sourceType: z.enum(['direct_purchase', 'opening', 'stock_reclass']),
  sourceId: id.nullable(),
  createdAt: timestamp,
  createdBy: id,
});

export const depreciationPostSchema = z.object({
  id,
  workspaceId: id,
  assetId: id,
  period: z.string().regex(/^\d{4}-\d{2}$/),
  amountCentavos: nonNegativeCentavos,
  cumulativeAfterCentavos: nonNegativeCentavos,
  status: z.enum(['calculated', 'approved', 'posted']),
  calculatedAt: timestamp,
  calculatedBy: id,
  approvedBy: id.nullable(),
  approvedAt: timestamp.nullable(),
  postedAt: timestamp.nullable(),
  journalId: id.nullable(),
  effectKey: z.string(),
});

export const journalDraftSchema = z.object({
  id,
  workspaceId: id,
  draftNo: z.string().min(1),
  journalDate: dateOnly,
  memo: z.string().min(1),
  lines: z.array(
    z.object({ accountId: id, debitCentavos: nonNegativeCentavos, creditCentavos: nonNegativeCentavos }),
  ).min(2),
  status: z.enum(['draft', 'approved', 'posted', 'rejected']),
  createdBy: id,
  createdAt: timestamp,
  approvedBy: id.nullable(),
  approvedAt: timestamp.nullable(),
  rejectionReason: z.string().nullable(),
  journalId: id.nullable(),
});

export const taxRecordSchema = z.object({
  id,
  workspaceId: id,
  publicNo: z.string().min(1),
  type: z.enum(['output_vat', 'input_vat', 'ewt_creditable', 'fwt_final']),
  sourceType: z.string().min(1),
  sourceId: id,
  taxDate: dateOnly,
  partyContactId: id.nullable(),
  baseCentavos: centavos,
  taxCentavos: centavos,
  direction: z.enum(['output', 'input', 'creditable', 'final']),
  certificateStatus: z.enum(['not_required', 'pending', 'received', 'issued']),
  certificateId: id.nullable(),
  description: z.string(),
});

export const certificate2307Schema = z.object({
  id,
  workspaceId: id,
  direction: z.enum(['issued', 'received']),
  counterpartyContactId: id,
  certificateNo: z.string().min(1),
  certificateDate: dateOnly,
  periodFrom: dateOnly,
  periodTo: dateOnly,
  creditableTaxCentavos: positiveInt,
  sourceTaxRecordIds: z.array(id),
  status: z.enum(['pending', 'issued', 'received']),
  createdBy: id,
  createdAt: timestamp,
});

export const archiveLogSchema = z.object({
  id,
  workspaceId: id,
  action: z.enum(['export', 'restore']),
  at: timestamp,
  by: id,
  fileName: z.string(),
  checksumPrefix: z.string(),
  reason: z.string().nullable(),
  counts: z.record(z.string(), z.number()),
});

export const idempotencyReceiptSchema = z.object({
  key: z.string().min(1),
  payloadHash: z.string().min(1),
  commandType: z.string().min(1),
  resultJson: z.string(),
  at: timestamp,
});

export const sourceEffectSchema = z.object({
  kind: z.string().min(1),
  documentId: z.string().min(1),
  at: timestamp,
});

export const numberingPolicySchema = z.object({
  id,
  workspaceId: id,
  kind: z.enum(RECORD_KINDS),
  prefix: z.string().max(8),
  startNumber: z.number().int().positive(),
  nextNumber: z.number().int().positive(),
  minDigits: z.number().int().min(0).max(12),
  increment: z.number().int().positive(),
  manualOverride: z.boolean(),
  version: z.number().int().positive(),
  updatedBy: z.string(),
  updatedAt: timestamp,
  reason: z.string(),
});

export const appStateSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  revision: nonNegativeInt,
  workspaces: z.array(workspaceSchema),
  users: z.array(userSchema),
  memberships: z.array(membershipSchema),
  seats: z.array(seatSchema),
  contacts: z.array(contactSchema),
  accounts: z.array(accountSchema),
  periods: z.array(periodSchema),
  journals: z.array(journalSchema),
  auditEvents: z.array(auditEventSchema),
  idempotency: z.record(z.string(), idempotencyReceiptSchema),
  sourceEffects: z.record(z.string(), sourceEffectSchema),
  invoices: z.array(invoiceSchema),
  receipts: z.array(receiptSchema),
  creditNotes: z.array(creditNoteSchema),
  refunds: z.array(refundSchema),
  purchaseOrders: z.array(purchaseOrderSchema),
  goodsReceipts: z.array(goodsReceiptSchema),
  bills: z.array(billSchema),
  rfps: z.array(rfpSchema),
  payments: z.array(paymentSchema),
  advances: z.array(advanceSchema),
  liquidations: z.array(liquidationSchema),
  bankAccounts: z.array(bankAccountSchema),
  bankStatements: z.array(bankStatementSchema),
  bankRows: z.array(bankRowSchema),
  items: z.array(itemSchema),
  locations: z.array(locationSchema),
  movements: z.array(movementSchema),
  employees: z.array(employeeSchema),
  deductionSchedules: z.array(deductionScheduleSchema),
  payrollPolicies: z.array(payrollPolicySchema),
  timeImports: z.array(timeImportSchema),
  payrollRuns: z.array(payrollRunSchema),
  worksheets: z.array(worksheetSchema),
  assets: z.array(assetSchema),
  depreciationPosts: z.array(depreciationPostSchema),
  journalDrafts: z.array(journalDraftSchema),
  taxRecords: z.array(taxRecordSchema),
  certificates2307: z.array(certificate2307Schema),
  archiveLog: z.array(archiveLogSchema),
  numberingPolicies: z.array(numberingPolicySchema),
  demoFixtureVersion: z.string().optional(),
});

export type AppState = z.infer<typeof appStateSchema>;
export type Workspace = z.infer<typeof workspaceSchema>;
export type User = z.infer<typeof userSchema>;
export type Seat = z.infer<typeof seatSchema>;
export type Membership = z.infer<typeof membershipSchema>;
export type Role = z.infer<typeof roleSchema>;
export type ProductCode = z.infer<typeof productSchema>;
export type Entitlement = z.infer<typeof entitlementSchema>;
export type Contact = z.infer<typeof contactSchema>;
export type Account = z.infer<typeof accountSchema>;
export type Period = z.infer<typeof periodSchema>;
export type Journal = z.infer<typeof journalSchema>;
export type JournalLine = z.infer<typeof journalLineSchema>;
export type AuditEvent = z.infer<typeof auditEventSchema>;
export type Invoice = z.infer<typeof invoiceSchema>;
export type InvoiceLine = z.infer<typeof invoiceLineSchema>;
export type Receipt = z.infer<typeof receiptSchema>;
export type CreditNote = z.infer<typeof creditNoteSchema>;
export type Refund = z.infer<typeof refundSchema>;
export type PurchaseOrder = z.infer<typeof purchaseOrderSchema>;
export type PoLine = z.infer<typeof poLineSchema>;
export type GoodsReceipt = z.infer<typeof goodsReceiptSchema>;
export type Bill = z.infer<typeof billSchema>;
export type BillLine = z.infer<typeof billLineSchema>;
export type Rfp = z.infer<typeof rfpSchema>;
export type Payment = z.infer<typeof paymentSchema>;
export type Advance = z.infer<typeof advanceSchema>;
export type Liquidation = z.infer<typeof liquidationSchema>;
export type BankAccount = z.infer<typeof bankAccountSchema>;
export type BankStatement = z.infer<typeof bankStatementSchema>;
export type BankRow = z.infer<typeof bankRowSchema>;
export type Item = z.infer<typeof itemSchema>;
export type Location = z.infer<typeof locationSchema>;
export type Movement = z.infer<typeof movementSchema>;
export type MovementType = z.infer<typeof movementTypeSchema>;
export type Employee = z.infer<typeof employeeSchema>;
export type DeductionSchedule = z.infer<typeof deductionScheduleSchema>;
export type PayrollPolicy = z.infer<typeof payrollPolicySchema>;
export type TimeMatrixRule = z.infer<typeof timeMatrixRuleSchema>;
export type TaxBracket = z.infer<typeof taxBracketSchema>;
export type TimeBucket = z.infer<typeof timeBucketSchema>;
export type TimeImport = z.infer<typeof timeImportSchema>;
export type PayrollBucketLine = z.infer<typeof payrollBucketLineSchema>;
export type PayrollLine = z.infer<typeof payrollLineSchema>;
export type PayrollTotals = z.infer<typeof payrollTotalsSchema>;
export type PayrollRun = z.infer<typeof payrollRunSchema>;
export type Worksheet = z.infer<typeof worksheetSchema>;
export type Asset = z.infer<typeof assetSchema>;
export type DepreciationPost = z.infer<typeof depreciationPostSchema>;
export type JournalDraft = z.infer<typeof journalDraftSchema>;
export type TaxRecord = z.infer<typeof taxRecordSchema>;
export type Certificate2307 = z.infer<typeof certificate2307Schema>;
export type ArchiveLog = z.infer<typeof archiveLogSchema>;

export type ParseStateResult =
  | { ok: true; state: AppState }
  | { ok: false; reason: 'invalid_json' | 'unsupported_version' | 'invalid_shape'; message: string };

/** Validate arbitrary stored/restored data without guessing unknown versions. */
export function parseAppState(raw: unknown): ParseStateResult {
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, reason: 'invalid_shape', message: 'Stored data is not an object.' };
  }
  const version = (raw as { schemaVersion?: unknown }).schemaVersion;
  if (version !== SCHEMA_VERSION) {
    return {
      ok: false,
      reason: 'unsupported_version',
      message: `Stored schema version ${String(version)} is not supported (expected ${SCHEMA_VERSION}).`,
    };
  }
  const parsed = appStateSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      reason: 'invalid_shape',
      message: first ? `${first.path.join('.') || 'state'}: ${first.message}` : 'Stored state failed validation.',
    };
  }
  return { ok: true, state: parsed.data };
}
