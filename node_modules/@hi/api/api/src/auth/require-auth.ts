/**
 * Authentication hook.
 *
 * Ownership is derived HERE and nowhere else: a `user_id` in a request body is
 * ignored entirely. The internal id comes from `app_resolve_identity`, the one
 * narrow SECURITY DEFINER lookup the API is granted.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiError } from '@hi/contracts';
import type { AuthenticatedUser } from '../types.js';
import { readSessionCookie } from './session.js';

/** Issuer recorded on accounts that sign in with a first-party password. */
export const PASSWORD_ISSUER = 'password';

function bearerToken(request: FastifyRequest): string | null {
  const raw = request.headers.authorization;
  if (typeof raw !== 'string') return null;
  const match = /^Bearer[ ]+(\S+)$/i.exec(raw.trim());
  return match?.[1] ?? null;
}

export async function authenticate(app: FastifyInstance, request: FastifyRequest): Promise<AuthenticatedUser> {
  let issuer: string | null = null;
  let subject: string | null = null;

  // A bearer id-token is accepted only in oidc mode, and only by the verifier.
  if (app.config.authMode === 'oidc') {
    const token = bearerToken(request);
    if (token !== null) {
      if (app.oidc === null) throw new ApiError('unauthenticated', 'identity verification is unavailable');
      const verified = await app.oidc.verify(token);
      issuer = verified.issuer;
      subject = verified.subject;
    }
  }

  let cookieEpoch: number | null = null;
  if (issuer === null || subject === null) {
    const session = readSessionCookie(request, app.config);
    if (session === null) throw new ApiError('unauthenticated', 'sign in to continue');
    cookieEpoch = session.ep;
    // A cookie minted under a different AUTH_MODE must not be honoured.
    const expectedIssuer = app.config.authMode === 'password'
      ? PASSWORD_ISSUER
      : app.config.oidc?.issuer ?? '';
    if (session.iss !== expectedIssuer) throw new ApiError('unauthenticated', 'sign in to continue');
    issuer = session.iss;
    subject = session.sub;
  }

  const identity = await app.db.resolveIdentity(issuer, subject, 'UTC');
  if (identity === null) throw new ApiError('unauthenticated', 'sign in to continue');
  // A cookie minted before the latest password change is no longer a session.
  if (cookieEpoch !== null && cookieEpoch !== identity.sessionEpoch) {
    throw new ApiError('unauthenticated', 'your password changed; sign in again');
  }
  // Deletion deactivates the account immediately, before the erasure job runs.
  if (identity.deactivated) throw new ApiError('forbidden', 'this account has been deactivated');

  return { userId: identity.userId, issuer, subject };
}

export function registerAuth(app: FastifyInstance): void {
  app.decorateRequest('auth', null);
}

/** preHandler for every owned route. */
export function requireAuth(app: FastifyInstance) {
  return async function requireAuthHook(request: FastifyRequest): Promise<void> {
    request.auth = await authenticate(app, request);
  };
}

export function currentUser(request: FastifyRequest): AuthenticatedUser {
  if (request.auth === null) throw new ApiError('unauthenticated', 'sign in to continue');
  return request.auth;
}
