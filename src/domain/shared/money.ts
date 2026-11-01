import { err, ok, type Result } from './result';

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/**
 * Integer PHP centavos. All ledger arithmetic is integer; division is rounded
 * half-up only at a named calculation/posting boundary.
 */
export function assertSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} is outside the safe integer range`);
  }
  return value;
}

export function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new RangeError('denominator must be positive');
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  const rounded = (absolute * 2n + denominator) / (denominator * 2n);
  return negative ? -rounded : rounded;
}

/** a * b / c with half-up rounding, returning a safe integer. */
export function mulDivRound(a: number, b: number, c: number): number {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || !Number.isSafeInteger(c)) {
    throw new RangeError('mulDivRound requires safe integers');
  }
  if (c === 0) throw new RangeError('mulDivRound divisor must not be zero');
  const result = divRoundHalfUp(BigInt(a) * BigInt(b), BigInt(c));
  if (result > BigInt(MAX_SAFE) || result < BigInt(-MAX_SAFE)) {
    throw new RangeError('mulDivRound result is outside the safe integer range');
  }
  return Number(result);
}

/** Multiply by a basis-point factor (10000 = 1.00), half-up. */
export function applyBasisPoints(value: number, factorBp: number): number {
  return mulDivRound(value, Math.trunc(factorBp), 10_000);
}

/** Multiply two basis-point factors into a single factor, half-up. */
export function multiplyBasisPoints(a: number, b: number): number {
  return mulDivRound(Math.trunc(a), Math.trunc(b), 10_000);
}

export function sumCentavos(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    assertSafeInteger(value, 'money value');
    total += value;
    if (!Number.isSafeInteger(total)) throw new RangeError('money total overflow');
  }
  return total;
}

const MONEY_PATTERN = /^-?\d+(?:\.\d{1,2})?$/;

/**
 * Parse an explicit decimal money string into centavos.
 * Rejects thousands separators, empty values, signs on zero and >2 decimals.
 */
export function parseMoneyToCentavos(input: string, label = 'amount'): Result<number> {
  const text = input.trim();
  if (text.length === 0) return err('VALIDATION', `${label} is required`, label);
  if (!MONEY_PATTERN.test(text)) {
    return err(
      'VALIDATION',
      `${label} must be a plain decimal with at most 2 decimal places (for example 1000.00)`,
      label,
    );
  }
  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const [wholeText = '0', fractionText = ''] = unsigned.split('.');
  if (wholeText.length > 13) return err('VALIDATION', `${label} is too large`, label);
  const whole = Number(wholeText);
  const fraction = fractionText.padEnd(2, '0');
  const centavos = whole * 100 + Number(fraction);
  if (!Number.isSafeInteger(centavos)) return err('VALIDATION', `${label} is too large`, label);
  if (negative && centavos === 0) return err('VALIDATION', `${label} cannot be negative zero`, label);
  return ok(negative ? -centavos : centavos);
}

/** Format centavos with exactly two decimals; integer math for the split. */
export function formatCentavos(centavos: number): string {
  if (!Number.isSafeInteger(centavos)) return '—';
  const negative = centavos < 0;
  const absolute = Math.abs(centavos);
  const whole = Math.floor(absolute / 100);
  const fraction = String(absolute % 100).padStart(2, '0');
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}.${fraction}`;
}

export function formatPeso(centavos: number): string {
  return `₱${formatCentavos(centavos)}`;
}

const QUANTITY_PATTERN = /^\d+(?:\.\d{1,3})?$/;

/** Parse quantity into thousandths of the item's one base unit. */
export function parseQuantityToMilli(input: string, label = 'quantity'): Result<number> {
  const text = input.trim();
  if (text.length === 0) return err('VALIDATION', `${label} is required`, label);
  if (!QUANTITY_PATTERN.test(text)) {
    return err('VALIDATION', `${label} must be a positive number with at most 3 decimal places`, label);
  }
  const [wholeText = '0', fractionText = ''] = text.split('.');
  if (wholeText.length > 12) return err('VALIDATION', `${label} is too large`, label);
  const milli = Number(wholeText) * 1000 + Number(fractionText.padEnd(3, '0'));
  if (!Number.isSafeInteger(milli)) return err('VALIDATION', `${label} is too large`, label);
  return ok(milli);
}

export function formatQuantity(milli: number, baseUnit: string): string {
  if (!Number.isSafeInteger(milli)) return '—';
  const negative = milli < 0;
  const absolute = Math.abs(milli);
  const whole = Math.floor(absolute / 1000);
  const fraction = absolute % 1000;
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const suffix = fraction === 0 ? '' : `.${String(fraction).padStart(3, '0').replace(/0+$/, '')}`;
  return `${negative ? '-' : ''}${grouped}${suffix} ${baseUnit}`;
}

/** Parse non-negative whole minutes. */
export function parseMinutes(input: string, label = 'minutes'): Result<number> {
  const text = input.trim();
  if (!/^\d+$/.test(text)) return err('VALIDATION', `${label} must be a whole number`, label);
  const minutes = Number(text);
  if (!Number.isSafeInteger(minutes) || minutes < 0) {
    return err('VALIDATION', `${label} is out of range`, label);
  }
  return ok(minutes);
}

export function formatMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours === 0) return `${remainder}m`;
  return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
}
