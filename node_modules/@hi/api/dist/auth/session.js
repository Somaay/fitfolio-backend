// The plugin's type augmentation must be loaded for reply.setCookie / request.cookies.
import '@fastify/cookie';
export function encodeSession(payload) {
    return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}
export function decodeSession(raw) {
    try {
        const json = Buffer.from(raw, 'base64url').toString('utf8');
        const parsed = JSON.parse(json);
        if (typeof parsed !== 'object' || parsed === null)
            return null;
        const { iss, sub, exp, ep } = parsed;
        if (typeof iss !== 'string' || iss === '')
            return null;
        if (typeof sub !== 'string' || sub === '')
            return null;
        if (typeof exp !== 'number' || !Number.isFinite(exp))
            return null;
        if (exp * 1000 <= Date.now())
            return null;
        // A cookie without an epoch predates session revocation; refuse it rather
        // than treat a missing value as "any epoch".
        if (typeof ep !== 'number' || !Number.isInteger(ep))
            return null;
        return { iss, sub, exp, ep };
    }
    catch {
        return null;
    }
}
export function issueSessionCookie(reply, config, identity) {
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
export function clearSessionCookie(reply, config) {
    void reply.clearCookie(config.sessionCookieName, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: config.isProduction,
    });
}
export function readSessionCookie(request, config) {
    const raw = request.cookies[config.sessionCookieName];
    if (typeof raw !== 'string' || raw === '')
        return null;
    const unsigned = request.unsignCookie(raw);
    if (!unsigned.valid || unsigned.value === null)
        return null;
    return decodeSession(unsigned.value);
}
//# sourceMappingURL=session.js.map