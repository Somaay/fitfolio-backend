/**
 * Session endpoints.
 *
 * Two real modes, no backdoor:
 *   password — first-party email + password, hashed with scrypt (see password.ts)
 *   oidc     — an external provider, verified against its published JWKS
 *
 * Deliberate choices in the password flow:
 *   - Sign-in answers identically for "no such account" and "wrong password",
 *     and spends comparable time in both cases, so neither reveals whether an
 *     address is registered.
 *   - Registration answers identically whether or not the address was taken.
 *   - Repeated failures lock the CREDENTIAL, not the IP, so rotating addresses
 *     does not reset the budget.
 */
import type { FastifyInstance } from 'fastify';
export declare function registerAuthRoutes(app: FastifyInstance): void;
//# sourceMappingURL=routes.d.ts.map