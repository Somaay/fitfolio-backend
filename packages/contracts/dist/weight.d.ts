/**
 * Weight storage and weekly trend.
 *
 * Weight is stored as kilograms with three decimal places, which is exactly whole
 * grams. We therefore do all arithmetic in integer grams (bigint) so that repeated
 * unit conversion or averaging can never degrade a stored measurement
 * (docs/decisions.md D-05).
 *
 * Weekly trend = mean of each day's readings, then the MEDIAN of those daily means.
 * Taking a plain mean of all readings would let five weigh-ins on one day dominate
 * the week.
 */
import { type IsoDate } from './plan-calendar.js';
export declare const WEIGHT_DECIMALS = 3;
export declare class WeightError extends Error {
    constructor(message: string);
}
/** Parse a kg decimal string into exact integer grams. */
export declare function kgToGrams(kg: string | number): bigint;
/** Render integer grams as a fixed 3-decimal kg string. */
export declare function gramsToKg(grams: bigint): string;
/** Display-only conversion. Never write the result back to storage. */
export declare function kgToLbDisplay(grams: bigint): number;
/** Convert a user-entered lb value to grams exactly once, at the input edge. */
export declare function lbToKg(lb: string | number): bigint;
export interface WeightObservation {
    readonly localDate: IsoDate;
    readonly weightKg: string;
}
/** Mean of one day's readings, in grams, rounded half-up. */
export declare function dailyMeanGrams(readings: readonly bigint[]): bigint;
/** Weekly trend for a bag of observations already filtered to one week. */
export declare function weeklyTrendGrams(entries: readonly WeightObservation[]): bigint | null;
export interface WeeklyTrendPoint {
    readonly weekIndex: number;
    readonly startDate: IsoDate;
    readonly endDate: IsoDate;
    readonly trendKg: string | null;
    readonly missing: boolean;
    /** True when the reporting week has not finished as of the cutoff. */
    readonly provisional: boolean;
    readonly observationCount: number;
    /** Change vs the immediately preceding calendar week; null if either is missing. */
    readonly changeFromPreviousKg: string | null;
}
/**
 * Build the weekly series up to (and including) the cutoff date.
 * Weeks entirely after the cutoff are not emitted at all; weeks inside the plan
 * with no readings are emitted as explicit null gaps.
 */
export declare function buildWeeklySeries(planStartDate: IsoDate, entries: readonly WeightObservation[], asOf: IsoDate): WeeklyTrendPoint[];
/** Most recent populated weekly value through the cutoff. */
export declare function latestPopulatedTrend(series: readonly WeeklyTrendPoint[]): WeeklyTrendPoint | null;
export declare const countMissingWeeks: (series: readonly WeeklyTrendPoint[]) => number;
//# sourceMappingURL=weight.d.ts.map