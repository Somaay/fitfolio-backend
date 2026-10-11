/**
 * Database access.
 *
 * Every statement runs as the RESTRICTED api login (never the migration owner),
 * so `FORCE ROW LEVEL SECURITY` genuinely applies. Row ownership is carried by
 * `app.user_id`, set with set_config(..., true) — TRANSACTION-local, so a pooled
 * connection can never leak one user's context into the next user's queries.
 */
import pg from 'pg';
/**
 * A business DATE is a date, not an instant. node-postgres otherwise hands back a
 * JS Date at the SERVER's local midnight, which shifts `paid_on` by a day for any
 * process not running in UTC. Keep the wire text exactly as Postgres wrote it.
 */
pg.types.setTypeParser(1082, (value) => value);
/** Postgres error codes we translate rather than leak as a 500. */
export const PG = {
    uniqueViolation: '23505',
    foreignKeyViolation: '23503',
    checkViolation: '23514',
    notNullViolation: '23502',
    serializationFailure: '40001',
    deadlockDetected: '40P01',
    insufficientPrivilege: '42501',
};
export function pgErrorCode(error) {
    if (typeof error === 'object' && error !== null && 'code' in error) {
        const code = error.code;
        return typeof code === 'string' ? code : null;
    }
    return null;
}
export function pgConstraint(error) {
    if (typeof error === 'object' && error !== null && 'constraint' in error) {
        const c = error.constraint;
        return typeof c === 'string' ? c : null;
    }
    return null;
}
const RETRYABLE = new Set([PG.serializationFailure, PG.deadlockDetected]);
const MAX_TRANSACTION_ATTEMPTS = 3;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export class Database {
    #pool;
    constructor(config) {
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
    async close() {
        await this.#pool.end();
    }
    /** Liveness of the connection pool only — no user context, no owned rows. */
    async ping() {
        const client = await this.#pool.connect();
        try {
            await client.query('SELECT 1');
        }
        finally {
            client.release();
        }
    }
    /**
     * Identity bootstrap runs BEFORE any user context exists, so it cannot go
     * through the owner-scoped policies. `app_resolve_identity` is the single
     * narrow SECURITY DEFINER operation granted for that.
     */
    async resolveIdentity(issuer, subject, timezone) {
        const client = await this.#pool.connect();
        try {
            const { rows } = await client.query('SELECT user_id, is_new, deactivated, session_epoch FROM app_resolve_identity($1, $2, $3)', [issuer, subject, timezone]);
            const row = rows[0];
            if (!row || row.user_id === null)
                return null;
            return {
                userId: row.user_id, isNew: row.is_new,
                deactivated: row.deactivated, sessionEpoch: row.session_epoch,
            };
        }
        finally {
            client.release();
        }
    }
    /**
     * Credential operations. Like identity bootstrap these run with NO user
     * context — you cannot be scoped to yourself before you have proved who you
     * are — so each goes through one narrow SECURITY DEFINER function rather than
     * a policy bypass. The password hash is never exposed to the ordinary grants.
     */
    async registerPasswordUser(email, passwordHash, timezone) {
        const client = await this.#pool.connect();
        try {
            const { rows } = await client.query('SELECT app_register_password_user($1, $2, $3) AS id', [email, passwordHash, timezone]);
            return rows[0]?.id ?? null;
        }
        finally {
            client.release();
        }
    }
    async passwordCredential(email) {
        const client = await this.#pool.connect();
        try {
            const { rows } = await client.query('SELECT user_id, password_hash, failed_attempts, locked_until, deactivated'
                + ' FROM app_password_credential($1)', [email]);
            const row = rows[0];
            if (!row)
                return null;
            return {
                userId: row.user_id, passwordHash: row.password_hash,
                failedAttempts: row.failed_attempts, lockedUntil: row.locked_until,
                deactivated: row.deactivated,
            };
        }
        finally {
            client.release();
        }
    }
    async recordLoginAttempt(userId, success, maxAttempts, lockSeconds) {
        const client = await this.#pool.connect();
        try {
            await client.query('SELECT app_record_login_attempt($1, $2, $3, $4)', [userId, success, maxAttempts, lockSeconds]);
        }
        finally {
            client.release();
        }
    }
    /**
     * Records the token AND queues its delivery in one transaction, inside the
     * SECURITY DEFINER function — a reset happens with no user context, so the
     * outbox insert cannot go through the owner-scoped policies.
     */
    async createPasswordReset(email, tokenHash, ttlSeconds, payload) {
        const client = await this.#pool.connect();
        try {
            const { rows } = await client.query('SELECT app_create_password_reset($1, $2, $3, $4::jsonb) AS id', [email, tokenHash, ttlSeconds, JSON.stringify(payload)]);
            return rows[0]?.id ?? null;
        }
        finally {
            client.release();
        }
    }
    /** Atomically claims the token. A second redemption of the same token gets null. */
    async redeemPasswordReset(tokenHash) {
        const client = await this.#pool.connect();
        try {
            const { rows } = await client.query('SELECT app_redeem_password_reset($1) AS id', [tokenHash]);
            return rows[0]?.id ?? null;
        }
        finally {
            client.release();
        }
    }
    /** Invalidates every session cookie already issued for this user. */
    async bumpSessionEpoch(userId) {
        const client = await this.#pool.connect();
        try {
            const { rows } = await client.query('SELECT app_bump_session_epoch($1) AS epoch', [userId]);
            return rows[0]?.epoch ?? 1;
        }
        finally {
            client.release();
        }
    }
    async setPassword(userId, passwordHash) {
        const client = await this.#pool.connect();
        try {
            await client.query('SELECT app_set_password($1, $2)', [userId, passwordHash]);
        }
        finally {
            client.release();
        }
    }
    /**
     * Read/write transaction bound to one user. All business invariants that span
     * rows (budget sums, refund limits, void-and-replace) live inside one of these.
     */
    async withUserTransaction(userId, fn) {
        return this.#transaction(userId, 'BEGIN', fn);
    }
    /**
     * Reporting reads. ONE consistent snapshot, so spending, weights and activity
     * cannot be read from different moments and disagree.
     */
    async withReadSnapshot(userId, fn) {
        return this.#transaction(userId, 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY', fn);
    }
    async #transaction(userId, begin, fn) {
        if (!UUID.test(userId))
            throw new Error('withUserTransaction requires a verified uuid');
        let lastError;
        for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
            const client = await this.#pool.connect();
            try {
                await client.query(begin);
                // `true` => transaction-local. Never session-local on a pooled connection.
                await client.query('SELECT set_config($1, $2, true)', ['app.user_id', userId]);
                const result = await fn(client);
                await client.query('COMMIT');
                return result;
            }
            catch (error) {
                try {
                    await client.query('ROLLBACK');
                }
                catch {
                    /* the connection is already broken; releasing it is enough */
                }
                lastError = error;
                const code = pgErrorCode(error);
                if (code !== null && RETRYABLE.has(code) && attempt < MAX_TRANSACTION_ATTEMPTS)
                    continue;
                throw error;
            }
            finally {
                client.release();
            }
        }
        throw lastError;
    }
}
//# sourceMappingURL=pool.js.map