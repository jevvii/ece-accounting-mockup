import type { NumberingPolicy } from '../numbering';

export function formatNumber(policy: Pick<NumberingPolicy, 'prefix' | 'minDigits'>, value: number): string {
  return `${policy.prefix}${String(value).padStart(policy.minDigits, '0')}`;
}

export function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}
