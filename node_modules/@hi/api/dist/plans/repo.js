/** Plan row access. Every lookup is scoped to the session user; RLS is the backstop. */
import { ApiError } from '@hi/contracts';
import { decodeCursor } from '../http/cursor.js';
const PLAN_COLUMNS = `id, user_id, name, status, start_date, end_date, timezone, currency_code,
  budget_scope, baseline_weight_kg, target_weight_kg, daily_protein_target_g, daily_calorie_target,
  activated_at, closed_at, closed_on, version, created_at, updated_at`;
/** Not owned and not existing are the SAME answer: 404. Anything else leaks existence. */
export async function loadPlan(tx, userId, planId) {
    const { rows } = await tx.query(`SELECT ${PLAN_COLUMNS} FROM plans WHERE id = $1 AND user_id = $2`, [planId, userId]);
    const plan = rows[0];
    if (!plan)
        throw ApiError.notFound('plan');
    return plan;
}
/**
 * Serialises every cross-row plan invariant (activation, budget revisions,
 * lifecycle changes) against concurrent writers.
 */
export async function lockPlan(tx, userId, planId) {
    const { rows } = await tx.query(`SELECT ${PLAN_COLUMNS} FROM plans WHERE id = $1 AND user_id = $2 FOR UPDATE`, [planId, userId]);
    const plan = rows[0];
    if (!plan)
        throw ApiError.notFound('plan');
    return plan;
}
export async function listPlans(tx, userId, limit, cursor) {
    if (cursor === null) {
        const { rows } = await tx.query(`SELECT ${PLAN_COLUMNS} FROM plans WHERE user_id = $1
        ORDER BY created_at DESC, id DESC LIMIT $2`, [userId, limit]);
        return rows;
    }
    const parts = decodeCursor(cursor, 2);
    const { rows } = await tx.query(`SELECT ${PLAN_COLUMNS} FROM plans
      WHERE user_id = $1 AND (created_at, id) < ($2::timestamptz, $3::uuid)
      ORDER BY created_at DESC, id DESC LIMIT $4`, [userId, parts[0], parts[1], limit]);
    return rows;
}
export async function activePlanId(tx, userId) {
    const { rows } = await tx.query(`SELECT id FROM plans WHERE user_id = $1 AND status = 'active' LIMIT 1`, [userId]);
    return rows[0]?.id ?? null;
}
//# sourceMappingURL=repo.js.map