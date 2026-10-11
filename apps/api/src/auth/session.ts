/**
 * Session cookie.
 *
 * The cookie carries only (issuer, subject, expiry) and is HMAC-signed by
 * @fastify/cookie. It is httpOnly (no script access), sameSite=lax (a cross-site
 * POST cannot ride it), and `secure` in production. The INTERNAL user id is never
 * placed in the cookie: it is resolved server-side on every request, which is also
 * what makes an immediate deactivation take effect immediately.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
// The plugin's type augmentation must be loaded for reply.setCookie / request.cookies.
import '@fastify/cookie';
import type { AppConfig } from '../config.js';

export interface SessionPayload {
  readonly iss: string;
  readonly sub: string;
  /** Unix seconds. */
  readonly exp: number;
  /**
   * The account's session epoch when this cookie was minted. Changing a password
   * increments the stored epoch, so every cookie issued before it stops
   * validating. Without this a reset would leave an attacker's session alive —
   * which is precisely the situation a reset is usually for.
   */
  readonly ep: number;
}

export function encodeSession(payload: SessionPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeSession(raw: string): SessionPayload | null {
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { iss, sub, exp, ep } = parsed as Record<string, unknown>;
    if (typeof iss !== 'string' || iss === '') return null;
    if (typeof sub !== 'string' || sub === '') return null;
    if (typeof exp !== 'number' || !Number.isFinite(exp)) return null;
    if (exp * 1000 <= Date.now()) return null;
    // A cookie without an epoch predates session revocation; refuse it rather
    // than treat a missing value as "any epoch".
    if (typeof ep !== 'number' || !Number.isInteger(ep)) return null;
    return { iss, sub, exp, ep };
  } catch {
    return null;
  }
}

export function issueSessionCookie(
  reply: FastifyReply,
  config: AppConfig,
  identity: { issuer: string; subject: string; sessionEpoch: number },
): void {
  const exp = Math.floor(Date.now() / 1000) + config.sessionTtlSeconds;
  void reply.setCookie(config.sessionCookieName, encodeSession({
    iss: identity.issuer, sub: identity.subject, exp, ep: identity.sessionEpoch,
  }), {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProduction,
    signed: true,
    maxAge: config.sessionTtlSeconds,
  });
}

export function clearSessionCookie(reply: FastifyReply, config: AppConfig): void {
  void reply.clearCookie(config.sessionCookieName, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProduction,
  });
}

export function readSessionCookie(request: FastifyRequest, config: AppConfig): SessionPayload | null {
  const raw = request.cookies[config.sessionCookieName];
  if (typeof raw !== 'string' || raw === '') return null;
  const unsigned = request.unsignCookie(raw);
  if (!unsigned.valid || unsigned.value === null) return null;
  return decodeSession(unsigned.value);
}
