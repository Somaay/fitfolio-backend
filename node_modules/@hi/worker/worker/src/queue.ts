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
export function backoffSeconds(attempts: number, options: BackoffOptions, random: () => number = Math.random): number {
  const exponent = Math.min(Math.max(attempts, 1) - 1, 20);
  const ceiling = Math.min(options.baseSeconds * 2 ** exponent, options.maxSeconds);
  const jittered = Math.round(ceiling / 2 + random() * (ceiling / 2));
  return Math.max(1, jittered);
}

/**
 * Claim up to `limit` due jobs.
 *
 * `FOR UPDATE SKIP LOCKED` is what makes several workers safe: a row already
 * locked by a peer is skipped instead of blocking, so two workers never claim the
 * same job. `attempts` is incremented AT CLAIM TIME, so a worker that dies before
 * it can report anything still burns an attempt and cannot retry forever.
 */
export async function claimJobs(sql: Sql, limit: number, leaseSeconds: number): Promise<OutboxJob[]> {
  const { rows } = await sql.query<OutboxJob>(
    `UPDATE outbox_jobs
        SET status = 'running',
            locked_at = now(),
            lease_expires_at = now() + make_interval(secs => $2::double precision),
            attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM outbox_jobs
         WHERE status = 'pending'
           AND available_at <= now()
         ORDER BY available_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT $1
      )
      RETURNING *`,
    [limit, leaseSeconds],
  );
  return rows;
}

/**
 * Extend the lease of a job still being worked on. Long handlers call this so a
 * slow job is not mistaken for a crashed one.
 */
export async function renewLease(sql: Sql, jobId: string, leaseSeconds: number): Promise<boolean> {
  const { rowCount } = await sql.query(
    `UPDATE outbox_jobs
        SET lease_expires_at = now() + make_interval(secs => $2::double precision)
      WHERE id = $1 AND status = 'running'`,
    [jobId, leaseSeconds],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Acknowledge success.
 *
 * Returns false when the row is gone — which is NORMAL for `account_erasure`,
 * because erasing the user cascades the job row away.
 */
export async function completeJob(sql: Sql, jobId: string): Promise<boolean> {
  const { rowCount } = await sql.query(
    `UPDATE outbox_jobs
        SET status = 'done', completed_at = now(), lease_expires_at = NULL, last_error_code = NULL
      WHERE id = $1 AND status = 'running'`,
    [jobId],
  );
  return (rowCount ?? 0) > 0;
}

export type FailureOutcome = 'retry_scheduled' | 'failed_permanently' | 'not_found';

/**
 * Record a failure. Bounded: once `attempts >= max_attempts` the job is terminal
 * and is never picked up again, so a poison message cannot spin forever.
 *
 * `errorCode` is a SHORT CODE, never a message: a driver message can quote a row
 * value, and this column is readable by anyone with database access.
 */
export async function failJob(
  sql: Sql,
  job: Pick<OutboxJob, 'id' | 'attempts' | 'max_attempts'>,
  errorCode: string,
  options: BackoffOptions,
  random: () => number = Math.random,
): Promise<FailureOutcome> {
  const terminal = job.attempts >= job.max_attempts;
  const code = errorCode.slice(0, 64);

  if (terminal) {
    const { rowCount } = await sql.query(
      `UPDATE outbox_jobs
          SET status = 'failed', last_error_code = $2, lease_expires_at = NULL, completed_at = now()
        WHERE id = $1 AND status = 'running'`,
      [job.id, code],
    );
    return (rowCount ?? 0) > 0 ? 'failed_permanently' : 'not_found';
  }

  const delay = backoffSeconds(job.attempts, options, random);
  const { rowCount } = await sql.query(
    `UPDATE outbox_jobs
        SET status = 'pending',
            last_error_code = $2,
            available_at = now() + make_interval(secs => $3::double precision),
            locked_at = NULL,
            lease_expires_at = NULL
      WHERE id = $1 AND status = 'running'`,
    [job.id, code, delay],
  );
  return (rowCount ?? 0) > 0 ? 'retry_scheduled' : 'not_found';
}

/**
 * Release a claim WITHOUT counting it as a failure outcome, used on graceful
 * shutdown so a redeploy does not leave jobs parked for a whole lease period.
 *
 * The consumed attempt is NOT refunded: the handler may have had side effects
 * before we stopped, and pretending otherwise would understate the retry count.
 */
export async function releaseJob(sql: Sql, jobId: string): Promise<boolean> {
  const { rowCount } = await sql.query(
    `UPDATE outbox_jobs
        SET status = 'pending', locked_at = NULL, lease_expires_at = NULL, available_at = now()
      WHERE id = $1 AND status = 'running'`,
    [jobId],
  );
  return (rowCount ?? 0) > 0;
}

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
export async function sweepExpiredLeases(sql: Sql, options: BackoffOptions): Promise<SweepResult> {
  const failed = await sql.query(
    `UPDATE outbox_jobs
        SET status = 'failed', last_error_code = 'lease_expired',
            lease_expires_at = NULL, completed_at = now()
      WHERE status = 'running'
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at < now()
        AND attempts >= max_attempts`,
  );

  const requeued = await sql.query(
    `UPDATE outbox_jobs
        SET status = 'pending', last_error_code = 'lease_expired',
            locked_at = NULL, lease_expires_at = NULL,
            available_at = now() + make_interval(
              secs => LEAST($2::double precision,
                            $1::double precision * power(2, LEAST(GREATEST(attempts,1) - 1, 20)))
            )
      WHERE status = 'running'
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at < now()
        AND attempts < max_attempts`,
    [options.baseSeconds, options.maxSeconds],
  );

  return { requeued: requeued.rowCount ?? 0, failed: failed.rowCount ?? 0 };
}
