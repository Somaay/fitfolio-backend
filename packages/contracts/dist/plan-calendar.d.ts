/**
 * Plan calendar arithmetic.
 *
 * A plan spans [start_date, end_date) where end_date is six CALENDAR months after
 * the start (see docs/decisions.md D-02). It is never 180 days or 26 weeks: those
 * approximations drift by days and put month-end and leap-year starts in the wrong
 * month. This mirrors PostgreSQL's `(start_date + interval '6 months')::date`,
 * including its month-end clamping, so the CHECK constraint and the application
 * can never disagree.
 */
export declare const PLAN_LENGTH_MONTHS = 6;
export declare const DAYS_PER_REPORTING_WEEK = 7;
/** A weight-derived metric older than this many days is reported as stale. */
export declare const STALE_MEASUREMENT_DAYS = 14;
/** ISO calendar date, `YYYY-MM-DD`. Business dates are dates, not instants. */
export type IsoDate = string;
export declare class CalendarError extends Error {
    constructor(message: string);
}
export declare function assertIsoDate(value: string): IsoDate;
export declare function daysInMonth(year: number, month: number): number;
/** Calendar-month addition with month-end clamping (Aug 31 + 6mo -> Feb 28/29). */
export declare function addCalendarMonths(date: IsoDate, months: number): IsoDate;
export declare function addDays(date: IsoDate, days: number): IsoDate;
export declare function differenceInDays(from: IsoDate, to: IsoDate): number;
/** Lexicographic comparison is correct for zero-padded ISO dates. */
export declare function compareIsoDate(a: IsoDate, b: IsoDate): number;
export declare const minIsoDate: (a: IsoDate, b: IsoDate) => IsoDate;
export declare const maxIsoDate: (a: IsoDate, b: IsoDate) => IsoDate;
/** Exclusive end of the plan interval. */
export declare function planEndDateExclusive(startDate: IsoDate): IsoDate;
/** The last day actually inside the plan. */
export declare function planLastIncludedDay(startDate: IsoDate): IsoDate;
export declare function isWithinPlan(startDate: IsoDate, date: IsoDate): boolean;
export interface ReportingWeek {
    readonly index: number;
    readonly startDate: IsoDate;
    readonly endDate: IsoDate;
}
/**
 * Seven-day blocks from the plan start. The final block is truncated at the plan
 * end rather than extending past it, so a partial final week stays partial.
 */
export declare function reportingWeeks(startDate: IsoDate): ReportingWeek[];
/** 1-based reporting week for a plan-local date, or null if outside the plan. */
export declare function weekIndexForDate(startDate: IsoDate, date: IsoDate): number | null;
/** Total number of reporting weeks in a plan. */
export declare function reportingWeekCount(startDate: IsoDate): number;
export declare function isValidTimeZone(zone: string): boolean;
/**
 * Derive the local calendar date of an instant in a given IANA zone.
 *
 * This runs on the SERVER using the plan's frozen zone. Grouping history by the
 * browser's current zone would silently move entries between reporting weeks when
 * the user travels or edits their profile.
 */
export declare function localDateInZone(instant: Date | string, zone: string): IsoDate;
/** "Today" in the plan's frozen zone — the cap for actual measurements and payments. */
export declare function todayInZone(zone: string, now?: Date): IsoDate;
//# sourceMappingURL=plan-calendar.d.ts.map