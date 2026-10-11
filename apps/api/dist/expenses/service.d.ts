/**
 * Spending rules.
 *
 * Three invariants here cannot be expressed as constraints, because each spans
 * several rows, and all three are enforced under a row lock on the ORIGINAL
 * payment:
 *
 *   1. cumulative refunds never exceed the original FULL amount
 *   2. cumulative refunds never exceed the original ATTRIBUTABLE amount
 *   3. cumulative refunds never exceed the original NON-ATTRIBUTABLE remainder
 *
 * Checking only (1) and (2) lets two partial refunds combine into a negative
 * non-attributable balance, which quietly corrupts every `incremental` report.
 *
 * Lock order is ALWAYS the original payment first, then its refunds by id
 * ascending. Refund chains are disjoint, so that single rule removes the cycle.
 */
import { type CreateExpenseBody } from '@hi/contracts';
import type { Tx } from '../db/pool.js';
import type { PlanRow } from '../plans/repo.js';
import { type ExpenseRow } from './repo.js';
export declare function createExpense(tx: Tx, plan: PlanRow, body: CreateExpenseBody, requestId: string): Promise<ExpenseRow>;
export interface RefundInput {
    refunded_on: string;
    amount_minor: string;
    attributable_minor: string;
    description?: string | null | undefined;
}
export declare function createRefund(tx: Tx, plan: PlanRow, originalId: string, body: RefundInput, requestId: string): Promise<ExpenseRow>;
export interface CorrectionResult {
    readonly voided: ExpenseRow;
    readonly replacement: ExpenseRow;
    readonly carriedRefundIds: readonly string[];
}
/**
 * Atomic void-and-replace. NEVER a fake refund: a data-entry fix is not money
 * moving back to the user, and modelling it as one corrupts refund ceilings and
 * every category total (D-06).
 */
export declare function correctExpense(tx: Tx, plan: PlanRow, expenseId: string, input: {
    reason: string;
    replacement: CreateExpenseBody;
}, requestId: string): Promise<CorrectionResult>;
//# sourceMappingURL=service.d.ts.map