import { jwtVerify } from 'jose';
import { ApiError } from '@hi/contracts';
export function createSupabaseVerifier(config) {
    const secretKey = new TextEncoder().encode(config.jwtSecret);
    return {
        async verify(token) {
            try {
                const { payload } = await jwtVerify(token, secretKey);
                const subject = payload.sub;
                if (typeof subject !== 'string') {
                    throw new ApiError('unauthenticated', 'invalid token subject');
                }
                // Supabase often sets issuer but if not, we use 'supabase' as a constant issuer
                const issuer = typeof payload.iss === 'string' ? payload.iss : 'supabase';
                return { issuer, subject };
            }
            catch (error) {
                throw new ApiError('unauthenticated', 'invalid or expired token');
            }
        }
    };
}
//# sourceMappingURL=supabase.js.map