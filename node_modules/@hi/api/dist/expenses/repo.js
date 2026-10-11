/**
 * Expenses are append-only. The API role holds `SELECT, INSERT` plus a
 * COLUMN-level `UPDATE (voided_at, void_reason, replaced_by_id)` — by design, so
 * an amount, date or category can never be silently rewritten in place.
 */
import { ApiError } from '@hi/contracts';
import { categoryCode } from '../db/categories.js';
import { decodeCursor } from '../http/cursor.js';
export const EXPENSE_COLUMNS = `id, user_id, plan_id, category_id, commitment_id, paid_on, kind,
  amount_minor, attributable_minor, refund_of_id, description, voided_at, void_reason,
  replaced_by_id, created_at`;
export async function loadExpense(tx, userId, planId, expenseId) {
    const { rows } = await tx.query(`SELECT ${EXPENSE_COLUMNS} FROM expenses WHERE id = $1 AND user_id = $2 AND plan_id = $3`, [expenseId, userId, planId]);
    const row = rows[0];
    if (!row)
        throw ApiError.notFound('expense');
    return row;
}
/**
 * Lock a set of expense rows in ONE statement, ordered by id ASCENDING.
 *
 * The consistent lock order is what keeps a refund and a correction touching the
 * same chain from deadlocking each other. `ORDER BY id` inside the sub-select is
 * what makes the order deterministic.
 */
export async function lockExpenses(tx, userId, planId, ids) {
    if (ids.length === 0)
        return new Map();
    const ordered = [...new Set(ids)].sort();
    const { rows } = await tx.query(`SELECT ${EXPENSE_COLUMNS} FROM expenses
      WHERE user_id = $1 AND plan_id = $2 AND id = ANY($3::uuid[])
      ORDER BY id ASC
      FOR UPDATE`, [userId, planId, ordered]);
    return new Map(rows.map((r) => [r.id, r]));
}
export async function refundsOf(tx, userId, planId, originalId) {
    const { rows } = await tx.query(`SELECT ${EXPENSE_COLUMNS} FROM expenses
      WHERE user_id = $1 AND plan_id = $2 AND refund_of_id = $3 AND voided_at IS NULL
      ORDER BY id ASC`, [userId, planId, originalId]);
    return rows;
}
export async function listExpenses(tx, userId, planId, limit, cursor, range) {
    const params = [userId, planId, limit];
    const where = ['user_id = $1', 'plan_id = $2'];
    if (!range.includeVoided)
        where.push('voided_at IS NULL');
    if (range.from) {
        params.push(range.from);
        where.push(`paid_on >= $${params.length}::date`);
    }
    if (range.to) {
        params.push(range.to);
        where.push(`paid_on <= $${params.length}::date`);
    }
    if (cursor) {
        const parts = decodeCursor(cursor, 2);
        params.push(parts[0], parts[1]);
        where.push(`(paid_on, id) > ($${params.length - 1}::date, $${params.length}::uuid)`);
    }
    const { rows } = await tx.query(`SELECT ${EXPENSE_COLUMNS} FROM expenses
      WHERE ${where.join(' AND ')} ORDER BY paid_on ASC, id ASC LIMIT $3`, params);
    return rows;
}
export async function serializeExpense(tx, row) {
    return {
        id: row.id,
        plan_id: row.plan_id,
        category_code: await categoryCode(tx, row.category_id),
        commitment_id: row.commitment_id,
        paid_on: row.paid_on,
        kind: row.kind,
        amount_minor: row.amount_minor,
        attributable_minor: row.attributable_minor,
        refund_of_id: row.refund_of_id,
        description: row.description,
        voided_at: row.voided_at,
        void_reason: row.void_reason,
        replaced_by_id: row.replaced_by_id,
        created_at: row.created_at,
    };
}
//# sourceMappingURL=repo.js.map