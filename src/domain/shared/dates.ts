import { err, ok, type Result } from './result';

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidDateOnly(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return false;
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return (
    candidate.getUTCFullYear() === year &&
    candidate.getUTCMonth() === month - 1 &&
    candidate.getUTCDate() === day
  );
}

export function parseDateOnly(value: string, label = 'date'): Result<string> {
  const text = value.trim();
  if (!isValidDateOnly(text)) {
    return err('VALIDATION', `${label} must be a real calendar date in YYYY-MM-DD form`, label);
  }
  return ok(text);
}

export function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function todayInManila(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function monthKey(dateOnly: string): string {
  return dateOnly.slice(0, 7);
}

export function periodIdFor(workspaceId: string, dateOnly: string): string {
  return `${workspaceId}:${monthKey(dateOnly)}`;
}

/** Whole-day difference (later - earlier), using UTC date-only arithmetic. */
export function dayDifference(earlier: string, later: string): number {
  const a = Date.parse(`${earlier}T00:00:00Z`);
  const b = Date.parse(`${later}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) throw new Error('invalid date in dayDifference');
  return Math.round((b - a) / 86_400_000);
}

export function addDays(dateOnly: string, days: number): string {
  const timestamp = Date.parse(`${dateOnly}T00:00:00Z`);
  if (Number.isNaN(timestamp)) throw new Error('invalid date in addDays');
  return formatDateOnly(new Date(timestamp + days * 86_400_000));
}

export function isOnOrBefore(dateOnly: string, limit: string): boolean {
  return dateOnly <= limit;
}

export function isWithin(dateOnly: string, from: string, to: string): boolean {
  return dateOnly >= from && dateOnly <= to;
}

export function compareDateOnly(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function formatTimestampManila(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('en-PH', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}
