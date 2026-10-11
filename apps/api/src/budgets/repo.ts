/** Budget revisions are append-only: the API role holds no UPDATE or DELETE grant. */
import type { IsoDate } from '@hi/contracts';
import type { Tx } from '../db/pool.js';
import { categoryCode, categoryId } from '../db/categories.js';

export interface RevisionRow {
  id: string;
  revision: number;
  total_minor: string;
  effective_on: IsoDate;
  reason: string;
  created_at: Date;
}

export interface RevisionLine {
  category_code: string;
  allocated_minor: string;
}

export interface RevisionWithLines extends RevisionRow {
  lines: RevisionLine[];
}

export async function nextRevisionNumber(tx: Tx, userId: string, planId: string): Promise<number> {
  const { rows } = await tx.query<{ next: number }>(
    `SELECT coalesce(max(revision), 0) + 1 AS next
       FROM budget_revisions WHERE user_id = $1 AND plan_id = $2`,
    [userId, planId],
  );
  return rows[0]?.next ?? 1;
}

export async function insertRevision(
  tx: Tx,
  input: {
    userId: string; planId: string; revision: number; totalMinor: bigint;
    effectiveOn: IsoDate; reason: string;
    lines: readonly { category_code: string; allocated_minor: bigint }[];
  },
): Promise<RevisionRow> {
  const { rows } = await tx.query<RevisionRow>(
    `INSERT INTO budget_revisions (user_id, plan_id, revision, total_minor, effective_on, reason)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, revision, total_minor, effective_on, reason, created_at`,
    [input.userId, input.planId, input.revision, input.totalMinor.toString(10), input.effectiveOn, input.reason],
  );
  const header = rows[0];
  if (!header) throw new Error('budget revision insert returned no row');

  // Header and every line in the same transaction: a revision is a COMPLETE snapshot.
  for (const line of input.lines) {
    await tx.query(
      `INSERT INTO budget_lines (user_id, plan_id, revision_id, category_id, allocated_minor)
       VALUES ($1, $2, $3, $4, $5)`,
      [input.userId, input.planId, header.id, await categoryId(tx, line.category_code), line.allocated_minor.toString(10)],
    );
  }
  return header;
}

export async function loadRevisionLines(
  tx: Tx, userId: string, revisionIds: readonly string[],
): Promise<Map<string, RevisionLine[]>> {
  const map = new Map<string, RevisionLine[]>();
  if (revisionIds.length === 0) return map;
  const { rows } = await tx.query<{ revision_id: string; category_id: number; allocated_minor: string }>(
    `SELECT revision_id, category_id, allocated_minor
       FROM budget_lines
      WHERE user_id = $1 AND revision_id = ANY($2::uuid[])
      ORDER BY category_id`,
    [userId, revisionIds as string[]],
  );
  for (const row of rows) {
    const bucket = map.get(row.revision_id) ?? [];
    bucket.push({ category_code: await categoryCode(tx, row.category_id), allocated_minor: row.allocated_minor });
    map.set(row.revision_id, bucket);
  }
  return map;
}

export async function listRevisions(tx: Tx, userId: string, planId: string): Promise<RevisionWithLines[]> {
  const { rows } = await tx.query<RevisionRow>(
    `SELECT id, revision, total_minor, effective_on, reason, created_at
       FROM budget_revisions WHERE user_id = $1 AND plan_id = $2 ORDER BY revision ASC`,
    [userId, planId],
  );
  const lines = await loadRevisionLines(tx, userId, rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, lines: lines.get(r.id) ?? [] }));
}

/**
 * The revision in force on `asOf`. Ties on effective_on break on the HIGHEST
 * revision: two revisions dated the same day means the later edit wins.
 */
export async function effectiveRevision(
  tx: Tx, userId: string, planId: string, asOf: IsoDate,
): Promise<RevisionRow | null> {
  const { rows } = await tx.query<RevisionRow>(
    `SELECT id, revision, total_minor, effective_on, reason, created_at
       FROM budget_revisions
      WHERE user_id = $1 AND plan_id = $2 AND effective_on <= $3::date
      ORDER BY effective_on DESC, revision DESC
      LIMIT 1`,
    [userId, planId, asOf],
  );
  return rows[0] ?? null;
}

/** Revision 1: the original comparison, which a later increase must never erase. */
export async function originalRevision(tx: Tx, userId: string, planId: string): Promise<RevisionRow | null> {
  const { rows } = await tx.query<RevisionRow>(
    `SELECT id, revision, total_minor, effective_on, reason, created_at
       FROM budget_revisions
      WHERE user_id = $1 AND plan_id = $2
      ORDER BY revision ASC LIMIT 1`,
    [userId, planId],
  );
  return rows[0] ?? null;
}

export async function latestRevision(tx: Tx, userId: string, planId: string): Promise<RevisionRow | null> {
  const { rows } = await tx.query<RevisionRow>(
    `SELECT id, revision, total_minor, effective_on, reason, created_at
       FROM budget_revisions
      WHERE user_id = $1 AND plan_id = $2
      ORDER BY revision DESC LIMIT 1`,
    [userId, planId],
  );
  return rows[0] ?? null;
}
