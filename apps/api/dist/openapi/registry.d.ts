/**
 * One registration point for every route.
 *
 * `defineRoute` both registers the Fastify handler and records the description,
 * so the emitted OpenAPI document cannot drift from what the server actually
 * serves: there is no second, hand-maintained list to forget.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeAny } from 'zod';
export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
export interface RouteSpec {
    readonly method: HttpMethod;
    /** Fastify path, e.g. `/v1/plans/:planId`. */
    readonly url: string;
    readonly operationId: string;
    readonly summary: string;
    readonly description?: string;
    readonly tags: readonly string[];
    readonly auth: boolean;
    readonly body?: ZodTypeAny;
    readonly query?: ZodTypeAny;
    /** Accepts `Idempotency-Key` and replays the stored response. */
    readonly idempotent?: boolean;
    /** Requires `If-Match: "<version>"`. */
    readonly ifMatch?: boolean;
    /**
     * A stricter per-IP budget than the global one. Used on the credential
     * endpoints: the per-account lockout stops brute force against ONE account,
     * this stops one address spraying many accounts.
     */
    readonly rateLimit?: {
        readonly max: number;
        readonly timeWindow: string;
    };
    /**
     * Keep this route out of the request log. Used for the health endpoints: a
     * platform probes them every few seconds, and two log lines per probe is tens
     * of thousands of entries a day that bury anything worth reading.
     */
    readonly quiet?: boolean;
    readonly responses: Readonly<Record<number, string>>;
}
export declare function registeredRoutes(): readonly RouteSpec[];
export declare function resetRegistry(): void;
export declare function defineRoute(app: FastifyInstance, spec: RouteSpec, handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>): void;
//# sourceMappingURL=registry.d.ts.map