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

export const PLAN_LENGTH_MONTHS = 6;
export const DAYS_PER_REPORTING_WEEK = 7;
/** A weight-derived metric older than this many days is reported as stale. */
export const STALE_MEASUREMENT_DAYS = 14;

/** ISO calendar date, `YYYY-MM-DD`. Business dates are dates, not instants. */
export type IsoDate = string;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export class CalendarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalendarError';
  }
}

export function assertIsoDate(value: string): IsoDate {
  const m = ISO_DATE.exec(value);
  if (!m) throw new CalendarError(`not an ISO date: ${JSON.stringify(value)}`);
  const [, y, mo, d] = m as unknown as [string, string, string, string];
  const year = Number(y), month = Number(mo), day = Number(d);
  if (month < 1 || month > 12) throw new CalendarError(`month out of range: ${value}`);
  if (day < 1 || day > daysInMonth(year, month)) throw new CalendarError(`day out of range: ${value}`);
  return value;
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');
const fmt = (y: number, m: number, d: number) => `${pad(y, 4)}-${pad(m)}-${pad(d)}`;

export function daysInMonth(year: number, month: number): number {
  // Day 0 of the next month is the last day of this month.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parts(date: IsoDate): [number, number, number] {
  assertIsoDate(date);
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return [y, m, d];
}

/** Calendar-month addition with month-end clamping (Aug 31 + 6mo -> Feb 28/29). */
export function addCalendarMonths(date: IsoDate, months: number): IsoDate {
  const [y, m, d] = parts(date);
  const zeroBased = (m - 1) + months;
  const targetYear = y + Math.floor(zeroBased / 12);
  const targetMonth = ((zeroBased % 12) + 12) % 12 + 1;
  const clampedDay = Math.min(d, daysInMonth(targetYear, targetMonth));
  return fmt(targetYear, targetMonth, clampedDay);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const [y, m, d] = parts(date);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return fmt(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

export function differenceInDays(from: IsoDate, to: IsoDate): number {
  const [ay, am, ad] = parts(from);
  const [by, bm, bd] = parts(to);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/** Lexicographic comparison is correct for zero-padded ISO dates. */
export function compareIsoDate(a: IsoDate, b: IsoDate): number {
  assertIsoDate(a); assertIsoDate(b);
  return a < b ? -1 : a > b ? 1 : 0;
}

export const minIsoDate = (a: IsoDate, b: IsoDate): IsoDate => (compareIsoDate(a, b) <= 0 ? a : b);
export const maxIsoDate = (a: IsoDate, b: IsoDate): IsoDate => (compareIsoDate(a, b) >= 0 ? a : b);

/** Exclusive end of the plan interval. */
export function planEndDateExclusive(startDate: IsoDate): IsoDate {
  return addCalendarMonths(startDate, PLAN_LENGTH_MONTHS);
}

/** The last day actually inside the plan. */
export function planLastIncludedDay(startDate: IsoDate): IsoDate {
  return addDays(planEndDateExclusive(startDate), -1);
}

export function isWithinPlan(startDate: IsoDate, date: IsoDate): boolean {
  return compareIsoDate(date, startDate) >= 0
    && compareIsoDate(date, planEndDateExclusive(startDate)) < 0;
}

export interface ReportingWeek {
  readonly index: number;      // 1-based
  readonly startDate: IsoDate;
  readonly endDate: IsoDate;   // inclusive; the final block may be shorter than 7 days
}

/**
 * Seven-day blocks from the plan start. The final block is truncated at the plan
 * end rather than extending past it, so a partial final week stays partial.
 */
export function reportingWeeks(startDate: IsoDate): ReportingWeek[] {
  const lastDay = planLastIncludedDay(startDate);
  const weeks: ReportingWeek[] = [];
  let cursor = assertIsoDate(startDate);
  let index = 1;
  while (compareIsoDate(cursor, lastDay) <= 0) {
    const blockEnd = addDays(cursor, DAYS_PER_REPORTING_WEEK - 1);
    weeks.push({ index, startDate: cursor, endDate: minIsoDate(blockEnd, lastDay) });
    cursor = addDays(cursor, DAYS_PER_REPORTING_WEEK);
    index += 1;
  }
  return weeks;
}

/** 1-based reporting week for a plan-local date, or null if outside the plan. */
export function weekIndexForDate(startDate: IsoDate, date: IsoDate): number | null {
  if (!isWithinPlan(startDate, date)) return null;
  return Math.floor(differenceInDays(startDate, date) / DAYS_PER_REPORTING_WEEK) + 1;
}

/** Total number of reporting weeks in a plan. */
export function reportingWeekCount(startDate: IsoDate): number {
  return Math.ceil(
    (differenceInDays(startDate, planLastIncludedDay(startDate)) + 1) / DAYS_PER_REPORTING_WEEK,
  );
}

export function isValidTimeZone(zone: string): boolean {
  // Reject abbreviations and offsets: only real IANA identifiers are stable.
  if (!/^[A-Za-z]+(?:[_+-][A-Za-z0-9]+)*(?:\/[A-Za-z0-9]+(?:[_+-][A-Za-z0-9]+)*)+$/.test(zone)
      && zone !== 'UTC') {
    return false;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * Derive the local calendar date of an instant in a given IANA zone.
 *
 * This runs on the SERVER using the plan's frozen zone. Grouping history by the
 * browser's current zone would silently move entries between reporting weeks when
 * the user travels or edits their profile.
 */
export function localDateInZone(instant: Date | string, zone: string): IsoDate {
  if (!isValidTimeZone(zone)) throw new CalendarError(`invalid IANA time zone: ${zone}`);
  let formatter = zoneFormatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    });
    zoneFormatters.set(zone, formatter);
  }
  const date = typeof instant === 'string' ? new Date(instant) : instant;
  if (Number.isNaN(date.getTime())) throw new CalendarError(`invalid instant: ${String(instant)}`);
  // en-CA yields YYYY-MM-DD.
  return formatter.format(date);
}

/** "Today" in the plan's frozen zone — the cap for actual measurements and payments. */
export function todayInZone(zone: string, now: Date = new Date()): IsoDate {
  return localDateInZone(now, zone);
}
