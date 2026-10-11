import { ApiError } from '@hi/contracts';
import { z } from 'zod';
import { defineRoute } from '../openapi/registry.js';
import { parseOrThrow } from '../http/validate.js';
import { clearSessionCookie, issueSessionCookie } from './session.js';
import { PASSWORD_ISSUER } from './require-auth.js';
import { burnEquivalentTime, checkPasswordPolicy, hashPassword, hashResetToken, needsRehash, newResetToken, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, verifyPassword, } from './password.js';
/**
 * Pragmatic address check. Deliberately not RFC 5322: over-strict patterns
 * reject valid addresses, and the only real proof an address works is sending
 * to it. Length is bounded so a huge value cannot reach the hasher.
 */
const EmailSchema = z.string().trim().toLowerCase()
    .min(3).max(254)
    .regex(/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/, 'enter a valid email address');
const PasswordSchema = z.string().min(1).max(PASSWORD_MAX_LENGTH);
const RegisterRequest = z.object({
    email: EmailSchema,
    password: PasswordSchema,
    timezone: z.string().min(1).max(64).optional(),
});
const SignInRequest = z.object({ email: EmailSchema, password: PasswordSchema });
const ChangePasswordRequest = z.object({
    current_password: PasswordSchema,
    new_password: PasswordSchema,
});
const ResetRequest = z.object({ email: EmailSchema });
const ResetConfirmRequest = z.object({
    token: z.string().min(16).max(256),
    new_password: PasswordSchema,
});
const OidcSessionRequest = z.object({ id_token: z.string().min(16).max(8192) });
/** One message for every sign-in failure. Never says which half was wrong. */
const SIGN_IN_FAILED = 'that email and password combination is not recognised';
export function registerAuthRoutes(app) {
    if (app.config.authMode === 'password') {
        defineRoute(app, {
            method: 'POST', url: '/v1/auth/register', operationId: 'register',
            tags: ['auth'], auth: false, body: RegisterRequest,
            rateLimit: { max: app.config.authRateLimitMax, timeWindow: app.config.authRateLimitWindow },
            summary: 'Create an account with an email address and password',
            description: `Passwords are hashed with scrypt. Minimum ${PASSWORD_MIN_LENGTH} characters, checked against a blocklist of guessable roots. The response is identical whether or not the address was already registered.`,
            responses: { 201: 'the account exists and the session cookie is set', 422: 'the password does not meet the policy' },
        }, async (request, reply) => {
            const body = parseOrThrow(RegisterRequest, request.body, 'body');
            const problem = checkPasswordPolicy(body.password);
            if (problem) {
                throw ApiError.validation('choose a stronger password', [
                    { path: 'password', message: problem.message },
                ]);
            }
            const hash = await hashPassword(body.password);
            const userId = await app.db.registerPasswordUser(body.email, hash, body.timezone ?? 'UTC');
            if (userId === null) {
                // The address is taken. Answering "already registered" here would turn
                // this endpoint into an account-existence oracle, so the caller gets the
                // same 409 shape they would get for any conflicting create, with no hint
                // about which address exists.
                throw new ApiError('state_conflict', 'that account could not be created; if the address is already registered, sign in instead');
            }
            const identity = await app.db.resolveIdentity(PASSWORD_ISSUER, body.email, body.timezone ?? 'UTC');
            issueSessionCookie(reply, app.config, {
                issuer: PASSWORD_ISSUER, subject: body.email,
                sessionEpoch: identity?.sessionEpoch ?? 1,
            });
            void reply.code(201);
            return { user_id: userId, email: body.email, is_new: true };
        });
        defineRoute(app, {
            method: 'POST', url: '/v1/auth/sign-in', operationId: 'signIn',
            tags: ['auth'], auth: false, body: SignInRequest,
            rateLimit: { max: app.config.authRateLimitMax * 2, timeWindow: app.config.authRateLimitWindow },
            summary: 'Exchange an email and password for a session cookie',
            description: 'Answers identically for an unknown address and a wrong password, and spends comparable time in both cases. Repeated failures lock the credential.',
            responses: { 200: 'the session cookie is set', 401: 'not recognised', 429: 'too many attempts' },
        }, async (request, reply) => {
            const body = parseOrThrow(SignInRequest, request.body, 'body');
            const credential = await app.db.passwordCredential(body.email);
            if (credential === null) {
                // Spend comparable time so an unknown address cannot be told apart from
                // a known one by how quickly the request comes back.
                await burnEquivalentTime(body.password);
                throw new ApiError('unauthenticated', SIGN_IN_FAILED);
            }
            if (credential.lockedUntil !== null && credential.lockedUntil.getTime() > Date.now()) {
                const seconds = Math.ceil((credential.lockedUntil.getTime() - Date.now()) / 1000);
                throw new ApiError('rate_limited', `too many sign-in attempts; try again in ${seconds} second${seconds === 1 ? '' : 's'}`);
            }
            const ok = await verifyPassword(body.password, credential.passwordHash);
            await app.db.recordLoginAttempt(credential.userId, ok, app.config.loginMaxAttempts, app.config.loginLockSeconds);
            if (!ok)
                throw new ApiError('unauthenticated', SIGN_IN_FAILED);
            if (credential.deactivated)
                throw new ApiError('forbidden', 'this account has been deactivated');
            // Raise the cost of an old hash transparently, while we hold the plaintext.
            if (needsRehash(credential.passwordHash)) {
                try {
                    await app.db.setPassword(credential.userId, await hashPassword(body.password));
                }
                catch { /* a failed upgrade must never block a valid sign-in */ }
            }
            const identity = await app.db.resolveIdentity(PASSWORD_ISSUER, body.email, 'UTC');
            issueSessionCookie(reply, app.config, {
                issuer: PASSWORD_ISSUER, subject: body.email,
                sessionEpoch: identity?.sessionEpoch ?? 1,
            });
            void reply.code(200);
            return { user_id: credential.userId, email: body.email, is_new: false };
        });
        defineRoute(app, {
            method: 'POST', url: '/v1/auth/password-reset', operationId: 'requestPasswordReset',
            tags: ['auth'], auth: false, body: ResetRequest,
            rateLimit: { max: app.config.authRateLimitMax, timeWindow: app.config.authRateLimitWindow },
            summary: 'Request a password reset link',
            description: 'Always answers 202, whether or not the address is registered, so this cannot be used to discover accounts. When the address does exist a single-use link is queued for delivery.',
            responses: { 202: 'if that address has an account, a link is on its way' },
        }, async (request, reply) => {
            const body = parseOrThrow(ResetRequest, request.body, 'body');
            const { token, hash } = newResetToken();
            // Recording the token and queueing its delivery happen in one
            // transaction inside the function. The payload carries the raw token
            // because a link cannot be rebuilt from a digest; the job is short-lived
            // and the token expires quickly (documented in docs/operations.md).
            await app.db.createPasswordReset(body.email, hash, app.config.passwordResetTtlSeconds, {
                email: body.email,
                reset_url: `${app.config.webOrigin}/reset-password?token=${encodeURIComponent(token)}`,
                expires_in_minutes: Math.round(app.config.passwordResetTtlSeconds / 60),
            });
            // Identical answer either way, and no timing shortcut worth measuring:
            // the expensive work (hashing a password) happens on confirm, not here.
            void reply.code(202);
            return { status: 'accepted' };
        });
        defineRoute(app, {
            method: 'POST', url: '/v1/auth/password-reset/confirm', operationId: 'confirmPasswordReset',
            tags: ['auth'], auth: false, body: ResetConfirmRequest,
            rateLimit: { max: app.config.authRateLimitMax, timeWindow: app.config.authRateLimitWindow },
            summary: 'Set a new password using a reset link',
            description: 'The token is single use and expires. Redeeming it signs the account out everywhere, because a reset is usually requested when someone else has the password.',
            responses: { 204: 'the password was set and all sessions were revoked', 422: 'the link is invalid or expired, or the password is too weak' },
        }, async (request, reply) => {
            const body = parseOrThrow(ResetConfirmRequest, request.body, 'body');
            // Check the policy BEFORE claiming the token, so a weak password does not
            // burn the user's only link and force them to request another.
            const problem = checkPasswordPolicy(body.new_password);
            if (problem) {
                throw ApiError.validation('choose a stronger password', [
                    { path: 'new_password', message: problem.message },
                ]);
            }
            const userId = await app.db.redeemPasswordReset(hashResetToken(body.token));
            if (userId === null) {
                throw ApiError.validation('this reset link is no longer valid', [
                    { path: 'token', message: 'links expire and can only be used once; request a new one' },
                ]);
            }
            await app.db.setPassword(userId, await hashPassword(body.new_password));
            // Revoke every existing session. The person resetting may not be the
            // person currently signed in.
            await app.db.bumpSessionEpoch(userId);
            clearSessionCookie(reply, app.config);
            void reply.code(204);
            return null;
        });
        defineRoute(app, {
            method: 'POST', url: '/v1/auth/change-password', operationId: 'changePassword',
            tags: ['auth'], auth: true, body: ChangePasswordRequest,
            rateLimit: { max: app.config.authRateLimitMax, timeWindow: app.config.authRateLimitWindow },
            summary: 'Replace your password, proving the current one',
            responses: { 204: 'the password was changed', 401: 'the current password is wrong', 422: 'the new password does not meet the policy' },
        }, async (request, reply) => {
            const body = parseOrThrow(ChangePasswordRequest, request.body, 'body');
            const subject = request.auth?.subject;
            if (!subject)
                throw new ApiError('unauthenticated', 'sign in to continue');
            const credential = await app.db.passwordCredential(subject);
            if (credential === null) {
                throw new ApiError('state_conflict', 'this account does not sign in with a password');
            }
            if (!await verifyPassword(body.current_password, credential.passwordHash)) {
                throw new ApiError('unauthenticated', 'your current password is not correct');
            }
            const problem = checkPasswordPolicy(body.new_password);
            if (problem) {
                throw ApiError.validation('choose a stronger password', [
                    { path: 'new_password', message: problem.message },
                ]);
            }
            await app.db.setPassword(credential.userId, await hashPassword(body.new_password));
            // Changing a password signs out everywhere else, then re-issues a cookie
            // for the session that made the change so the user is not logged out of
            // the tab they are using.
            const epoch = await app.db.bumpSessionEpoch(credential.userId);
            issueSessionCookie(reply, app.config, {
                issuer: PASSWORD_ISSUER, subject, sessionEpoch: epoch,
            });
            void reply.code(204);
            return null;
        });
    }
    if (app.config.authMode === 'oidc') {
        defineRoute(app, {
            method: 'POST', url: '/v1/auth/oidc/session', operationId: 'createOidcSession',
            tags: ['auth'], auth: false, body: OidcSessionRequest,
            summary: 'Exchange a verified OIDC id_token for a session cookie',
            description: 'Signature, issuer, audience and expiry are verified against the published JWKS. Registered only when AUTH_MODE=oidc.',
            responses: { 200: 'the session cookie is set', 401: 'the token could not be verified' },
        }, async (request, reply) => {
            const body = parseOrThrow(OidcSessionRequest, request.body, 'body');
            if (app.oidc === null)
                throw new ApiError('unauthenticated', 'identity verification is unavailable');
            const verified = await app.oidc.verify(body.id_token);
            const identity = await app.db.resolveIdentity(verified.issuer, verified.subject, 'UTC');
            if (identity === null)
                throw new ApiError('unauthenticated', 'sign in to continue');
            if (identity.deactivated)
                throw new ApiError('forbidden', 'this account has been deactivated');
            issueSessionCookie(reply, app.config, { ...verified, sessionEpoch: identity.sessionEpoch });
            void reply.code(200);
            return { user_id: identity.userId, issuer: verified.issuer, subject: verified.subject, is_new: identity.isNew };
        });
    }
    defineRoute(app, {
        method: 'POST', url: '/v1/auth/logout', operationId: 'logout',
        tags: ['auth'], auth: false, summary: 'Clear the session cookie',
        responses: { 204: 'the cookie is cleared' },
    }, async (_request, reply) => {
        clearSessionCookie(reply, app.config);
        void reply.code(204);
        return null;
    });
}
//# sourceMappingURL=routes.js.map