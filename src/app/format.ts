import { formatCentavos, formatMinutes, formatPeso, formatQuantity } from '../domain/shared/money';

export { formatCentavos, formatMinutes, formatPeso, formatQuantity };

export function money(centavos: number | null | undefined): string {
  return centavos === null || centavos === undefined ? '—' : formatCentavos(centavos);
}

export function peso(centavos: number | null | undefined): string {
  return centavos === null || centavos === undefined ? '—' : formatPeso(centavos);
}

export function quantity(milli: number | null | undefined, unit = 'unit'): string {
  return milli === null || milli === undefined ? '—' : formatQuantity(milli, unit);
}

export function centsInput(centavos: number | null | undefined): string {
  return centavos === null || centavos === undefined ? '' : (centavos / 100).toFixed(2);
}

export function humanDate(dateOnly: string | null | undefined): string {
  if (!dateOnly) return '—';
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOnly);
  if (!match) return dateOnly;
  const [, year, month, day] = match;
  const monthName = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ][Number(month) - 1];
  return monthName ? `${day} ${monthName} ${year}` : dateOnly;
}

export function humanTimestamp(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${humanDate(date.toISOString().slice(0, 10))} ${date.toISOString().slice(11, 16)} UTC`;
}

export function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function signedMoney(centavos: number): string {
  return centavos < 0 ? `(${formatCentavos(Math.abs(centavos))})` : formatCentavos(centavos);
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
