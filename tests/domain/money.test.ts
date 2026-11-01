import { describe, expect, it } from 'vitest';
import {
  applyBasisPoints,
  divRoundHalfUp,
  formatCentavos,
  formatQuantity,
  mulDivRound,
  multiplyBasisPoints,
  parseMinutes,
  parseMoneyToCentavos,
  parseQuantityToMilli,
  sumCentavos,
} from '../../src/domain/shared/money';

describe('integer money primitives', () => {
  it('rounds positive halves up', () => {
    expect(mulDivRound(1, 1, 2)).toBe(1);
    expect(mulDivRound(3, 1, 2)).toBe(2);
    expect(mulDivRound(1, 1, 3)).toBe(0);
    expect(mulDivRound(2, 1, 3)).toBe(1);
    expect(mulDivRound(5, 1, 3)).toBe(2);
  });

  it('rounds negative halves away from zero (half-up magnitude)', () => {
    expect(divRoundHalfUp(-1n, 2n)).toBe(-1n);
    expect(divRoundHalfUp(-3n, 2n)).toBe(-2n);
    expect(divRoundHalfUp(-1n, 3n)).toBe(0n);
  });

  it('applies basis points with 10000 = 1.0', () => {
    expect(applyBasisPoints(100_000, 1_200)).toBe(12_000);
    expect(applyBasisPoints(10_000, 10_000)).toBe(10_000);
    expect(applyBasisPoints(1, 5_000)).toBe(1);
    expect(multiplyBasisPoints(12_500, 11_000)).toBe(13_750);
  });

  it('never uses floating point that drifts on large centavo values', () => {
    expect(mulDivRound(9_007_199_254_740, 10, 3)).toBe(
      Number((BigInt(9_007_199_254_740) * 10n * 2n + 3n) / 6n),
    );
  });

  it('sums integer centavos and rejects unsafe input', () => {
    expect(sumCentavos([100, 250, 1])).toBe(351);
    expect(() => sumCentavos([1.5])).toThrow(RangeError);
  });
});

describe('parseMoneyToCentavos', () => {
  it('parses plain decimal strings without floating-point conversion', () => {
    expect(parseMoneyToCentavos('1000')).toEqual({ ok: true, value: 100_000 });
    expect(parseMoneyToCentavos('1000.5')).toEqual({ ok: true, value: 100_050 });
    expect(parseMoneyToCentavos(' 0.01 ')).toEqual({ ok: true, value: 1 });
    expect(parseMoneyToCentavos('-12.34')).toEqual({ ok: true, value: -1234 });
  });

  it('rejects ambiguous or malformed money', () => {
    for (const text of ['', '1,000.00', '1.234', '₱100', 'abc', '-0.00', '1e3']) {
      const parsed = parseMoneyToCentavos(text);
      expect(parsed.ok, text).toBe(false);
    }
  });

  it('formats centavos with grouping and exactly two decimals', () => {
    expect(formatCentavos(100_000)).toBe('1,000.00');
    expect(formatCentavos(-1234)).toBe('-12.34');
    expect(formatCentavos(0)).toBe('0.00');
    expect(formatCentavos(1)).toBe('0.01');
  });
});

describe('quantity, minutes, and basis-point parsing', () => {
  it('parses quantities into thousandths', () => {
    expect(parseQuantityToMilli('3')).toEqual({ ok: true, value: 3000 });
    expect(parseQuantityToMilli('1.25')).toEqual({ ok: true, value: 1250 });
    expect(parseQuantityToMilli('0.001')).toEqual({ ok: true, value: 1 });
    expect(parseQuantityToMilli('1.2345').ok).toBe(false);
    expect(parseQuantityToMilli('-1').ok).toBe(false);
  });

  it('formats quantities and whole minutes', () => {
    expect(formatQuantity(1250, 'pc')).toBe('1.25 pc');
    expect(formatQuantity(1, 'pc')).toBe('0.001 pc');
    expect(formatQuantity(3000, 'pc')).toBe('3 pc');
    expect(parseMinutes('240')).toEqual({ ok: true, value: 240 });
    expect(parseMinutes('2.5').ok).toBe(false);
  });
});
