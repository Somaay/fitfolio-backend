/**
 * `account_export` — assemble the user's own data into an expiring artifact.
 *
 * Runs with `app.user_id` set to the job owner, so row-level security — not a
 * hand-written WHERE clause — is what guarantees one user's export cannot
 * contain another user's rows. The explicit `user_id = $1` predicates are belt
 * and braces, and they let the planner use the owner-prefixed indexes.
 *
 * Money is emitted as decimal integer strings in minor units and weights as kg
 * strings, matching docs/api-contract.md. Values are round-tripped through the
 * shared contracts helpers so the export cannot drift from the API's encoding.
 */
import { randomBytes } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { parseMinor, serializeMinor, gramsToKg, kgToGrams } from '@hi/contracts';
import { userRef } from '../logger.js';
import type { Sql } from '../db.js';
import type { Handler, HandlerResult } from './types.js';

/** Hard cap per collection. An export must not be able to exhaust worker memory. */
const MAX_ROWS_PER_COLLECTION = 50_000;

const money = (value: unknown): string => serializeMinor(parseMinor(value as string));
const weightKg = (value: unknown): string => gramsToKg(kgToGrams(value as string));

async function collect<T extends QueryResultRow>(sql: Sql, text: string, userId: string): Promise<T[]> {
  const { rows } = await sql.query<T>(`${text} LIMIT ${MAX_ROWS_PER_COLLECTION}`, [userId]);
  return rows;
}

export const accountExport: Handler = async ({ sql, job, logger, now }): Promise<HandlerResult> => {
  const requestedId = typeof job.payload['export_id'] === 'string' ? (job.payload['export_id'] as string) : null;

  if (requestedId !== null) {
    const existing = await sql.query<{ status: string }>(
      `SELECT status FROM account_exports WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [requestedId, job.user_id],
    );
    const row = existing.rows[0];
    if (row === undefined) {
      // The API row is gone (or never existed, or belongs to someone else). No
      // amount of retrying fixes that.
      return { outcome: 'permanent', code: 'export_row_missing' };
    }
    if (row.status === 'ready') {
      // At-least-once redelivery landed on an already-completed export. Doing it
      // again would mint a second download token for the same artifact.
      logger.info({ job_id: job.id, export_id: requestedId }, 'export already ready; nothing to do');
      return { outcome: 'skipped', reason: 'already_ready' };
    }
  }

  const profile = await sql.query<Record<string, unknown>>(
    `SELECT id, display_name, timezone, weight_unit, notification_opt_in,
            to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SSOF') AS created_at
       FROM users WHERE id = $1`,
    [job.user_id],
  );
  if (profile.rows[0] === undefined) {
    return { outcome: 'permanent', code: 'user_missing' };
  }

  const plans = await collect<Record<string, unknown>>(
    sql,
    `SELECT id, name, status, to_char(start_date,'YYYY-MM-DD') AS start_date,
            to_char(end_date,'YYYY-MM-DD') AS end_date, timezone, currency_code, budget_scope,
            baseline_weight_kg, target_weight_kg, daily_protein_target_g, daily_calorie_target,
            to_char(closed_on,'YYYY-MM-DD') AS closed_on, version
       FROM plans WHERE user_id = $1 ORDER BY created_at, id`,
    job.user_id,
  );

  const revisions = await collect<Record<string, unknown>>(
    sql,
    `SELECT id, plan_id, revision, total_minor, to_char(effective_on,'YYYY-MM-DD') AS effective_on, reason
       FROM budget_revisions WHERE user_id = $1 ORDER BY plan_id, revision`,
    job.user_id,
  );

  const lines = await collect<Record<string, unknown>>(
    sql,
    `SELECT bl.revision_id, bl.plan_id, c.code AS category, bl.allocated_minor
       FROM budget_lines bl JOIN categories c ON c.id = bl.category_id
      WHERE bl.user_id = $1 ORDER BY bl.revision_id, c.sort_order`,
    job.user_id,
  );

  const commitments = await collect<Record<string, unknown>>(
    sql,
    `SELECT cm.id, cm.plan_id, c.code AS category, cm.label, to_char(cm.due_on,'YYYY-MM-DD') AS due_on,
            cm.expected_minor, cm.attributable_minor, cm.session_model, cm.expected_sessions, cm.status
       FROM commitments cm JOIN categories c ON c.id = cm.category_id
      WHERE cm.user_id = $1 ORDER BY cm.due_on, cm.id`,
    job.user_id,
  );

  const expenses = await collect<Record<string, unknown>>(
    sql,
    `SELECT e.id, e.plan_id, c.code AS category, e.commitment_id, to_char(e.paid_on,'YYYY-MM-DD') AS paid_on,
            e.kind, e.amount_minor, e.attributable_minor, e.refund_of_id, e.description,
            to_char(e.voided_at,'YYYY-MM-DD"T"HH24:MI:SSOF') AS voided_at, e.void_reason, e.replaced_by_id
       FROM expenses e JOIN categories c ON c.id = e.category_id
      WHERE e.user_id = $1 ORDER BY e.paid_on, e.id`,
    job.user_id,
  );

  const weights = await collect<Record<string, unknown>>(
    sql,
    `SELECT id, plan_id, to_char(measured_at,'YYYY-MM-DD"T"HH24:MI:SSOF') AS measured_at,
            to_char(local_date,'YYYY-MM-DD') AS local_date, weight_kg, source
       FROM weight_entries WHERE user_id = $1 ORDER BY local_date, id`,
    job.user_id,
  );

  const nutrition = await collect<Record<string, unknown>>(
    sql,
    `SELECT id, plan_id, to_char(local_date,'YYYY-MM-DD') AS local_date, calories, protein_g
       FROM nutrition_days WHERE user_id = $1 ORDER BY local_date`,
    job.user_id,
  );

  const activities = await collect<Record<string, unknown>>(
    sql,
    `SELECT id, plan_id, commitment_id, to_char(occurred_at,'YYYY-MM-DD"T"HH24:MI:SSOF') AS occurred_at,
            to_char(local_date,'YYYY-MM-DD') AS local_date, kind, status, duration_minutes
       FROM activity_entries WHERE user_id = $1 ORDER BY local_date, id`,
    job.user_id,
  );

  const consents = await collect<Record<string, unknown>>(
    sql,
    `SELECT purpose, policy_version, action, to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SSOF') AS created_at
       FROM consent_events WHERE user_id = $1 ORDER BY created_at, id`,
    job.user_id,
  );

  const document = {
    format: 'hi.account_export',
    format_version: 1,
    generated_at: now.toISOString(),
    notes: [
      'Monetary values are decimal integer strings in minor units of the plan currency.',
      'Weights are kilograms as decimal strings.',
      'Dates are plan-local calendar dates; instants are RFC3339 with offset.',
    ],
    profile: profile.rows[0],
    plans,
    budget_revisions: revisions.map((r) => ({ ...r, total_minor: money(r['total_minor']) })),
    budget_lines: lines.map((r) => ({ ...r, allocated_minor: money(r['allocated_minor']) })),
    commitments: commitments.map((r) => ({
      ...r,
      expected_minor: money(r['expected_minor']),
      attributable_minor: money(r['attributable_minor']),
    })),
    expenses: expenses.map((r) => ({
      ...r,
      amount_minor: money(r['amount_minor']),
      attributable_minor: money(r['attributable_minor']),
    })),
    weight_entries: weights.map((r) => ({ ...r, weight_kg: weightKg(r['weight_kg']) })),
    nutrition_days: nutrition,
    activity_entries: activities,
    consent_events: consents,
    truncated: [plans, revisions, lines, commitments, expenses, weights, nutrition, activities, consents]
      .some((collection) => collection.length >= MAX_ROWS_PER_COLLECTION),
  };

  // base64url, 256 bits: unguessable, and never derived from the user id.
  const token = randomBytes(32).toString('base64url');

  const written = requestedId !== null
    ? await sql.query<{ id: string }>(
        `UPDATE account_exports
            SET status = 'ready', payload = $3::jsonb, download_token = $4, completed_at = now()
          WHERE id = $1 AND user_id = $2
          RETURNING id`,
        [requestedId, job.user_id, JSON.stringify(document), token],
      )
    : await sql.query<{ id: string }>(
        `INSERT INTO account_exports(user_id, status, payload, download_token, completed_at)
         VALUES ($1, 'ready', $2::jsonb, $3, now())
         RETURNING id`,
        [job.user_id, JSON.stringify(document), token],
      );

  const exportId = written.rows[0]?.id ?? null;
  if (exportId === null) return { outcome: 'permanent', code: 'export_row_missing' };

  await sql.query(
    `INSERT INTO audit_events(user_id, actor_type, action, entity_type, entity_id)
     VALUES ($1, 'system', 'account.export_ready', 'account_export', $2)`,
    [job.user_id, exportId],
  );

  // Row COUNTS are operational metrics; no value from any row is logged.
  logger.info(
    {
      job_id: job.id,
      owner: userRef(job.user_id),
      export_id: exportId,
      counts: {
        plans: plans.length,
        expenses: expenses.length,
        weight_entries: weights.length,
        activity_entries: activities.length,
      },
    },
    'account export ready',
  );

  return { outcome: 'done' };
};
