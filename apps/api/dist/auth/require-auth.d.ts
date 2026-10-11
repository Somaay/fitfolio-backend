/**
 * Authentication hook.
 *
 * Ownership is derived HERE and nowhere else: a `user_id` in a request body is
 * ignored entirely. The internal id comes from `app_resolve_identity`, the one
 * narrow SECURITY DEFINER lookup the API is granted.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuthenticatedUser } from '../types.js';
/** Issuer recorded on accounts that sign in with a first-party password. */
export declare const PASSWORD_ISSUER = "password";
export declare function authenticate(app: FastifyInstance, request: FastifyRequest): Promise<AuthenticatedUser>;
export declare function registerAuth(app: FastifyInstance): void;
/** preHandler for every owned route. */
export declare function requireAuth(app: FastifyInstance): (request: FastifyRequest) => Promise<void>;
export declare function currentUser(request: FastifyRequest): AuthenticatedUser;
//# sourceMappingURL=require-auth.d.ts.map