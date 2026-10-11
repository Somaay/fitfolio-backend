/**
 * When may a fact be recorded against a plan?
 *
 * One place, because the answer differs per lifecycle state and getting it wrong
 * silently corrupts every report:
 *
 *   draft      no spending and no progress at all — nothing has started
 *   active     inside [start_date, end_date) and not in the plan-local future
 *   completed  corrections and late entries, still dated inside the interval
 *   cancelled  the same, but only through closed_on, capped at the plan's last day
 */
import { type IsoDate } from '@hi/contracts';
import type { PlanRow } from './repo.js';
export declare function planToday(plan: Pick<PlanRow, 'timezone'>, now?: Date): IsoDate;
export declare function planLastDay(plan: Pick<PlanRow, 'start_date'>): IsoDate;
/** The inclusive last date on which a fact may be recorded, given the state. */
export declare function recordingCutoff(plan: PlanRow, now?: Date): IsoDate;
export declare function assertPlanAcceptsEntries(plan: PlanRow): void;
/**
 * Validates a plan-local business date for a spending or progress record.
 * `field` names the offending request field so the client can point at it.
 */
export declare function assertEntryDate(plan: PlanRow, date: IsoDate, field: string, now?: Date): void;
/** Forecasts may be dated ahead of today, but never outside the plan interval. */
export declare function assertForecastDate(plan: PlanRow, date: IsoDate, field: string): void;
//# sourceMappingURL=window.d.ts.map