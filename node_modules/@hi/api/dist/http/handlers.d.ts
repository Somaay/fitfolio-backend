/** Transaction + idempotency plumbing shared by every mutating route. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Tx } from '../db/pool.js';
import type { AuthenticatedUser } from '../types.js';
import { type IdempotentOutcome } from './idempotency.js';
export interface MutationContext {
    readonly tx: Tx;
    readonly user: AuthenticatedUser;
    readonly requestId: string;
}
/**
 * Reserve the key, mutate and store the replay body — all in ONE transaction, so
 * a failure rolls the reservation back with the work and a retry can succeed.
 */
export declare function mutate(app: FastifyInstance, request: FastifyRequest, reply: FastifyReply, routeKey: string, run: (ctx: MutationContext) => Promise<IdempotentOutcome>): Promise<void>;
/** A mutation with no idempotency semantics (PATCH/DELETE guarded by If-Match). */
export declare function transact<T>(app: FastifyInstance, request: FastifyRequest, run: (ctx: MutationContext) => Promise<T>): Promise<T>;
export declare function readOnly<T>(app: FastifyInstance, request: FastifyRequest, run: (ctx: MutationContext) => Promise<T>): Promise<T>;
/** Reporting: one REPEATABLE READ snapshot for every fact set. */
export declare function snapshot<T>(app: FastifyInstance, request: FastifyRequest, run: (ctx: MutationContext) => Promise<T>): Promise<T>;
//# sourceMappingURL=handlers.d.ts.map