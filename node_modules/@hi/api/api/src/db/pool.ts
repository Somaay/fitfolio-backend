/**
 * Database access.
 *
 * Every statement runs as the RESTRICTED api login (never the migration owner),
 * so `FORCE ROW LEVEL SECURITY` genuinely applies. Row ownership is carried by
 * `app.user_id`, set with set_config(..., true) — TRANSACTION-local, so a pooled
 * connection can never leak one user's context into the next user's queries.
 */
import pg from 'pg';
import type { AppConfig } from '../config.js';

/**
 * A business DATE is a date, not an instant. node-postgres otherwise hands back a
 * JS Date at the SERVER's local midnight, which shifts `paid_on` by a day for any
 * process not running in UTC. Keep the wire text exactly as Postgres wrote it.
 */
pg.types.setTypeParser(1082, (value: string) => value);

export interface Tx {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: readonly unknown[],
  ): Promise<pg.QueryResult<R>>;
}

export type SqlParams = readonly unknown[];

/** Postgres error codes we translate rather than leak as a 500. */
export const PG = {
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
  checkViolation: '23514',
  notNullViolation: '23502',
  serializationFailure: '40001',
  deadlockDetected: '40P01',
  insufficientPrivilege: '42501',
} as const;

export function pgErrorCode(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

export function pgConstraint(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'constraint' in error) {
    const c = (error as { constraint?: unknown }).constraint;
    return typeof c === 'string' ? c : null;
  }
  return null;
}

const RETRYABLE = new Set<string>([PG.serializationFailure, PG.deadlockDetected]);
const MAX_TRANSACTION_ATTEMPTS = 3;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class Database {
  readonly #pool: pg.Pool;

  constructor(config: AppConfig) {
    this.#pool = new pg.Pool({
      connectionString: config.databaseUrl,
      max: config.dbPoolMax,
      // A runaway query must not pin a pooled connection forever.
      statement_timeout: config.dbStatementTimeoutMs,
      idle_in_transaction_session_timeout: config.dbStatementTimeoutMs * 3,
      application_name: 'hi_api',
    });
    // An idle-client error must never crash the process.
    this.#pool.on('error', () => undefined);
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }

  /** Liveness of the connection pool only — no user context, no owned rows. */
  async ping(): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query('SELECT 1');
    } finally {
      client.release();
    }
  }

  /**
   * Identity bootstrap runs BEFORE any user context exists, so it cannot go
   * through the owner-scoped policies. `app_resolve_identity` is the single
   * narrow SECURITY DEFINER operation granted for that.
   */
  async resolveIdentity(
    issuer: string,
    subject: string,
    timezone: string,
  ): Promise<{ userId: string; isNew: boolean; deactivated: boolean; sessionEpoch: number } | null> {
    const client = await this.#pool.connect();
    try {
      const { rows } = await client.query<{
        user_id: string; is_new: boolean; deactivated: boolean; session_epoch: number;
      }>(
        'SELECT user_id, is_new, deactivated, session_epoch FROM app_resolve_identity($1, $2, $3)',
        [issuer, subject, timezone],
      );
      const row = rows[0];
      if (!row || row.user_id === null) return null;
      return {
        userId: row.user_id, isNew: row.is_new,
        deactivated: row.deactivated, sessionEpoch: row.session_epoch,
      };
    } finally {
      client.release();
    }
  }

  /**
   * Credential operations. Like identity bootstrap these run with NO user
   * context — you cannot be scoped to yourself before you have proved who you
   * are — so each goes through one narrow SECURITY DEFINER function rather than
   * a policy bypass. The password hash is never exposed to the ordinary grants.
   */
  async registerPasswordUser(
    email: string, passwordHash: string, timezone: string,
  ): Promise<string | null> {
    const client = await this.#pool.connect();
    try {
      const { rows } = await client.query<{ id: string | null }>(
        'SELECT app_register_password_user($1, $2, $3) AS id',
        [email, passwordHash, timezone],
      );
      return rows[0]?.id ?? null;
    } finally {
      client.release();
    }
  }

  async passwordCredential(email: string): Promise<{
    userId: string; passwordHash: string; failedAttempts: number;
    lockedUntil: Date | null; deactivated: boolean;
  } | null> {
    const client = await this.#pool.connect();
    try {
      const { rows } = await client.query<{
        user_id: string; password_hash: string; failed_attempts: number;
        locked_until: Date | null; deactivated: boolean;
      }>(
        'SELECT user_id, password_hash, failed_attempts, locked_until, deactivated'
        + ' FROM app_password_credential($1)', [email],
      );
      const row = rows[0];
      if (!row) return null;
      return {
        userId: row.user_id, passwordHash: row.password_hash,
        failedAttempts: row.failed_attempts, lockedUntil: row.locked_until,
        deactivated: row.deactivated,
      };
    } finally {
      client.release();
    }
  }

  async recordLoginAttempt(
    userId: string, success: boolean, maxAttempts: number, lockSeconds: number,
  ): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query('SELECT app_record_login_attempt($1, $2, $3, $4)',
        [userId, success, maxAttempts, lockSeconds]);
    } finally {
      client.release();
    }
  }

  /**
   * Records the token AND queues its delivery in one transaction, inside the
   * SECURITY DEFINER function — a reset happens with no user context, so the
   * outbox insert cannot go through the owner-scoped policies.
   */
  async createPasswordReset(
    email: string, tokenHash: string, ttlSeconds: number, payload: unknown,
  ): Promise<string | null> {
    const client = await this.#pool.connect();
    try {
      const { rows } = await client.query<{ id: string | null }>(
        'SELECT app_create_password_reset($1, $2, $3, $4::jsonb) AS id',
        [email, tokenHash, ttlSeconds, JSON.stringify(payload)],
      );
      return rows[0]?.id ?? null;
    } finally {
      client.release();
    }
  }

  /** Atomically claims the token. A second redemption of the same token gets null. */
  async redeemPasswordReset(tokenHash: string): Promise<string | null> {
    const client = await this.#pool.connect();
    try {
      const { rows } = await client.query<{ id: string | null }>(
        'SELECT app_redeem_password_reset($1) AS id', [tokenHash]);
      return rows[0]?.id ?? null;
    } finally {
      client.release();
    }
  }

  /** Invalidates every session cookie already issued for this user. */
  async bumpSessionEpoch(userId: string): Promise<number> {
    const client = await this.#pool.connect();
    try {
      const { rows } = await client.query<{ epoch: number }>(
        'SELECT app_bump_session_epoch($1) AS epoch', [userId]);
      return rows[0]?.epoch ?? 1;
    } finally {
      client.release();
    }
  }

  async setPassword(userId: string, passwordHash: string): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query('SELECT app_set_password($1, $2)', [userId, passwordHash]);
    } finally {
      client.release();
    }
  }

  /**
   * Read/write transaction bound to one user. All business invariants that span
   * rows (budget sums, refund limits, void-and-replace) live inside one of these.
   */
  async withUserTransaction<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.#transaction(userId, 'BEGIN', fn);
  }

  /**
   * Reporting reads. ONE consistent snapshot, so spending, weights and activity
   * cannot be read from different moments and disagree.
   */
  async withReadSnapshot<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.#transaction(userId, 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY', fn);
  }

  async #transaction<T>(userId: string, begin: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    if (!UUID.test(userId)) throw new Error('withUserTransaction requires a verified uuid');
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      const client = await this.#pool.connect();
      try {
        await client.query(begin);
        // `true` => transaction-local. Never session-local on a pooled connection.
        await client.query('SELECT set_config($1, $2, true)', ['app.user_id', userId]);
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          /* the connection is already broken; releasing it is enough */
        }
        lastError = error;
        const code = pgErrorCode(error);
        if (code !== null && RETRYABLE.has(code) && attempt < MAX_TRANSACTION_ATTEMPTS) continue;
        throw error;
      } finally {
        client.release();
      }
    }
    throw lastError;
  }
}
