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
import type { NotificationAdapter } from './notifications.js';
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
export declare class Runner {
    #private;
    readonly stats: RunnerStats;
    constructor(config: WorkerConfig, db: Db, adapter: NotificationAdapter, logger: Logger);
    get draining(): boolean;
    /** Crash-recovery sweep, on its own timer so a busy claim loop cannot starve it. */
    sweep(): Promise<void>;
    /** One claim-and-process cycle. Returns how many jobs were claimed. */
    runCycle(): Promise<number>;
    /** Poll until stopped. Resolves once the loop has fully drained. */
    start(): Promise<void>;
    /**
     * Stop claiming, then give the job currently in flight a bounded chance to
     * finish. Whatever is still running when the grace period ends keeps its lease
     * and is reclaimed by the sweep — at-least-once, never lost.
     */
    drain(): Promise<{
        finished: boolean;
    }>;
}
//# sourceMappingURL=runner.d.ts.map