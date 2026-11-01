import { describe, expect, it } from 'vitest';
import {
  annualTaxFromSchedule,
  calculateBucket,
  calculateRunLines,
  computeWorksheet,
  hourlyRateCentavos,
} from '../../src/domain/payroll';
import { accountBalance } from '../../src/domain/ledger';
import { createSeedState, WORKSPACE_A } from '../../src/fixtures/seed';
import type { PayrollPolicy, TimeBucket } from '../../src/domain/schema';
import { createHarness, debitTotal, creditTotal } from './harness';

const seed = createSeedState();
const policy = seed.payrollPolicies.find((candidate) => candidate.id === 'pol-a-payroll') as PayrollPolicy;
const ana = seed.employees.find((employee) => employee.id === 'emp-a-001')!;
const buckets = new Map<string, Map<TimeBucket, number>>([
  [
    'emp-a-001',
    new Map<TimeBucket, number>([
      ['ordinary_ot', 120],
      ['ordinary_night_ot', 60],
      ['rest_day_ot', 60],
      ['rest_day_night_ot', 60],
    ]),
  ],
]);

function rule(code: TimeBucket) {
  const found = policy.timeMatrix.find((candidate) => candidate.code === code);
  if (!found) throw new Error(`missing bucket ${code}`);
  return found;
}

describe('G08 — explicit hourly basis and per-bucket premiums', () => {
  it('derives an hourly rate of 100.00 from 20,000.00 over 200 hours', () => {
    expect(hourlyRateCentavos(2_000_000, 200)).toBe(10_000);
  });

  it('values the four disjoint OT buckets at 250 + 137.50 + 169 + 185.90', () => {
    expect(calculateBucket(10_000, 120, rule('ordinary_ot')).totalValueCentavos).toBe(25_000);
    expect(calculateBucket(10_000, 60, rule('ordinary_night_ot')).totalValueCentavos).toBe(13_750);
    expect(calculateBucket(10_000, 60, rule('rest_day_ot')).totalValueCentavos).toBe(16_900);
    expect(calculateBucket(10_000, 60, rule('rest_day_night_ot')).totalValueCentavos).toBe(18_590);
    expect(25_000 + 13_750 + 16_900 + 18_590).toBe(74_240);
  });

  it('adds only the 10% premium for an ordinary night hour already inside base', () => {
    const night = calculateBucket(10_000, 60, rule('ordinary_night'));
    expect(night.totalValueCentavos).toBe(11_000);
    expect(night.baseIncludedCentavos).toBe(10_000);
    expect(night.payableCentavos).toBe(1_000);
  });

  it('produces gross 10,742.40, deductions 1,000.00, net 9,742.40 and employer cost 11,242.40', () => {
    const result = calculateRunLines([ana], policy, buckets, seed.deductionSchedules);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const line = result.value.lines[0]!;
    expect(line.basePayCentavos).toBe(1_000_000);
    expect(line.buckets.map((bucket) => bucket.payableCentavos)).toEqual([25_000, 13_750, 16_900, 18_590]);
    expect(line.grossCentavos).toBe(1_074_240);
    expect(line.totalDeductionsCentavos).toBe(100_000);
    expect(line.netCentavos).toBe(974_240);
    expect(line.totalEmployerCentavos).toBe(50_000);
    expect(line.employerCostCentavos).toBe(1_124_240);
    expect(result.value.totals.grossCentavos).toBe(1_074_240);
    expect(result.value.totals.netCentavos).toBe(974_240);
  });
});

describe('G09 — base-inclusion subtraction without duplicate base', () => {
  it('values special+rest and regular+rest hours at 150.00 and 260.00', () => {
    const special = calculateBucket(10_000, 60, rule('special_nonworking_rest'));
    const regular = calculateBucket(10_000, 60, rule('regular_holiday_rest'));
    expect(special.totalValueCentavos).toBe(15_000);
    expect(special.baseIncludedCentavos).toBe(10_000);
    expect(special.payableCentavos).toBe(5_000);
    expect(regular.totalValueCentavos).toBe(26_000);
    expect(regular.baseIncludedCentavos).toBe(10_000);
    expect(regular.payableCentavos).toBe(16_000);
  });

  it('does not subtract base from a bucket that is not already included in salary', () => {
    const overtime = calculateBucket(10_000, 60, rule('ordinary_ot'));
    expect(overtime.totalValueCentavos).toBe(12_500);
    expect(overtime.baseIncludedCentavos).toBe(0);
    expect(overtime.payableCentavos).toBe(12_500);
  });
});

describe('G10 / G10a / G10b — explicit worksheets', () => {
  it('computes 13th month from 120,000.00 and requires the annual basic input', () => {
    const result = computeWorksheet('13th_month', { annual_basic_earned: 12_000_000 }, policy);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.thirteenth_month_centavos).toBe(1_000_000);
    expect(result.value.divisor).toBe(12);

    const missing = computeWorksheet('13th_month', {}, policy);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('VALIDATION');
  });

  it('combines current and prior-employer pay once and ignores prior withheld tax in the adjustment', () => {
    const result = computeWorksheet(
      'annualization',
      {
        current_employer_taxable: 18_000_000,
        prior_employer_taxable: 2_000_000,
        tax_withheld: 800_000,
        prior_employer_tax_withheld: 300_000,
      },
      policy,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.combined_taxable_centavos).toBe(20_000_000);
    expect(result.value.annual_tax_centavos).toBe(1_000_000);
    expect(result.value.year_end_adjustment_centavos).toBe(200_000);
    expect(result.value.prior_employer_tax_withheld_reported).toBe(300_000);
    expect(annualTaxFromSchedule(12_000_000, policy.annualTaxSchedule)).toBe(200_000);
  });

  it('computes final pay 7,300.00 less 500.00 = 6,800.00 from explicit components only', () => {
    const result = computeWorksheet(
      'final_pay',
      {
        earned_pay: 500_000,
        thirteenth_month_accrual: 200_000,
        approved_benefit: 30_000,
        permitted_deduction: 50_000,
      },
      policy,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.gross_components_centavos).toBe(730_000);
    expect(result.value.net_settlement_centavos).toBe(680_000);
    expect(result.value).not.toHaveProperty('severance');
    expect(result.value).not.toHaveProperty('advance_deduction');
  });
});

describe('payroll run lifecycle and duplicate posting', () => {
  it('calculates, requires independent approval, posts once, and releases net pay', () => {
    const h = createHarness({ actorId: 'u-payroll' });
    const timeImport = h.runOk({
      type: 'time.import',
      input: {
        sourceName: 'nov-first-half.csv',
        rows: [
          { employeeId: 'emp-a-001', bucket: 'ordinary_ot', minutes: 120 },
          { employeeId: 'emp-a-001', bucket: 'ordinary_night_ot', minutes: 60 },
          { employeeId: 'emp-a-001', bucket: 'rest_day_ot', minutes: 60 },
          { employeeId: 'emp-a-001', bucket: 'rest_day_night_ot', minutes: 60 },
        ],
      },
    });
    const calculated = h.runOk({ type: 'payroll.calculate', input: { timeImportId: timeImport.documentId } });
    const run = h.state.payrollRuns.find((candidate) => candidate.id === calculated.documentId);
    expect(run?.lines).toHaveLength(3);
    expect(run?.totals.grossCentavos).toBe(3_824_240);
    expect(run?.totals.netCentavos).toBe(3_524_240);
    expect(run?.totals.employerCostCentavos).toBe(3_974_240);

    const selfApproval = h.run({ type: 'payroll.approve', input: { runId: calculated.documentId } });
    expect(selfApproval.ok).toBe(false);
    if (!selfApproval.ok) expect(selfApproval.error.code).toBe('FORBIDDEN');

    h.runOk({ type: 'payroll.approve', input: { runId: calculated.documentId } }, { actorId: 'u-accountant' });
    const posted = h.runOk(
      { type: 'payroll.post', input: { runId: calculated.documentId } },
      { actorId: 'u-accountant' },
    );
    const journal = h.state.journals.find((candidate) => candidate.id === posted.journalIds[0]);
    expect(debitTotal(h, journal!.id)).toBe(creditTotal(h, journal!.id));
    expect(debitTotal(h, journal!.id)).toBe(3_974_240);
    expect(h.state.payrollRuns.find((candidate) => candidate.id === calculated.documentId)?.status).toBe('posted');

    const journalCount = h.state.journals.length;
    const repeatPost = h.run(
      { type: 'payroll.post', input: { runId: calculated.documentId } },
      { actorId: 'u-accountant' },
    );
    expect(repeatPost.ok).toBe(false);
    if (!repeatPost.ok) expect(repeatPost.error.code).toBe('CONFLICT');
    expect(h.state.journals.length).toBe(journalCount);

    const paid = h.runOk(
      {
        type: 'payroll.pay',
        input: { runId: calculated.documentId, paymentDate: '2026-11-20', bankAccountId: 'bank-a-1' },
      },
      { actorId: 'u-accountant' },
    );
    expect(paid.journalIds).toHaveLength(1);
    expect(accountBalance(h.state, WORKSPACE_A, 'acc-ws-a-2060', null, null).netDebitCentavos).toBe(0);
    expect(h.state.payrollRuns.find((candidate) => candidate.id === calculated.documentId)?.status).toBe('paid');

    const reversePaid = h.run(
      {
        type: 'payroll.reverse',
        input: { runId: calculated.documentId, reversalDate: '2026-11-21', reason: 'Synthetic test' },
      },
      { actorId: 'u-accountant' },
    );
    expect(reversePaid.ok).toBe(false);
  });

  it('refuses a second run for the same policy period', () => {
    const h = createHarness({ actorId: 'u-payroll' });
    const timeImport = h.runOk({
      type: 'time.import',
      input: { sourceName: 'nov.csv', rows: [{ employeeId: 'emp-a-001', bucket: 'ordinary_ot', minutes: 60 }] },
    });
    h.runOk({ type: 'payroll.calculate', input: { timeImportId: timeImport.documentId } });
    const duplicate = h.run({ type: 'payroll.calculate', input: { timeImportId: timeImport.documentId } });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.error.code).toBe('CONFLICT');
    expect(h.state.payrollRuns).toHaveLength(1);
  });
});
