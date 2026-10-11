/**
 * Consent re-check AT SEND TIME.
 *
 * Consent checked when the job was enqueued is not consent. A user can revoke
 * between enqueue and delivery — and for a weekly reminder that window is days
 * wide. Every delivery path therefore re-reads the CURRENT state immediately
 * before sending, inside the same transaction that will acknowledge the job.
 *
 * The check FAILS CLOSED: absent context, an absent user, an absent consent
 * record, a pending deletion or a deactivated account all mean "do not send".
 */
import type { Sql } from './db.js';

/** Purpose string used for reminder notifications when a job does not name one. */
export const NOTIFICATION_PURPOSE = 'notifications';

export type ConsentDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: SuppressionReason };

export type SuppressionReason =
  | 'user_missing'
  | 'user_deactivated'
  | 'deletion_requested'
  | 'opted_out'
  | 'consent_never_granted'
  | 'consent_revoked';

interface ConsentRow {
  readonly notification_opt_in: boolean;
  readonly deactivated_at: Date | null;
  readonly deletion_requested_at: Date | null;
  readonly latest_action: 'granted' | 'revoked' | null;
}

/**
 * Requires `app.user_id` to be set on `sql` (see Db.withWorkerTx), because both
 * `users` and `consent_events` are owner-scoped by row-level security.
 *
 * Tie-break note: if a grant and a revocation share a timestamp to the
 * microsecond, the REVOCATION wins. Ordering by id alone would make the outcome
 * depend on a random uuid.
 */
export async function checkConsent(
  sql: Sql,
  userId: string,
  purpose: string = NOTIFICATION_PURPOSE,
): Promise<ConsentDecision> {
  const { rows } = await sql.query<ConsentRow>(
    `SELECT u.notification_opt_in,
            u.deactivated_at,
            u.deletion_requested_at,
            (SELECT c.action
               FROM consent_events c
              WHERE c.user_id = u.id AND c.purpose = $2
              ORDER BY c.created_at DESC, (c.action = 'revoked') DESC, c.id DESC
              LIMIT 1) AS latest_action
       FROM users u
      WHERE u.id = $1`,
    [userId, purpose],
  );

  const row = rows[0];
  if (row === undefined) return { allowed: false, reason: 'user_missing' };
  if (row.deactivated_at !== null) return { allowed: false, reason: 'user_deactivated' };
  if (row.deletion_requested_at !== null) return { allowed: false, reason: 'deletion_requested' };
  if (row.latest_action === null) return { allowed: false, reason: 'consent_never_granted' };
  if (row.latest_action === 'revoked') return { allowed: false, reason: 'consent_revoked' };
  if (!row.notification_opt_in) return { allowed: false, reason: 'opted_out' };
  return { allowed: true };
}
