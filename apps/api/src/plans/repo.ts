/** Plan row access. Every lookup is scoped to the session user; RLS is the backstop. */
import { ApiError, type IsoDate } from '@hi/contracts';
import type { Tx } from '../db/pool.js';
import { decodeCursor } from '../http/cursor.js';

export type PlanStatus = 'draft' | 'active' | 'completed' | 'cancelled';

export interface PlanRow {
  id: string;
  user_id: string;
  name: string;
  status: PlanStatus;
  start_date: IsoDate;
  end_date: IsoDate;
  timezone: string;
  currency_code: string;
  budget_scope: 'total' | 'incremental';
  baseline_weight_kg: string;
  target_weight_kg: string;
  daily_protein_target_g: string | null;
  daily_calorie_target: number | null;
  activated_at: Date | null;
  closed_at: Date | null;
  closed_on: IsoDate | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

const PLAN_COLUMNS = `id, user_id, name, status, start_date, end_date, timezone, currency_code,
  budget_scope, baseline_weight_kg, target_weight_kg, daily_protein_target_g, daily_calorie_target,
  activated_at, closed_at, closed_on, version, created_at, updated_at`;

/** Not owned and not existing are the SAME answer: 404. Anything else leaks existence. */
export async function loadPlan(tx: Tx, userId: string, planId: string): Promise<PlanRow> {
  const { rows } = await tx.query<PlanRow>(
    `SELECT ${PLAN_COLUMNS} FROM plans WHERE id = $1 AND user_id = $2`,
    [planId, userId],
  );
  const plan = rows[0];
  if (!plan) throw ApiError.notFound('plan');
  return plan;
}

/**
 * Serialises every cross-row plan invariant (activation, budget revisions,
 * lifecycle changes) against concurrent writers.
 */
export async function lockPlan(tx: Tx, userId: string, planId: string): Promise<PlanRow> {
  const { rows } = await tx.query<PlanRow>(
    `SELECT ${PLAN_COLUMNS} FROM plans WHERE id = $1 AND user_id = $2 FOR UPDATE`,
    [planId, userId],
  );
  const plan = rows[0];
  if (!plan) throw ApiError.notFound('plan');
  return plan;
}

export async function listPlans(
  tx: Tx, userId: string, limit: number, cursor: string | null,
): Promise<PlanRow[]> {
  if (cursor === null) {
    const { rows } = await tx.query<PlanRow>(
      `SELECT ${PLAN_COLUMNS} FROM plans WHERE user_id = $1
        ORDER BY created_at DESC, id DESC LIMIT $2`,
      [userId, limit],
    );
    return rows;
  }
  const parts = decodeCursor(cursor, 2);
  const { rows } = await tx.query<PlanRow>(
    `SELECT ${PLAN_COLUMNS} FROM plans
      WHERE user_id = $1 AND (created_at, id) < ($2::timestamptz, $3::uuid)
      ORDER BY created_at DESC, id DESC LIMIT $4`,
    [userId, parts[0], parts[1], limit],
  );
  return rows;
}

export async function activePlanId(tx: Tx, userId: string): Promise<string | null> {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT id FROM plans WHERE user_id = $1 AND status = 'active' LIMIT 1`,
    [userId],
  );
  return rows[0]?.id ?? null;
}
