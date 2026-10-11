/**
 * Idempotent writes.
 *
 * Everything below happens inside ONE transaction:
 *   1. reserve (user_id, route, key)   -- the primary key serialises racers
 *   2. compare the canonical request hash
 *   3. perform the mutation
 *   4. store response_status + response_body
 *   5. COMMIT
 *
 * A replay returns the STORED BODY, not a fresh read of the resource: by the time
 * a client retries, the resource may already have been corrected or voided, and
 * re-reading it would answer a different question than the one that was asked
 * (D-12).
 *
 * A failed mutation rolls the reservation back with the rest of the transaction,
 * so a retry after an error is free to succeed.
 */
import { createHash } from 'node:crypto';
import { ApiError } from '@hi/contracts';
const MAX_KEY_LENGTH = 128;
export function readIdempotencyKey(headers) {
    const raw = headers['idempotency-key'];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value !== 'string' || value.trim() === '')
        return null;
    const key = value.trim();
    if (key.length > MAX_KEY_LENGTH) {
        throw new ApiError('malformed_request', 'Idempotency-Key is too long', [
            { path: 'Idempotency-Key', message: `at most ${MAX_KEY_LENGTH} characters` },
        ]);
    }
    return key;
}
/**
 * Stable serialisation: object keys sorted at every depth so that two logically
 * identical bodies hash identically regardless of key order on the wire.
 */
export function canonicalize(value) {
    if (value === null || typeof value !== 'object')
        return JSON.stringify(value ?? null) ?? 'null';
    if (Array.isArray(value))
        return `[${value.map(canonicalize).join(',')}]`;
    const entries = Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
}
export function requestHash(route, body) {
    return createHash('sha256').update(`${route}\n${canonicalize(body)}`).digest('hex');
}
/**
 * `route` must be the ROUTE TEMPLATE plus its concrete path ids (for example
 * `POST /v1/plans/{id}/expenses:<plan uuid>`), so the same key used against two
 * different plans is two different reservations.
 */
export async function runIdempotent(tx, args, mutate) {
    if (args.key === null) {
        return { outcome: await mutate(), replayed: false };
    }
    const hash = requestHash(args.route, args.body);
    // The PRIMARY KEY is the serialisation point. A concurrent caller with the same
    // key blocks here until we commit or roll back, so exactly one mutation happens.
    const reserved = await tx.query(`INSERT INTO idempotency_keys (user_id, route, key, request_hash)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, route, key) DO NOTHING
     RETURNING key`, [args.userId, args.route, args.key, hash]);
    if ((reserved.rowCount ?? 0) === 0) {
        // Someone got there first. Take the row lock so we observe its committed state.
        const existing = await tx.query(`SELECT request_hash, response_status, response_body, resource_id, completed_at
         FROM idempotency_keys
        WHERE user_id = $1 AND route = $2 AND key = $3
        FOR UPDATE`, [args.userId, args.route, args.key]);
        const row = existing.rows[0];
        if (row) {
            if (row.request_hash !== hash) {
                throw new ApiError('idempotency_key_conflict', 'this Idempotency-Key was already used with a different request body');
            }
            if (row.completed_at !== null && row.response_status !== null) {
                return {
                    outcome: { status: row.response_status, body: row.response_body, resourceId: row.resource_id },
                    replayed: true,
                };
            }
            // Reserved but never completed: the original transaction rolled back after
            // committing nothing, or is a stale row. Fall through and do the work.
        }
        else {
            // The winner rolled back and its reservation vanished. Claim it ourselves.
            const retry = await tx.query(`INSERT INTO idempotency_keys (user_id, route, key, request_hash)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, route, key) DO NOTHING
         RETURNING key`, [args.userId, args.route, args.key, hash]);
            if ((retry.rowCount ?? 0) === 0) {
                throw new ApiError('state_conflict', 'a concurrent request with this idempotency key is in flight');
            }
        }
    }
    const outcome = await mutate();
    // response_status is CHECKed to 2xx: only a success is ever replayable.
    await tx.query(`UPDATE idempotency_keys
        SET resource_id = $4, response_status = $5, response_body = $6::jsonb, completed_at = now()
      WHERE user_id = $1 AND route = $2 AND key = $3`, [
        args.userId, args.route, args.key,
        outcome.resourceId ?? null, outcome.status, JSON.stringify(outcome.body ?? null),
    ]);
    return { outcome, replayed: false };
}
//# sourceMappingURL=idempotency.js.map