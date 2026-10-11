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
import { ApiError, compareIsoDate, parseMinor, } from '@hi/contracts';
import { categoryId } from '../db/categories.js';
import { recordAudit } from '../http/audit.js';
import { assertEntryDate } from '../plans/window.js';
import { lockCommitment } from '../commitments/repo.js';
import { assertCategoryCompatible } from '../commitments/service.js';
import { EXPENSE_COLUMNS, lockExpenses, refundsOf } from './repo.js';
function assertAmounts(amountMinor, attributableMinor) {
    const amount = parseMinor(amountMinor);
    const attributable = parseMinor(attributableMinor);
    if (amount <= 0n) {
        throw ApiError.validation('the amount must be greater than zero', [
            { path: 'amount_minor', message: 'must be greater than zero' },
        ]);
    }
    if (attributable < 0n || attributable > amount) {
        throw ApiError.validation('the attributable amount is out of range', [
            { path: 'attributable_minor', message: 'must be between 0 and amount_minor' },
        ]);
    }
    return { amount, attributable };
}
async function resolveCommitment(tx, plan, commitmentId, catId) {
    if (!commitmentId)
        return null;
    const commitment = await lockCommitment(tx, plan.user_id, plan.id, commitmentId);
    if (commitment.status === 'cancelled') {
        throw ApiError.validation('this commitment was cancelled', [
            { path: 'commitment_id', message: 'a cancelled commitment cannot receive payments' },
        ]);
    }
    await assertCategoryCompatible(tx, commitment, catId);
    return commitment.id;
}
async function insertExpense(tx, input) {
    const { rows } = await tx.query(`INSERT INTO expenses (user_id, plan_id, category_id, commitment_id, paid_on, kind,
                           amount_minor, attributable_minor, refund_of_id, description)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING ${EXPENSE_COLUMNS}`, [
        input.plan.user_id, input.plan.id, input.categoryId, input.commitmentId, input.paidOn, input.kind,
        input.amounts.amount.toString(10), input.amounts.attributable.toString(10),
        input.refundOfId, input.description,
    ]);
    const row = rows[0];
    if (!row)
        throw new Error('expense insert returned no row');
    return row;
}
export async function createExpense(tx, plan, body, requestId) {
    assertEntryDate(plan, body.paid_on, 'paid_on');
    const amounts = assertAmounts(body.amount_minor, body.attributable_minor);
    const catId = await categoryId(tx, body.category_code);
    const commitmentId = await resolveCommitment(tx, plan, body.commitment_id, catId);
    const row = await insertExpense(tx, {
        plan, categoryId: catId, commitmentId, paidOn: body.paid_on, kind: 'payment',
        amounts, refundOfId: null, description: body.description ?? null,
    });
    await recordAudit(tx, {
        userId: plan.user_id, action: 'expense.create', entityType: 'expense', entityId: row.id, requestId,
    });
    return row;
}
function totalRefunded(refunds) {
    let amount = 0n;
    let attributable = 0n;
    for (const refund of refunds) {
        amount += BigInt(refund.amount_minor);
        attributable += BigInt(refund.attributable_minor);
    }
    return { amount, attributable, nonAttributable: amount - attributable };
}
/** All three cumulative ceilings, together. Any one alone is insufficient. */
function assertRefundLimits(original, already, next) {
    const originalAmount = BigInt(original.amount_minor);
    const originalAttributable = BigInt(original.attributable_minor);
    const originalNonAttributable = originalAmount - originalAttributable;
    if (already.amount + next.amount > originalAmount) {
        throw ApiError.validation('refunds would exceed the original payment', [
            { path: 'amount_minor', message: 'cumulative refunds must not exceed the original amount' },
        ]);
    }
    if (already.attributable + next.attributable > originalAttributable) {
        throw ApiError.validation('refunds would exceed the original attributable amount', [
            { path: 'attributable_minor', message: 'cumulative attributable refunds must not exceed the original attributable amount' },
        ]);
    }
    if (already.nonAttributable + (next.amount - next.attributable) > originalNonAttributable) {
        throw ApiError.validation('refunds would exceed the original non-attributable amount', [
            { path: 'attributable_minor', message: 'cumulative non-attributable refunds must not exceed the original non-attributable amount' },
        ]);
    }
}
export async function createRefund(tx, plan, originalId, body, requestId) {
    // The lock is what makes two simultaneous refunds safe: the second one reads
    // the first one's row only after it has committed.
    const locked = await lockExpenses(tx, plan.user_id, plan.id, [originalId]);
    const original = locked.get(originalId);
    if (!original)
        throw ApiError.notFound('expense');
    if (original.voided_at !== null) {
        throw new ApiError('state_conflict', 'this payment was voided and can no longer be refunded');
    }
    if (original.kind !== 'payment') {
        throw ApiError.validation('a refund cannot refund another refund', [
            { path: 'expense_id', message: 'refunds may only reference a payment' },
        ]);
    }
    assertEntryDate(plan, body.refunded_on, 'refunded_on');
    // Money cannot come back before it went out. assertEntryDate only checks the
    // plan window and "not in the future", so without this a refund can be dated
    // before its own payment, and every date-ordered report — including the
    // dashboard's as_of cutoff — reads a refund that has no payment behind it yet.
    if (compareIsoDate(body.refunded_on, original.paid_on) < 0) {
        throw ApiError.validation('a refund cannot be dated before the payment it refunds', [
            { path: 'refunded_on', message: `must be on or after ${original.paid_on}` },
        ]);
    }
    const amounts = assertAmounts(body.amount_minor, body.attributable_minor);
    assertRefundLimits(original, totalRefunded(await refundsOf(tx, plan.user_id, plan.id, originalId)), amounts);
    // Category and commitment are INHERITED. Letting the client choose them would
    // move money between categories through a refund.
    const row = await insertExpense(tx, {
        plan, categoryId: original.category_id, commitmentId: original.commitment_id,
        paidOn: body.refunded_on, kind: 'refund', amounts, refundOfId: original.id,
        description: body.description ?? null,
    });
    await recordAudit(tx, {
        userId: plan.user_id, action: 'expense.refund', entityType: 'expense', entityId: row.id, requestId,
    });
    return row;
}
/**
 * Atomic void-and-replace. NEVER a fake refund: a data-entry fix is not money
 * moving back to the user, and modelling it as one corrupts refund ceilings and
 * every category total (D-06).
 */
export async function correctExpense(tx, plan, expenseId, input, requestId) {
    // Lock order: the original payment first, then its refunds by id ascending.
    const originalLock = await lockExpenses(tx, plan.user_id, plan.id, [expenseId]);
    const original = originalLock.get(expenseId);
    if (!original)
        throw ApiError.notFound('expense');
    if (original.voided_at !== null) {
        throw new ApiError('state_conflict', 'this entry has already been voided');
    }
    if (original.kind !== 'payment') {
        throw ApiError.validation('only a payment can be corrected', [
            { path: 'expense_id', message: 'correct the payment instead of its refund' },
        ]);
    }
    const refunds = await refundsOf(tx, plan.user_id, plan.id, expenseId);
    if (refunds.length > 0) {
        await lockExpenses(tx, plan.user_id, plan.id, refunds.map((r) => r.id));
    }
    assertEntryDate(plan, input.replacement.paid_on, 'replacement.paid_on');
    const amounts = assertAmounts(input.replacement.amount_minor, input.replacement.attributable_minor);
    const catId = await categoryId(tx, input.replacement.category_code);
    const commitmentId = await resolveCommitment(tx, plan, input.replacement.commitment_id, catId);
    if (refunds.length > 0) {
        // The chain can only be carried if the replacement can still HOLD it.
        const names = refunds.map((r) => r.id);
        if (catId !== original.category_id) {
            throw ApiError.validation('this payment has refunds, so its category cannot be changed by a correction', [{ path: 'replacement.category_code', message: `first correct or reverse refunds ${names.join(', ')}` }]);
        }
        const totals = totalRefunded(refunds);
        const replacementAmount = amounts.amount;
        const replacementAttributable = amounts.attributable;
        const failures = [];
        if (totals.amount > replacementAmount)
            failures.push('amount_minor');
        if (totals.attributable > replacementAttributable)
            failures.push('attributable_minor');
        if (totals.nonAttributable > replacementAmount - replacementAttributable)
            failures.push('non-attributable remainder');
        if (failures.length > 0) {
            throw ApiError.validation('the replacement is too small to carry the refunds already recorded against this payment', [{
                    path: 'replacement',
                    message: `refunds ${names.join(', ')} total more than the replacement ${failures.join(', ')}; reverse them first or raise the replacement`,
                }]);
        }
    }
    const replacement = await insertExpense(tx, {
        plan, categoryId: catId, commitmentId, paidOn: input.replacement.paid_on, kind: 'payment',
        amounts, refundOfId: null, description: input.replacement.description ?? null,
    });
    // Carry the chain: each live refund is re-issued against the replacement and the
    // old one is voided and pointed at its successor. `refund_of_id` is not a
    // grantable UPDATE column, so re-issuing is the only correct way to move a refund.
    const carried = [];
    for (const refund of refunds) {
        const reissued = await insertExpense(tx, {
            plan, categoryId: catId, commitmentId,
            paidOn: refund.paid_on, kind: 'refund',
            amounts: { amount: BigInt(refund.amount_minor), attributable: BigInt(refund.attributable_minor) },
            refundOfId: replacement.id, description: refund.description,
        });
        await tx.query(`UPDATE expenses SET voided_at = now(), void_reason = $3, replaced_by_id = $4
        WHERE id = $1 AND user_id = $2 AND voided_at IS NULL`, [refund.id, plan.user_id, 'carried to a corrected payment', reissued.id]);
        carried.push(refund.id);
    }
    const { rows: voidedRows } = await tx.query(`UPDATE expenses SET voided_at = now(), void_reason = $3, replaced_by_id = $4
      WHERE id = $1 AND user_id = $2 AND voided_at IS NULL
      RETURNING ${EXPENSE_COLUMNS}`, [expenseId, plan.user_id, input.reason, replacement.id]);
    const voided = voidedRows[0];
    if (!voided)
        throw new ApiError('state_conflict', 'this entry was voided by a concurrent request');
    await recordAudit(tx, {
        userId: plan.user_id, action: 'expense.void', entityType: 'expense', entityId: expenseId, requestId,
    });
    await recordAudit(tx, {
        userId: plan.user_id, action: 'expense.correct', entityType: 'expense', entityId: replacement.id, requestId,
    });
    return { voided, replacement, carriedRefundIds: carried };
}
//# sourceMappingURL=service.js.map