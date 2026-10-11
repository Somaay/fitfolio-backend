import { createRemoteJWKSet, jwtVerify, decodeProtectedHeader } from 'jose';
import { ApiError } from '@hi/contracts';

export interface SupabaseConfig {
  readonly jwtSecret: string;
}

export function createSupabaseVerifier(config: SupabaseConfig, databaseUrl?: string) {
  let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
  const secretKey = new TextEncoder().encode(config.jwtSecret);

  if (databaseUrl && databaseUrl.includes('.supabase.co')) {
    try {
      const dbHost = new URL(databaseUrl).hostname;
      const projectHost = dbHost.replace(/^db\./, '');
      const jwksUrl = new URL(`https://${projectHost}/auth/v1/.well-known/jwks.json`);
      jwks = createRemoteJWKSet(jwksUrl);
    } catch {
      // ignore
    }
  }

  return {
    async verify(token: string): Promise<{ issuer: string; subject: string }> {
      try {
        const header = decodeProtectedHeader(token);
        const verifier = (header.alg === 'HS256' || !jwks) ? secretKey : jwks;
        
        const { payload } = await jwtVerify(token, verifier);

        
        const subject = payload.sub;
        if (typeof subject !== 'string') {
          throw new ApiError('unauthenticated', 'invalid token subject');
        }
        
        const issuer = typeof payload.iss === 'string' ? payload.iss : 'supabase';
        return { issuer, subject };
      } catch (error) {
        console.error('[supabase-auth] JWT verification failed:', error);
        throw new ApiError('unauthenticated', 'invalid or expired token');
      }
    }
  };
}
