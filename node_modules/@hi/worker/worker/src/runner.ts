/**
 * The worker loop.
 *
 * Shape of one cycle:
 *   1. Claim a batch in ONE short transaction (`app.worker='on'`), then commit —
 *      so the lease is immediately visible to every other worker.
 *   2. Process each job in its OWN transaction with `app.user_id` set, so the
 *      handler's writes and the acknowledgement commit together. There is no
 *      window in which the work is done but the job still looks pending.
 *   3. A separate timer sweeps leases that expired because a worker died.
 *
 * Delivery is at-least-once: step 2 can succeed in the handler's external effect
 * (a notification) and then lose the commit. That trade is documented in
 * docs/operations.md; the alternative loses jobs outright.
 */
import type { Logger } from 'pino';
import type { WorkerConfig } from './config.js';
import type { Db } from './db.js';
import { errorCode, userRef } from './logger.js';
import { handlerFor } from './handlers/index.js';
import type { NotificationAdapter } from './notifications.js';
import {
  claimJobs,
  completeJob,
  failJob,
  releaseJob,
  renewLease,
  sweepExpiredLeases,
  type BackoffOptions,
  type OutboxJob,
} from './queue.js';

export interface RunnerStats {
  cycles: number;
  claimed: number;
  completed: number;
  skipped: number;
  retried: number;
  failed: number;
  reclaimed: number;
  lastError: string | null;
  lastCycleAt: string | null;
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });

export class Runner {
  readonly #config: WorkerConfig;
  readonly #db: Db;
  readonly #logger: Logger;
  readonly #adapter: NotificationAdapter;
  readonly #backoff: BackoffOptions;
  readonly #abort = new AbortController();

  #draining = false;
  #inFlight: Promise<void> | null = null;
  #sweepTimer: NodeJS.Timeout | null = null;

  readonly stats: RunnerStats = {
    cycles: 0, claimed: 0, completed: 0, skipped: 0,
    retried: 0, failed: 0, reclaimed: 0, lastError: null, lastCycleAt: null,
  };

  constructor(config: WorkerConfig, db: Db, adapter: NotificationAdapter, logger: Logger) {
    this.#config = config;
    this.#db = db;
    this.#adapter = adapter;
    this.#logger = logger;
    this.#backoff = { baseSeconds: config.retryBaseSeconds, maxSeconds: config.retryMaxSeconds };
  }

  get draining(): boolean {
    return this.#draining;
  }

  /** Crash-recovery sweep, on its own timer so a busy claim loop cannot starve it. */
  async sweep(): Promise<void> {
    try {
      const result = await this.#db.withWorkerTx(null, (sql) => sweepExpiredLeases(sql, this.#backoff));
      if (result.requeued > 0 || result.failed > 0) {
        this.stats.reclaimed += result.requeued + result.failed;
        this.#logger.warn(
          { requeued: result.requeued, exhausted: result.failed },
          'reclaimed jobs whose lease expired (a worker died or stalled)',
        );
      }
    } catch (error) {
      this.stats.lastError = errorCode(error);
      this.#logger.error({ err_code: errorCode(error) }, 'lease sweep failed');
    }
  }

  /** One claim-and-process cycle. Returns how many jobs were claimed. */
  async runCycle(): Promise<number> {
    this.stats.cycles += 1;
    this.stats.lastCycleAt = new Date().toISOString();

    const batch = await this.#db.withWorkerTx(null, (sql) =>
      claimJobs(sql, this.#config.batchSize, this.#config.leaseSeconds),
    );
    if (batch.length === 0) return 0;

    this.stats.claimed += batch.length;
    this.#logger.debug({ claimed: batch.length }, 'claimed jobs');

    for (let index = 0; index < batch.length; index += 1) {
      const job = batch[index] as OutboxJob;
      if (this.#draining) {
        // Hand the rest of the batch straight back rather than holding leases
        // that this process will not honour.
        await this.#releaseRemaining(batch.slice(index));
        break;
      }
      const work = this.#processJob(job);
      this.#inFlight = work;
      try {
        await work;
      } finally {
        this.#inFlight = null;
      }
    }
    return batch.length;
  }

  async #releaseRemaining(jobs: readonly OutboxJob[]): Promise<void> {
    if (jobs.length === 0) return;
    try {
      await this.#db.withWorkerTx(null, async (sql) => {
        for (const job of jobs) await releaseJob(sql, job.id);
      });
      this.#logger.info({ released: jobs.length }, 'released unstarted leases during shutdown');
    } catch (error) {
      this.#logger.error(
        { err_code: errorCode(error), pending: jobs.length },
        'could not release unstarted leases; the sweep will reclaim them',
      );
    }
  }

  async #processJob(job: OutboxJob): Promise<void> {
    const log = this.#logger.child({ job_id: job.id, kind: job.kind, attempt: job.attempts, owner: userRef(job.user_id) });
    const handler = handlerFor(job.kind);

    if (handler === null) {
      log.error('no handler registered for this job kind; failing permanently');
      await this.#recordFailure(job, 'unknown_job_kind', true);
      return;
    }

    // Keep the lease alive while a long handler runs, using a SEPARATE
    // connection: the handler's own transaction has not committed yet.
    const heartbeat = setInterval(() => {
      void this.#db
        .withWorkerTx(null, (sql) => renewLease(sql, job.id, this.#config.leaseSeconds))
        .catch((error: unknown) => log.warn({ err_code: errorCode(error) }, 'lease renewal failed'));
    }, Math.max(1000, Math.floor((this.#config.leaseSeconds * 1000) / 3)));

    const started = Date.now();
    try {
      const outcome = await this.#db.withWorkerTx(job.user_id, async (sql) => {
        const result = await handler({ sql, job, logger: log, adapter: this.#adapter, now: new Date() });
        if (result.outcome === 'done' || result.outcome === 'skipped') {
          const acknowledged = await completeJob(sql, job.id);
          if (!acknowledged && job.kind !== 'account_erasure') {
            // Someone else reclaimed the lease while we worked. Commit anyway:
            // the handler's writes are already in this transaction, and the
            // duplicate run is the at-least-once behaviour we documented.
            log.warn('job row was no longer ours at acknowledgement time');
          }
        }
        return result;
      });

      switch (outcome.outcome) {
        case 'done':
          this.stats.completed += 1;
          log.info({ duration_ms: Date.now() - started }, 'job done');
          break;
        case 'skipped':
          this.stats.skipped += 1;
          log.info({ duration_ms: Date.now() - started, reason: outcome.reason }, 'job skipped');
          break;
        case 'retry':
          await this.#recordFailure(job, outcome.code, false);
          break;
        case 'permanent':
          await this.#recordFailure(job, outcome.code, true);
          break;
      }
    } catch (error) {
      const code = errorCode(error);
      this.stats.lastError = code;
      log.error({ err_code: code, duration_ms: Date.now() - started }, 'job threw; scheduling retry');
      await this.#recordFailure(job, code, false);
    } finally {
      clearInterval(heartbeat);
    }
  }

  async #recordFailure(job: OutboxJob, code: string, permanent: boolean): Promise<void> {
    const effective = permanent ? { ...job, attempts: job.max_attempts } : job;
    try {
      const outcome = await this.#db.withWorkerTx(null, (sql) =>
        failJob(sql, effective, code, this.#backoff),
      );
      if (outcome === 'failed_permanently') {
        this.stats.failed += 1;
        this.#logger.error({ job_id: job.id, kind: job.kind, err_code: code }, 'job failed permanently');
      } else if (outcome === 'retry_scheduled') {
        this.stats.retried += 1;
      }
    } catch (error) {
      // The lease sweep is the backstop: the job stays `running` until it expires.
      this.#logger.error(
        { job_id: job.id, err_code: errorCode(error) },
        'could not record failure; the lease sweep will reclaim this job',
      );
    }
  }

  /** Poll until stopped. Resolves once the loop has fully drained. */
  async start(): Promise<void> {
    this.#sweepTimer = setInterval(() => { void this.sweep(); }, this.#config.sweepIntervalMs);
    this.#sweepTimer.unref();
    await this.sweep();

    while (!this.#draining) {
      let claimed = 0;
      try {
        claimed = await this.runCycle();
      } catch (error) {
        const code = errorCode(error);
        this.stats.lastError = code;
        this.#logger.error({ err_code: code }, 'claim cycle failed; backing off');
        await sleep(this.#config.pollIntervalMs, this.#abort.signal);
        continue;
      }
      // Only idle when the queue was empty; a full batch means more work waits.
      if (claimed === 0 && !this.#draining) {
        await sleep(this.#config.pollIntervalMs, this.#abort.signal);
      }
    }
  }

  /**
   * Stop claiming, then give the job currently in flight a bounded chance to
   * finish. Whatever is still running when the grace period ends keeps its lease
   * and is reclaimed by the sweep — at-least-once, never lost.
   */
  async drain(): Promise<{ finished: boolean }> {
    if (this.#draining) return { finished: this.#inFlight === null };
    this.#draining = true;
    this.#abort.abort();
    if (this.#sweepTimer !== null) clearInterval(this.#sweepTimer);

    const current = this.#inFlight;
    if (current === null) return { finished: true };

    this.#logger.info({ grace_ms: this.#config.shutdownGraceMs }, 'draining: waiting for the in-flight job');
    const finished = await Promise.race([
      current.then(() => true, () => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), this.#config.shutdownGraceMs).unref()),
    ]);
    if (!finished) {
      this.#logger.warn('grace period expired with a job still running; its lease will be reclaimed by the sweep');
    }
    return { finished };
  }
}
