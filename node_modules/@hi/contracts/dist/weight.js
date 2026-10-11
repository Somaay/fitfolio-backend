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
import { reportingWeeks, compareIsoDate, weekIndexForDate, } from './plan-calendar.js';
export const WEIGHT_DECIMALS = 3;
const GRAMS_PER_KG = 1000n;
/**
 * Exact NIST definition: 1 lb = 0.45359237 kg = 453.59237 g.
 * Held as a rational so pound conversion is exact, not a float constant.
 */
const GRAMS_PER_LB_NUMERATOR = 45359237n;
const GRAMS_PER_LB_DENOMINATOR = 100000n;
export class WeightError extends Error {
    constructor(message) {
        super(message);
        this.name = 'WeightError';
    }
}
const KG_STRING = /^(-?)(\d+)(?:\.(\d{1,3}))?$/;
/** Parse a kg decimal string into exact integer grams. */
export function kgToGrams(kg) {
    const text = typeof kg === 'number' ? kg.toString() : kg.trim();
    const m = KG_STRING.exec(text);
    if (!m) {
        throw new WeightError(`weight must be a number with at most ${WEIGHT_DECIMALS} decimal places: ${JSON.stringify(kg)}`);
    }
    const [, sign, whole, fraction = ''] = m;
    const grams = BigInt(`${whole}${(fraction ?? '').padEnd(WEIGHT_DECIMALS, '0')}`);
    return sign === '-' ? -grams : grams;
}
/** Render integer grams as a fixed 3-decimal kg string. */
export function gramsToKg(grams) {
    const negative = grams < 0n;
    const digits = (negative ? -grams : grams).toString(10).padStart(WEIGHT_DECIMALS + 1, '0');
    const whole = digits.slice(0, digits.length - WEIGHT_DECIMALS);
    const fraction = digits.slice(digits.length - WEIGHT_DECIMALS);
    return `${negative ? '-' : ''}${whole}.${fraction}`;
}
/** Divide with half-up rounding, sign-aware. Deterministic across platforms. */
function divideRoundHalfUp(numerator, denominator) {
    if (denominator === 0n)
        throw new WeightError('division by zero');
    const negative = (numerator < 0n) !== (denominator < 0n);
    const a = numerator < 0n ? -numerator : numerator;
    const b = denominator < 0n ? -denominator : denominator;
    const quotient = a / b;
    const remainder = a % b;
    const rounded = remainder * 2n >= b ? quotient + 1n : quotient;
    return negative ? -rounded : rounded;
}
/** Display-only conversion. Never write the result back to storage. */
export function kgToLbDisplay(grams) {
    return (Number(grams) * Number(GRAMS_PER_LB_DENOMINATOR)) / Number(GRAMS_PER_LB_NUMERATOR);
}
/** Convert a user-entered lb value to grams exactly once, at the input edge. */
export function lbToKg(lb) {
    const text = typeof lb === 'number' ? lb.toString() : lb.trim();
    const m = /^(-?)(\d+)(?:\.(\d{1,6}))?$/.exec(text);
    if (!m)
        throw new WeightError(`not a valid pound value: ${JSON.stringify(lb)}`);
    const [, sign, whole, fraction = ''] = m;
    const scale = 1000000n;
    const micro = BigInt(`${whole}${(fraction ?? '').padEnd(6, '0')}`);
    // micro is lb scaled by 1e6; GRAMS_PER_LB_* already yields grams, so no extra kg factor.
    const grams = divideRoundHalfUp(micro * GRAMS_PER_LB_NUMERATOR, GRAMS_PER_LB_DENOMINATOR * scale);
    return sign === '-' ? -grams : grams;
}
/** Mean of one day's readings, in grams, rounded half-up. */
export function dailyMeanGrams(readings) {
    if (readings.length === 0)
        throw new WeightError('no readings');
    const total = readings.reduce((acc, g) => acc + g, 0n);
    return divideRoundHalfUp(total, BigInt(readings.length));
}
/** Median of a sorted-able set of grams; even counts average the two middles. */
function medianGrams(values) {
    const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const n = sorted.length;
    const mid = Math.floor(n / 2);
    if (n % 2 === 1)
        return sorted[mid];
    return divideRoundHalfUp(sorted[mid - 1] + sorted[mid], 2n);
}
/** Weekly trend for a bag of observations already filtered to one week. */
export function weeklyTrendGrams(entries) {
    if (entries.length === 0)
        return null;
    const byDay = new Map();
    for (const entry of entries) {
        const bucket = byDay.get(entry.localDate);
        const grams = kgToGrams(entry.weightKg);
        if (bucket)
            bucket.push(grams);
        else
            byDay.set(entry.localDate, [grams]);
    }
    const dailyMeans = [...byDay.values()].map(dailyMeanGrams);
    return medianGrams(dailyMeans);
}
/**
 * Build the weekly series up to (and including) the cutoff date.
 * Weeks entirely after the cutoff are not emitted at all; weeks inside the plan
 * with no readings are emitted as explicit null gaps.
 */
export function buildWeeklySeries(planStartDate, entries, asOf) {
    const weeks = reportingWeeks(planStartDate);
    const grouped = new Map();
    for (const entry of entries) {
        if (compareIsoDate(entry.localDate, asOf) > 0)
            continue; // respect the cutoff
        const index = weekIndexForDate(planStartDate, entry.localDate);
        if (index === null)
            continue; // outside the plan
        const bucket = grouped.get(index);
        if (bucket)
            bucket.push(entry);
        else
            grouped.set(index, [entry]);
    }
    const points = [];
    let previousTrend = null;
    for (const week of weeks) {
        if (compareIsoDate(week.startDate, asOf) > 0)
            break; // week lies entirely ahead
        const weekEntries = grouped.get(week.index) ?? [];
        const trend = weeklyTrendGrams(weekEntries);
        const provisional = compareIsoDate(week.endDate, asOf) > 0;
        points.push({
            weekIndex: week.index,
            startDate: week.startDate,
            endDate: week.endDate,
            trendKg: trend === null ? null : gramsToKg(trend),
            missing: trend === null,
            provisional,
            observationCount: weekEntries.length,
            changeFromPreviousKg: trend !== null && previousTrend !== null ? gramsToKg(trend - previousTrend) : null,
        });
        previousTrend = trend;
    }
    return points;
}
/** Most recent populated weekly value through the cutoff. */
export function latestPopulatedTrend(series) {
    for (let i = series.length - 1; i >= 0; i--) {
        if (series[i].trendKg !== null)
            return series[i];
    }
    return null;
}
export const countMissingWeeks = (series) => series.filter((p) => p.missing).length;
//# sourceMappingURL=weight.js.map