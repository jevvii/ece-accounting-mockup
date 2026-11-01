import { describe, expect, it } from 'vitest';
import { calendarMonth, shiftMonth, trialBalancePeriod } from '../../src/domain/shared/reportPeriod';
import { sourceBookTrialBalance, trialBalanceCellDrilldown } from '../../src/domain/queries';
import { createBaseSeedState, WORKSPACE_A } from '../../src/fixtures/seed';

describe('easy monthly Trial Balance scope', () => {
  it('handles actual month lengths, leap years and year transitions', () => {
    expect(calendarMonth('2024-02')).toEqual({ ok: true, value: { fromDate: '2024-02-01', toDate: '2024-02-29' } });
    expect(calendarMonth('2026-02')).toEqual({ ok: true, value: { fromDate: '2026-02-01', toDate: '2026-02-28' } });
    expect(shiftMonth('2026-12', 1)).toEqual({ ok: true, value: '2027-01' });
    expect(shiftMonth('2026-01', -1)).toEqual({ ok: true, value: '2025-12' });
    expect(calendarMonth('2026-13').ok).toBe(false);
    expect(calendarMonth('').ok).toBe(false);
  });

  it('separates cumulative month-end balances from activity inside the selected month', () => {
    const base = { month: '2026-02', asOfDate: '2026-03-12', fromDate: '2026-01-15', toDate: '2026-03-12' };
    expect(trialBalancePeriod({ ...base, preset: 'month_end' })).toEqual({
      ok: true, value: { mode: 'as_of', fromDate: null, toDate: '2026-02-28' },
    });
    expect(trialBalancePeriod({ ...base, preset: 'month_activity' })).toEqual({
      ok: true, value: { mode: 'activity', fromDate: '2026-02-01', toDate: '2026-02-28' },
    });
    expect(trialBalancePeriod({ ...base, preset: 'as_of' })).toEqual({
      ok: true, value: { mode: 'as_of', fromDate: null, toDate: '2026-03-12' },
    });
    expect(trialBalancePeriod({ ...base, preset: 'activity', fromDate: '2026-04-01' }).ok).toBe(false);
  });

  it('month-end includes earlier openings and uses the same scope in drill-through', () => {
    const state = createBaseSeedState();
    const scope = trialBalancePeriod({ preset: 'month_end', month: '2026-02', asOfDate: '', fromDate: '', toDate: '' });
    expect(scope.ok).toBe(true);
    if (!scope.ok) return;
    const report = sourceBookTrialBalance(state, WORKSPACE_A, scope.value);
    expect(report.grossTotals.debitCentavos).toBe(1_000_000);
    expect(report.netBalanceTotals.debitCentavos).toBe(1_000_000);
    const bank = state.accounts.find((row) => row.workspaceId === WORKSPACE_A && row.controlRole === 'bank')!;
    expect(trialBalanceCellDrilldown(state, WORKSPACE_A, { ...scope.value, accountId: bank.id })).toHaveLength(1);
    const activity = sourceBookTrialBalance(state, WORKSPACE_A, { mode: 'activity', fromDate: '2026-02-01', toDate: '2026-02-28' });
    expect(activity.grossTotals.debitCentavos).toBe(0);
    expect(activity.totals.closingDebitCentavos).toBe(1_000_000);
    expect(activity.netBalanceTotals.debitCentavos).toBe(0);
  });
});
