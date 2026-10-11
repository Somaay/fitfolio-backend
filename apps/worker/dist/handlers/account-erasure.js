/**
 * `account_erasure` — irreversibly delete a user and everything that cascades
 * from them.
 *
 * This is the one job that must never run speculatively, so it re-checks that the
 * account actually requested deletion before calling `app_erase_account`. The
 * function is SECURITY DEFINER and is granted to `app_worker` ONLY: the HTTP API
 * cannot call it, so a bug in a request handler cannot delete an account.
 *
 * IMPORTANT: `app_erase_account` deletes the `users` row, which cascades to
 * `outbox_jobs` — including THIS job. The acknowledging UPDATE therefore matches
 * zero rows, which is expected and is not an error.
 */
import { userRef } from '../logger.js';
export const accountErasure = async ({ sql, job, logger }) => {
    // A plain SELECT, deliberately: `app_worker` holds SELECT on `users` and
    // nothing more, so `FOR UPDATE` would be rejected with insufficient_privilege.
    // No row lock is needed — `app_erase_account` is a single atomic DELETE and a
    // duplicate run simply deletes zero rows.
    const { rows } = await sql.query(`SELECT deletion_requested_at FROM users WHERE id = $1`, [job.user_id]);
    const user = rows[0];
    if (user === undefined) {
        // Already erased — a redelivered job, or a concurrent erasure won the race.
        // Erasure is idempotent by construction, so this is success.
        logger.info({ job_id: job.id, owner: userRef(job.user_id) }, 'account already erased; nothing to do');
        return { outcome: 'skipped', reason: 'already_erased' };
    }
    if (user.deletion_requested_at === null) {
        // Refuse, loudly and terminally. Retrying would not make consent appear, and
        // an unrequested erasure is unrecoverable.
        logger.error({ job_id: job.id, owner: userRef(job.user_id) }, 'erasure job for an account with no deletion request; refusing');
        return { outcome: 'permanent', code: 'erasure_not_requested' };
    }
    await sql.query('SELECT app_erase_account($1)', [job.user_id]);
    logger.warn({ job_id: job.id, owner: userRef(job.user_id), irreversible: true }, 'account erased');
    return { outcome: 'done' };
};
//# sourceMappingURL=account-erasure.js.map