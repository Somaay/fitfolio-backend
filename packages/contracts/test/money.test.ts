import { describe, it, expect } from 'vitest';
import {
  parseMinor, addMinor, subMinor, sumMinor, minorToMajorDecimal,
  majorDecimalToMinor, formatMoney, MONEY_MAX_MINOR, minorUnitExponent,
} from '../src/money.js';

describe('minor-unit exponents', () => {
  it('knows currencies are not all 2-decimal', () => {
    expect(minorUnitExponent('INR')).toBe(2);
    expect(minorUnitExponent('JPY')).toBe(0);
  });
  it('rejects unsupported currency', () => {
    expect(() => minorUnitExponent('XYZ')).toThrow();
  });
});

describe('parseMinor', () => {
  it('accepts decimal integer strings and bigints', () => {
    expect(parseMinor('1000000')).toBe(1000000n);
    expect(parseMinor(0)).toBe(0n);
  });
  it('rejects floats, junk, and exponent notation', () => {
    for (const bad of ['1.5', '1e3', '', ' 12', '0x10', 'NaN', '--1']) {
      expect(() => parseMinor(bad), bad).toThrow();
    }
  });
  it('rejects values beyond the safe bound', () => {
    expect(() => parseMinor((MONEY_MAX_MINOR + 1n).toString())).toThrow();
  });
  it('keeps every accepted value inside exact-integer territory', () => {
    // The cap is deliberately below 2^53, so no accepted amount can ever be
    // mangled by a float round-trip anywhere downstream.
    expect(MONEY_MAX_MINOR).toBeLessThan(BigInt(Number.MAX_SAFE_INTEGER));
    const justUnder = MONEY_MAX_MINOR - 1n;
    expect(parseMinor(justUnder.toString())).toBe(justUnder);
    // A 16-digit value is rejected by range, not silently truncated.
    expect(() => parseMinor('9007199254740993')).toThrow(/out of supported range/);
  });
});

describe('exact arithmetic', () => {
  it('adds, subtracts and sums exactly', () => {
    expect(addMinor(1n, 2n)).toBe(3n);
    expect(subMinor(1n, 5n)).toBe(-4n); // remaining budget may be negative
    expect(sumMinor([1n, 2n, 3n])).toBe(6n);
    expect(sumMinor([])).toBe(0n);
  });
});

describe('major/minor conversion', () => {
  it('converts INR (exp 2)', () => {
    expect(minorToMajorDecimal(1800000n, 'INR')).toBe('18000.00');
    expect(majorDecimalToMinor('18000', 'INR')).toBe(1800000n);
    expect(majorDecimalToMinor('18000.5', 'INR')).toBe(1800050n);
  });
  it('converts JPY (exp 0) without inventing decimals', () => {
    expect(minorToMajorDecimal(18000n, 'JPY')).toBe('18000');
    expect(majorDecimalToMinor('18000', 'JPY')).toBe(18000n);
    expect(() => majorDecimalToMinor('18000.5', 'JPY')).toThrow();
  });
  it('handles negatives and sub-unit values', () => {
    expect(minorToMajorDecimal(-50n, 'INR')).toBe('-0.50');
    expect(minorToMajorDecimal(5n, 'INR')).toBe('0.05');
  });
  it('round-trips large values exactly', () => {
    const big = 900719925474099n;
    expect(majorDecimalToMinor(minorToMajorDecimal(big, 'INR'), 'INR')).toBe(big);
  });
});

describe('formatMoney (presentation boundary)', () => {
  it('formats INR and JPY with correct fraction digits', () => {
    expect(formatMoney(1800000n, 'INR', 'en-IN')).toContain('18,000.00');
    expect(formatMoney(18000n, 'JPY', 'en-US')).not.toContain('.');
  });
});
