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
import { ApiError, compareIsoDate, isWithinPlan, minIsoDate, planLastIncludedDay, todayInZone, } from '@hi/contracts';
export function planToday(plan, now = new Date()) {
    return todayInZone(plan.timezone, now);
}
export function planLastDay(plan) {
    return planLastIncludedDay(plan.start_date);
}
/** The inclusive last date on which a fact may be recorded, given the state. */
export function recordingCutoff(plan, now = new Date()) {
    const cutoff = minIsoDate(planToday(plan, now), planLastDay(plan));
    if (plan.status === 'cancelled' && plan.closed_on !== null) {
        return minIsoDate(cutoff, plan.closed_on);
    }
    return cutoff;
}
export function assertPlanAcceptsEntries(plan) {
    if (plan.status === 'draft') {
        throw new ApiError('state_conflict', 'this plan is still a draft; activate it before recording spending or progress');
    }
}
/**
 * Validates a plan-local business date for a spending or progress record.
 * `field` names the offending request field so the client can point at it.
 */
export function assertEntryDate(plan, date, field, now = new Date()) {
    assertPlanAcceptsEntries(plan);
    if (!isWithinPlan(plan.start_date, date)) {
        throw ApiError.validation('the date is outside this plan', [
            { path: field, message: `must be on or after ${plan.start_date} and before ${plan.end_date}` },
        ]);
    }
    const today = planToday(plan, now);
    if (compareIsoDate(date, today) > 0) {
        throw ApiError.validation('the date is in the future', [
            { path: field, message: `must not be after ${today} in ${plan.timezone}` },
        ]);
    }
    if (plan.status === 'cancelled' && plan.closed_on !== null) {
        const cutoff = minIsoDate(plan.closed_on, planLastDay(plan));
        if (compareIsoDate(date, cutoff) > 0) {
            throw ApiError.validation('this plan was cancelled before that date', [
                { path: field, message: `must not be after ${cutoff}` },
            ]);
        }
    }
}
/** Forecasts may be dated ahead of today, but never outside the plan interval. */
export function assertForecastDate(plan, date, field) {
    if (plan.status === 'completed' || plan.status === 'cancelled') {
        throw new ApiError('state_conflict', 'this plan is closed; no new forecasts can be scheduled');
    }
    if (!isWithinPlan(plan.start_date, date)) {
        throw ApiError.validation('the due date is outside this plan', [
            { path: field, message: `must be on or after ${plan.start_date} and before ${plan.end_date}` },
        ]);
    }
}
//# sourceMappingURL=window.js.map