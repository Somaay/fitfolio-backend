/**
 * Reporting aggregates.
 *
 * D-09: EVERY fact set is aggregated in its OWN statement before anything is
 * combined. A single query joining expenses to weights to activities multiplies
 * rows — three weigh-ins on the day of one payment would count that payment three
 * times — and silently inflates both spending and attendance. There is deliberately
 * no join across those tables anywhere in this file.
 *
 * All of these run inside ONE `REPEATABLE READ` snapshot, so spending, weight and
 * attendance are read from the same instant and cannot disagree.
 */
import { compareIsoDate, minIsoDate, } from '@hi/contracts';
import { linkedNetByCommitment, outstandingMinor } from '../commitments/repo.js';
import { planLastDay, planToday } from '../plans/window.js';
/** Never past plan-local today, never past the plan's last included day. */
export function resolveAsOf(plan, requested, now = new Date()) {
    const cap = minIsoDate(planToday(plan, now), planLastDay(plan));
    if (requested === undefined)
        return cap;
    return compareIsoDate(requested, cap) > 0 ? cap : requested;
}
const scopedColumn = (scope) => (scope === 'total' ? 'amount_minor' : 'attributable_minor');
/** Non-void scoped payments minus non-void scoped refunds, through the cutoff. */
export async function netSpendMinor(tx, userId, planId, scope, asOf) {
    const { rows } = await tx.query(`SELECT coalesce(sum(CASE WHEN kind = 'payment' THEN ${scopedColumn(scope)}
                              ELSE -${scopedColumn(scope)} END), 0)::text AS net
       FROM expenses
      WHERE user_id = $1 AND plan_id = $2 AND voided_at IS NULL AND paid_on <= $3::date`, [userId, planId, asOf]);
    return BigInt(rows[0]?.net ?? '0');
}
/**
 * Spending relevant to attended sessions: the gym and trainer categories. Dividing
 * TOTAL spending by session count would price groceries per gym visit.
 */
export async function sessionScopedSpendMinor(tx, userId, planId, scope, asOf) {
    const { rows } = await tx.query(`SELECT coalesce(sum(CASE WHEN e.kind = 'payment' THEN e.${scopedColumn(scope)}
                              ELSE -e.${scopedColumn(scope)} END), 0)::text AS net
       FROM expenses e
       JOIN categories c ON c.id = e.category_id
      WHERE e.user_id = $1 AND e.plan_id = $2 AND e.voided_at IS NULL
        AND e.paid_on <= $3::date AND c.code IN ('gym', 'trainer')`, [userId, planId, asOf]);
    return BigInt(rows[0]?.net ?? '0');
}
/** Weight observations only: no join, so repeated same-day readings stay one row each. */
export async function weightObservations(tx, userId, planId, asOf) {
    const { rows } = await tx.query(`SELECT local_date, weight_kg FROM weight_entries
      WHERE user_id = $1 AND plan_id = $2 AND local_date <= $3::date
      ORDER BY local_date ASC, id ASC`, [userId, planId, asOf]);
    return rows.map((r) => ({ localDate: r.local_date, weightKg: r.weight_kg }));
}
export async function latestMeasurementDate(tx, userId, planId, asOf) {
    const { rows } = await tx.query(`SELECT max(local_date)::text AS latest FROM weight_entries
      WHERE user_id = $1 AND plan_id = $2 AND local_date <= $3::date`, [userId, planId, asOf]);
    return rows[0]?.latest ?? null;
}
export async function completedSessions(tx, userId, planId, asOf) {
    const { rows } = await tx.query(
    // Only gym and trainer attendance. sessionScopedSpendMinor sums exactly
    // those two categories, so counting home workouts here would divide PAID
    // spending by sessions nobody paid for, understating the real cost.
    `SELECT count(*)::text AS total FROM activity_entries
      WHERE user_id = $1 AND plan_id = $2 AND status = 'completed'
        AND kind IN ('gym', 'trainer') AND local_date <= $3::date`, [userId, planId, asOf]);
    return Number(rows[0]?.total ?? '0');
}
/**
 * Sum of `max(0, expected_scoped - linked net scoped payments)` over PENDING
 * commitments only. A completed or cancelled commitment contributes zero, even if
 * a refund later left money outstanding: reopening it is an explicit user action.
 */
export async function outstandingCommitmentMinor(tx, userId, planId, scope, asOf) {
    const linked = await linkedNetByCommitment(tx, userId, planId, scope, asOf);
    const { rows } = await tx.query(`SELECT id, status, expected_minor, attributable_minor FROM commitments
      WHERE user_id = $1 AND plan_id = $2 AND status = 'pending'`, [userId, planId]);
    let total = 0n;
    for (const row of rows) {
        total += outstandingMinor({ status: 'pending', expected_minor: row.expected_minor, attributable_minor: row.attributable_minor }, scope, linked.get(row.id) ?? 0n);
    }
    return total;
}
//# sourceMappingURL=aggregate.js.map