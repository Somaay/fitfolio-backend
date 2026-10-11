/**
 * `weekly_reminder` — nudge a user to log their week.
 *
 * Two properties matter more than the message itself:
 *  1. Consent is re-read HERE, at send time, in the acknowledging transaction.
 *     A revocation recorded after the job was enqueued suppresses delivery.
 *  2. The message body carries no weight, calorie or spending figure. See
 *     notifications.ts for the enforced content rule.
 */
import { todayInZone, weekIndexForDate, isValidTimeZone } from '@hi/contracts';
import { checkConsent, NOTIFICATION_PURPOSE } from '../consent.js';
import { userRef } from '../logger.js';
export const weeklyReminder = async ({ sql, job, logger, adapter, now }) => {
    const purposeRaw = job.payload['purpose'];
    const purpose = typeof purposeRaw === 'string' && purposeRaw.length > 0 ? purposeRaw : NOTIFICATION_PURPOSE;
    // ---- consent re-check at send time (never at enqueue time) ----
    const decision = await checkConsent(sql, job.user_id, purpose);
    if (!decision.allowed) {
        logger.info({ job_id: job.id, recipient: userRef(job.user_id), suppressed: decision.reason }, 'reminder suppressed; delivery skipped');
        // The job is DONE, not failed: suppression is the correct outcome, and
        // retrying it would only re-check the same revocation.
        return { outcome: 'skipped', reason: decision.reason };
    }
    const { rows } = await sql.query(`SELECT id, to_char(start_date,'YYYY-MM-DD') AS start_date, timezone, status
       FROM plans
      WHERE user_id = $1 AND status = 'active'
      LIMIT 1`, [job.user_id]);
    const plan = rows[0];
    if (plan === undefined) {
        logger.info({ job_id: job.id, recipient: userRef(job.user_id) }, 'no active plan; reminder skipped');
        return { outcome: 'skipped', reason: 'no_active_plan' };
    }
    // A plan's time zone is frozen at creation; a bad value is a data problem, not
    // a transient one, so fall back rather than retry forever.
    const zone = isValidTimeZone(plan.timezone) ? plan.timezone : 'UTC';
    const today = todayInZone(zone, now);
    const weekIndex = weekIndexForDate(plan.start_date, today);
    if (weekIndex === null) {
        logger.info({ job_id: job.id, plan_id: plan.id }, 'today falls outside the plan window; reminder skipped');
        return { outcome: 'skipped', reason: 'outside_plan_window' };
    }
    await adapter.send({
        userId: job.user_id,
        template: 'weekly_reminder',
        dedupeKey: job.dedupe_key,
        // Week number and a plan reference only. No measurement, no money.
        vars: { week: weekIndex, plan_ref: plan.id.slice(0, 8) },
    });
    await sql.query(`INSERT INTO audit_events(user_id, actor_type, action, entity_type, entity_id)
     VALUES ($1, 'system', 'notification.reminder_sent', 'outbox_job', $2)`, [job.user_id, job.id]);
    return { outcome: 'done' };
};
//# sourceMappingURL=weekly-reminder.js.map