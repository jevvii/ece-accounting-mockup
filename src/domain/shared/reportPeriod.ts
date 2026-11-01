import { daysInMonth, parseDateOnly } from './dates';
import { err, ok, type Result } from './result';

export const TRIAL_BALANCE_PRESETS = [
  { id: 'month_end', label: 'Month end (includes opening balances)' },
  { id: 'month_activity', label: 'Monthly activity' },
  { id: 'as_of', label: 'Custom as of date' },
  { id: 'activity', label: 'Custom activity range' },
] as const;
export type TrialBalancePreset = (typeof TRIAL_BALANCE_PRESETS)[number]['id'];

export function calendarMonth(month: string): Result<{ fromDate: string; toDate: string }> {
  if (!/^\d{4}-\d{2}$/.test(month)) return err('VALIDATION', 'Choose a valid reporting month.');
  const first = parseDateOnly(`${month}-01`, 'Reporting month');
  if (!first.ok) return first;
  const last = daysInMonth(Number(month.slice(0, 4)), Number(month.slice(5, 7)));
  return ok({ fromDate: first.value, toDate: `${month}-${String(last).padStart(2, '0')}` });
}

export function shiftMonth(month: string, offset: number): Result<string> {
  const range = calendarMonth(month);
  if (!range.ok) return range;
  if (!Number.isInteger(offset)) return err('VALIDATION', 'Month offset must be a whole number.');
  const date = new Date(`${range.value.fromDate}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + offset);
  if (Number.isNaN(date.getTime())) return err('VALIDATION', 'Month is outside the supported calendar.');
  const value = date.toISOString().slice(0, 7);
  const valid = calendarMonth(value);
  return valid.ok ? ok(value) : valid;
}

export function trialBalancePeriod(input: {
  preset: TrialBalancePreset;
  month: string;
  asOfDate: string;
  fromDate: string;
  toDate: string;
}): Result<{ mode: 'as_of' | 'activity'; fromDate: string | null; toDate: string }> {
  if (input.preset === 'month_end' || input.preset === 'month_activity') {
    const range = calendarMonth(input.month);
    if (!range.ok) return range;
    return ok({ mode: input.preset === 'month_end' ? 'as_of' : 'activity',
      fromDate: input.preset === 'month_end' ? null : range.value.fromDate,
      toDate: range.value.toDate });
  }
  const to = parseDateOnly(input.preset === 'as_of' ? input.asOfDate : input.toDate, 'Report date');
  if (!to.ok) return to;
  if (input.preset === 'as_of') return ok({ mode: 'as_of', fromDate: null, toDate: to.value });
  const from = parseDateOnly(input.fromDate, 'Start date');
  if (!from.ok) return from;
  if (from.value > to.value) return err('VALIDATION', 'The start date must be on or before the end date.');
  return ok({ mode: 'activity', fromDate: from.value, toDate: to.value });
}
