/**
 * Exact money handling.
 *
 * Invariants enforced here (see docs/decisions.md D-04):
 *  - Amounts are integer MINOR units, held as bigint. No float ever touches a value.
 *  - JSON carries them as decimal integer STRINGS, so a JS client cannot silently
 *    round a large value.
 *  - The minor-unit exponent comes from the currency. JPY has 0 decimals; assuming
 *    2 everywhere would inflate every JPY amount by 100x.
 */

export type CurrencyCode = 'INR' | 'USD' | 'EUR' | 'GBP' | 'JPY';

/** Minor-unit exponents. Mirrors the `currencies` table; the DB stays authoritative. */
const MINOR_UNIT_EXPONENTS: Readonly<Record<CurrencyCode, number>> = Object.freeze({
  INR: 2, USD: 2, EUR: 2, GBP: 2, JPY: 0,
});

export const SUPPORTED_CURRENCIES = Object.keys(MINOR_UNIT_EXPONENTS) as CurrencyCode[];

/**
 * Upper bound for any single stored amount. The column is bigint, but we cap well
 * below 2^63 so that sums of many rows cannot overflow the column either.
 * 10^15 minor units = 10 trillion INR — far beyond any real personal budget.
 */
export const MONEY_MAX_MINOR = 1_000_000_000_000_000n;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

export function isSupportedCurrency(code: string): code is CurrencyCode {
  return Object.prototype.hasOwnProperty.call(MINOR_UNIT_EXPONENTS, code);
}

export function minorUnitExponent(code: string): number {
  if (!isSupportedCurrency(code)) throw new MoneyError(`unsupported currency: ${code}`);
  return MINOR_UNIT_EXPONENTS[code];
}

/** Strict decimal-integer string (optional leading '-'), no exponent, no fraction. */
const INTEGER_STRING = /^-?(0|[1-9][0-9]*)$/;

/**
 * Parse an external minor-unit value. Accepts a decimal integer string, a bigint,
 * or a safe-integer number. Rejects anything that would lose precision.
 */
export function parseMinor(value: string | number | bigint): bigint {
  let parsed: bigint;
  if (typeof value === 'bigint') {
    parsed = value;
  } else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new MoneyError(`not a safe integer: ${value}`);
    parsed = BigInt(value);
  } else {
    if (!INTEGER_STRING.test(value)) throw new MoneyError(`not a decimal integer string: ${JSON.stringify(value)}`);
    parsed = BigInt(value);
  }
  if (parsed > MONEY_MAX_MINOR || parsed < -MONEY_MAX_MINOR) {
    throw new MoneyError(`amount out of supported range: ${parsed}`);
  }
  return parsed;
}

/** Serialize for JSON. Always a decimal integer string. */
export function serializeMinor(value: bigint): string {
  return value.toString(10);
}

export const addMinor = (a: bigint, b: bigint): bigint => a + b;
export const subMinor = (a: bigint, b: bigint): bigint => a - b;
export const sumMinor = (values: readonly bigint[]): bigint => values.reduce((acc, v) => acc + v, 0n);

/**
 * Render minor units as an exact major-unit decimal string, e.g. 1800000 INR -> "18000.00".
 * Pure string/bigint math — no division by a float.
 */
export function minorToMajorDecimal(minor: bigint, currency: string): string {
  const exp = minorUnitExponent(currency);
  if (exp === 0) return minor.toString(10);
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString(10).padStart(exp + 1, '0');
  const whole = digits.slice(0, digits.length - exp);
  const fraction = digits.slice(digits.length - exp);
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/**
 * Parse a user-entered major-unit decimal string into minor units.
 * Rejects more fraction digits than the currency supports rather than rounding
 * silently — the user should see that JPY has no paise.
 */
export function majorDecimalToMinor(input: string, currency: string): bigint {
  const exp = minorUnitExponent(currency);
  const trimmed = input.trim();
  const match = /^(-?)(\d+)(?:\.(\d*))?$/.exec(trimmed);
  if (!match) throw new MoneyError(`not a decimal amount: ${JSON.stringify(input)}`);
  const [, sign, whole, fractionRaw = ''] = match as unknown as [string, string, string, string | undefined];
  const fraction = fractionRaw ?? '';
  if (fraction.length > exp) {
    throw new MoneyError(
      exp === 0
        ? `${currency} has no fractional unit; remove the decimals`
        : `${currency} supports at most ${exp} decimal places`,
    );
  }
  const padded = fraction.padEnd(exp, '0');
  const magnitude = BigInt(`${whole}${padded}`);
  return parseMinor(sign === '-' ? -magnitude : magnitude);
}

/** Presentation boundary only. Never feed the result back into arithmetic. */
export function formatMoney(minor: bigint, currency: string, locale = 'en-IN'): string {
  const exp = minorUnitExponent(currency);
  const major = minorToMajorDecimal(minor, currency);
  const formatter = new Intl.NumberFormat(locale, {
    style: 'currency', currency,
    minimumFractionDigits: exp, maximumFractionDigits: exp,
  });
  // Number() is safe here: this value is only ever rendered, never stored or summed.
  return formatter.format(Number(major));
}
