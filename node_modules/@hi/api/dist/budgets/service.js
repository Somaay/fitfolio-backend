/**
 * Budget revision rules.
 *
 * A revision is an IMMUTABLE, COMPLETE six-month snapshot. The cross-row sum
 * (`sum(lines) <= total_minor`) cannot be a CHECK constraint — a CHECK sees one
 * row — so it is asserted here, in bigint, under a lock on the plan row. Doing the
 * sum in JS `number` would start losing paise above 2^53.
 */
import { ApiError, compareIsoDate, isWithinPlan, parseMinor, sumMinor, } from '@hi/contracts';
import { planToday } from '../plans/window.js';
import { insertRevision, nextRevisionNumber } from './repo.js';
/** Sum in bigint and reject duplicate categories before the unique index does. */
export function validateAllocations(input) {
    const total = parseMinor(input.total_minor);
    const seen = new Set();
    const lines = input.lines.map((line, index) => {
        if (seen.has(line.category_code)) {
            throw ApiError.validation('a category appears twice in this revision', [
                { path: `lines.${index}.category_code`, message: 'each category may appear at most once' },
            ]);
        }
        seen.add(line.category_code);
        return { category_code: line.category_code, allocated_minor: parseMinor(line.allocated_minor) };
    });
    const allocated = sumMinor(lines.map((l) => l.allocated_minor));
    if (allocated > total) {
        // The remainder may be unallocated; it may never be over-allocated.
        throw ApiError.validation('category allocations exceed the budget total', [
            { path: 'lines', message: 'the sum of allocations must not exceed total_minor' },
        ]);
    }
    return { total, lines };
}
/**
 * Revision 1 takes effect on the plan start date. Every later revision takes
 * effect today or later — NEVER backdated, because backdating silently rewrites
 * the utilisation history of an already-reported period.
 */
export function resolveEffectiveOn(plan, revision, requested, now = new Date()) {
    if (revision === 1)
        return plan.start_date;
    const today = planToday(plan, now);
    const earliest = compareIsoDate(today, plan.start_date) > 0 ? today : plan.start_date;
    const effectiveOn = requested ?? earliest;
    if (compareIsoDate(effectiveOn, earliest) < 0) {
        throw ApiError.validation('a budget revision cannot be backdated', [
            { path: 'effective_on', message: `must be on or after ${earliest}` },
        ]);
    }
    if (!isWithinPlan(plan.start_date, effectiveOn)) {
        throw ApiError.validation('the effective date is outside this plan', [
            { path: 'effective_on', message: `must be before ${plan.end_date}` },
        ]);
    }
    return effectiveOn;
}
/** Caller MUST already hold `SELECT ... FOR UPDATE` on the plan row. */
export async function createRevisionLocked(tx, plan, input, now = new Date()) {
    if (plan.status === 'completed' || plan.status === 'cancelled') {
        throw new ApiError('state_conflict', 'this plan is closed; its budget can no longer be revised');
    }
    const { total, lines } = validateAllocations(input);
    const revision = await nextRevisionNumber(tx, plan.user_id, plan.id);
    const effectiveOn = resolveEffectiveOn(plan, revision, input.effective_on, now);
    return insertRevision(tx, {
        userId: plan.user_id, planId: plan.id, revision, totalMinor: total,
        effectiveOn, reason: input.reason, lines,
    });
}
//# sourceMappingURL=service.js.map