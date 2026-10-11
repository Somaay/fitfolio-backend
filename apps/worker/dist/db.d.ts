/**
 * Database access for the worker.
 *
 * Connects as the restricted `hi_worker` login (member of `app_worker`), which is
 * NOSUPERUSER / NOBYPASSRLS and owns no tables, so FORCE ROW LEVEL SECURITY really
 * applies to it.
 *
 * Two transaction-local settings gate everything:
 *   - `app.worker  = 'on'`   -> enables the `worker_claims_jobs` /
 *                               `worker_writes_exports` policies (migration 0002).
 *   - `app.user_id = <uuid>` -> scopes ordinary owned tables to one user.
 * Both are set with `set_config(..., true)`, i.e. TRANSACTION-local, so a pooled
 * connection can never leak one user's context into the next job.
 */
import pg from 'pg';
import type { Logger } from 'pino';
export type Sql = pg.PoolClient;
export interface DbOptions {
    readonly connectionString: string;
    readonly applicationName?: string;
    readonly maxConnections?: number;
    readonly statementTimeoutMs?: number;
}
export declare class Db {
    #private;
    constructor(options: DbOptions, logger: Logger);
    /** Verify credentials and confirm we are NOT connected as a superuser. */
    verifyRole(): Promise<{
        user: string;
        database: string;
    }>;
    /**
     * Run `fn` inside one transaction with the worker policy flag set.
     * `userId`, when given, additionally scopes the owned-row policies.
     */
    withWorkerTx<T>(userId: string | null, fn: (sql: Sql) => Promise<T>): Promise<T>;
    /**
     * The recipient address for one user.
     *
     * Runs inside a worker transaction with that user's context set, so the
     * existing `owned_credential` policy restricts it to exactly that account.
     * The worker's grant covers (user_id, email) only — the password hash is
     * unreachable to it, as to every runtime role.
     */
    recipientEmail(userId: string): Promise<string | null>;
    close(): Promise<void>;
}
//# sourceMappingURL=db.d.ts.map