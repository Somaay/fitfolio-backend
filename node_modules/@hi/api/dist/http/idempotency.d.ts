import type { Tx } from '../db/pool.js';
export interface IdempotentOutcome {
    readonly status: number;
    readonly body: unknown;
    readonly resourceId?: string | null;
}
export declare function readIdempotencyKey(headers: Record<string, unknown>): string | null;
/**
 * Stable serialisation: object keys sorted at every depth so that two logically
 * identical bodies hash identically regardless of key order on the wire.
 */
export declare function canonicalize(value: unknown): string;
export declare function requestHash(route: string, body: unknown): string;
/**
 * `route` must be the ROUTE TEMPLATE plus its concrete path ids (for example
 * `POST /v1/plans/{id}/expenses:<plan uuid>`), so the same key used against two
 * different plans is two different reservations.
 */
export declare function runIdempotent(tx: Tx, args: {
    userId: string;
    route: string;
    key: string | null;
    body: unknown;
}, mutate: () => Promise<IdempotentOutcome>): Promise<{
    outcome: IdempotentOutcome;
    replayed: boolean;
}>;
//# sourceMappingURL=idempotency.d.ts.map