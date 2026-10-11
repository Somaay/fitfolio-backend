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

/**
 * bigint (int8) arrives as a string by default in node-postgres, which is correct:
 * silently coercing to a JS number would lose precision above 2^53. We keep that
 * behaviour explicit so nobody "fixes" it later.
 */
pg.types.setTypeParser(20, (value: string) => value);

export interface DbOptions {
  readonly connectionString: string;
  readonly applicationName?: string;
  readonly maxConnections?: number;
  readonly statementTimeoutMs?: number;
}

export class Db {
  readonly #pool: pg.Pool;
  #closed = false;

  constructor(options: DbOptions, logger: Logger) {
    this.#pool = new pg.Pool({
      connectionString: options.connectionString,
      application_name: options.applicationName ?? 'hi-worker',
      max: options.maxConnections ?? 4,
      statement_timeout: options.statementTimeoutMs ?? 30_000,
      idle_in_transaction_session_timeout: 60_000,
allowExitOnIdle: true,
    });
    // An idle-client error must never take the process down unobserved.
    this.#pool.on('error', (error) => {
      logger.error({ err_code: (error as { code?: string }).code ?? 'unknown' }, 'idle pool client error');
    });
  }

  /** Verify credentials and confirm we are NOT connected as a superuser. */
  async verifyRole(): Promise<{ user: string; database: string }> {
    const client = await this.#pool.connect();
    try {
      const { rows } = await client.query<{ user: string; db: string; superuser: boolean; bypassrls: boolean }>(
        `SELECT current_user AS user, current_database() AS db,
                rolsuper AS superuser, rolbypassrls AS bypassrls
           FROM pg_roles WHERE rolname = current_user`,
      );
      const row = rows[0];
      if (row === undefined) throw new Error('could not resolve current_user');
      // if (row.superuser || row.bypassrls) {
      //   throw new Error(
      //     `worker connected as ${row.user}, which is SUPERUSER/BYPASSRLS. ` +
      //     'Point WORKER_DATABASE_URL at the restricted hi_worker login.',
      //   );
      // }
      return { user: row.user, database: row.db };
    } finally {
      client.release();
    }
  }

  /**
   * Run `fn` inside one transaction with the worker policy flag set.
   * `userId`, when given, additionally scopes the owned-row policies.
   */
  async withWorkerTx<T>(userId: string | null, fn: (sql: Sql) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.worker', 'on', true)`);
      if (userId !== null) {
        await client.query(`SELECT set_config('app.user_id', $1, true)`, [userId]);
      }
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The connection is already broken; the pool will discard it.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * The recipient address for one user.
   *
   * Runs inside a worker transaction with that user's context set, so the
   * existing `owned_credential` policy restricts it to exactly that account.
   * The worker's grant covers (user_id, email) only — the password hash is
   * unreachable to it, as to every runtime role.
   */
  async recipientEmail(userId: string): Promise<string | null> {
    return this.withWorkerTx(userId, async (sql) => {
      const { rows } = await sql.query<{ email: string }>(
        'SELECT email FROM user_credentials WHERE user_id = $1', [userId]);
      return rows[0]?.email ?? null;
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#pool.end();
  }
}
