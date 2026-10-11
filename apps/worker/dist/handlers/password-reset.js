/**
 * `password_reset` — deliver a single-use reset link.
 *
 * Deliberately NOT consent-gated, unlike the weekly reminder. A reset link is a
 * transactional security message the user just asked for; someone who opted out
 * of product notifications has not opted out of being able to recover their own
 * account.
 *
 * The link is the whole secret, so this handler is the one place a raw reset
 * token exists outside the original request. It is never logged: only the
 * user reference and whether delivery was attempted.
 */
import { userRef } from '../logger.js';
export const passwordReset = async ({ sql, job, logger, adapter }) => {
    const resetUrl = job.payload['reset_url'];
    const expiresIn = job.payload['expires_in_minutes'];
    if (typeof resetUrl !== 'string' || resetUrl.length === 0) {
        // A malformed payload will not become well-formed on retry.
        logger.warn({ job_id: job.id, recipient: userRef(job.user_id) }, 'password reset payload is unusable');
        return { outcome: 'permanent', code: 'invalid_payload' };
    }
    // Deactivated accounts do not get recovery links: erasure is in progress.
    const { rows } = await sql.query('SELECT (deactivated_at IS NOT NULL) AS deactivated FROM users WHERE id = $1', [job.user_id]);
    if (rows[0]?.deactivated !== false) {
        logger.info({ job_id: job.id, recipient: userRef(job.user_id) }, 'account is deactivated; reset link suppressed');
        return { outcome: 'skipped', reason: 'account_deactivated' };
    }
    await adapter.send({
        userId: job.user_id,
        template: 'password_reset',
        dedupeKey: job.dedupe_key,
        // No health or spending data, and no address: the recipient is resolved
        // from userId by whichever adapter delivers. The link travels in `link`,
        // not `vars`, because it is a secret rather than content.
        vars: { expires_in_minutes: typeof expiresIn === 'number' ? expiresIn : 30 },
        link: resetUrl,
    });
    await sql.query(`INSERT INTO audit_events(user_id, actor_type, action, entity_type, entity_id)
     VALUES ($1, 'system', 'auth.password_reset_sent', 'outbox_job', $2)`, [job.user_id, job.id]);
    return { outcome: 'done' };
};
//# sourceMappingURL=password-reset.js.map