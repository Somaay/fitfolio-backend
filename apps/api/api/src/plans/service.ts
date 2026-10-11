/**
 * Plan lifecycle.
 *
 * `draft -> active -> completed`, or `draft|active -> cancelled`. Every transition
 * takes `SELECT ... FOR UPDATE` on the plan row first, so two concurrent callers
 * cannot both read `draft` and both write `active`. The partial unique index
 * `one_active_plan_per_user` is the LAST line of defence, not the first: a unique
 * violation from it is a 409, never a 500.
 */
import {
  ApiError, compareIsoDate, kgToGrams, planEndDateExclusive, type IsoDate,
} from '@hi/contracts';
import type { CreatePlanBody } from '@hi/contracts';
import type { Tx } from '../db/pool.js';
import { createRevisionLocked } from '../budgets/service.js';
import { recordAudit } from '../http/audit.js';
import { assertFresh } from '../http/concurrency.js';
import { loadPlan, lockPlan, type PlanRow } from './repo.js';
import { planToday } from './window.js';

export async function createPlan(
  tx: Tx, userId: string, body: CreatePlanBody, requestId: string,
): Promise<PlanRow> {
  assertWeightTargets(body.baseline_weight_kg, body.target_weight_kg);

  // The client NEVER sends end_date. It is derived from the shared calendar rule
  // so the application and the `six_calendar_months` CHECK cannot disagree.
  const endDate: IsoDate = planEndDateExclusive(body.start_date);

  const { rows } = await tx.query<PlanRow>(
    `INSERT INTO plans (user_id, name, start_date, end_date, timezone, currency_code, budget_scope,
                        baseline_weight_kg, target_weight_kg, daily_calorie_target, daily_protein_target_g)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING id, user_id, name, status, start_date, end_date, timezone, currency_code, budget_scope,
               baseline_weight_kg, target_weight_kg, daily_protein_target_g, daily_calorie_target,
               activated_at, closed_at, closed_on, version, created_at, updated_at`,
    [
      userId, body.name, body.start_date, endDate, body.timezone, body.currency_code, body.budget_scope,
      body.baseline_weight_kg, body.target_weight_kg,
      body.daily_calorie_target ?? null, body.daily_protein_target_g ?? null,
    ],
  );
  const plan = rows[0];
  if (!plan) throw new Error('plan insert returned no row');

  // Draft plus revision 1, atomically: a plan without a budget cannot be activated,
  // so creating one without a budget would strand the user.
  await createRevisionLocked(tx, plan, {
    total_minor: body.budget.total_minor,
    reason: body.budget.reason,
    lines: body.budget.lines,
  });

  await recordAudit(tx, { userId, action: 'plan.create', entityType: 'plan', entityId: plan.id, requestId });
  return plan;
}

function assertWeightTargets(baseline: string, target: string): void {
  const baselineGrams = kgToGrams(baseline);
  const targetGrams = kgToGrams(target);
  if (targetGrams <= 0n) {
    throw ApiError.validation('the target weight must be greater than zero', [
      { path: 'target_weight_kg', message: 'must be greater than zero' },
    ]);
  }
  if (baselineGrams <= targetGrams) {
    throw ApiError.validation('the target weight must be below the starting weight', [
      { path: 'target_weight_kg', message: 'must be below baseline_weight_kg' },
    ]);
  }
}

const DRAFT_EDITABLE = [
  'name', 'start_date', 'timezone', 'currency_code', 'budget_scope',
  'baseline_weight_kg', 'target_weight_kg', 'daily_calorie_target', 'daily_protein_target_g',
] as const;

export async function updateDraftPlan(
  tx: Tx, userId: string, planId: string, expectedVersion: number,
  patch: Record<string, unknown>, requestId: string,
): Promise<PlanRow> {
  const plan = await lockPlan(tx, userId, planId);
  if (plan.status !== 'draft') {
    // Dates, currency, scope, baseline and target are FROZEN at activation.
    throw new ApiError('state_conflict', 'only a draft plan can be edited; this plan is ' + plan.status);
  }

  const next = { ...plan } as Record<string, unknown>;
  for (const field of DRAFT_EDITABLE) {
    if (Object.prototype.hasOwnProperty.call(patch, field)) next[field] = patch[field];
  }
  assertWeightTargets(String(next.baseline_weight_kg), String(next.target_weight_kg));
  const startDate = String(next.start_date) as IsoDate;
  const endDate = planEndDateExclusive(startDate);

  const { rowCount, rows } = await tx.query<PlanRow>(
    `UPDATE plans SET name = $4, start_date = $5, end_date = $6, timezone = $7, currency_code = $8,
                      budget_scope = $9, baseline_weight_kg = $10, target_weight_kg = $11,
                      daily_calorie_target = $12, daily_protein_target_g = $13
      WHERE id = $1 AND user_id = $2 AND version = $3
      RETURNING id, user_id, name, status, start_date, end_date, timezone, currency_code, budget_scope,
                baseline_weight_kg, target_weight_kg, daily_protein_target_g, daily_calorie_target,
                activated_at, closed_at, closed_on, version, created_at, updated_at`,
    [
      planId, userId, expectedVersion, next.name, startDate, endDate, next.timezone, next.currency_code,
      next.budget_scope, next.baseline_weight_kg, next.target_weight_kg,
      next.daily_calorie_target ?? null, next.daily_protein_target_g ?? null,
    ],
  );
  assertFresh(rowCount);
  const updated = rows[0];
  if (!updated) throw ApiError.stale();
  await recordAudit(tx, { userId, action: 'plan.update', entityType: 'plan', entityId: planId, requestId });
  return updated;
}

export async function activatePlan(
  tx: Tx, userId: string, planId: string, requestId: string, now: Date = new Date(),
): Promise<PlanRow> {
  const plan = await lockPlan(tx, userId, planId);

  if (plan.status !== 'draft') {
    throw new ApiError('state_conflict', `only a draft plan can be activated; this plan is ${plan.status}`);
  }

  const { rows: budget } = await tx.query<{ id: string }>(
    `SELECT id FROM budget_revisions WHERE user_id = $1 AND plan_id = $2 LIMIT 1`,
    [userId, planId],
  );
  // Lifecycle preconditions are STATE conflicts (409), not payload validation (422):
  // POST /activate carries no payload for a 422 to point at.
  if (!budget[0]) {
    throw new ApiError('state_conflict', 'this plan has no budget revision to activate against');
  }

  assertWeightTargets(plan.baseline_weight_kg, plan.target_weight_kg);

  const today = planToday(plan, now);
  if (compareIsoDate(plan.start_date, today) > 0) {
    throw new ApiError(
      'state_conflict',
      `this plan starts on ${plan.start_date}; it cannot be activated before then (today is ${today} in ${plan.timezone})`,
    );
  }

  // The unique partial index catches the racer that got past the row lock on a
  // DIFFERENT plan row. translatePgError turns that into a 409, not a 500.
  const { rows } = await tx.query<PlanRow>(
    `UPDATE plans SET status = 'active', activated_at = now()
      WHERE id = $1 AND user_id = $2 AND status = 'draft'
      RETURNING id, user_id, name, status, start_date, end_date, timezone, currency_code, budget_scope,
                baseline_weight_kg, target_weight_kg, daily_protein_target_g, daily_calorie_target,
                activated_at, closed_at, closed_on, version, created_at, updated_at`,
    [planId, userId],
  );
  const activated = rows[0];
  if (!activated) throw new ApiError('state_conflict', 'the plan changed while it was being activated');

  await recordAudit(tx, { userId, action: 'plan.activate', entityType: 'plan', entityId: planId, requestId });
  return activated;
}

export async function completePlan(
  tx: Tx, userId: string, planId: string, requestId: string, now: Date = new Date(),
): Promise<PlanRow> {
  const plan = await lockPlan(tx, userId, planId);
  if (plan.status !== 'active') {
    throw new ApiError('state_conflict', `only an active plan can be completed; this plan is ${plan.status}`);
  }
  const today = planToday(plan, now);
  // end_date is EXCLUSIVE: the plan is over once local today reaches it.
  // A forbidden lifecycle transition is a 409, the same family as activating an
  // already-active plan or transitioning out of a terminal state.
  if (compareIsoDate(today, plan.end_date) < 0) {
    throw new ApiError(
      'state_conflict',
      `this plan has not finished yet; completion is available from ${plan.end_date}`,
    );
  }
  return closePlan(tx, plan, 'completed', today, requestId);
}

export async function cancelPlan(
  tx: Tx, userId: string, planId: string, requestId: string, now: Date = new Date(),
): Promise<PlanRow> {
  const plan = await lockPlan(tx, userId, planId);
  if (plan.status !== 'draft' && plan.status !== 'active') {
    throw new ApiError('state_conflict', `this plan is already ${plan.status}`);
  }
  // closed_on is the plan-LOCAL closing date: corrections are accepted through it.
  return closePlan(tx, plan, 'cancelled', planToday(plan, now), requestId);
}

async function closePlan(
  tx: Tx, plan: PlanRow, status: 'completed' | 'cancelled', closedOn: IsoDate, requestId: string,
): Promise<PlanRow> {
  const { rows } = await tx.query<PlanRow>(
    `UPDATE plans SET status = $3, closed_at = now(), closed_on = $4
      WHERE id = $1 AND user_id = $2 AND status = $5
      RETURNING id, user_id, name, status, start_date, end_date, timezone, currency_code, budget_scope,
                baseline_weight_kg, target_weight_kg, daily_protein_target_g, daily_calorie_target,
                activated_at, closed_at, closed_on, version, created_at, updated_at`,
    [plan.id, plan.user_id, status, closedOn, plan.status],
  );
  const closed = rows[0];
  if (!closed) throw new ApiError('state_conflict', 'the plan changed while it was being closed');
  await recordAudit(tx, {
    userId: plan.user_id,
    action: status === 'completed' ? 'plan.complete' : 'plan.cancel',
    entityType: 'plan', entityId: plan.id, requestId,
  });
  return closed;
}

export { loadPlan, lockPlan };
