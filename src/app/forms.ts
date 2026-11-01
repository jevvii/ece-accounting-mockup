import { parseMoneyToCentavos, parseQuantityToMilli, parseMinutes } from '../domain/shared/money';
import { parseDateOnly } from '../domain/shared/dates';

export interface ParsedField<T> {
  ok: boolean;
  value: T | null;
  message: string;
}

export function moneyField(value: string, _label = 'amount'): ParsedField<number> {
  const result = parseMoneyToCentavos(value);
  return result.ok
    ? { ok: true, value: result.value, message: '' }
    : { ok: false, value: null, message: result.error.message };
}

export function quantityField(value: string, label = 'quantity'): ParsedField<number> {
  const result = parseQuantityToMilli(value, label);
  return result.ok
    ? { ok: true, value: result.value, message: '' }
    : { ok: false, value: null, message: result.error.message };
}

export function minutesField(value: string, label = 'minutes'): ParsedField<number> {
  const result = parseMinutes(value, label);
  return result.ok
    ? { ok: true, value: result.value, message: '' }
    : { ok: false, value: null, message: result.error.message };
}

export function requiredField(value: string, label: string): ParsedField<string> {
  const trimmed = value.trim();
  return trimmed.length > 0
    ? { ok: true, value: trimmed, message: '' }
    : { ok: false, value: null, message: `${label} is required.` };
}

export function positiveIntField(value: string, label: string): ParsedField<number> {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, value: null, message: `${label} must be a whole number.` };
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return { ok: false, value: null, message: `${label} must be a positive whole number.` };
  }
  return { ok: true, value: parsed, message: '' };
}

export function dateField(value: string, label: string): ParsedField<string> {
  const result = parseDateOnly(value.trim(), label);
  return result.ok
    ? { ok: true, value: result.value, message: '' }
    : { ok: false, value: null, message: `${result.error.message} Use a real date in YYYY-MM-DD form.` };
}

/** Move focus to the first invalid control after a failed submission. */
export function focusField(id: string): void {
  window.requestAnimationFrame(() => {
    document.getElementById(id)?.focus();
  });
}
