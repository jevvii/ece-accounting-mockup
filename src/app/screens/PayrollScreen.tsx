import { useMemo, useState } from 'react';
import type {
  PayrollLine,
  PayrollRun,
  TimeImport,
  Worksheet,
} from '../../domain/schema';
import type { TimeRowInput } from '../../domain/commandTypes';
import { numberingPolicy, previewCodes } from '../../domain/numbering';
import { useApp } from '../useApp';
import { useAppRoute } from '../navigation';
import {
  TIME_BUCKETS,
  TIME_CSV_TEMPLATE,
  downloadText,
  parseTimeCsv,
  toCsv,
} from '../../adapters/csv';
import { EmptyState, Field, Modal, Panel, StatusBadge } from '../components';
import {
  formatMinutes,
  humanDate,
  humanTimestamp,
  money,
  peso,
  titleCase,
} from '../format';
import { dateField, focusField, moneyField, positiveIntField, requiredField } from '../forms';
import { hasAnyRole } from '../permissions';

type PayrollTab = 'policy' | 'employees' | 'time' | 'runs' | 'worksheets';

const WORKSHEET_FIELDS: Record<
  Worksheet['kind'],
  Array<{ key: string; label: string; required: boolean }>
> = {
  '13th_month': [
    { key: 'annual_basic_earned', label: 'Annual basic earned (PHP)', required: true },
    { key: 'divisor', label: '13th-month divisor (optional, defaults to policy)', required: false },
  ],
  annualization: [
    { key: 'current_employer_taxable', label: 'Current-employer taxable pay (PHP)', required: true },
    { key: 'prior_employer_taxable', label: 'Prior-employer taxable pay (PHP)', required: false },
    { key: 'tax_withheld', label: 'Tax already withheld (PHP)', required: false },
    { key: 'prior_employer_tax_withheld', label: 'Prior-employer tax withheld, reporting only (PHP)', required: false },
  ],
  final_pay: [
    { key: 'earned_pay', label: 'Earned pay (PHP)', required: true },
    { key: 'thirteenth_month_accrual', label: 'Eligible 13th-month accrual (PHP)', required: false },
    { key: 'approved_benefit', label: 'Approved benefit (PHP)', required: false },
    { key: 'permitted_deduction', label: 'Permitted non-advance deduction (PHP)', required: false },
  ],
  '2316': [
    { key: 'gross_compensation', label: 'Gross compensation (PHP)', required: true },
    { key: 'tax_withheld', label: 'Tax withheld (PHP)', required: true },
  ],
};

function resultLabel(key: string): string {
  return key
    .replace(/_centavos$/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function PayrollScreen() {
  const api = useApp();
  const route = useAppRoute();
  const { state, workspaceId, access } = api;
  const workspace = state.workspaces.find((candidate) => candidate.id === workspaceId);
  const payrollStatus = api.productStatus('payroll');
  const accountingStatus = api.productStatus('accounting');
  const payrollActive = payrollStatus === 'active';
  const accountingActive = accountingStatus === 'active';
  const hasDetail = access?.membership.payrollDetail ?? false;

  const canPayrollWrite = payrollActive && hasAnyRole(access, 'payroll_officer', 'company_admin');
  const canPost = accountingActive && hasAnyRole(access, 'accountant', 'company_admin');
  const canReverse = accountingActive && hasAnyRole(access, 'accountant', 'company_admin');

  const policy = state.payrollPolicies.find(
    (candidate) =>
      candidate.id === workspace?.settings.payrollPolicyId && candidate.workspaceId === workspaceId,
  );
  const schedules = state.deductionSchedules.filter(
    (schedule) => schedule.workspaceId === workspaceId,
  );
  const employees = state.employees.filter((employee) => employee.workspaceId === workspaceId);
  const timeImports = state.timeImports
    .filter((item) => item.workspaceId === workspaceId)
    .slice()
    .sort((left, right) => right.importedAt.localeCompare(left.importedAt));
  const runs = state.payrollRuns
    .filter((run) => run.workspaceId === workspaceId)
    .slice()
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const worksheets = state.worksheets
    .filter((worksheet) => worksheet.workspaceId === workspaceId)
    .slice()
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

  const tab: PayrollTab =
    route?.page === 'policy' ||
    route?.page === 'employees' ||
    route?.page === 'time' ||
    route?.page === 'worksheets'
      ? route.page
      : 'runs';
  const [policyOpen, setPolicyOpen] = useState(false);
  const [policyForm, setPolicyForm] = useState(() => ({
    hoursPerMonth: String(policy?.hoursPerMonth ?? 200),
    periodStart: policy?.periodStart ?? api.clock.today,
    periodEnd: policy?.periodEnd ?? api.clock.today,
    payDate: policy?.payDate ?? api.clock.today,
    approvalDeadline: policy?.approvalDeadline ?? api.clock.today,
    periodWorkingDays: String(policy?.periodWorkingDays ?? 11),
  }));
  const [employeeOpen, setEmployeeOpen] = useState(false);
  const [employeeErrors, setEmployeeErrors] = useState<{
    employeeNo?: string;
    name?: string;
    salary?: string;
    hired?: string;
  }>({});
  const [employeeForm, setEmployeeForm] = useState({
    employeeNo: '',
    name: '',
    monthlySalary: '',
    hiredOn: api.clock.today,
    deductionScheduleId: schedules.find((schedule) => schedule.status === 'demo_approved')?.id ?? '',
    branch: 'Main',
    department: '',
  });
  const [timeOpen, setTimeOpen] = useState(false);
  const [timeSourceName, setTimeSourceName] = useState('synthetic-time.csv');
  const [timeText, setTimeText] = useState('');
  const [selectedImportId, setSelectedImportId] = useState('');
  const [payTarget, setPayTarget] = useState<PayrollRun | null>(null);
  const [payForm, setPayForm] = useState({ paymentDate: api.clock.today, bankAccountId: '' });
  const [reverseTarget, setReverseTarget] = useState<PayrollRun | null>(null);
  const [reverseForm, setReverseForm] = useState({ reversalDate: api.clock.today, reason: '' });
  const [payslip, setPayslip] = useState<{ run: PayrollRun; line: PayrollLine } | null>(null);
  const [worksheetOpen, setWorksheetOpen] = useState(false);
  const [worksheetForm, setWorksheetForm] = useState<{
    kind: Worksheet['kind'];
    employeeId: string;
    label: string;
    inputs: Record<string, string>;
  }>({
    kind: '13th_month',
    employeeId: '',
    label: '',
    inputs: {},
  });

  const banks = state.bankAccounts.filter(
    (bank) => bank.workspaceId === workspaceId && bank.active,
  );
  const latestImport = timeImports[0] ?? null;
  const selectedImport: TimeImport | null =
    timeImports.find((item) => item.id === selectedImportId) ?? latestImport;

  const parsedTime = useMemo(() => {
    if (!timeText.trim()) {
      return { rows: [] as TimeRowInput[], errors: [] as string[] };
    }
    const parsed = parseTimeCsv(timeText);
    const rows: TimeRowInput[] = [];
    const errors = [...parsed.errors];
    const seen = new Set<string>();
    for (const row of parsed.rows) {
      const employee = employees.find((candidate) => candidate.employeeNo === row.employeeNo);
      if (!employee) {
        errors.push(`Employee number ${row.employeeNo} is not in this company.`);
        continue;
      }
      const key = `${employee.id}:${row.bucket}`;
      if (seen.has(key)) {
        errors.push(
          `Employee ${row.employeeNo} has more than one ${titleCase(row.bucket)} row; buckets must be disjoint.`,
        );
        continue;
      }
      seen.add(key);
      rows.push({ employeeId: employee.id, bucket: row.bucket, minutes: row.minutes });
    }
    return { rows, errors };
  }, [timeText, employees]);

  const openPolicy = () => {
    if (!policy) return;
    setPolicyForm({
      hoursPerMonth: String(policy.hoursPerMonth),
      periodStart: policy.periodStart,
      periodEnd: policy.periodEnd,
      payDate: policy.payDate,
      approvalDeadline: policy.approvalDeadline,
      periodWorkingDays: String(policy.periodWorkingDays),
    });
    setPolicyOpen(true);
  };

  const submitPolicy = () => {
    if (!policy) return;
    const hours = positiveIntField(policyForm.hoursPerMonth, 'hours per month');
    const workingDays = positiveIntField(policyForm.periodWorkingDays, 'working days');
    const start = dateField(policyForm.periodStart, 'period start');
    const end = dateField(policyForm.periodEnd, 'period end');
    const pay = dateField(policyForm.payDate, 'pay date');
    const deadline = dateField(policyForm.approvalDeadline, 'approval deadline');
    const firstError = [hours, workingDays, start, end, pay, deadline].find((field) => !field.ok);
    if (firstError) {
      api.notify('error', 'Policy update is incomplete', firstError.message);
      return;
    }
    const result = api.dispatch({
      type: 'payrollPolicy.update',
      input: {
        policyId: policy.id,
        hoursPerMonth: hours.value ?? policy.hoursPerMonth,
        periodStart: policyForm.periodStart,
        periodEnd: policyForm.periodEnd,
        payDate: policyForm.payDate,
        approvalDeadline: policyForm.approvalDeadline,
        periodWorkingDays: workingDays.value ?? policy.periodWorkingDays,
      },
    });
    if (result) setPolicyOpen(false);
  };

  const openEmployee = () => {
    setEmployeeForm({
      employeeNo: '',
      name: '',
      monthlySalary: '',
      hiredOn: api.clock.today,
      deductionScheduleId: schedules.find((schedule) => schedule.status === 'demo_approved')?.id ?? '',
      branch: 'Main',
      department: '',
    });
    setEmployeeOpen(true);
  };

  const employeePolicy = numberingPolicy(state, workspaceId, 'employee');

  const submitEmployee = () => {
    const number = employeePolicy.manualOverride
      ? requiredField(employeeForm.employeeNo, 'employee number')
      : { ok: true as const, value: '' };
    const name = requiredField(employeeForm.name, 'employee name');
    const salary = moneyField(employeeForm.monthlySalary, 'monthly salary');
    const hired = dateField(employeeForm.hiredOn, 'hire date');
    const firstError = [number, name, salary, hired].find((field) => !field.ok);
    setEmployeeErrors({
      employeeNo: number.ok ? undefined : number.message,
      name: name.ok ? undefined : name.message,
      salary: salary.ok ? undefined : salary.message,
      hired: hired.ok ? undefined : hired.message,
    });
    if (firstError && !firstError.ok) {
      focusField(
        !number.ok ? 'employee-no' : !name.ok ? 'employee-name' : !salary.ok ? 'employee-salary' : 'employee-hired',
      );
      api.notify('error', 'Employee is incomplete', firstError.message);
      return;
    }
    if (!employeeForm.deductionScheduleId) {
      api.notify('error', 'Employee is incomplete', 'Select an approved synthetic deduction schedule.');
      return;
    }
    const result = api.dispatch({
      type: 'employee.create',
      input: {
        employeeNo: employeePolicy.manualOverride ? employeeForm.employeeNo : '',
        name: employeeForm.name,
        monthlySalaryCentavos: salary.value ?? 0,
        hiredOn: employeeForm.hiredOn,
        deductionScheduleId: employeeForm.deductionScheduleId,
        branch: employeeForm.branch,
        department: employeeForm.department,
      },
    });
    if (result) {
      setEmployeeErrors({});
      setEmployeeOpen(false);
    }
  };

  const openTime = () => {
    setTimeSourceName('synthetic-time.csv');
    setTimeText('');
    setTimeOpen(true);
  };

  const submitTime = () => {
    if (parsedTime.errors.length > 0) {
      api.notify('error', 'Time file has errors', parsedTime.errors[0] ?? 'Fix the file before importing.');
      return;
    }
    if (parsedTime.rows.length === 0) {
      api.notify('error', 'Time file has no rows', 'Paste or choose a CSV with employee_no, bucket, minutes.');
      return;
    }
    const result = api.dispatch({
      type: 'time.import',
      input: { sourceName: timeSourceName, rows: parsedTime.rows },
    });
    if (result) {
      setTimeOpen(false);
      setTimeText('');
    }
  };

  const submitPay = () => {
    if (!payTarget) return;
    const result = api.dispatch({
      type: 'payroll.pay',
      input: {
        runId: payTarget.id,
        paymentDate: payForm.paymentDate,
        bankAccountId: payForm.bankAccountId || banks[0]?.id || '',
      },
    });
    if (result) setPayTarget(null);
  };

  const submitReverse = () => {
    if (!reverseTarget) return;
    const result = api.dispatch({
      type: 'payroll.reverse',
      input: {
        runId: reverseTarget.id,
        reversalDate: reverseForm.reversalDate,
        reason: reverseForm.reason,
      },
    });
    if (result) {
      setReverseTarget(null);
      setReverseForm({ reversalDate: api.clock.today, reason: '' });
    }
  };

  const submitWorksheet = () => {
    const label = requiredField(worksheetForm.label, 'worksheet label');
    if (!label.ok) {
      api.notify('error', 'Worksheet is incomplete', label.message);
      return;
    }
    const inputs: Record<string, number> = {};
    for (const field of WORKSHEET_FIELDS[worksheetForm.kind]) {
      const raw = worksheetForm.inputs[field.key] ?? '';
      if (raw.trim() === '') {
        if (field.required) {
          api.notify('error', 'Worksheet is incomplete', `${field.label} is required.`);
          return;
        }
        continue;
      }
      const parsed = moneyField(raw, field.label);
      if (!parsed.ok || parsed.value === null) {
        api.notify('error', 'Worksheet is incomplete', parsed.message);
        return;
      }
      inputs[field.key] = parsed.value;
    }
    const result = api.dispatch({
      type: 'worksheet.save',
      input: {
        kind: worksheetForm.kind,
        employeeId: worksheetForm.employeeId || null,
        label: worksheetForm.label,
        inputs,
      },
    });
    if (result) setWorksheetOpen(false);
  };

  const exportRegister = (run: PayrollRun) => {
    if (!hasDetail) {
      api.notify('error', 'Payroll detail not granted', 'A payroll-detail grant is required to export the register.');
      return;
    }
    downloadText(
      `ece-accounting-payroll-register-${run.runNo}.csv`,
      toCsv(
        run.lines.map((line) => ({
          employee: line.employeeName,
          base_pay_centavos: line.basePayCentavos,
          gross_centavos: line.grossCentavos,
          employee_sss_centavos: line.employeeSssCentavos,
          employee_philhealth_centavos: line.employeePhilhealthCentavos,
          employee_pagibig_centavos: line.employeePagibigCentavos,
          employee_tax_centavos: line.employeeTaxCentavos,
          total_deductions_centavos: line.totalDeductionsCentavos,
          net_centavos: line.netCentavos,
          employer_cost_centavos: line.employerCostCentavos,
        })),
      ),
    );
  };

  return (
    <div className="screen">
      {payrollStatus !== 'active' && (
        <div className="callout callout-warn" role="status">
          <strong>Payroll is {payrollStatus}.</strong> Payroll records stay readable for the demo,
          but importing time, calculating, or approving a run is blocked.
        </div>
      )}
      {!hasDetail && (
        <div className="callout callout-info" role="status">
          <strong>Payroll detail is not granted to this demo actor.</strong> Aggregate run totals
          and lifecycle actions remain visible; employee salaries, time rows, payslips, and
          worksheet amounts are hidden. An admin role does not imply this grant.
        </div>
      )}
      {accountingStatus !== 'active' && (
        <div className="callout callout-warn" role="status">
          <strong>Accounting is {accountingStatus}.</strong> Payroll can be calculated and approved,
          but posting and net-pay release need an active accounting product.
        </div>
      )}

      {tab === 'policy' && (
        <>
          <Panel
            title="Payroll policy version"
            subtitle="Every calculation stores the policy version and its explicit demo parameters. Nothing here is inferred from current law."
            actions={
              <button type="button" onClick={openPolicy} disabled={!canPayrollWrite || !policy}>
                Update policy
              </button>
            }
          >
            {!policy ? (
              <EmptyState title="No payroll policy is assigned to this company" />
            ) : (
              <>
                <dl className="definition-grid">
                  <div>
                    <dt>Policy version</dt>
                    <dd>{policy.version}</dd>
                  </div>
                  <div>
                    <dt>Status</dt>
                    <dd>
                      <StatusBadge status={policy.status} />
                    </dd>
                  </div>
                  <div>
                    <dt>Effective from</dt>
                    <dd>{humanDate(policy.effectiveFrom)}</dd>
                  </div>
                  <div>
                    <dt>Effective to</dt>
                    <dd>{policy.effectiveTo ? humanDate(policy.effectiveTo) : 'Open-ended'}</dd>
                  </div>
                  <div>
                    <dt>Hours per month</dt>
                    <dd>{policy.hoursPerMonth}</dd>
                  </div>
                  <div>
                    <dt>Standard minutes per day</dt>
                    <dd>{policy.standardMinutesPerDay}</dd>
                  </div>
                  <div>
                    <dt>Period working days</dt>
                    <dd>{policy.periodWorkingDays}</dd>
                  </div>
                  <div>
                    <dt>Pay frequency</dt>
                    <dd>{titleCase(policy.payFrequency)}</dd>
                  </div>
                  <div>
                    <dt>Period</dt>
                    <dd>
                      {humanDate(policy.periodStart)} – {humanDate(policy.periodEnd)}
                    </dd>
                  </div>
                  <div>
                    <dt>Pay date</dt>
                    <dd>{humanDate(policy.payDate)}</dd>
                  </div>
                  <div>
                    <dt>Approval deadline</dt>
                    <dd>{humanDate(policy.approvalDeadline)}</dd>
                  </div>
                  <div>
                    <dt>Rounding</dt>
                    <dd>{titleCase(policy.rounding)}</dd>
                  </div>
                  <div>
                    <dt>13th-month divisor</dt>
                    <dd>{policy.thirteenthMonthDivisor}</dd>
                  </div>
                </dl>
                <p className="callout callout-info">{policy.notes}</p>
                <h3>Time buckets and demo factors</h3>
                <div className="table-wrap">
                  <table className="data-table">
                    <caption>Synthetic time matrix</caption>
                    <thead>
                      <tr>
                        <th scope="col">Bucket</th>
                        <th scope="col">Label</th>
                        <th scope="col" className="numeric">
                          Day factor
                        </th>
                        <th scope="col" className="numeric">
                          OT factor
                        </th>
                        <th scope="col" className="numeric">
                          Night factor
                        </th>
                        <th scope="col">Already in base?</th>
                      </tr>
                    </thead>
                    <tbody>
                      {policy.timeMatrix.map((rule) => (
                        <tr key={rule.code}>
                          <th scope="row">{rule.code}</th>
                          <td>{rule.label}</td>
                          <td className="numeric">{rule.dayFactorBp / 10_000}</td>
                          <td className="numeric">
                            {rule.otFactorBp === null ? '—' : rule.otFactorBp / 10_000}
                          </td>
                          <td className="numeric">
                            {rule.nightFactorBp === null ? '—' : rule.nightFactorBp / 10_000}
                          </td>
                          <td>{rule.includedInBase ? 'Yes' : 'No'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <h3>Annual tax schedule (synthetic fixture)</h3>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th scope="col">Taxable up to</th>
                      <th scope="col" className="numeric">
                        Rate
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {policy.annualTaxSchedule.map((bracket, index) => (
                      <tr key={index}>
                        <td>{bracket.upToCentavos === null ? 'No ceiling' : money(bracket.upToCentavos)}</td>
                        <td className="numeric">{(bracket.rateBp / 100).toFixed(2)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <h3>Deduction schedules (synthetic fixture)</h3>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th scope="col">Schedule</th>
                      <th scope="col">Status</th>
                      <th scope="col" className="numeric">
                        Employee SSS
                      </th>
                      <th scope="col" className="numeric">
                        PhilHealth
                      </th>
                      <th scope="col" className="numeric">
                        Pag-IBIG
                      </th>
                      <th scope="col" className="numeric">
                        Tax
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {schedules.map((schedule) => (
                      <tr key={schedule.id}>
                        <th scope="row">
                          {schedule.label} · {schedule.version}
                        </th>
                        <td>
                          <StatusBadge status={schedule.status} />
                        </td>
                        <td className="numeric">{money(schedule.employeeSssCentavos)}</td>
                        <td className="numeric">{money(schedule.employeePhilhealthCentavos)}</td>
                        <td className="numeric">{money(schedule.employeePagibigCentavos)}</td>
                        <td className="numeric">{money(schedule.employeeTaxCentavos)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </Panel>
        </>
      )}

      {tab === 'employees' && (
        <Panel
          title="Employees"
          subtitle="Protected payroll detail. Salaries and schedules are visible only to a member holding the explicit payroll-detail grant."
          actions={
            <button
              type="button"
              className="primary"
              onClick={openEmployee}
              disabled={!canPayrollWrite || !hasDetail}
            >
              Add employee
            </button>
          }
        >
          {!hasDetail ? (
            <EmptyState title="Payroll detail not granted">
              Switch to a demo actor holding the payroll-detail grant (for example the payroll
              officer or company owner) to view employee salaries and payslips.
            </EmptyState>
          ) : employees.length === 0 ? (
            <EmptyState title="No employees configured" />
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <caption>Employee master</caption>
                <thead>
                  <tr>
                    <th scope="col">Employee no.</th>
                    <th scope="col">Name</th>
                    <th scope="col">Branch</th>
                    <th scope="col">Department</th>
                    <th scope="col">Hired</th>
                    <th scope="col" className="numeric">
                      Monthly salary
                    </th>
                    <th scope="col">Schedule</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {employees.map((employee) => (
                    <tr key={employee.id}>
                      <th scope="row">{employee.employeeNo}</th>
                      <td>{employee.name}</td>
                      <td>{employee.branch}</td>
                      <td>{employee.department}</td>
                      <td>{humanDate(employee.hiredOn)}</td>
                      <td className="numeric">{money(employee.monthlySalaryCentavos)}</td>
                      <td>
                        {schedules.find((schedule) => schedule.id === employee.deductionScheduleId)?.label ??
                          employee.deductionScheduleId}
                      </td>
                      <td>{titleCase(employee.status)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}

      {tab === 'time' && (
        <Panel
          title="Classified time import"
          subtitle="CSV columns: employee_no, bucket, minutes. Each employee may appear at most once per bucket; overlapping rows would double-count the same minutes."
          actions={
            <>
              <button type="button" onClick={() => downloadText('ece-accounting-time-template.csv', TIME_CSV_TEMPLATE)}>
                Download template
              </button>
              <button
                type="button"
                className="primary"
                onClick={openTime}
                disabled={!canPayrollWrite || !hasDetail}
              >
                Import time CSV
              </button>
            </>
          }
        >
          {!hasDetail ? (
            <EmptyState title="Payroll detail not granted">
              Time rows identify individual employees and are hidden without the detail grant.
            </EmptyState>
          ) : timeImports.length === 0 ? (
            <EmptyState title="No time imports yet">
              Import a synthetic CSV to feed the next payroll calculation.
            </EmptyState>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <caption>Time imports</caption>
                <thead>
                  <tr>
                    <th scope="col">Source</th>
                    <th scope="col">Imported</th>
                    <th scope="col">By</th>
                    <th scope="col" className="numeric">
                      Rows
                    </th>
                    <th scope="col" className="numeric">
                      Row errors
                    </th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {timeImports.map((item) => (
                    <tr key={item.id}>
                      <th scope="row">{item.sourceName}</th>
                      <td>{humanTimestamp(item.importedAt)}</td>
                      <td>{state.users.find((user) => user.id === item.importedBy)?.name ?? item.importedBy}</td>
                      <td className="numeric">{item.rows.length}</td>
                      <td className="numeric">{item.errors.length}</td>
                      <td>
                        {item.errors.length === 0 ? (
                          <StatusBadge status="clean" />
                        ) : (
                          <StatusBadge status="errors" />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {hasDetail &&
            timeImports.map((item) => (
              <details key={item.id} className="detail-block">
                <summary>
                  {item.sourceName} · {item.rows.length} row(s)
                </summary>
                <ul className="compact-list">
                  {item.rows.map((row, index) => (
                    <li key={`${item.id}-${index}`}>
                      {employees.find((employee) => employee.id === row.employeeId)?.name ?? row.employeeId} ·{' '}
                      {titleCase(row.bucket)} · {formatMinutes(row.minutes)}
                    </li>
                  ))}
                </ul>
              </details>
            ))}
        </Panel>
      )}

      {tab === 'runs' && (
        <Panel
          title="Payroll runs"
          subtitle="Calculate creates a run for the approved policy period. A different user approves, accounting posts the journal, and net pay is released once against a bank account."
          actions={
            <label className="inline-control">
              <span>Time import</span>
              <select
                value={selectedImport?.id ?? ''}
                onChange={(event) => setSelectedImportId(event.target.value)}
                disabled={!hasDetail}
              >
                {timeImports.length === 0 && <option value="">No imports</option>}
                {timeImports.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.sourceName} · {humanTimestamp(item.importedAt)}
                  </option>
                ))}
              </select>
            </label>
          }
        >
          <div className="button-row">
            <button
              type="button"
              className="primary"
              disabled={
                !canPayrollWrite ||
                !hasDetail ||
                !selectedImport ||
                selectedImport.errors.length > 0
              }
              onClick={() => {
                if (!selectedImport) return;
                api.dispatch({ type: 'payroll.calculate', input: { timeImportId: selectedImport.id } });
              }}
            >
              Calculate payroll
            </button>
            {selectedImport && selectedImport.errors.length > 0 && (
              <span className="muted">The selected time import contains row errors and cannot be calculated.</span>
            )}
          </div>
          {runs.length === 0 ? (
            <EmptyState title="No payroll runs yet" />
          ) : (
            <>
              <div className="table-wrap">
                <table className="data-table">
                  <caption>Payroll run lifecycle</caption>
                  <thead>
                    <tr>
                      <th scope="col">Run</th>
                      <th scope="col">Period</th>
                      <th scope="col">Pay date</th>
                      <th scope="col">Status</th>
                      <th scope="col" className="numeric">
                        Employees
                      </th>
                      <th scope="col" className="numeric">
                        Gross
                      </th>
                      <th scope="col" className="numeric">
                        Deductions
                      </th>
                      <th scope="col" className="numeric">
                        Net pay
                      </th>
                      <th scope="col" className="numeric">
                        Employer cost
                      </th>
                      <th scope="col">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map((run) => {
                      const makerConflict = run.calculatedBy === api.actorId;
                      return (
                        <tr key={run.id}>
                          <th scope="row">{run.runNo}</th>
                          <td>
                            {humanDate(run.periodStart)} – {humanDate(run.periodEnd)}
                          </td>
                          <td>{humanDate(run.payDate)}</td>
                          <td>
                            <StatusBadge status={run.status} />
                          </td>
                          <td className="numeric">{run.lines.length}</td>
                          <td className="numeric">{money(run.totals.grossCentavos)}</td>
                          <td className="numeric">{money(run.totals.employeeDeductionsCentavos)}</td>
                          <td className="numeric">{money(run.totals.netCentavos)}</td>
                          <td className="numeric">{money(run.totals.employerCostCentavos)}</td>
                          <td className="actions">
                            {run.status === 'calculated' && (
                              <button
                                type="button"
                                className="link-button"
                                disabled={!canPayrollWrite || !hasDetail || makerConflict}
                                title={makerConflict ? 'A different user must approve.' : undefined}
                                onClick={() =>
                                  api.dispatch({ type: 'payroll.approve', input: { runId: run.id } })
                                }
                              >
                                Approve
                              </button>
                            )}
                            {run.status === 'approved' && (
                              <button
                                type="button"
                                className="link-button"
                                disabled={!canPost}
                                onClick={() =>
                                  api.dispatch({ type: 'payroll.post', input: { runId: run.id } })
                                }
                              >
                                Post
                              </button>
                            )}
                            {run.status === 'posted' && (
                              <>
                                <button
                                  type="button"
                                  className="link-button"
                                  disabled={!canPost}
                                  onClick={() => {
                                    setPayTarget(run);
                                    setPayForm({
                                      paymentDate: api.clock.today,
                                      bankAccountId: banks[0]?.id ?? '',
                                    });
                                  }}
                                >
                                  Pay net
                                </button>
                                <button
                                  type="button"
                                  className="link-button"
                                  disabled={!canReverse}
                                  onClick={() => {
                                    setReverseTarget(run);
                                    setReverseForm({ reversalDate: api.clock.today, reason: '' });
                                  }}
                                >
                                  Reverse
                                </button>
                              </>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {runs.map((run) => (
                <div key={run.id} className="run-block">
                  <div className="run-head">
                    <h3>
                      {run.runNo} register{' '}
                      <StatusBadge status={run.status} />
                    </h3>
                    <div className="button-row">
                      <button type="button" onClick={() => exportRegister(run)} disabled={!hasDetail}>
                        Export register CSV
                      </button>
                      {run.journalId && <span className="muted">Posting journal {run.journalId}</span>}
                      {run.paymentJournalId && (
                        <span className="muted">Payment journal {run.paymentJournalId}</span>
                      )}
                    </div>
                  </div>
                  {!hasDetail ? (
                    <p className="muted">
                      Per-employee register hidden: payroll-detail grant required. Aggregate totals
                      remain available above.
                    </p>
                  ) : run.lines.length === 0 ? (
                    <p className="muted">No employees in this run.</p>
                  ) : (
                    <div className="table-wrap">
                      <table className="data-table">
                        <caption>{run.runNo} per-employee register</caption>
                        <thead>
                          <tr>
                            <th scope="col">Employee</th>
                            <th scope="col" className="numeric">
                              Base pay
                            </th>
                            <th scope="col" className="numeric">
                              Premiums
                            </th>
                            <th scope="col" className="numeric">
                              Gross
                            </th>
                            <th scope="col" className="numeric">
                              SSS
                            </th>
                            <th scope="col" className="numeric">
                              PhilHealth
                            </th>
                            <th scope="col" className="numeric">
                              Pag-IBIG
                            </th>
                            <th scope="col" className="numeric">
                              Tax
                            </th>
                            <th scope="col" className="numeric">
                              Net pay
                            </th>
                            <th scope="col">Payslip</th>
                          </tr>
                        </thead>
                        <tbody>
                          {run.lines.map((line) => (
                            <tr key={line.employeeId}>
                              <th scope="row">{line.employeeName}</th>
                              <td className="numeric">{money(line.basePayCentavos)}</td>
                              <td className="numeric">
                                {money(line.grossCentavos - line.basePayCentavos)}
                              </td>
                              <td className="numeric">{money(line.grossCentavos)}</td>
                              <td className="numeric">{money(line.employeeSssCentavos)}</td>
                              <td className="numeric">{money(line.employeePhilhealthCentavos)}</td>
                              <td className="numeric">{money(line.employeePagibigCentavos)}</td>
                              <td className="numeric">{money(line.employeeTaxCentavos)}</td>
                              <td className="numeric">{money(line.netCentavos)}</td>
                              <td>
                                <button
                                  type="button"
                                  className="link-button"
                                  onClick={() => setPayslip({ run, line })}
                                >
                                  View payslip
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot>
                          <tr className="total-row">
                            <th scope="row">Totals</th>
                            <td />
                            <td />
                            <td className="numeric">{money(run.totals.grossCentavos)}</td>
                            <td className="numeric">{money(run.totals.employeeSssCentavos)}</td>
                            <td className="numeric">{money(run.totals.employeePhilhealthCentavos)}</td>
                            <td className="numeric">{money(run.totals.employeePagibigCentavos)}</td>
                            <td className="numeric">{money(run.totals.employeeTaxCentavos)}</td>
                            <td className="numeric">{money(run.totals.netCentavos)}</td>
                            <td />
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  )}
                </div>
              ))}
            </>
          )}
        </Panel>
      )}

      {tab === 'worksheets' && (
        <Panel
          title="Payroll worksheets"
          subtitle="13th month, annualization, final pay, and 2316 estimates use explicit inputs and the demo policy. They do not file, remit, or issue any official form."
          actions={
            <button
              type="button"
              className="primary"
              onClick={() => {
                setWorksheetForm({ kind: '13th_month', employeeId: '', label: '', inputs: {} });
                setWorksheetOpen(true);
              }}
              disabled={!hasDetail || !payrollActive || !canPayrollWrite}
            >
              New worksheet
            </button>
          }
        >
          {!hasDetail ? (
            <EmptyState title="Payroll detail not granted">
              Worksheets contain individual pay amounts and are hidden without the detail grant.
            </EmptyState>
          ) : worksheets.length === 0 ? (
            <EmptyState title="No worksheets saved" />
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <caption>Saved worksheets</caption>
                <thead>
                  <tr>
                    <th scope="col">Label</th>
                    <th scope="col">Kind</th>
                    <th scope="col">Employee</th>
                    <th scope="col">Created</th>
                    <th scope="col">Inputs</th>
                    <th scope="col">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {worksheets.map((worksheet) => (
                    <tr key={worksheet.id}>
                      <th scope="row">{worksheet.label}</th>
                      <td>{titleCase(worksheet.kind)}</td>
                      <td>
                        {worksheet.employeeId
                          ? employees.find((employee) => employee.id === worksheet.employeeId)?.name ??
                            worksheet.employeeId
                          : <span className="muted">—</span>}
                      </td>
                      <td>{humanTimestamp(worksheet.createdAt)}</td>
                      <td className="small">
                        {Object.entries(worksheet.inputs)
                          .map(([key, value]) => `${resultLabel(key)}: ${value}`)
                          .join(' · ')}
                      </td>
                      <td className="small">
                        {Object.entries(worksheet.result)
                          .map(([key, value]) =>
                            `${resultLabel(key)}: ${
                              key.endsWith('_centavos') && typeof value === 'number'
                                ? money(value)
                                : String(value)
                            }`,
                          )
                          .join(' · ')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}

      <Modal
        open={policyOpen}
        title="Update payroll policy"
        onClose={() => setPolicyOpen(false)}
        footer={
          <>
            <button type="button" onClick={() => setPolicyOpen(false)}>
              Cancel
            </button>
            <button type="button" className="primary" onClick={submitPolicy}>
              Save policy
            </button>
          </>
        }
      >
        <p className="callout callout-info">
          The annual tax schedule and deduction fixtures stay unchanged; this edits only the
          explicit demo period and hour basis.
        </p>
        <div className="form-grid">
          <Field label="Hours per month" htmlFor="policy-hours">
            <input
              id="policy-hours"
              inputMode="numeric"
              value={policyForm.hoursPerMonth}
              onChange={(event) => setPolicyForm({ ...policyForm, hoursPerMonth: event.target.value })}
            />
          </Field>
          <Field label="Period working days" htmlFor="policy-days">
            <input
              id="policy-days"
              inputMode="numeric"
              value={policyForm.periodWorkingDays}
              onChange={(event) =>
                setPolicyForm({ ...policyForm, periodWorkingDays: event.target.value })
              }
            />
          </Field>
          <Field label="Period start" htmlFor="policy-start">
            <input
              id="policy-start"
              type="date"
              value={policyForm.periodStart}
              onChange={(event) => setPolicyForm({ ...policyForm, periodStart: event.target.value })}
            />
          </Field>
          <Field label="Period end" htmlFor="policy-end">
            <input
              id="policy-end"
              type="date"
              value={policyForm.periodEnd}
              onChange={(event) => setPolicyForm({ ...policyForm, periodEnd: event.target.value })}
            />
          </Field>
          <Field label="Pay date" htmlFor="policy-pay">
            <input
              id="policy-pay"
              type="date"
              value={policyForm.payDate}
              onChange={(event) => setPolicyForm({ ...policyForm, payDate: event.target.value })}
            />
          </Field>
          <Field label="Approval deadline" htmlFor="policy-deadline">
            <input
              id="policy-deadline"
              type="date"
              value={policyForm.approvalDeadline}
              onChange={(event) =>
                setPolicyForm({ ...policyForm, approvalDeadline: event.target.value })
              }
            />
          </Field>
        </div>
      </Modal>

      <Modal
        open={employeeOpen}
        title="Add employee"
        onClose={() => setEmployeeOpen(false)}
        footer={
          <>
            <button type="button" onClick={() => setEmployeeOpen(false)}>
              Cancel
            </button>
            <button type="button" className="primary" onClick={submitEmployee}>
              Add employee
            </button>
          </>
        }
      >
        <div className="form-grid">
          {employeePolicy.manualOverride ? (
            <Field label="Employee no. (manual override)" htmlFor="employee-no">
              <input
                id="employee-no"
                value={employeeForm.employeeNo}
                aria-invalid={employeeErrors.employeeNo ? 'true' : undefined}
                onChange={(event) => setEmployeeForm({ ...employeeForm, employeeNo: event.target.value })}
              />
              {employeeErrors.employeeNo && (
                <p className="field-message" role="alert">
                  {employeeErrors.employeeNo}
                </p>
              )}
            </Field>
          ) : (
            <p className="form-note">
              Employee number will be allocated:{' '}
              <code>{previewCodes(state, workspaceId, 'employee', 1)[0]}</code>
            </p>
          )}
          <Field label="Name" htmlFor="employee-name" error={employeeErrors.name}>
            <input
              id="employee-name"
              value={employeeForm.name}
              onChange={(event) => setEmployeeForm({ ...employeeForm, name: event.target.value })}
            />
          </Field>
          <Field label="Monthly salary (PHP)" htmlFor="employee-salary" error={employeeErrors.salary}>
            <input
              id="employee-salary"
              inputMode="decimal"
              value={employeeForm.monthlySalary}
              onChange={(event) =>
                setEmployeeForm({ ...employeeForm, monthlySalary: event.target.value })
              }
            />
          </Field>
          <Field label="Hired on" htmlFor="employee-hired" error={employeeErrors.hired}>
            <input
              id="employee-hired"
              type="date"
              value={employeeForm.hiredOn}
              onChange={(event) => setEmployeeForm({ ...employeeForm, hiredOn: event.target.value })}
            />
          </Field>
          <Field label="Deduction schedule" htmlFor="employee-schedule">
            <select
              id="employee-schedule"
              value={employeeForm.deductionScheduleId}
              onChange={(event) =>
                setEmployeeForm({ ...employeeForm, deductionScheduleId: event.target.value })
              }
            >
              <option value="">Select an approved schedule</option>
              {schedules
                .filter((schedule) => schedule.status === 'demo_approved')
                .map((schedule) => (
                  <option key={schedule.id} value={schedule.id}>
                    {schedule.label}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Branch" htmlFor="employee-branch">
            <input
              id="employee-branch"
              value={employeeForm.branch}
              onChange={(event) => setEmployeeForm({ ...employeeForm, branch: event.target.value })}
            />
          </Field>
          <Field label="Department" htmlFor="employee-department">
            <input
              id="employee-department"
              value={employeeForm.department}
              onChange={(event) =>
                setEmployeeForm({ ...employeeForm, department: event.target.value })
              }
            />
          </Field>
        </div>
        <p className="callout callout-info">
          The deduction schedule is a synthetic fixture. The mockup does not infer statutory
          contribution or tax rates.
        </p>
      </Modal>

      <Modal
        open={timeOpen}
        wide
        title="Import classified time"
        onClose={() => setTimeOpen(false)}
        footer={
          <>
            <button type="button" onClick={() => setTimeOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="primary"
              onClick={submitTime}
              disabled={parsedTime.errors.length > 0 || parsedTime.rows.length === 0}
            >
              Import {parsedTime.rows.length} row(s)
            </button>
          </>
        }
      >
        <div className="form-grid">
          <Field label="Source file name" htmlFor="time-source">
            <input
              id="time-source"
              value={timeSourceName}
              onChange={(event) => setTimeSourceName(event.target.value)}
            />
          </Field>
          <Field label="CSV file" htmlFor="time-file">
            <input
              id="time-file"
              type="file"
              accept=".csv,text/csv"
              onChange={async (event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                setTimeSourceName(file.name);
                setTimeText(await file.text());
              }}
            />
          </Field>
        </div>
        <Field label="Paste CSV" htmlFor="time-text" hint="employee_no,bucket,minutes">
          <textarea
            id="time-text"
            rows={8}
            value={timeText}
            onChange={(event) => setTimeText(event.target.value)}
            placeholder={TIME_CSV_TEMPLATE}
          />
        </Field>
        <button type="button" onClick={() => downloadText('ece-accounting-time-template.csv', TIME_CSV_TEMPLATE)}>
          Download template
        </button>
        <p className="muted">
          Known buckets: {TIME_BUCKETS.join(', ')}.
        </p>
        {parsedTime.errors.length > 0 ? (
          <div className="callout callout-error" role="alert">
            <strong>{parsedTime.errors.length} file error(s)</strong>
            <ul className="compact-list">
              {parsedTime.errors.map((error, index) => (
                <li key={index}>{error}</li>
              ))}
            </ul>
          </div>
        ) : (
          parsedTime.rows.length > 0 && (
            <p className="callout callout-ok">
              {parsedTime.rows.length} valid row(s) read. Buckets are disjoint per employee.
            </p>
          )
        )}
      </Modal>

      <Modal
        open={payTarget !== null}
        title={payTarget ? `Release net pay for ${payTarget.runNo}` : 'Release net pay'}
        onClose={() => setPayTarget(null)}
        footer={
          <>
            <button type="button" onClick={() => setPayTarget(null)}>
              Cancel
            </button>
            <button type="button" className="primary" onClick={submitPay}>
              Release net pay once
            </button>
          </>
        }
      >
        <p>
          Net pay is released once from the selected bank account after posting.{' '}
          {payTarget ? peso(payTarget.totals.netCentavos) : ''} would move to the bank ledger
          account. This is a synthetic journal, not a real payment.
        </p>
        <div className="form-grid">
          <Field label="Payment date" htmlFor="pay-date">
            <input
              id="pay-date"
              type="date"
              value={payForm.paymentDate}
              onChange={(event) => setPayForm({ ...payForm, paymentDate: event.target.value })}
            />
          </Field>
          <Field label="Bank account" htmlFor="pay-bank">
            <select
              id="pay-bank"
              value={payForm.bankAccountId || banks[0]?.id || ''}
              onChange={(event) => setPayForm({ ...payForm, bankAccountId: event.target.value })}
            >
              {banks.map((bank) => (
                <option key={bank.id} value={bank.id}>
                  {bank.name} · {bank.bankName}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </Modal>

      <Modal
        open={reverseTarget !== null}
        title={reverseTarget ? `Reverse ${reverseTarget.runNo}` : 'Reverse payroll'}
        onClose={() => setReverseTarget(null)}
        footer={
          <>
            <button type="button" onClick={() => setReverseTarget(null)}>
              Cancel
            </button>
            <button type="button" className="danger" onClick={submitReverse}>
              Post linked reversal
            </button>
          </>
        }
      >
        <p>
          Only a posted, unpaid run can be reversed. The payroll journal is reversed by a linked
          entry; the original stays visible.
        </p>
        <div className="form-grid">
          <Field label="Reversal date" htmlFor="payroll-reverse-date">
            <input
              id="payroll-reverse-date"
              type="date"
              value={reverseForm.reversalDate}
              onChange={(event) => setReverseForm({ ...reverseForm, reversalDate: event.target.value })}
            />
          </Field>
          <Field label="Reason" htmlFor="payroll-reverse-reason">
            <input
              id="payroll-reverse-reason"
              value={reverseForm.reason}
              onChange={(event) => setReverseForm({ ...reverseForm, reason: event.target.value })}
            />
          </Field>
        </div>
      </Modal>

      <Modal
        open={payslip !== null}
        wide
        title="Demo payslip · synthetic data"
        onClose={() => setPayslip(null)}
        footer={
          <>
            <button type="button" onClick={() => setPayslip(null)}>
              Close
            </button>
            <button type="button" className="primary" onClick={() => window.print()}>
              Print payslip
            </button>
          </>
        }
      >
        {payslip && (
          <article className="payslip">
            <p className="demo-stamp">LOCAL DEMO · SYNTHETIC DATA · NOT A PAYSLIP OF RECORD</p>
            <h2>ECE Accounting demo payslip</h2>
            <p>
              <strong>{payslip.line.employeeName}</strong> · {payslip.run.runNo} ·{' '}
              {humanDate(payslip.run.periodStart)} – {humanDate(payslip.run.periodEnd)} · pay date{' '}
              {humanDate(payslip.run.payDate)}
            </p>
            <table className="data-table">
              <tbody>
                <tr>
                  <th scope="row">Base pay</th>
                  <td className="numeric">{money(payslip.line.basePayCentavos)}</td>
                </tr>
                {payslip.line.buckets.map((bucket) => (
                  <tr key={bucket.code}>
                    <th scope="row">
                      {bucket.label} · {formatMinutes(bucket.minutes)}
                    </th>
                    <td className="numeric">{money(bucket.payableCentavos)}</td>
                  </tr>
                ))}
                <tr>
                  <th scope="row">Gross pay</th>
                  <td className="numeric">{money(payslip.line.grossCentavos)}</td>
                </tr>
                <tr>
                  <th scope="row">SSS</th>
                  <td className="numeric">({money(payslip.line.employeeSssCentavos)})</td>
                </tr>
                <tr>
                  <th scope="row">PhilHealth</th>
                  <td className="numeric">({money(payslip.line.employeePhilhealthCentavos)})</td>
                </tr>
                <tr>
                  <th scope="row">Pag-IBIG</th>
                  <td className="numeric">({money(payslip.line.employeePagibigCentavos)})</td>
                </tr>
                <tr>
                  <th scope="row">Withholding tax</th>
                  <td className="numeric">({money(payslip.line.employeeTaxCentavos)})</td>
                </tr>
                <tr className="total-row">
                  <th scope="row">Net pay</th>
                  <td className="numeric">{money(payslip.line.netCentavos)}</td>
                </tr>
              </tbody>
            </table>
            <p className="muted">
              Employer cost shown in the register: {money(payslip.line.employerCostCentavos)}.
              Contribution and tax values come from the synthetic deduction fixture, not current
              law.
            </p>
          </article>
        )}
      </Modal>

      <Modal
        open={worksheetOpen}
        wide
        title="New payroll worksheet"
        onClose={() => setWorksheetOpen(false)}
        footer={
          <>
            <button type="button" onClick={() => setWorksheetOpen(false)}>
              Cancel
            </button>
            <button type="button" className="primary" onClick={submitWorksheet}>
              Save worksheet
            </button>
          </>
        }
      >
        <div className="form-grid">
          <Field label="Worksheet kind" htmlFor="worksheet-kind">
            <select
              id="worksheet-kind"
              value={worksheetForm.kind}
              onChange={(event) =>
                setWorksheetForm({
                  ...worksheetForm,
                  kind: event.target.value as Worksheet['kind'],
                  inputs: {},
                })
              }
            >
              <option value="13th_month">13th month</option>
              <option value="annualization">Annualization</option>
              <option value="final_pay">Final pay</option>
              <option value="2316">2316 estimate</option>
            </select>
          </Field>
          <Field label="Employee (optional)" htmlFor="worksheet-employee">
            <select
              id="worksheet-employee"
              value={worksheetForm.employeeId}
              onChange={(event) =>
                setWorksheetForm({ ...worksheetForm, employeeId: event.target.value })
              }
            >
              <option value="">No employee</option>
              {employees.map((employee) => (
                <option key={employee.id} value={employee.id}>
                  {employee.employeeNo} · {employee.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Label" htmlFor="worksheet-label">
            <input
              id="worksheet-label"
              value={worksheetForm.label}
              onChange={(event) => setWorksheetForm({ ...worksheetForm, label: event.target.value })}
            />
          </Field>
          {WORKSHEET_FIELDS[worksheetForm.kind].map((field) => (
            <Field key={field.key} label={field.label} htmlFor={`worksheet-${field.key}`}>
              <input
                id={`worksheet-${field.key}`}
                inputMode="decimal"
                value={worksheetForm.inputs[field.key] ?? ''}
                onChange={(event) =>
                  setWorksheetForm({
                    ...worksheetForm,
                    inputs: { ...worksheetForm.inputs, [field.key]: event.target.value },
                  })
                }
              />
            </Field>
          ))}
        </div>
        <p className="callout callout-info">
          Amounts are entered in Philippine pesos. Results are estimates from explicit inputs and the
          demo policy; nothing is filed or remitted.
        </p>
      </Modal>
    </div>
  );
}
