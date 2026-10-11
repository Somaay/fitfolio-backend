/**
 * Expenses are append-only. The API role holds `SELECT, INSERT` plus a
 * COLUMN-level `UPDATE (voided_at, void_reason, replaced_by_id)` — by design, so
 * an amount, date or category can never be silently rewritten in place.
 */
import { type IsoDate } from '@hi/contracts';
import type { Tx } from '../db/pool.js';
export interface ExpenseRow {
    id: string;
    user_id: string;
    plan_id: string;
    category_id: number;
    commitment_id: string | null;
    paid_on: IsoDate;
    kind: 'payment' | 'refund';
    amount_minor: string;
    attributable_minor: string;
    refund_of_id: string | null;
    description: string | null;
    voided_at: Date | null;
    void_reason: string | null;
    replaced_by_id: string | null;
    created_at: Date;
}
export declare const EXPENSE_COLUMNS = "id, user_id, plan_id, category_id, commitment_id, paid_on, kind,\n  amount_minor, attributable_minor, refund_of_id, description, voided_at, void_reason,\n  replaced_by_id, created_at";
export declare function loadExpense(tx: Tx, userId: string, planId: string, expenseId: string): Promise<ExpenseRow>;
/**
 * Lock a set of expense rows in ONE statement, ordered by id ASCENDING.
 *
 * The consistent lock order is what keeps a refund and a correction touching the
 * same chain from deadlocking each other. `ORDER BY id` inside the sub-select is
 * what makes the order deterministic.
 */
export declare function lockExpenses(tx: Tx, userId: string, planId: string, ids: readonly string[]): Promise<Map<string, ExpenseRow>>;
export declare function refundsOf(tx: Tx, userId: string, planId: string, originalId: string): Promise<ExpenseRow[]>;
export declare function listExpenses(tx: Tx, userId: string, planId: string, limit: number, cursor: string | null, range: {
    from?: IsoDate;
    to?: IsoDate;
    includeVoided?: boolean;
}): Promise<ExpenseRow[]>;
export declare function serializeExpense(tx: Tx, row: ExpenseRow): Promise<Record<string, unknown>>;
//# sourceMappingURL=repo.d.ts.map