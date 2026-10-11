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
export declare const SUPPORTED_CURRENCIES: CurrencyCode[];
/**
 * Upper bound for any single stored amount. The column is bigint, but we cap well
 * below 2^63 so that sums of many rows cannot overflow the column either.
 * 10^15 minor units = 10 trillion INR — far beyond any real personal budget.
 */
export declare const MONEY_MAX_MINOR = 1000000000000000n;
export declare class MoneyError extends Error {
    constructor(message: string);
}
export declare function isSupportedCurrency(code: string): code is CurrencyCode;
export declare function minorUnitExponent(code: string): number;
/**
 * Parse an external minor-unit value. Accepts a decimal integer string, a bigint,
 * or a safe-integer number. Rejects anything that would lose precision.
 */
export declare function parseMinor(value: string | number | bigint): bigint;
/** Serialize for JSON. Always a decimal integer string. */
export declare function serializeMinor(value: bigint): string;
export declare const addMinor: (a: bigint, b: bigint) => bigint;
export declare const subMinor: (a: bigint, b: bigint) => bigint;
export declare const sumMinor: (values: readonly bigint[]) => bigint;
/**
 * Render minor units as an exact major-unit decimal string, e.g. 1800000 INR -> "18000.00".
 * Pure string/bigint math — no division by a float.
 */
export declare function minorToMajorDecimal(minor: bigint, currency: string): string;
/**
 * Parse a user-entered major-unit decimal string into minor units.
 * Rejects more fraction digits than the currency supports rather than rounding
 * silently — the user should see that JPY has no paise.
 */
export declare function majorDecimalToMinor(input: string, currency: string): bigint;
/** Presentation boundary only. Never feed the result back into arithmetic. */
export declare function formatMoney(minor: bigint, currency: string, locale?: string): string;
//# sourceMappingURL=money.d.ts.map