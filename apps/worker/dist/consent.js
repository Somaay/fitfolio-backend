/** Purpose string used for reminder notifications when a job does not name one. */
export const NOTIFICATION_PURPOSE = 'notifications';
/**
 * Requires `app.user_id` to be set on `sql` (see Db.withWorkerTx), because both
 * `users` and `consent_events` are owner-scoped by row-level security.
 *
 * Tie-break note: if a grant and a revocation share a timestamp to the
 * microsecond, the REVOCATION wins. Ordering by id alone would make the outcome
 * depend on a random uuid.
 */
export async function checkConsent(sql, userId, purpose = NOTIFICATION_PURPOSE) {
    const { rows } = await sql.query(`SELECT u.notification_opt_in,
            u.deactivated_at,
            u.deletion_requested_at,
            (SELECT c.action
               FROM consent_events c
              WHERE c.user_id = u.id AND c.purpose = $2
              ORDER BY c.created_at DESC, (c.action = 'revoked') DESC, c.id DESC
              LIMIT 1) AS latest_action
       FROM users u
      WHERE u.id = $1`, [userId, purpose]);
    const row = rows[0];
    if (row === undefined)
        return { allowed: false, reason: 'user_missing' };
    if (row.deactivated_at !== null)
        return { allowed: false, reason: 'user_deactivated' };
    if (row.deletion_requested_at !== null)
        return { allowed: false, reason: 'deletion_requested' };
    if (row.latest_action === null)
        return { allowed: false, reason: 'consent_never_granted' };
    if (row.latest_action === 'revoked')
        return { allowed: false, reason: 'consent_revoked' };
    if (!row.notification_opt_in)
        return { allowed: false, reason: 'opted_out' };
    return { allowed: true };
}
//# sourceMappingURL=consent.js.map