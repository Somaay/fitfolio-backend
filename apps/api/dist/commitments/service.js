/**
 * Commitment rules.
 *
 *  - `session_model='unlimited'` means visits with NO invented session allowance.
 *    `'sessions'` requires an explicit `expected_sessions` count (D-08).
 *  - Reopening a completed commitment after a refund is an EXPLICIT, audited
 *    action that stamps `reopened_at`; a refund never silently reopens it (D-07).
 *  - Generation is idempotent through the `commitments_generation_key` unique
 *    index: re-running the same expansion creates nothing new.
 */
import { createHash } from 'node:crypto';
import { ApiError, addCalendarMonths, addDays, isWithinPlan, parseMinor, } from '@hi/contracts';
import { categoryCode, categoryId } from '../db/categories.js';
import { recordAudit } from '../http/audit.js';
import { assertFresh } from '../http/concurrency.js';
import { assertForecastDate } from '../plans/window.js';
import { COMMITMENT_COLUMNS, lockCommitment } from './repo.js';
function assertAmounts(expected, attributable) {
    const e = parseMinor(expected);
    const a = parseMinor(attributable);
    if (a > e) {
        throw ApiError.validation('the attributable amount cannot exceed the expected amount', [
            { path: 'attributable_minor', message: 'must be between 0 and expected_minor' },
        ]);
    }
    return { expected: e, attributable: a };
}
function sessionModel(expectedSessions) {
    return expectedSessions === null || expectedSessions === undefined ? 'unlimited' : 'sessions';
}
export async function createCommitment(tx, plan, body, requestId) {
    assertForecastDate(plan, body.due_on, 'due_on');
    const amounts = assertAmounts(body.expected_minor, body.attributable_minor);
    const sessions = body.expected_sessions ?? null;
    const { rows } = await tx.query(`INSERT INTO commitments (user_id, plan_id, category_id, label, due_on, expected_minor,
                              attributable_minor, session_model, expected_sessions)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING ${COMMITMENT_COLUMNS}`, [
        plan.user_id, plan.id, await categoryId(tx, body.category_code), body.label, body.due_on,
        amounts.expected.toString(10), amounts.attributable.toString(10), sessionModel(sessions), sessions,
    ]);
    const row = rows[0];
    if (!row)
        throw new Error('commitment insert returned no row');
    await recordAudit(tx, {
        userId: plan.user_id, action: 'commitment.create', entityType: 'commitment', entityId: row.id, requestId,
    });
    return row;
}
export async function updateCommitment(tx, plan, commitmentId, expectedVersion, patch, requestId) {
    const current = await lockCommitment(tx, plan.user_id, plan.id, commitmentId);
    const wantsStatus = patch.status !== undefined && patch.status !== current.status;
    const isReopen = wantsStatus && patch.status === 'pending' && current.status !== 'pending';
    const editsFields = ['label', 'due_on', 'expected_minor', 'attributable_minor', 'expected_sessions']
        .some((k) => Object.prototype.hasOwnProperty.call(patch, k));
    if (editsFields && current.status !== 'pending' && !isReopen) {
        throw new ApiError('state_conflict', `a ${current.status} commitment can only be reopened, not edited`);
    }
    if (patch.status !== undefined && patch.status === current.status) {
        throw new ApiError('state_conflict', `this commitment is already ${current.status}`);
    }
    const label = patch.label ?? current.label;
    const dueOn = (patch.due_on ?? current.due_on);
    if (patch.due_on !== undefined)
        assertForecastDate(plan, dueOn, 'due_on');
    const amounts = assertAmounts(patch.expected_minor ?? current.expected_minor, patch.attributable_minor ?? current.attributable_minor);
    const sessions = Object.prototype.hasOwnProperty.call(patch, 'expected_sessions')
        ? patch.expected_sessions ?? null
        : current.expected_sessions;
    const status = patch.status ?? current.status;
    const { rowCount, rows } = await tx.query(`UPDATE commitments
        SET label = $4, due_on = $5, expected_minor = $6, attributable_minor = $7,
            session_model = $8, expected_sessions = $9, status = $10,
            reopened_at = CASE WHEN $11::boolean THEN now() ELSE reopened_at END
      WHERE id = $1 AND user_id = $2 AND plan_id = $12 AND version = $3
      RETURNING ${COMMITMENT_COLUMNS}`, [
        commitmentId, plan.user_id, expectedVersion, label, dueOn,
        amounts.expected.toString(10), amounts.attributable.toString(10),
        sessionModel(sessions), sessions, status, isReopen, plan.id,
    ]);
    assertFresh(rowCount);
    const updated = rows[0];
    if (!updated)
        throw ApiError.stale();
    await recordAudit(tx, {
        userId: plan.user_id, action: isReopen ? 'commitment.reopen' : 'commitment.update',
        entityType: 'commitment', entityId: commitmentId, requestId,
    });
    return updated;
}
/**
 * Stable across retries AND across separate requests with the same parameters:
 * the key hashes the whole expansion definition plus the occurrence index, so
 * re-running the same generation is a genuine no-op, not a duplicate set.
 */
export function generationKey(input, index) {
    const canonical = JSON.stringify([
        input.category_code, input.label, input.amount_minor, input.attributable_minor,
        input.cadence, input.first_due_on, input.occurrences, input.expected_sessions ?? null,
    ]);
    return `${createHash('sha256').update(canonical).digest('hex').slice(0, 40)}:${index}`;
}
export function occurrenceDates(input) {
    const dates = [];
    for (let i = 0; i < input.occurrences; i += 1) {
        dates.push(input.cadence === 'monthly'
            ? addCalendarMonths(input.first_due_on, i)
            : addDays(input.first_due_on, i * 7));
    }
    return dates;
}
export async function generateCommitments(tx, plan, input, requestId) {
    assertForecastDate(plan, input.first_due_on, 'first_due_on');
    const amounts = assertAmounts(input.amount_minor, input.attributable_minor);
    const sessions = input.expected_sessions ?? null;
    const catId = await categoryId(tx, input.category_code);
    const created = [];
    let skipped = 0;
    for (const [index, dueOn] of occurrenceDates(input).entries()) {
        // Occurrences past the plan end are dropped, not clamped onto the last day:
        // clamping would invent several commitments all due on the same date.
        if (!isWithinPlan(plan.start_date, dueOn)) {
            skipped += 1;
            continue;
        }
        const { rows } = await tx.query(`INSERT INTO commitments (user_id, plan_id, category_id, label, due_on, expected_minor,
                                attributable_minor, session_model, expected_sessions, generation_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (user_id, plan_id, generation_key) WHERE generation_key IS NOT NULL DO NOTHING
       RETURNING ${COMMITMENT_COLUMNS}`, [
            plan.user_id, plan.id, catId, input.label, dueOn,
            amounts.expected.toString(10), amounts.attributable.toString(10),
            sessionModel(sessions), sessions, generationKey(input, index),
        ]);
        const row = rows[0];
        if (row)
            created.push(row);
        else
            skipped += 1;
    }
    await recordAudit(tx, {
        userId: plan.user_id, action: 'commitment.generate', entityType: 'commitment',
        entityId: created[0]?.id ?? null, requestId,
    });
    return { created, skipped };
}
/**
 * A gym commitment must not receive a trainer payment. The composite foreign key
 * binds a commitment to the same user and plan but NOT to the same category, so
 * the category check has to happen here.
 */
export async function assertCategoryCompatible(tx, commitment, paymentCategoryId, field = 'commitment_id') {
    if (commitment.category_id === paymentCategoryId)
        return;
    throw ApiError.validation('this payment does not match the commitment category', [
        { path: field, message: `the commitment is for ${await categoryCode(tx, commitment.category_id)}` },
    ]);
}
//# sourceMappingURL=service.js.map