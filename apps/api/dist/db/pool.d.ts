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
export interface Tx {
    query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params?: readonly unknown[]): Promise<pg.QueryResult<R>>;
}
export type SqlParams = readonly unknown[];
/** Postgres error codes we translate rather than leak as a 500. */
export declare const PG: {
    readonly uniqueViolation: "23505";
    readonly foreignKeyViolation: "23503";
    readonly checkViolation: "23514";
    readonly notNullViolation: "23502";
    readonly serializationFailure: "40001";
    readonly deadlockDetected: "40P01";
    readonly insufficientPrivilege: "42501";
};
export declare function pgErrorCode(error: unknown): string | null;
export declare function pgConstraint(error: unknown): string | null;
export declare class Database {
    #private;
    constructor(config: AppConfig);
    close(): Promise<void>;
    /** Liveness of the connection pool only — no user context, no owned rows. */
    ping(): Promise<void>;
    /**
     * Identity bootstrap runs BEFORE any user context exists, so it cannot go
     * through the owner-scoped policies. `app_resolve_identity` is the single
     * narrow SECURITY DEFINER operation granted for that.
     */
    resolveIdentity(issuer: string, subject: string, timezone: string): Promise<{
        userId: string;
        isNew: boolean;
        deactivated: boolean;
        sessionEpoch: number;
    } | null>;
    /**
     * Credential operations. Like identity bootstrap these run with NO user
     * context — you cannot be scoped to yourself before you have proved who you
     * are — so each goes through one narrow SECURITY DEFINER function rather than
     * a policy bypass. The password hash is never exposed to the ordinary grants.
     */
    registerPasswordUser(email: string, passwordHash: string, timezone: string): Promise<string | null>;
    passwordCredential(email: string): Promise<{
        userId: string;
        passwordHash: string;
        failedAttempts: number;
        lockedUntil: Date | null;
        deactivated: boolean;
    } | null>;
    recordLoginAttempt(userId: string, success: boolean, maxAttempts: number, lockSeconds: number): Promise<void>;
    /**
     * Records the token AND queues its delivery in one transaction, inside the
     * SECURITY DEFINER function — a reset happens with no user context, so the
     * outbox insert cannot go through the owner-scoped policies.
     */
    createPasswordReset(email: string, tokenHash: string, ttlSeconds: number, payload: unknown): Promise<string | null>;
    /** Atomically claims the token. A second redemption of the same token gets null. */
    redeemPasswordReset(tokenHash: string): Promise<string | null>;
    /** Invalidates every session cookie already issued for this user. */
    bumpSessionEpoch(userId: string): Promise<number>;
    setPassword(userId: string, passwordHash: string): Promise<void>;
    /**
     * Read/write transaction bound to one user. All business invariants that span
     * rows (budget sums, refund limits, void-and-replace) live inside one of these.
     */
    withUserTransaction<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T>;
    /**
     * Reporting reads. ONE consistent snapshot, so spending, weights and activity
     * cannot be read from different moments and disagree.
     */
    withReadSnapshot<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T>;
}
//# sourceMappingURL=pool.d.ts.map