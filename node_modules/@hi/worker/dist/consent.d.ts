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
export declare const NOTIFICATION_PURPOSE = "notifications";
export type ConsentDecision = {
    readonly allowed: true;
} | {
    readonly allowed: false;
    readonly reason: SuppressionReason;
};
export type SuppressionReason = 'user_missing' | 'user_deactivated' | 'deletion_requested' | 'opted_out' | 'consent_never_granted' | 'consent_revoked';
/**
 * Requires `app.user_id` to be set on `sql` (see Db.withWorkerTx), because both
 * `users` and `consent_events` are owner-scoped by row-level security.
 *
 * Tie-break note: if a grant and a revocation share a timestamp to the
 * microsecond, the REVOCATION wins. Ordering by id alone would make the outcome
 * depend on a random uuid.
 */
export declare function checkConsent(sql: Sql, userId: string, purpose?: string): Promise<ConsentDecision>;
//# sourceMappingURL=consent.d.ts.map