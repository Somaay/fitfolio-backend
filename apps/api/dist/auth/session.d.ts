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
export declare function encodeSession(payload: SessionPayload): string;
export declare function decodeSession(raw: string): SessionPayload | null;
export declare function issueSessionCookie(reply: FastifyReply, config: AppConfig, identity: {
    issuer: string;
    subject: string;
    sessionEpoch: number;
}): void;
export declare function clearSessionCookie(reply: FastifyReply, config: AppConfig): void;
export declare function readSessionCookie(request: FastifyRequest, config: AppConfig): SessionPayload | null;
//# sourceMappingURL=session.d.ts.map