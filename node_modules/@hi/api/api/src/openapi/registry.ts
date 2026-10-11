/**
 * One registration point for every route.
 *
 * `defineRoute` both registers the Fastify handler and records the description,
 * so the emitted OpenAPI document cannot drift from what the server actually
 * serves: there is no second, hand-maintained list to forget.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import type { ZodTypeAny } from 'zod';
import { requireAuth } from '../auth/require-auth.js';

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
  readonly rateLimit?: { readonly max: number; readonly timeWindow: string };
  /**
   * Keep this route out of the request log. Used for the health endpoints: a
   * platform probes them every few seconds, and two log lines per probe is tens
   * of thousands of entries a day that bury anything worth reading.
   */
  readonly quiet?: boolean;
  readonly responses: Readonly<Record<number, string>>;
}

const registry: RouteSpec[] = [];

export function registeredRoutes(): readonly RouteSpec[] {
  return registry;
}

export function resetRegistry(): void {
  registry.length = 0;
}

export function defineRoute(
  app: FastifyInstance,
  spec: RouteSpec,
  handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
): void {
  if (!registry.some((r) => r.method === spec.method && r.url === spec.url)) registry.push(spec);
  app.route({
    method: spec.method,
    url: spec.url,
    ...(spec.auth ? { preHandler: requireAuth(app) } : {}),
    ...(spec.rateLimit ? { config: { rateLimit: spec.rateLimit } } : {}),
    ...(spec.quiet ? { logLevel: 'silent' as const } : {}),
    handler: handler as RouteHandlerMethod,
  });
}
