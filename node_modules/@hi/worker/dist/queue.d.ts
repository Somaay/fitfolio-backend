/**
 * Outbox queue mechanics: claim, acknowledge, retry, terminal failure, and the
 * crash-recovery sweep.
 *
 * Delivery semantics are AT-LEAST-ONCE, deliberately. The alternative — marking a
 * job done before doing the work — is at-most-once and silently loses jobs. See
 * docs/operations.md for the residual re-delivery window and how `dedupe_key`
 * bounds it.
 */
import type { Sql } from './db.js';
export type JobStatus = 'pending' | 'running' | 'done' | 'failed';
export interface OutboxJob {
    readonly id: string;
    readonly user_id: string;
    readonly kind: string;
    readonly dedupe_key: string;
    readonly payload: Record<string, unknown>;
    readonly status: JobStatus;
    readonly attempts: number;
    readonly max_attempts: number;
    readonly available_at: Date;
    readonly locked_at: Date | null;
    readonly lease_expires_at: Date | null;
    readonly last_error_code: string | null;
    readonly completed_at: Date | null;
    readonly created_at: Date;
}
export interface BackoffOptions {
    readonly baseSeconds: number;
    readonly maxSeconds: number;
}
/**
 * Exponential backoff with full jitter, capped.
 *
 * Jitter matters: without it, a batch of jobs that failed together retries
 * together forever and keeps hammering whatever just broke.
 */
export declare function backoffSeconds(attempts: number, options: BackoffOptions, random?: () => number): number;
/**
 * Claim up to `limit` due jobs.
 *
 * `FOR UPDATE SKIP LOCKED` is what makes several workers safe: a row already
 * locked by a peer is skipped instead of blocking, so two workers never claim the
 * same job. `attempts` is incremented AT CLAIM TIME, so a worker that dies before
 * it can report anything still burns an attempt and cannot retry forever.
 */
export declare function claimJobs(sql: Sql, limit: number, leaseSeconds: number): Promise<OutboxJob[]>;
/**
 * Extend the lease of a job still being worked on. Long handlers call this so a
 * slow job is not mistaken for a crashed one.
 */
export declare function renewLease(sql: Sql, jobId: string, leaseSeconds: number): Promise<boolean>;
/**
 * Acknowledge success.
 *
 * Returns false when the row is gone — which is NORMAL for `account_erasure`,
 * because erasing the user cascades the job row away.
 */
export declare function completeJob(sql: Sql, jobId: string): Promise<boolean>;
export type FailureOutcome = 'retry_scheduled' | 'failed_permanently' | 'not_found';
/**
 * Record a failure. Bounded: once `attempts >= max_attempts` the job is terminal
 * and is never picked up again, so a poison message cannot spin forever.
 *
 * `errorCode` is a SHORT CODE, never a message: a driver message can quote a row
 * value, and this column is readable by anyone with database access.
 */
export declare function failJob(sql: Sql, job: Pick<OutboxJob, 'id' | 'attempts' | 'max_attempts'>, errorCode: string, options: BackoffOptions, random?: () => number): Promise<FailureOutcome>;
/**
 * Release a claim WITHOUT counting it as a failure outcome, used on graceful
 * shutdown so a redeploy does not leave jobs parked for a whole lease period.
 *
 * The consumed attempt is NOT refunded: the handler may have had side effects
 * before we stopped, and pretending otherwise would understate the retry count.
 */
export declare function releaseJob(sql: Sql, jobId: string): Promise<boolean>;
export interface SweepResult {
    readonly requeued: number;
    readonly failed: number;
}
/**
 * Crash recovery.
 *
 * A worker that is SIGKILLed, loses power, or has its container evicted leaves a
 * job in `running` with a lease that nobody will ever renew. This sweep is the
 * only thing that makes such a job visible again, so it runs on its own timer,
 * independently of the claim loop.
 *
 * Jobs that have exhausted their attempts become terminal `failed` with
 * `last_error_code = 'lease_expired'` rather than looping forever.
 */
export declare function sweepExpiredLeases(sql: Sql, options: BackoffOptions): Promise<SweepResult>;
//# sourceMappingURL=queue.d.ts.map