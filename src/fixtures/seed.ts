import { reconcileMasterCodes } from '../domain/masterCodes';
import { defaultNumberingPolicy, formatNumber } from '../domain/numbering';
import type {
  Account,
  AppState,
  Contact,
  DeductionSchedule,
  Employee,
  Item,
  Journal,
  Location,
  Membership,
  PayrollPolicy,
  Period,
  Seat,
  TimeMatrixRule,
  User,
  Workspace,
} from '../domain/schema';
import { SCHEMA_VERSION } from '../domain/schema';
import { policiesForState } from '../domain/migration';
import { executeCommand } from '../domain/commands';
import { createFixedClock } from '../domain/shared/clock';
import { backfillJournalProvenance } from '../domain/ledger';
import type { CommandEnvelope, DomainCommand } from '../domain/commandTypes';

export const DEMO_FIXTURE_VERSION = 'ece-accounting-demo-v1';

export const DEMO_TODAY = '2026-11-01';
export const DEMO_NOW = '2026-11-01T09:00:00.000Z';

export const WORKSPACE_A = 'ws-a';
export const WORKSPACE_B = 'ws-b';

const OPENING_EFFECT = 'opening:initial-equity';
const OPENING_JOURNAL_ID = 'jv-a-opening';
const OPENING_TIMESTAMP = '2026-01-01T00:00:00.000Z';

export const USERS: User[] = [
  { id: 'u-accountant', name: 'Rosa Mendoza', title: 'Accountant / approver (demo)' },
  { id: 'u-maker', name: 'Paolo Garcia', title: 'AP/AR clerk — maker (demo)' },
  { id: 'u-checker', name: 'Elena Bautista', title: 'Independent approver (demo)' },
  { id: 'u-payroll', name: 'Nina Torres', title: 'Payroll officer (demo)' },
  { id: 'u-inventory', name: 'Rico Alvarez', title: 'Inventory officer (demo)' },
  { id: 'u-owner', name: 'Victor Lim', title: 'Company administrator (demo)' },
  { id: 'u-badmin', name: 'Mila Santos', title: 'Company B administrator (demo)' },
  { id: 'u-bpayroll', name: 'Dennis Cruz', title: 'Company B payroll officer (demo)' },
  { id: 'u-binv', name: 'Grace Tan', title: 'Company B inventory officer (demo)' },
];

export const DEFAULT_ACTOR_ID = 'u-accountant';

function entitlement(active: boolean, activatedOn: string | null, expiresOn: string | null) {
  return { active, activatedOn, expiresOn };
}

const SEATS: Seat[] = [
  { id: 'seat-a-1', workspaceId: WORKSPACE_A, label: 'A-Seat 1', assignedUserId: 'u-accountant' },
  { id: 'seat-a-2', workspaceId: WORKSPACE_A, label: 'A-Seat 2', assignedUserId: 'u-maker' },
  { id: 'seat-a-3', workspaceId: WORKSPACE_A, label: 'A-Seat 3', assignedUserId: 'u-checker' },
  { id: 'seat-a-4', workspaceId: WORKSPACE_A, label: 'A-Seat 4', assignedUserId: 'u-payroll' },
  { id: 'seat-a-5', workspaceId: WORKSPACE_A, label: 'A-Seat 5', assignedUserId: 'u-inventory' },
  { id: 'seat-a-6', workspaceId: WORKSPACE_A, label: 'A-Seat 6', assignedUserId: 'u-owner' },
  { id: 'seat-b-1', workspaceId: WORKSPACE_B, label: 'B-Seat 1', assignedUserId: 'u-badmin' },
  { id: 'seat-b-2', workspaceId: WORKSPACE_B, label: 'B-Seat 2', assignedUserId: 'u-bpayroll' },
  { id: 'seat-b-3', workspaceId: WORKSPACE_B, label: 'B-Seat 3', assignedUserId: 'u-binv' },
];

const MEMBERSHIPS: Membership[] = [
  {
    userId: 'u-accountant',
    workspaceId: WORKSPACE_A,
    roles: ['company_admin', 'accountant'],
    payrollDetail: false,
    archiveGrant: true,
    active: true,
    seatId: 'seat-a-1',
  },
  {
    userId: 'u-maker',
    workspaceId: WORKSPACE_A,
    roles: ['ap_ar_clerk'],
    payrollDetail: false,
    archiveGrant: false,
    active: true,
    seatId: 'seat-a-2',
  },
  {
    userId: 'u-checker',
    workspaceId: WORKSPACE_A,
    roles: ['accountant'],
    payrollDetail: false,
    archiveGrant: false,
    active: true,
    seatId: 'seat-a-3',
  },
  {
    userId: 'u-payroll',
    workspaceId: WORKSPACE_A,
    roles: ['payroll_officer'],
    payrollDetail: true,
    archiveGrant: false,
    active: true,
    seatId: 'seat-a-4',
  },
  {
    userId: 'u-inventory',
    workspaceId: WORKSPACE_A,
    roles: ['inventory_officer'],
    payrollDetail: false,
    archiveGrant: false,
    active: true,
    seatId: 'seat-a-5',
  },
  {
    userId: 'u-owner',
    workspaceId: WORKSPACE_A,
    roles: ['company_admin'],
    // The owner holds the two privileged grants separately: a company admin
    // does not impliedly see payslips or export an archive that contains them.
    payrollDetail: true,
    archiveGrant: true,
    active: true,
    seatId: 'seat-a-6',
  },
  {
    userId: 'u-badmin',
    workspaceId: WORKSPACE_B,
    roles: ['company_admin', 'accountant'],
    payrollDetail: false,
    archiveGrant: true,
    active: true,
    seatId: 'seat-b-1',
  },
  {
    userId: 'u-bpayroll',
    workspaceId: WORKSPACE_B,
    roles: ['payroll_officer'],
    payrollDetail: true,
    archiveGrant: false,
    active: true,
    seatId: 'seat-b-2',
  },
  {
    userId: 'u-binv',
    workspaceId: WORKSPACE_B,
    roles: ['inventory_officer'],
    payrollDetail: false,
    archiveGrant: false,
    active: true,
    seatId: 'seat-b-3',
  },
];

function makeAccounts(workspaceId: string): Account[] {
  const rows: Array<[string, string, Account['type'], Account['normalBalance'], string | null]> = [
    ['1010', 'Cash on hand', 'asset', 'debit', 'cash'],
    ['1020', 'Bank — demo operating account', 'asset', 'debit', 'bank'],
    ['1030', 'Incoming clearing', 'asset', 'debit', 'incoming_clearing'],
    ['1040', 'Outgoing clearing', 'asset', 'debit', 'outgoing_clearing'],
    ['1100', 'Accounts receivable', 'asset', 'debit', 'ar'],
    ['1200', 'Inventory', 'asset', 'debit', 'inventory'],
    ['1300', 'Employee advances', 'asset', 'debit', 'employee_advance'],
    ['1400', 'Input VAT', 'asset', 'debit', 'input_vat'],
    ['1500', 'Fixed assets — cost', 'asset', 'debit', 'asset_cost'],
    ['1590', 'Accumulated depreciation', 'asset', 'credit', 'accumulated_depreciation'],
    ['2010', 'Accounts payable', 'liability', 'credit', 'ap'],
    ['2020', 'Goods received not invoiced', 'liability', 'credit', 'grni'],
    ['2030', 'Unapplied customer receipts', 'liability', 'credit', 'unapplied_receipts'],
    ['2040', 'Creditable withholding tax payable', 'liability', 'credit', 'ewt_payable'],
    ['2050', 'Final withholding tax payable', 'liability', 'credit', 'fwt_payable'],
    ['2060', 'Net pay payable', 'liability', 'credit', 'net_pay_payable'],
    ['2070', 'SSS contributions payable', 'liability', 'credit', 'sss_payable'],
    ['2071', 'PhilHealth contributions payable', 'liability', 'credit', 'philhealth_payable'],
    ['2072', 'Pag-IBIG contributions payable', 'liability', 'credit', 'pagibig_payable'],
    ['2080', 'Compensation tax withheld payable', 'liability', 'credit', 'tax_withheld_payable'],
    ['2090', 'Employee reimbursements payable', 'liability', 'credit', 'employee_payable'],
    ['2100', 'Output VAT payable', 'liability', 'credit', 'output_vat'],
    ['3010', 'Opening equity', 'equity', 'credit', 'opening_equity'],
    ['4010', 'Service and sales revenue', 'revenue', 'credit', 'revenue'],
    ['5010', 'Cost of goods sold', 'expense', 'debit', 'cogs'],
    ['6010', 'Salaries expense', 'expense', 'debit', 'salaries_expense'],
    ['6020', 'Employer contributions expense', 'expense', 'debit', 'employer_expense'],
    ['6030', 'Rent and operating expense', 'expense', 'debit', 'operating_expense'],
    ['6040', 'Supplies expense', 'expense', 'debit', 'supplies_expense'],
    ['6050', 'Depreciation expense', 'expense', 'debit', 'depreciation_expense'],
    ['6060', 'Inventory adjustment expense', 'expense', 'debit', 'inventory_adjustment'],
  ];
  const policy = defaultNumberingPolicy(workspaceId, 'account');
  return rows.map(([legacyCode, name, type, normalBalance, controlRole], index) => ({
    id: `acc-${workspaceId}-${legacyCode}`,
    workspaceId,
    code: formatNumber(policy, policy.startNumber + index * policy.increment),
    name,
    type,
    normalBalance,
    controlRole,
    active: true,
  }));
}

function makePeriods(workspaceId: string): Period[] {
  const periods: Period[] = [];
  for (let year = 2025; year <= 2029; year += 1) {
    for (let month = 1; month <= 12; month += 1) {
      periods.push({
        id: `${workspaceId}:${year}-${String(month).padStart(2, '0')}`,
        workspaceId,
        year,
        month,
        status: 'open',
        closedBy: null,
        closedAt: null,
        closeReason: null,
        reopenedBy: null,
        reopenedAt: null,
        reopenReason: null,
      });
    }
  }
  return periods;
}

const TIME_MATRIX: TimeMatrixRule[] = [
  ['ordinary_regular', 'Ordinary regular hours (in base salary)', 10000, null, null, true],
  ['ordinary_night', 'Ordinary night hour (base + 10% premium)', 11000, null, null, true],
  ['ordinary_ot', 'Ordinary overtime', 10000, 12500, null, false],
  ['ordinary_night_ot', 'Ordinary night overtime', 10000, 12500, 11000, false],
  ['rest_day', 'Rest-day work', 13000, null, null, false],
  ['rest_day_ot', 'Rest-day overtime', 13000, 13000, null, false],
  ['rest_day_night_ot', 'Rest-day night overtime', 13000, 13000, 11000, false],
  ['special_nonworking', 'Special nonworking holiday', 13000, null, null, true],
  ['special_nonworking_rest', 'Special nonworking holiday on rest day', 15000, null, null, true],
  ['special_nonworking_ot', 'Special nonworking holiday overtime', 13000, 13000, null, false],
  ['special_nonworking_rest_ot', 'Special nonworking holiday on rest day, overtime', 15000, 13000, null, false],
  ['special_nonworking_night_ot', 'Special nonworking holiday night overtime', 13000, 13000, 11000, false],
  [
    'special_nonworking_rest_night_ot',
    'Special nonworking holiday on rest day, night overtime',
    15000,
    13000,
    11000,
    false,
  ],
  ['regular_holiday', 'Regular holiday', 20000, null, null, true],
  ['regular_holiday_rest', 'Regular holiday on rest day', 26000, null, null, true],
  ['regular_holiday_ot', 'Regular holiday overtime', 20000, 13000, null, false],
  ['regular_holiday_rest_ot', 'Regular holiday on rest day, overtime', 26000, 13000, null, false],
  ['regular_holiday_night_ot', 'Regular holiday night overtime', 20000, 13000, 11000, false],
  [
    'regular_holiday_rest_night_ot',
    'Regular holiday on rest day, night overtime',
    26000,
    13000,
    11000,
    false,
  ],
].map(([code, label, dayFactorBp, otFactorBp, nightFactorBp, includedInBase]) => ({
  code: code as TimeMatrixRule['code'],
  label: label as string,
  dayFactorBp: dayFactorBp as number,
  otFactorBp: otFactorBp as number | null,
  nightFactorBp: nightFactorBp as number | null,
  includedInBase: includedInBase as boolean,
}));

const ANNUAL_TAX_SCHEDULE = [
  { upToCentavos: 10_000_000, rateBp: 0 },
  { upToCentavos: null, rateBp: 1000 },
];

const POLICIES: PayrollPolicy[] = [
  {
    id: 'pol-a-payroll-oct',
    workspaceId: WORKSPACE_A,
    version: 'DEMO-PAY-2026.OCT',
    effectiveFrom: '2026-10-01',
    effectiveTo: '2026-10-31',
    status: 'demo_approved',
    hoursPerMonth: 200,
    standardMinutesPerDay: 480,
    periodWorkingDays: 11,
    payFrequency: 'semi_monthly',
    periodStart: '2026-10-01',
    periodEnd: '2026-10-15',
    payDate: '2026-10-20',
    approvalDeadline: '2026-10-17',
    timeMatrix: TIME_MATRIX,
    annualTaxSchedule: ANNUAL_TAX_SCHEDULE,
    thirteenthMonthDivisor: 12,
    rounding: 'half_up_centavo',
    notes: 'Synthetic historical October payroll policy for seed demo calculation.',
  },
  {
    id: 'pol-a-payroll',
    workspaceId: WORKSPACE_A,
    version: 'DEMO-PAY-2026.1',
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
    status: 'demo_approved',
    hoursPerMonth: 200,
    standardMinutesPerDay: 480,
    periodWorkingDays: 11,
    payFrequency: 'semi_monthly',
    periodStart: '2026-11-01',
    periodEnd: '2026-11-15',
    payDate: '2026-11-20',
    approvalDeadline: '2026-11-17',
    timeMatrix: TIME_MATRIX,
    annualTaxSchedule: ANNUAL_TAX_SCHEDULE,
    thirteenthMonthDivisor: 12,
    rounding: 'half_up_centavo',
    notes:
      'SYNTHETIC FIXTURE · DEMO SCHEDULE — NOT VERIFIED CURRENT STATUTORY RATES. Explicit hour basis 200 h/month and semi-monthly dates are demo choices, not inferred defaults.',
  },
  {
    id: 'pol-b-payroll',
    workspaceId: WORKSPACE_B,
    version: 'DEMO-PAY-2026.1',
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
    status: 'demo_approved',
    hoursPerMonth: 200,
    standardMinutesPerDay: 480,
    periodWorkingDays: 11,
    payFrequency: 'semi_monthly',
    periodStart: '2026-11-01',
    periodEnd: '2026-11-15',
    payDate: '2026-11-20',
    approvalDeadline: '2026-11-17',
    timeMatrix: TIME_MATRIX,
    annualTaxSchedule: ANNUAL_TAX_SCHEDULE,
    thirteenthMonthDivisor: 12,
    rounding: 'half_up_centavo',
    notes:
      'SYNTHETIC FIXTURE · DEMO SCHEDULE — NOT VERIFIED CURRENT STATUTORY RATES. Payroll entitlement on this workspace expires 2026-12-31 to demonstrate read-only expiry.',
  },
];

function makeDeductionSchedule(workspaceId: string, id: string, label: string): DeductionSchedule {
  return {
    id,
    workspaceId,
    version: 'DEMO-DED-2026.1',
    label,
    status: 'demo_approved',
    employeeSssCentavos: 40_000,
    employeePhilhealthCentavos: 25_000,
    employeePagibigCentavos: 20_000,
    employeeTaxCentavos: 15_000,
    employerSssCentavos: 25_000,
    employerPhilhealthCentavos: 15_000,
    employerPagibigCentavos: 10_000,
  };
}

const DEDUCTION_SCHEDULES: DeductionSchedule[] = [
  makeDeductionSchedule(WORKSPACE_A, 'ded-a-1', 'DEMO employee deduction schedule A'),
  makeDeductionSchedule(WORKSPACE_B, 'ded-b-1', 'DEMO employee deduction schedule B'),
];

const EMPLOYEES: Employee[] = [
  {
    id: 'emp-a-001',
    workspaceId: WORKSPACE_A,
    employeeNo: '5000',
    name: 'Ana Reyes',
    monthlySalaryCentavos: 2_000_000,
    status: 'active',
    hiredOn: '2024-02-01',
    separatedOn: null,
    deductionScheduleId: 'ded-a-1',
    branch: 'Main',
    department: 'Operations',
  },
  {
    id: 'emp-a-002',
    workspaceId: WORKSPACE_A,
    employeeNo: '5001',
    name: 'Ben Cruz',
    monthlySalaryCentavos: 3_000_000,
    status: 'active',
    hiredOn: '2023-08-15',
    separatedOn: null,
    deductionScheduleId: 'ded-a-1',
    branch: 'Main',
    department: 'Delivery',
  },
  {
    id: 'emp-a-003',
    workspaceId: WORKSPACE_A,
    employeeNo: '5002',
    name: 'Cara Lim',
    monthlySalaryCentavos: 2_500_000,
    status: 'active',
    hiredOn: '2025-01-06',
    separatedOn: null,
    deductionScheduleId: 'ded-a-1',
    branch: 'Branch',
    department: 'Support',
  },
  {
    id: 'emp-b-001',
    workspaceId: WORKSPACE_B,
    employeeNo: '5000',
    name: 'Dina Flores',
    monthlySalaryCentavos: 2_200_000,
    status: 'active',
    hiredOn: '2024-05-01',
    separatedOn: null,
    deductionScheduleId: 'ded-b-1',
    branch: 'Main',
    department: 'Sales',
  },
  {
    id: 'emp-b-002',
    workspaceId: WORKSPACE_B,
    employeeNo: '5001',
    name: 'Elias Ramos',
    monthlySalaryCentavos: 1_800_000,
    status: 'active',
    hiredOn: '2025-03-03',
    separatedOn: null,
    deductionScheduleId: 'ded-b-1',
    branch: 'Main',
    department: 'Warehouse',
  },
];

const CONTACTS: Contact[] = [
  {
    id: 'contact-a-cust-1',
    workspaceId: WORKSPACE_A,
    contactNo: 'C100',
    name: 'Cordillera Services Demo Inc.',
    tin: '000-000-000-00101',
    address: 'Baguio demo address',
    roles: ['customer'],
    active: true,
  },
  {
    id: 'contact-a-cust-2',
    workspaceId: WORKSPACE_A,
    contactNo: 'C101',
    name: 'Harborline Trading Demo Corp.',
    tin: '000-000-000-00102',
    address: 'Manila demo address',
    roles: ['customer', 'vendor'],
    active: true,
  },
  {
    id: 'contact-a-vend-1',
    workspaceId: WORKSPACE_A,
    contactNo: 'C102',
    name: 'Metro Office Supply Demo Co.',
    tin: '000-000-000-00201',
    address: 'Quezon City demo address',
    roles: ['vendor'],
    active: true,
  },
  {
    id: 'contact-a-vend-2',
    workspaceId: WORKSPACE_A,
    contactNo: 'C103',
    name: 'Tandang Hardware Demo Co.',
    tin: '000-000-000-00202',
    address: 'Pasig demo address',
    roles: ['vendor'],
    active: true,
  },
  {
    id: 'contact-b-cust-1',
    workspaceId: WORKSPACE_B,
    contactNo: 'C100',
    name: 'Isla Retail Demo Store',
    tin: '000-000-000-00301',
    address: 'Cebu demo address',
    roles: ['customer'],
    active: true,
  },
  {
    id: 'contact-b-vend-1',
    workspaceId: WORKSPACE_B,
    contactNo: 'C101',
    name: 'Visayas Supply Demo Co.',
    tin: '000-000-000-00302',
    address: 'Iloilo demo address',
    roles: ['vendor'],
    active: true,
  },
];

const ITEMS: Item[] = [
  {
    id: 'item-a-1',
    workspaceId: WORKSPACE_A,
    itemNo: 'I100',
    sku: 'W100',
    name: 'Demo widget',
    baseUnit: 'pc',
    inventoryAccountId: `acc-${WORKSPACE_A}-1200`,
    cogsAccountId: `acc-${WORKSPACE_A}-5010`,
    active: true,
  },
  {
    id: 'item-a-2',
    workspaceId: WORKSPACE_A,
    itemNo: 'I101',
    sku: 'S200',
    name: 'Demo service kit',
    baseUnit: 'set',
    inventoryAccountId: `acc-${WORKSPACE_A}-1200`,
    cogsAccountId: `acc-${WORKSPACE_A}-5010`,
    active: true,
  },
  {
    id: 'item-b-1',
    workspaceId: WORKSPACE_B,
    itemNo: 'I100',
    sku: 'B100',
    name: 'Bayanihan trading item',
    baseUnit: 'pc',
    inventoryAccountId: `acc-${WORKSPACE_B}-1200`,
    cogsAccountId: `acc-${WORKSPACE_B}-5010`,
    active: true,
  },
];

const LOCATIONS: Location[] = [
  { id: 'loc-a-main', workspaceId: WORKSPACE_A, code: 'L100', name: 'Main warehouse', active: true },
  { id: 'loc-a-branch', workspaceId: WORKSPACE_A, code: 'L101', name: 'Branch store', active: true },
  { id: 'loc-b-main', workspaceId: WORKSPACE_B, code: 'L100', name: 'Main store', active: true },
];

const WORKSPACES: Workspace[] = [
  {
    id: WORKSPACE_A,
    name: 'Northwind Services Demo',
    legalName: 'Northwind Services Demo Co.',
    tin: '000-000-000-00001',
    fiscalYearStartMonth: 1,
    entitlements: {
      accounting: entitlement(true, '2026-01-01', null),
      payroll: entitlement(true, '2026-01-01', null),
      inventory: entitlement(true, '2026-01-01', null),
    },
    settings: {
      maintenance: {
        active: false,
        windowLabel: 'Monthly maintenance window — not scheduled',
        scheduledFor: '',
        maxDurationMinutes: 120,
        startedAt: null,
        startedBy: null,
        endedAt: null,
        endedBy: null,
        completionNote: '',
      },
      payrollPolicyId: 'pol-a-payroll',
      cutover: null,
      archiveNote:
        'Plaintext synthetic browser archive. Not encrypted, not delivered to customer storage, not the approved production recovery process.',
    },
  },
  {
    id: WORKSPACE_B,
    name: 'Bayanihan Trading Demo',
    legalName: 'Bayanihan Trading Demo Co.',
    tin: '000-000-000-00002',
    fiscalYearStartMonth: 1,
    entitlements: {
      accounting: entitlement(false, null, null),
      payroll: entitlement(true, '2026-01-01', '2026-12-31'),
      inventory: entitlement(true, '2026-01-01', null),
    },
    settings: {
      maintenance: {
        active: false,
        windowLabel: 'Monthly maintenance window — not scheduled',
        scheduledFor: '',
        maxDurationMinutes: 90,
        startedAt: null,
        startedBy: null,
        endedAt: null,
        endedBy: null,
        completionNote: '',
      },
      payrollPolicyId: 'pol-b-payroll',
      cutover: {
        proposedDate: '2026-11-15',
        approvedDate: null,
        approvedBy: null,
        inventoryOpeningValueCentavos: 100_000,
        status: 'proposed',
        notes:
          'Standalone inventory precedes Accounting. Activation must reconcile this synthetic opening value of 1,000.00 once and post new events prospectively.',
      },
      archiveNote:
        'Plaintext synthetic browser archive. Company B has no Accounting entitlement yet; standalone exports use operational source references.',
    },
  },
];

function openingJournal(): Journal {
  return {
    id: OPENING_JOURNAL_ID,
    workspaceId: WORKSPACE_A,
    journalNo: 'JV-00001',
    postingDate: '2026-01-01',
    documentDate: '2026-01-01',
    sourceType: 'opening',
    sourceId: 'opening-A-2026',
    effectKey: OPENING_EFFECT,
    memo: 'Approved synthetic opening balances — bank and opening equity',
    lines: [
      {
        accountId: `acc-${WORKSPACE_A}-1020`,
        accountCode: 'A101',
        debitCentavos: 1_000_000,
        creditCentavos: 0,
        memo: 'Opening bank balance',
      },
      {
        accountId: `acc-${WORKSPACE_A}-3010`,
        accountCode: 'A122',
        debitCentavos: 0,
        creditCentavos: 1_000_000,
        memo: 'Opening equity',
      },
    ],
    status: 'posted',
    createdBy: 'u-accountant',
    createdAt: OPENING_TIMESTAMP,
    approvedBy: 'u-accountant',
    policySnapshot: null,
    sourceProvenance: {
      version: 1,
      book: 'journals',
      originSourceType: 'opening',
      originSourceId: 'opening-A-2026',
      originJournalId: null,
      clearingTargetType: null,
      provisional: false,
      exceptionReason: null,
    },
    reversalOf: null,
    reversedBy: null,
  };
}

export function createBaseSeedState(): AppState {
  const state: AppState = {
    schemaVersion: SCHEMA_VERSION,
    revision: 1,
    demoFixtureVersion: DEMO_FIXTURE_VERSION,
    workspaces: WORKSPACES.map((workspace) => ({
      ...workspace,
      entitlements: {
        accounting: { ...workspace.entitlements.accounting },
        payroll: { ...workspace.entitlements.payroll },
        inventory: { ...workspace.entitlements.inventory },
      },
      settings: {
        ...workspace.settings,
        maintenance: { ...workspace.settings.maintenance },
        cutover: workspace.settings.cutover ? { ...workspace.settings.cutover } : null,
      },
    })),
    users: USERS.map((user) => ({ ...user })),
    memberships: MEMBERSHIPS.map((membership) => ({ ...membership, roles: [...membership.roles] })),
    seats: SEATS.map((seat) => ({ ...seat })),
    contacts: CONTACTS.map((contact) => ({ ...contact, roles: [...contact.roles] })),
    accounts: [...makeAccounts(WORKSPACE_A), ...makeAccounts(WORKSPACE_B)],
    periods: [...makePeriods(WORKSPACE_A), ...makePeriods(WORKSPACE_B)],
    journals: [openingJournal()],
    auditEvents: [
      {
        id: 'aud-seed-opening',
        workspaceId: WORKSPACE_A,
        actorId: 'u-accountant',
        action: 'opening.approved',
        recordType: 'journal',
        recordId: OPENING_JOURNAL_ID,
        at: OPENING_TIMESTAMP,
        reason: 'Synthetic approved opening balances',
        detail: { debitCentavos: 1_000_000, creditCentavos: 1_000_000 },
      },
      {
        id: 'aud-seed-inventory-b',
        workspaceId: WORKSPACE_B,
        actorId: 'u-binv',
        action: 'inventory.standalone-opening',
        recordType: 'movement',
        recordId: 'mv-b-opening',
        at: '2026-10-05T02:00:00.000Z',
        reason: 'Standalone stock before Accounting activation',
        detail: { quantityMilli: 10_000, valueCentavos: 100_000 },
      },
    ],
    idempotency: {},
    sourceEffects: {
      [`${WORKSPACE_A}:${OPENING_EFFECT}`]: {
        kind: 'opening',
        documentId: OPENING_JOURNAL_ID,
        at: OPENING_TIMESTAMP,
      },
      [`${WORKSPACE_B}:inventory-receipt:standalone-opening-b`]: {
        kind: 'standalone_opening',
        documentId: 'mv-b-opening',
        at: '2026-10-05T02:00:00.000Z',
      },
    },
    invoices: [],
    receipts: [],
    creditNotes: [],
    refunds: [],
    purchaseOrders: [],
    goodsReceipts: [],
    bills: [],
    rfps: [],
    payments: [],
    advances: [],
    liquidations: [],
    bankAccounts: [
      {
        id: 'bank-a-1',
        workspaceId: WORKSPACE_A,
        bankCode: 'B100',
        name: 'Operating account',
        bankName: 'Metro Demo Bank',
        accountNoMasked: '•••• 0001',
        ledgerAccountId: `acc-${WORKSPACE_A}-1020`,
        active: true,
      },
      {
        id: 'bank-b-1',
        workspaceId: WORKSPACE_B,
        bankCode: 'B100',
        name: 'Trading account',
        bankName: 'Demo Rural Bank',
        accountNoMasked: '•••• 0002',
        ledgerAccountId: `acc-${WORKSPACE_B}-1020`,
        active: true,
      },
    ],
    bankStatements: [],
    bankRows: [],
    items: ITEMS.map((item) => ({ ...item })),
    locations: LOCATIONS.map((location) => ({ ...location })),
    movements: [
      {
        id: 'mv-b-opening',
        workspaceId: WORKSPACE_B,
        movementNo: 'MVT-0001',
        itemId: 'item-b-1',
        sequence: 1,
        type: 'receipt',
        occurredOn: '2026-10-05',
        locationId: 'loc-b-main',
        toLocationId: null,
        quantityMilli: 10_000,
        unitCostCentavos: 10_000,
        valueCentavos: 100_000,
        unitCostAppliedCentavos: 10_000,
        sourceType: 'standalone_opening',
        sourceId: 'opening-B-inventory',
        effectKey: 'inventory-receipt:standalone-opening-b',
        referenceMovementId: null,
        approvedBy: 'u-binv',
        reason: 'Standalone stock before Accounting activation',
        journalId: null,
        createdAt: '2026-10-05T02:00:00.000Z',
        createdBy: 'u-binv',
      },
    ],
    employees: EMPLOYEES.map((employee) => ({ ...employee })),
    deductionSchedules: DEDUCTION_SCHEDULES.map((schedule) => ({ ...schedule })),
    payrollPolicies: POLICIES.map((policy) => ({
      ...policy,
      timeMatrix: policy.timeMatrix.map((rule) => ({ ...rule })),
      annualTaxSchedule: policy.annualTaxSchedule.map((bracket) => ({ ...bracket })),
    })),
    timeImports: [],
    payrollRuns: [],
    worksheets: [],
    assets: [],
    depreciationPosts: [],
    journalDrafts: [],
    taxRecords: [],
    certificates2307: [],
    archiveLog: [],
    numberingPolicies: [],
  };
  // Fresh seeds demonstrate the A100/5000 convention; counters sit above every
  // reserved code, including the opening journal and Company B's opening stock.
  state.numberingPolicies = policiesForState(state);
  const canonical = reconcileMasterCodes(state);
  if (!canonical.ok) throw new Error(canonical.error.message);
  return canonical.value.state;
}

export function createSeedState(): AppState {
  let state = createBaseSeedState();
  const clock = createFixedClock({ nowIso: DEMO_NOW, today: DEMO_TODAY, seed: 'demo' });
  let keySeq = 0;

  function run(command: DomainCommand, actorId: string, workspaceId: string = WORKSPACE_A) {
    keySeq += 1;
    const envelope: CommandEnvelope = {
      workspaceId,
      actorId,
      idempotencyKey: `demo-seed-k-${keySeq}`,
      expectedRevision: state.revision,
      command,
    };
    const outcome = executeCommand(state, envelope, clock);
    if (!outcome.ok) {
      throw new Error(`Seed command ${command.type} failed: ${outcome.error.code} - ${outcome.error.message}`);
    }
    state = outcome.value.state;
    return outcome.value.result;
  }

  // 1. Inventory receipt in ws-a on 2026-10-25 (before 2026-11-01)
  run(
    {
      type: 'movement.receipt',
      input: {
        itemId: 'item-a-1',
        locationId: 'loc-a-main',
        occurredOn: '2026-10-25',
        quantityMilli: 5_000,
        unitCostCentavos: 100_000,
        sourceType: 'inventory_receipt',
        sourceId: 'seed-mv-1',
        effectKey: 'seed:inventory-receipt:1',
      },
    },
    'u-inventory',
  );

  // 2. Fixed asset in ws-a on 2026-10-01, depreciation batch for 2026-10 on 2026-10-31
  run(
    {
      type: 'asset.create',
      input: {
        companyVendorBrand: 'Dell',
        purchaseDate: '2026-10-01',
        description: 'Dell PowerEdge R250 Server',
        supplierContactId: 'contact-a-vend-1',
        serialNo: 'SN-R250-100',
        assetAccountId: 'acc-ws-a-1500',
        costCentavos: 12_000_000,
        usefulLifeYears: 5,
        residualValueCentavos: 0,
        depreciationStart: '2026-10-01',
        convention: 'full_month',
        depreciationExpenseAccountId: 'acc-ws-a-6050',
        accumulatedDepreciationAccountId: 'acc-ws-a-1590',
        sourceType: 'opening',
        postAcquisition: false,
      },
    },
    'u-accountant',
  );

  run({ type: 'depreciation.calculate', input: { period: '2026-10' } }, 'u-accountant');
  run({ type: 'depreciation.approve', input: { period: '2026-10' } }, 'u-checker');
  run({ type: 'depreciation.post', input: { period: '2026-10' } }, 'u-accountant');

  // 3. October Payroll run under pol-a-payroll-oct (2026-10-01 to 2026-10-15, pay date 2026-10-20)
  const wsA = state.workspaces.find((w) => w.id === WORKSPACE_A)!;
  wsA.settings.payrollPolicyId = 'pol-a-payroll-oct';

  const tImport = run(
    {
      type: 'time.import',
      input: {
        sourceName: 'october-time.csv',
        rows: [
          { employeeId: 'emp-a-001', bucket: 'ordinary_regular', minutes: 5280 },
          { employeeId: 'emp-a-002', bucket: 'ordinary_regular', minutes: 5280 },
          { employeeId: 'emp-a-003', bucket: 'ordinary_regular', minutes: 5280 },
        ],
      },
    },
    'u-payroll',
  );

  const pRun = run(
    {
      type: 'payroll.calculate',
      input: { timeImportId: tImport.documentId },
    },
    'u-payroll',
  );

  run({ type: 'payroll.approve', input: { runId: pRun.documentId } }, 'u-owner');
  run({ type: 'payroll.post', input: { runId: pRun.documentId } }, 'u-accountant');
  run(
    {
      type: 'payroll.pay',
      input: {
        runId: pRun.documentId,
        paymentDate: '2026-10-20',
        bankAccountId: 'bank-a-1',
      },
    },
    'u-accountant',
  );

  wsA.settings.payrollPolicyId = 'pol-a-payroll';

  // 4. Sales Report: Customer Invoice 1 (posted), Credit Note (posted), Customer Invoice 2 (posted), Invoice 3 (draft)
  const inv1 = run(
    {
      type: 'invoice.create',
      input: {
        customerContactId: 'contact-a-cust-2',
        invoiceDate: '2026-11-02',
        dueDate: '2026-11-17',
        branch: 'Main',
        department: 'Consulting',
        taxTreatment: 'vat12',
        lines: [
          {
            description: 'Advisory Retainer',
            quantityMilli: 1000,
            unitPriceCentavos: 5_000_000,
            accountId: 'acc-ws-a-4010',
          },
        ],
      },
    },
    'u-maker',
  );
  run({ type: 'invoice.post', input: { invoiceId: inv1.documentId } }, 'u-accountant');

  run(
    {
      type: 'creditNote.create',
      input: {
        invoiceId: inv1.documentId,
        creditDate: '2026-11-03',
        netCentavos: 500_000,
        reason: 'Retainer partial adjustment',
      },
    },
    'u-accountant',
  );

  const inv2 = run(
    {
      type: 'invoice.create',
      input: {
        customerContactId: 'contact-a-cust-2',
        invoiceDate: '2026-11-04',
        dueDate: '2026-11-19',
        branch: 'Main',
        department: 'Consulting',
        taxTreatment: 'vat12',
        lines: [
          {
            description: 'Logistics Advisory Service',
            quantityMilli: 1000,
            unitPriceCentavos: 2_500_000,
            accountId: 'acc-ws-a-4010',
          },
        ],
      },
    },
    'u-maker',
  );
  run({ type: 'invoice.post', input: { invoiceId: inv2.documentId } }, 'u-accountant');

  run(
    {
      type: 'invoice.create',
      input: {
        customerContactId: 'contact-a-cust-2',
        invoiceDate: '2026-11-05',
        dueDate: '2026-11-20',
        branch: 'Main',
        department: 'Consulting',
        taxTreatment: 'vat12',
        lines: [
          {
            description: 'Draft Advisory Retainer',
            quantityMilli: 1000,
            unitPriceCentavos: 1_000_000,
            accountId: 'acc-ws-a-4010',
          },
        ],
      },
    },
    'u-maker',
  );

  // 5. Collections: Customer Receipt for INV-1
  run(
    {
      type: 'receipt.create',
      input: {
        customerContactId: 'contact-a-cust-2',
        receiptDate: '2026-11-05',
        amountCentavos: 3_000_000,
        bankAccountId: 'bank-a-1',
        method: 'bank_deposit',
        reference: 'DEP-2026-0001',
        allocations: [{ invoiceId: inv1.documentId, amountCentavos: 3_000_000 }],
      },
    },
    'u-accountant',
  );

  // 6. Purchases: Supplier Bill, RFP, and checker approval
  const bill1 = run(
    {
      type: 'bill.create',
      input: {
        vendorContactId: 'contact-a-vend-1',
        supplierInvoiceNo: 'SI-9001',
        billDate: '2026-11-03',
        dueDate: '2026-11-18',
        lines: [
          {
            description: 'Office operations and rent',
            accountId: 'acc-ws-a-6030',
            amountCentavos: 2_000_000,
            taxTreatment: 'input_vat12',
            ewtRateBp: 200,
          },
        ],
      },
    },
    'u-maker',
  );

  const rfp1 = run(
    {
      type: 'rfp.create',
      input: {
        billId: bill1.documentId,
        amountCentavos: 1_000_000,
      },
    },
    'u-maker',
  );
  run({ type: 'rfp.approve', input: { rfpId: rfp1.documentId } }, 'u-checker');

  // 7. Cash Disbursements: Payment, Employee Advance, and Compound Liquidation
  run(
    {
      type: 'payment.create',
      input: {
        rfpId: rfp1.documentId,
        paymentDate: '2026-11-06',
        method: 'bank_direct',
        bankAccountId: 'bank-a-1',
      },
    },
    'u-accountant',
  );

  const adv1 = run(
    {
      type: 'advance.create',
      input: {
        employeeId: 'emp-a-001',
        advanceDate: '2026-11-04',
        amountCentavos: 500_000,
        bankAccountId: 'bank-a-1',
      },
    },
    'u-accountant',
  );

  run(
    {
      type: 'advance.liquidate',
      input: {
        advanceId: adv1.documentId,
        liquidationDate: '2026-11-07',
        expenses: [
          {
            accountId: 'acc-ws-a-6040',
            description: 'Field supplies and materials',
            amountCentavos: 300_000,
          },
        ],
        unusedReturnCentavos: 200_000,
        excessReimbursementCentavos: 0,
        bankAccountId: 'bank-a-1',
      },
    },
    'u-accountant',
  );

  // 8. Bank Reconciliation: imported bank statement row ready for matching
  run(
    {
      type: 'bankRow.import',
      input: {
        bankAccountId: 'bank-a-1',
        sourceName: 'synthetic-demo-reconciliation.csv',
        rows: [
          {
            rowRef: 'BNK-OCT-0001',
            valueDate: '2026-10-31',
            description: 'Synthetic bank monthly maintenance fee',
            direction: 'out',
            amountCentavos: 50_000,
          },
        ],
      },
    },
    'u-accountant',
  );

  // 9. Manual Journal: draft, checker approval, accountant post
  const jd1 = run(
    {
      type: 'journalDraft.create',
      input: {
        journalDate: '2026-11-04',
        memo: 'Reclassification of prepaid office expenses to operating supplies',
        lines: [
          {
            accountId: 'acc-ws-a-6040',
            debitCentavos: 50_000,
            creditCentavos: 0,
          },
          {
            accountId: 'acc-ws-a-6030',
            debitCentavos: 0,
            creditCentavos: 50_000,
          },
        ],
      },
    },
    'u-maker',
  );
  run({ type: 'journalDraft.approve', input: { draftId: jd1.documentId } }, 'u-checker');
  run({ type: 'journalDraft.post', input: { draftId: jd1.documentId } }, 'u-accountant');

  // 10. Standalone inventory in Company B (demonstrating standalone operations)
  run(
    {
      type: 'movement.receipt',
      input: {
        itemId: 'item-b-1',
        locationId: 'loc-b-main',
        occurredOn: '2026-10-25',
        quantityMilli: 10_000,
        unitCostCentavos: 80_000,
        sourceType: 'standalone_receipt',
        sourceId: 'seed-b-mvt-2',
        effectKey: 'seed:b:inventory-receipt:2',
      },
    },
    'u-binv',
    WORKSPACE_B,
  );

  // Reset timeImports so the active November payroll period is completely clean for interactive imports
  state.timeImports = [];
  state = backfillJournalProvenance(state);
  return state;
}
