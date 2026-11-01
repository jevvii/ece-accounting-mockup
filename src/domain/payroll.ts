import type { CommandResult, DomainCommand } from './commandTypes';
import { postJournal, recordAudit, reverseJournal, type WriteContext } from './ledger';
import type {
  Employee,
  PayrollBucketLine,
  PayrollLine,
  PayrollPolicy,
  PayrollRun,
  PayrollTotals,
  TaxBracket,
  TimeBucket,
} from './schema';
import { requireAccountByRole, requireProduct, requireRole } from './shared/access';
import { parseDateOnly } from './shared/dates';
import { pushItem, updateItem, type StateDraft } from './shared/draft';
import { applyBasisPoints, divRoundHalfUp, mulDivRound, sumCentavos } from './shared/money';
import { err, ok, type Result } from './shared/result';
import { allocateCode, allocateMasterCode } from './numbering';


function roundHalfUp(numerator: number, denominator: number): number {
  return Number(divRoundHalfUp(BigInt(numerator), BigInt(denominator)));
}

export function hourlyRateCentavos(monthlySalaryCentavos: number, hoursPerMonth: number): number {
  return roundHalfUp(monthlySalaryCentavos, hoursPerMonth);
}

export interface BucketCalculation {
  totalValueCentavos: number;
  baseIncludedCentavos: number;
  payableCentavos: number;
}

/**
 * Value one explicit time bucket. Factors are applied per basis-point step;
 * includedInBase subtracts only the unpremium base-hour value, never the whole
 * bucket, so an ordinary-night hour inside base adds its 10% premium only.
 */
export function calculateBucket(
  hourlyCentavos: number,
  minutes: number,
  rule: PayrollPolicy['timeMatrix'][number],
): BucketCalculation {
  const baseHourPortion = mulDivRound(hourlyCentavos, minutes, 60);
  let total = baseHourPortion;
  total = applyBasisPoints(total, rule.dayFactorBp);
  if (rule.otFactorBp !== null) total = applyBasisPoints(total, rule.otFactorBp);
  if (rule.nightFactorBp !== null) total = applyBasisPoints(total, rule.nightFactorBp);
  const baseIncluded = rule.includedInBase ? baseHourPortion : 0;
  return {
    totalValueCentavos: total,
    baseIncludedCentavos: baseIncluded,
    payableCentavos: Math.max(0, total - baseIncluded),
  };
}

export function annualTaxFromSchedule(taxableCentavos: number, brackets: TaxBracket[]): number {
  let tax = 0;
  let previousCeiling = 0;
  for (const bracket of brackets) {
    const ceiling = bracket.upToCentavos;
    const taxableInBracket =
      ceiling === null
        ? Math.max(0, taxableCentavos - previousCeiling)
        : Math.max(0, Math.min(taxableCentavos, ceiling) - previousCeiling);
    if (taxableInBracket > 0) tax += applyBasisPoints(taxableInBracket, bracket.rateBp);
    if (ceiling === null) break;
    previousCeiling = ceiling;
    if (taxableCentavos <= ceiling) break;
  }
  return tax;
}

function timeRowsByEmployee(
  state: WriteContext['state'],
  workspaceId: string,
  timeImportId: string,
): Map<string, Map<TimeBucket, number>> {
  const result = new Map<string, Map<TimeBucket, number>>();
  const timeImport = state.timeImports.find(
    (candidate) => candidate.id === timeImportId && candidate.workspaceId === workspaceId,
  );
  if (!timeImport) return result;
  for (const row of timeImport.rows) {
    const buckets = result.get(row.employeeId) ?? new Map<TimeBucket, number>();
    buckets.set(row.bucket, (buckets.get(row.bucket) ?? 0) + row.minutes);
    result.set(row.employeeId, buckets);
  }
  return result;
}

export function calculateRunLines(
  employees: Employee[],
  policy: PayrollPolicy,
  timeRows: Map<string, Map<TimeBucket, number>>,
  schedules: WriteContext['state']['deductionSchedules'],
): Result<{ lines: PayrollLine[]; totals: PayrollTotals }> {
  const lines: PayrollLine[] = [];
  for (const employee of employees) {
    const schedule = schedules.find((candidate) => candidate.id === employee.deductionScheduleId);
    if (!schedule) {
      return err('POLICY_INCOMPLETE', `No approved deduction schedule for ${employee.name}.`);
    }
    const hourly = hourlyRateCentavos(employee.monthlySalaryCentavos, policy.hoursPerMonth);
    const basePay = roundHalfUp(employee.monthlySalaryCentavos, 2);
    const rows = timeRows.get(employee.id) ?? new Map<TimeBucket, number>();
    const buckets: PayrollBucketLine[] = [];
    for (const rule of policy.timeMatrix) {
      const minutes = rows.get(rule.code) ?? 0;
      if (minutes <= 0) continue;
      const calculated = calculateBucket(hourly, minutes, rule);
      buckets.push({
        code: rule.code,
        label: rule.label,
        minutes,
        totalValueCentavos: calculated.totalValueCentavos,
        baseIncludedCentavos: calculated.baseIncludedCentavos,
        payableCentavos: calculated.payableCentavos,
      });
    }
    const gross = basePay + sumCentavos(buckets.map((bucket) => bucket.payableCentavos));
    const employeeSss = schedule.employeeSssCentavos;
    const employeePhilhealth = schedule.employeePhilhealthCentavos;
    const employeePagibig = schedule.employeePagibigCentavos;
    const employeeTax = schedule.employeeTaxCentavos;
    const totalDeductions = employeeSss + employeePhilhealth + employeePagibig + employeeTax;
    if (totalDeductions > gross) {
      return err(
        'AMOUNT_MISMATCH',
        `${employee.name}: deductions ${totalDeductions} exceed gross pay ${gross}; the run is blocked rather than paid negative.`,
      );
    }
    const employerTotal = schedule.employerSssCentavos + schedule.employerPhilhealthCentavos + schedule.employerPagibigCentavos;
    const net = gross - totalDeductions;
    lines.push({
      employeeId: employee.id,
      employeeName: employee.name,
      monthlySalaryCentavos: employee.monthlySalaryCentavos,
      basePayCentavos: basePay,
      buckets,
      grossCentavos: gross,
      employeeSssCentavos: employeeSss,
      employeePhilhealthCentavos: employeePhilhealth,
      employeePagibigCentavos: employeePagibig,
      employeeTaxCentavos: employeeTax,
      totalDeductionsCentavos: totalDeductions,
      netCentavos: net,
      employerSssCentavos: schedule.employerSssCentavos,
      employerPhilhealthCentavos: schedule.employerPhilhealthCentavos,
      employerPagibigCentavos: schedule.employerPagibigCentavos,
      totalEmployerCentavos: employerTotal,
      employerCostCentavos: gross + employerTotal,
    });
  }
  const totals: PayrollTotals = {
    grossCentavos: sumCentavos(lines.map((line) => line.grossCentavos)),
    employeeDeductionsCentavos: sumCentavos(lines.map((line) => line.totalDeductionsCentavos)),
    netCentavos: sumCentavos(lines.map((line) => line.netCentavos)),
    employerContributionsCentavos: sumCentavos(lines.map((line) => line.totalEmployerCentavos)),
    employerCostCentavos: sumCentavos(lines.map((line) => line.employerCostCentavos)),
    employeeSssCentavos: sumCentavos(lines.map((line) => line.employeeSssCentavos)),
    employeePhilhealthCentavos: sumCentavos(lines.map((line) => line.employeePhilhealthCentavos)),
    employeePagibigCentavos: sumCentavos(lines.map((line) => line.employeePagibigCentavos)),
    employeeTaxCentavos: sumCentavos(lines.map((line) => line.employeeTaxCentavos)),
  };
  return ok({ lines, totals });
}

export function importTime(
  draft: StateDraft,
  ctx: WriteContext,
  input: Extract<DomainCommand, { type: 'time.import' }>['input'],
): Result<CommandResult> {
  const product = requireProduct(ctx, 'payroll');
  if (!product.ok) return product;
  const role = requireRole(ctx, 'payroll_officer', 'company_admin');
  if (!role.ok) return role;
  if (input.sourceName.trim().length === 0) return err('VALIDATION', 'CSV file name is required.', 'sourceName');
  if (input.rows.length === 0) return err('VALIDATION', 'The time file contained no rows.', 'rows');
  const errors: string[] = [];
  const validRows: Array<{ employeeId: string; bucket: TimeBucket; minutes: number }> = [];
  const buckets = new Set(ctx.state.payrollPolicies.flatMap((policy) => policy.timeMatrix.map((rule) => rule.code)));
  for (const [index, row] of input.rows.entries()) {
    const employee = ctx.state.employees.find(
      (candidate) => candidate.id === row.employeeId && candidate.workspaceId === ctx.workspaceId,
    );
    if (!employee) {
      errors.push(`Row ${index + 2}: employee ${row.employeeId} is not in this workspace.`);
      continue;
    }
    if (!buckets.has(row.bucket)) {
      errors.push(`Row ${index + 2}: ${row.bucket} is not a configured time bucket.`);
      continue;
    }
    if (!Number.isSafeInteger(row.minutes) || row.minutes < 0) {
      errors.push(`Row ${index + 2}: minutes must be a whole non-negative number.`);
      continue;
    }
    validRows.push({ ...row });
  }
  const timeImport = {
    id: ctx.clock.newId('time'),
    workspaceId: ctx.workspaceId,
    sourceName: input.sourceName.trim(),
    importedAt: ctx.clock.nowIso,
    importedBy: ctx.actorId,
    rows: validRows,
    errors,
  };
  pushItem(draft, 'timeImports', timeImport);
  recordAudit(draft, ctx, {
    action: 'time.import',
    recordType: 'time_import',
    recordId: timeImport.id,
    detail: { sourceName: timeImport.sourceName, accepted: validRows.length, errors: errors.length },
  });
  return ok({
    summary: `Imported ${validRows.length} time row(s); ${errors.length} row(s) need correction.`,
    documentType: 'time_import',
    documentId: timeImport.id,
    journalIds: [],
    warnings: errors,
  });
}

export function calculatePayroll(
  draft: StateDraft,
  ctx: WriteContext,
  input: { timeImportId: string },
): Result<CommandResult> {
  const product = requireProduct(ctx, 'payroll');
  if (!product.ok) return product;
  const role = requireRole(ctx, 'payroll_officer', 'company_admin');
  if (!role.ok) return role;
  const timeImport = ctx.state.timeImports.find(
    (candidate) => candidate.id === input.timeImportId && candidate.workspaceId === ctx.workspaceId,
  );
  if (!timeImport) return err('NOT_FOUND', 'Time import not found in this workspace.');
  if (timeImport.errors.length > 0) {
    return err('VALIDATION', 'Fix the time-import errors before calculating payroll.', 'timeImportId');
  }
  const policyId = ctx.workspace.settings.payrollPolicyId;
  const policy = ctx.state.payrollPolicies.find(
    (candidate) => candidate.id === policyId && candidate.workspaceId === ctx.workspaceId,
  );
  if (!policy) return err('POLICY_INCOMPLETE', 'No approved payroll policy is assigned to this workspace.');
  if (policy.status !== 'demo_approved') {
    return err('POLICY_INCOMPLETE', 'The payroll policy is a draft; approve a synthetic policy before calculating.');
  }
  const duplicate = ctx.state.payrollRuns.find(
    (candidate) =>
      candidate.workspaceId === ctx.workspaceId &&
      candidate.policyId === policy.id &&
      candidate.periodStart === policy.periodStart &&
      candidate.periodEnd === policy.periodEnd &&
      candidate.status !== 'reversed',
  );
  if (duplicate) {
    return err('CONFLICT', `Payroll ${duplicate.runNo} already exists for this policy period.`);
  }
  const employees = ctx.state.employees.filter(
    (employee) => employee.workspaceId === ctx.workspaceId && employee.status === 'active',
  );
  if (employees.length === 0) return err('VALIDATION', 'No active employees are configured.');
  const lines = calculateRunLines(
    employees,
    policy,
    timeRowsByEmployee(ctx.state, ctx.workspaceId, timeImport.id),
    ctx.state.deductionSchedules,
  );
  if (!lines.ok) return lines;
  const runNo = allocateCode(draft, ctx.workspaceId, 'payroll_run');
  if (!runNo.ok) return runNo;
  const run: PayrollRun = {
    id: ctx.clock.newId('prun'),
    workspaceId: ctx.workspaceId,
    runNo: runNo.value,
    policyId: policy.id,
    periodStart: policy.periodStart,
    periodEnd: policy.periodEnd,
    payDate: policy.payDate,
    status: 'calculated',
    timeImportId: timeImport.id,
    lines: lines.value.lines,
    totals: lines.value.totals,
    errors: [],
    calculatedAt: ctx.clock.nowIso,
    calculatedBy: ctx.actorId,
    approvedBy: null,
    approvedAt: null,
    journalId: null,
    paymentJournalId: null,
    reversedBy: null,
    createdAt: ctx.clock.nowIso,
  };
  pushItem(draft, 'payrollRuns', run);
  recordAudit(draft, ctx, {
    action: 'payroll.calculate',
    recordType: 'payroll_run',
    recordId: run.id,
    detail: { runNo: run.runNo, gross: run.totals.grossCentavos, employees: run.lines.length },
  });
  return ok({
    summary: `Payroll ${run.runNo} calculated for ${run.lines.length} employees; gross ${run.totals.grossCentavos} centavos.`,
    documentType: 'payroll_run',
    documentId: run.id,
    journalIds: [],
    warnings: [],
  });
}

export function approvePayroll(
  draft: StateDraft,
  ctx: WriteContext,
  input: { runId: string },
): Result<CommandResult> {
  const product = requireProduct(ctx, 'payroll');
  if (!product.ok) return product;
  const role = requireRole(ctx, 'payroll_officer', 'company_admin');
  if (!role.ok) return role;
  const run = ctx.state.payrollRuns.find(
    (candidate) => candidate.id === input.runId && candidate.workspaceId === ctx.workspaceId,
  );
  if (!run) return err('NOT_FOUND', 'Payroll run not found in this workspace.');
  if (run.status !== 'calculated') return err('CONFLICT', `Payroll is already ${run.status}.`);
  if (run.calculatedBy === ctx.actorId) {
    return err('FORBIDDEN', 'Payroll maker and approver must be different users.');
  }
  updateItem(
    draft,
    'payrollRuns',
    (candidate) => candidate.id === run.id,
    (candidate) => ({
      ...candidate,
      status: 'approved',
      approvedBy: ctx.actorId,
      approvedAt: ctx.clock.nowIso,
    }),
  );
  recordAudit(draft, ctx, {
    action: 'payroll.approve',
    recordType: 'payroll_run',
    recordId: run.id,
    detail: { approvedBy: ctx.actorId },
  });
  return ok({
    summary: `Payroll ${run.runNo} approved by a second user.`,
    documentType: 'payroll_run',
    documentId: run.id,
    journalIds: [],
    warnings: [],
  });
}

export function postPayroll(
  draft: StateDraft,
  ctx: WriteContext,
  input: { runId: string },
): Result<CommandResult> {
  const product = requireProduct(ctx, 'accounting');
  if (!product.ok) return product;
  const role = requireRole(ctx, 'accountant', 'company_admin');
  if (!role.ok) return role;
  const run = ctx.state.payrollRuns.find(
    (candidate) => candidate.id === input.runId && candidate.workspaceId === ctx.workspaceId,
  );
  if (!run) return err('NOT_FOUND', 'Payroll run not found in this workspace.');
  if (run.status !== 'approved') return err('CONFLICT', 'Payroll must be approved by a second user before posting.');
  const accounts = {
    salaries: requireAccountByRole(ctx.state, ctx.workspaceId, 'salaries_expense'),
    employer: requireAccountByRole(ctx.state, ctx.workspaceId, 'employer_expense'),
    net: requireAccountByRole(ctx.state, ctx.workspaceId, 'net_pay_payable'),
    sss: requireAccountByRole(ctx.state, ctx.workspaceId, 'sss_payable'),
    philhealth: requireAccountByRole(ctx.state, ctx.workspaceId, 'philhealth_payable'),
    pagibig: requireAccountByRole(ctx.state, ctx.workspaceId, 'pagibig_payable'),
    tax: requireAccountByRole(ctx.state, ctx.workspaceId, 'tax_withheld_payable'),
  };
  for (const account of Object.values(accounts)) {
    if (!account.ok) return account;
  }
  const sss = run.totals.employeeSssCentavos + sumCentavos(run.lines.map((line) => line.employerSssCentavos));
  const philhealth =
    run.totals.employeePhilhealthCentavos + sumCentavos(run.lines.map((line) => line.employerPhilhealthCentavos));
  const pagibig =
    run.totals.employeePagibigCentavos + sumCentavos(run.lines.map((line) => line.employerPagibigCentavos));
  const journal = postJournal(draft, ctx, {
    postingDate: run.periodEnd,
    documentDate: run.periodEnd,
    sourceType: 'payroll_run',
    sourceId: run.id,
    effectKey: `payroll-post:${run.id}`,
    memo: `Payroll ${run.runNo} — ${run.periodStart} to ${run.periodEnd}`,
    approvedBy: run.approvedBy,
    lines: [
      { accountId: (accounts.salaries as { value: { id: string } }).value.id, debitCentavos: run.totals.grossCentavos, creditCentavos: 0 },
      {
        accountId: (accounts.employer as { value: { id: string } }).value.id,
        debitCentavos: run.totals.employerContributionsCentavos,
        creditCentavos: 0,
      },
      { accountId: (accounts.net as { value: { id: string } }).value.id, debitCentavos: 0, creditCentavos: run.totals.netCentavos },
      ...(sss > 0 ? [{ accountId: (accounts.sss as { value: { id: string } }).value.id, debitCentavos: 0, creditCentavos: sss }] : []),
      ...(philhealth > 0
        ? [{ accountId: (accounts.philhealth as { value: { id: string } }).value.id, debitCentavos: 0, creditCentavos: philhealth }]
        : []),
      ...(pagibig > 0
        ? [{ accountId: (accounts.pagibig as { value: { id: string } }).value.id, debitCentavos: 0, creditCentavos: pagibig }]
        : []),
      ...(run.totals.employeeTaxCentavos > 0
        ? [{ accountId: (accounts.tax as { value: { id: string } }).value.id, debitCentavos: 0, creditCentavos: run.totals.employeeTaxCentavos }]
        : []),
    ],
  });
  if (!journal.ok) return journal;
  updateItem(
    draft,
    'payrollRuns',
    (candidate) => candidate.id === run.id,
    (candidate) => ({ ...candidate, status: 'posted', journalId: journal.value.id }),
  );
  recordAudit(draft, ctx, {
    action: 'payroll.post',
    recordType: 'payroll_run',
    recordId: run.id,
    detail: { journalId: journal.value.id },
  });
  return ok({
    summary: `Payroll ${run.runNo} posted to the ledger.`,
    documentType: 'payroll_run',
    documentId: run.id,
    journalIds: [journal.value.id],
    warnings: [],
  });
}

export function payPayroll(
  draft: StateDraft,
  ctx: WriteContext,
  input: { runId: string; paymentDate: string; bankAccountId: string },
): Result<CommandResult> {
  const product = requireProduct(ctx, 'accounting');
  if (!product.ok) return product;
  const role = requireRole(ctx, 'accountant', 'company_admin');
  if (!role.ok) return role;
  const run = ctx.state.payrollRuns.find(
    (candidate) => candidate.id === input.runId && candidate.workspaceId === ctx.workspaceId,
  );
  if (!run) return err('NOT_FOUND', 'Payroll run not found in this workspace.');
  if (run.status !== 'posted') return err('CONFLICT', 'Payroll must be posted before net pay is released.');
  const date = parseDateOnly(input.paymentDate, 'paymentDate');
  if (!date.ok) return date;
  const bank = ctx.state.bankAccounts.find(
    (candidate) => candidate.id === input.bankAccountId && candidate.workspaceId === ctx.workspaceId,
  );
  if (!bank) return err('VALIDATION', 'Select a bank account in this workspace.', 'bankAccountId');
  const netPayable = requireAccountByRole(ctx.state, ctx.workspaceId, 'net_pay_payable');
  if (!netPayable.ok) return netPayable;
  const journal = postJournal(draft, ctx, {
    postingDate: input.paymentDate,
    documentDate: input.paymentDate,
    sourceType: 'payroll_payment',
    sourceId: run.id,
    effectKey: `payroll-payment:${run.id}`,
    memo: `Net pay release — payroll ${run.runNo}`,
    lines: [
      { accountId: netPayable.value.id, debitCentavos: run.totals.netCentavos, creditCentavos: 0 },
      { accountId: bank.ledgerAccountId, debitCentavos: 0, creditCentavos: run.totals.netCentavos },
    ],
    approvedBy: run.approvedBy,
  });
  if (!journal.ok) return journal;
  updateItem(
    draft,
    'payrollRuns',
    (candidate) => candidate.id === run.id,
    (candidate) => ({ ...candidate, status: 'paid', paymentJournalId: journal.value.id }),
  );
  recordAudit(draft, ctx, {
    action: 'payroll.pay',
    recordType: 'payroll_run',
    recordId: run.id,
    detail: { journalId: journal.value.id, netCentavos: run.totals.netCentavos },
  });
  return ok({
    summary: `Net pay for ${run.runNo} released; ${run.totals.netCentavos} centavos.`,
    documentType: 'payroll_run',
    documentId: run.id,
    journalIds: [journal.value.id],
    warnings: [],
  });
}

export function reversePayroll(
  draft: StateDraft,
  ctx: WriteContext,
  input: { runId: string; reversalDate: string; reason: string },
): Result<CommandResult> {
  const role = requireRole(ctx, 'accountant', 'company_admin');
  if (!role.ok) return role;
  const run = ctx.state.payrollRuns.find(
    (candidate) => candidate.id === input.runId && candidate.workspaceId === ctx.workspaceId,
  );
  if (!run) return err('NOT_FOUND', 'Payroll run not found in this workspace.');
  if (run.status === 'paid') {
    return err('CONFLICT', 'Net pay is already released; reverse the payment through an authorized adjustment first.');
  }
  if (run.status !== 'posted' || !run.journalId) {
    return err('CONFLICT', 'Only a posted payroll journal can be reversed.');
  }
  if (input.reason.trim().length < 3) return err('VALIDATION', 'A reversal reason is required.', 'reason');
  const reversal = reverseJournal(
    draft,
    ctx,
    run.journalId,
    input.reversalDate,
    input.reason,
    'payroll_reversal',
    run.id,
  );
  if (!reversal.ok) return reversal;
  updateItem(
    draft,
    'payrollRuns',
    (candidate) => candidate.id === run.id,
    (candidate) => ({ ...candidate, status: 'reversed', reversedBy: reversal.value.id }),
  );
  recordAudit(draft, ctx, {
    action: 'payroll.reverse',
    recordType: 'payroll_run',
    recordId: run.id,
    reason: input.reason,
    detail: { reversalJournalId: reversal.value.id },
  });
  return ok({
    summary: `Payroll ${run.runNo} reversed with a linked journal.`,
    documentType: 'payroll_run',
    documentId: run.id,
    journalIds: [reversal.value.id],
    warnings: [],
  });
}

export function createEmployee(
  draft: StateDraft,
  ctx: WriteContext,
  input: Extract<DomainCommand, { type: 'employee.create' }>['input'],
): Result<CommandResult> {
  const product = requireProduct(ctx, 'payroll');
  if (!product.ok) return product;
  const role = requireRole(ctx, 'payroll_officer', 'company_admin');
  if (!role.ok) return role;
  if (input.name.trim().length === 0) return err('VALIDATION', 'Employee name is required.', 'name');
  if (!Number.isSafeInteger(input.monthlySalaryCentavos) || input.monthlySalaryCentavos <= 0) {
    return err('VALIDATION', 'Monthly salary must be greater than zero.', 'monthlySalaryCentavos');
  }
  const hired = parseDateOnly(input.hiredOn, 'hiredOn');
  if (!hired.ok) return hired;
  const employeeNo = allocateMasterCode(draft, ctx.workspaceId, 'employee', input.employeeNo);
  if (!employeeNo.ok) return employeeNo;
  const duplicate = ctx.state.employees.some(
    (employee) =>
      employee.workspaceId === ctx.workspaceId &&
      employee.employeeNo.trim().toLowerCase() === employeeNo.value.trim().toLowerCase(),
  );
  if (duplicate) return err('DUPLICATE_ROW', 'This employee number already exists.', 'employeeNo');
  const schedule = ctx.state.deductionSchedules.find(
    (candidate) => candidate.id === input.deductionScheduleId && candidate.workspaceId === ctx.workspaceId,
  );
  if (!schedule) return err('POLICY_INCOMPLETE', 'Select an approved deduction schedule.', 'deductionScheduleId');
  const employee: Employee = {
    id: ctx.clock.newId('emp'),
    workspaceId: ctx.workspaceId,
    employeeNo: employeeNo.value.trim(),
    name: input.name.trim(),
    monthlySalaryCentavos: input.monthlySalaryCentavos,
    status: 'active',
    hiredOn: input.hiredOn,
    separatedOn: null,
    deductionScheduleId: schedule.id,
    branch: input.branch.trim(),
    department: input.department.trim(),
  };
  pushItem(draft, 'employees', employee);
  recordAudit(draft, ctx, {
    action: 'employee.create',
    recordType: 'employee',
    recordId: employee.id,
    detail: { employeeNo: employee.employeeNo },
  });
  return ok({
    summary: `${employee.name} added to payroll.`,
    documentType: 'employee',
    documentId: employee.id,
    journalIds: [],
    warnings: [],
  });
}

export function updatePayrollPolicy(
  draft: StateDraft,
  ctx: WriteContext,
  input: Extract<DomainCommand, { type: 'payrollPolicy.update' }>['input'],
): Result<CommandResult> {
  const product = requireProduct(ctx, 'payroll');
  if (!product.ok) return product;
  const role = requireRole(ctx, 'payroll_officer', 'company_admin');
  if (!role.ok) return role;
  const policy = ctx.state.payrollPolicies.find(
    (candidate) => candidate.id === input.policyId && candidate.workspaceId === ctx.workspaceId,
  );
  if (!policy) return err('NOT_FOUND', 'Payroll policy not found in this workspace.');
  for (const key of ['periodStart', 'periodEnd', 'payDate', 'approvalDeadline'] as const) {
    const parsed = parseDateOnly(input[key], key);
    if (!parsed.ok) return parsed;
  }
  if (input.periodEnd < input.periodStart) return err('VALIDATION', 'Period end cannot precede period start.', 'periodEnd');
  if (!Number.isSafeInteger(input.hoursPerMonth) || input.hoursPerMonth <= 0) {
    return err('VALIDATION', 'Hours per month must be positive.', 'hoursPerMonth');
  }
  if (!Number.isSafeInteger(input.periodWorkingDays) || input.periodWorkingDays <= 0) {
    return err('VALIDATION', 'Period working days must be positive.', 'periodWorkingDays');
  }
  if (input.annualTaxSchedule) {
    if (input.annualTaxSchedule.length === 0) {
      return err('VALIDATION', 'Annual tax schedule cannot be empty.', 'annualTaxSchedule');
    }
    updateItem(
      draft,
      'payrollPolicies',
      (candidate) => candidate.id === policy.id,
      (candidate) => ({
        ...candidate,
        hoursPerMonth: input.hoursPerMonth,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        payDate: input.payDate,
        approvalDeadline: input.approvalDeadline,
        periodWorkingDays: input.periodWorkingDays,
        annualTaxSchedule: input.annualTaxSchedule ?? candidate.annualTaxSchedule,
      }),
    );
  } else {
    updateItem(
      draft,
      'payrollPolicies',
      (candidate) => candidate.id === policy.id,
      (candidate) => ({
        ...candidate,
        hoursPerMonth: input.hoursPerMonth,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        payDate: input.payDate,
        approvalDeadline: input.approvalDeadline,
        periodWorkingDays: input.periodWorkingDays,
      }),
    );
  }
  recordAudit(draft, ctx, {
    action: 'payrollPolicy.update',
    recordType: 'payroll_policy',
    recordId: policy.id,
    detail: { hoursPerMonth: input.hoursPerMonth, periodStart: input.periodStart, periodEnd: input.periodEnd },
  });
  return ok({
    summary: `Payroll policy ${policy.version} updated with explicit synthetic values.`,
    documentType: 'payroll_policy',
    documentId: policy.id,
    journalIds: [],
    warnings: ['Policy remains a demo-approved fixture; no statutory rates are inferred.'],
  });
}

function inputNumber(
  inputs: Record<string, string | number>,
  key: string,
  label: string,
  options: { required?: boolean; minimum?: number } = {},
): Result<number | null> {
  const raw = inputs[key];
  if (raw === undefined || raw === '') {
    if (options.required) return err('VALIDATION', `${label} is required.`, key);
    return ok(null);
  }
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isSafeInteger(value)) return err('VALIDATION', `${label} must be a whole centavo value.`, key);
  if (options.minimum !== undefined && value < options.minimum) {
    return err('VALIDATION', `${label} must be at least ${options.minimum}.`, key);
  }
  return ok(value);
}

export function computeWorksheet(
  kind: '13th_month' | 'annualization' | 'final_pay' | '2316',
  inputs: Record<string, string | number>,
  policy: PayrollPolicy,
): Result<Record<string, string | number>> {
  if (kind === '13th_month') {
    const annualBasic = inputNumber(inputs, 'annual_basic_earned', 'Annual basic earned', { required: true, minimum: 1 });
    if (!annualBasic.ok) return annualBasic;
    if (annualBasic.value === null) return err('VALIDATION', 'Annual basic earned is required.', 'annual_basic_earned');
    const divisor = inputNumber(inputs, 'divisor', '13th-month divisor', { minimum: 1 });
    if (!divisor.ok) return divisor;
    const actualDivisor = divisor.value ?? policy.thirteenthMonthDivisor;
    if (actualDivisor <= 0) return err('POLICY_INCOMPLETE', 'A positive 13th-month divisor is required.');
    const thirteenth = roundHalfUp(annualBasic.value, actualDivisor);
    return ok({
      annual_basic_earned: annualBasic.value,
      divisor: actualDivisor,
      thirteenth_month_centavos: thirteenth,
    });
  }
  if (kind === 'annualization') {
    const current = inputNumber(inputs, 'current_employer_taxable', 'Current-employer taxable pay', {
      required: true,
      minimum: 0,
    });
    if (!current.ok) return current;
    const prior = inputNumber(inputs, 'prior_employer_taxable', 'Prior-employer taxable pay', { minimum: 0 });
    if (!prior.ok) return prior;
    const withheld = inputNumber(inputs, 'tax_withheld', 'Tax already withheld', { minimum: 0 });
    if (!withheld.ok) return withheld;
    const priorWithheld = inputNumber(inputs, 'prior_employer_tax_withheld', 'Prior-employer tax withheld (for reporting only)', {
      minimum: 0,
    });
    if (!priorWithheld.ok) return priorWithheld;
    const combined = (current.value ?? 0) + (prior.value ?? 0);
    const annualTax = annualTaxFromSchedule(combined, policy.annualTaxSchedule);
    const alreadyWithheld = withheld.value ?? 0;
    return ok({
      current_employer_taxable: current.value ?? 0,
      prior_employer_taxable: prior.value ?? 0,
      combined_taxable_centavos: combined,
      annual_tax_centavos: annualTax,
      tax_withheld: alreadyWithheld,
      prior_employer_tax_withheld_reported: priorWithheld.value ?? 0,
      year_end_adjustment_centavos: annualTax - alreadyWithheld,
    });
  }
  if (kind === 'final_pay') {
    const earned = inputNumber(inputs, 'earned_pay', 'Earned pay', { required: true, minimum: 0 });
    if (!earned.ok) return earned;
    const thirteenth = inputNumber(inputs, 'thirteenth_month_accrual', 'Eligible 13th-month accrual', { minimum: 0 });
    if (!thirteenth.ok) return thirteenth;
    const benefit = inputNumber(inputs, 'approved_benefit', 'Approved benefit', { minimum: 0 });
    if (!benefit.ok) return benefit;
    const deduction = inputNumber(inputs, 'permitted_deduction', 'Permitted non-advance deduction', { minimum: 0 });
    if (!deduction.ok) return deduction;
    const gross =
      (earned.value ?? 0) + (thirteenth.value ?? 0) + (benefit.value ?? 0);
    const net = gross - (deduction.value ?? 0);
    if (net < 0) return err('AMOUNT_MISMATCH', 'Permitted deductions exceed final-pay components.');
    return ok({
      earned_pay: earned.value ?? 0,
      thirteenth_month_accrual: thirteenth.value ?? 0,
      approved_benefit: benefit.value ?? 0,
      permitted_deduction: deduction.value ?? 0,
      gross_components_centavos: gross,
      net_settlement_centavos: net,
    });
  }
  const gross = inputNumber(inputs, 'gross_compensation', 'Gross compensation', { required: true, minimum: 0 });
  if (!gross.ok) return gross;
  const tax = inputNumber(inputs, 'tax_withheld', 'Tax withheld', { required: true, minimum: 0 });
  if (!tax.ok) return tax;
  return ok({
    gross_compensation: gross.value ?? 0,
    tax_withheld: tax.value ?? 0,
  });
}

export function saveWorksheet(
  draft: StateDraft,
  ctx: WriteContext,
  input: Extract<DomainCommand, { type: 'worksheet.save' }>['input'],
): Result<CommandResult> {
  const product = requireProduct(ctx, 'payroll');
  if (!product.ok) return product;
  const role = requireRole(ctx, 'payroll_officer', 'accountant', 'company_admin');
  if (!role.ok) return role;
  if (input.label.trim().length === 0) return err('VALIDATION', 'A worksheet label is required.', 'label');
  if (input.employeeId) {
    const employee = ctx.state.employees.find(
      (candidate) => candidate.id === input.employeeId && candidate.workspaceId === ctx.workspaceId,
    );
    if (!employee) return err('VALIDATION', 'Employee is not in this workspace.', 'employeeId');
  }
  const policyId = ctx.workspace.settings.payrollPolicyId;
  const policy = ctx.state.payrollPolicies.find(
    (candidate) => candidate.id === policyId && candidate.workspaceId === ctx.workspaceId,
  );
  if (!policy) return err('POLICY_INCOMPLETE', 'No approved payroll policy is assigned to this workspace.');
  const result = computeWorksheet(input.kind, input.inputs, policy);
  if (!result.ok) return result;
  const worksheetNo = allocateCode(draft, ctx.workspaceId, 'payroll_worksheet');
  if (!worksheetNo.ok) return worksheetNo;
  const worksheet = {
    id: ctx.clock.newId('ws'),
    workspaceId: ctx.workspaceId,
    worksheetNo: worksheetNo.value,
    kind: input.kind,
    employeeId: input.employeeId ?? null,
    label: input.label.trim(),
    inputs: { ...input.inputs },
    result: result.value,
    createdAt: ctx.clock.nowIso,
    createdBy: ctx.actorId,
  };
  pushItem(draft, 'worksheets', worksheet);
  recordAudit(draft, ctx, {
    action: 'worksheet.save',
    recordType: 'worksheet',
    recordId: worksheet.id,
    detail: { kind: worksheet.kind },
  });
  return ok({
    summary: `${worksheet.label} saved with explicit inputs and computed result.`,
    documentType: 'worksheet',
    documentId: worksheet.id,
    journalIds: [],
    warnings: ['Worksheets are estimates from entered parameters; they do not file or remit anything.'],
  });
}

export function payrollDetailVisible(ctx: WriteContext): boolean {
  return ctx.membership.payrollDetail;
}
