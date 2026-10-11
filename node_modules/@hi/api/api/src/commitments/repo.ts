/** Commitments: unpaid dated forecasts, and the outstanding amount they still imply. */
import { ApiError, type IsoDate } from '@hi/contracts';
import type { Tx } from '../db/pool.js';
import { categoryCode } from '../db/categories.js';
import { decodeCursor } from '../http/cursor.js';

export type CommitmentStatus = 'pending' | 'completed' | 'cancelled';

export interface CommitmentRow {
  id: string;
  user_id: string;
  plan_id: string;
  category_id: number;
  label: string;
  due_on: IsoDate;
  expected_minor: string;
  attributable_minor: string;
  session_model: 'unlimited' | 'sessions';
  expected_sessions: number | null;
  status: CommitmentStatus;
  reopened_at: Date | null;
  generation_key: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export const COMMITMENT_COLUMNS = `id, user_id, plan_id, category_id, label, due_on, expected_minor,
  attributable_minor, session_model, expected_sessions, status, reopened_at, generation_key,
  version, created_at, updated_at`;

export async function loadCommitment(
  tx: Tx, userId: string, planId: string, commitmentId: string,
): Promise<CommitmentRow> {
  const { rows } = await tx.query<CommitmentRow>(
    `SELECT ${COMMITMENT_COLUMNS} FROM commitments WHERE id = $1 AND user_id = $2 AND plan_id = $3`,
    [commitmentId, userId, planId],
  );
  const row = rows[0];
  if (!row) throw ApiError.notFound('commitment');
  return row;
}

export async function lockCommitment(
  tx: Tx, userId: string, planId: string, commitmentId: string,
): Promise<CommitmentRow> {
  const { rows } = await tx.query<CommitmentRow>(
    `SELECT ${COMMITMENT_COLUMNS} FROM commitments
      WHERE id = $1 AND user_id = $2 AND plan_id = $3 FOR UPDATE`,
    [commitmentId, userId, planId],
  );
  const row = rows[0];
  if (!row) throw ApiError.notFound('commitment');
  return row;
}

export async function listCommitments(
  tx: Tx, userId: string, planId: string, limit: number, cursor: string | null,
  range: { from?: IsoDate; to?: IsoDate },
): Promise<CommitmentRow[]> {
  const params: unknown[] = [userId, planId, limit];
  const where: string[] = ['user_id = $1', 'plan_id = $2'];
  if (range.from) { params.push(range.from); where.push(`due_on >= $${params.length}::date`); }
  if (range.to) { params.push(range.to); where.push(`due_on <= $${params.length}::date`); }
  if (cursor) {
    const parts = decodeCursor(cursor, 2);
    params.push(parts[0], parts[1]);
    where.push(`(due_on, id) > ($${params.length - 1}::date, $${params.length}::uuid)`);
  }
  const { rows } = await tx.query<CommitmentRow>(
    `SELECT ${COMMITMENT_COLUMNS} FROM commitments
      WHERE ${where.join(' AND ')} ORDER BY due_on ASC, id ASC LIMIT $3`,
    params,
  );
  return rows;
}

/**
 * Net scoped payments already linked to each commitment.
 *
 * Aggregated on its OWN, then joined by the caller. Joining commitments to
 * expenses and to activities in one statement multiplies rows and inflates both.
 */
export async function linkedNetByCommitment(
  tx: Tx, userId: string, planId: string, scope: 'total' | 'incremental', asOf: IsoDate | null,
): Promise<Map<string, bigint>> {
  const column = scope === 'total' ? 'amount_minor' : 'attributable_minor';
  const params: unknown[] = [userId, planId];
  let cutoff = '';
  if (asOf !== null) { params.push(asOf); cutoff = ` AND paid_on <= $${params.length}::date`; }
  const { rows } = await tx.query<{ commitment_id: string; net: string }>(
    `SELECT commitment_id,
            sum(CASE WHEN kind = 'payment' THEN ${column} ELSE -${column} END)::text AS net
       FROM expenses
      WHERE user_id = $1 AND plan_id = $2 AND commitment_id IS NOT NULL AND voided_at IS NULL${cutoff}
      GROUP BY commitment_id`,
    params,
  );
  return new Map(rows.map((r) => [r.commitment_id, BigInt(r.net)]));
}

/** Completed and cancelled commitments contribute ZERO outstanding forecast. */
export function outstandingMinor(
  commitment: Pick<CommitmentRow, 'status' | 'expected_minor' | 'attributable_minor'>,
  scope: 'total' | 'incremental',
  linkedNet: bigint,
): bigint {
  if (commitment.status !== 'pending') return 0n;
  const expected = BigInt(scope === 'total' ? commitment.expected_minor : commitment.attributable_minor);
  const remaining = expected - linkedNet;
  return remaining > 0n ? remaining : 0n;
}

export async function serializeCommitment(
  tx: Tx, row: CommitmentRow, scope: 'total' | 'incremental', linkedNet: bigint,
): Promise<Record<string, unknown>> {
  return {
    id: row.id,
    plan_id: row.plan_id,
    category_code: await categoryCode(tx, row.category_id),
    label: row.label,
    due_on: row.due_on,
    expected_minor: row.expected_minor,
    attributable_minor: row.attributable_minor,
    session_model: row.session_model,
    expected_sessions: row.expected_sessions,
    status: row.status,
    reopened_at: row.reopened_at,
    generation_key: row.generation_key,
    linked_net_minor: linkedNet.toString(10),
    outstanding_minor: outstandingMinor(row, scope, linkedNet).toString(10),
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
