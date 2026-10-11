/**
 * OIDC adapter.
 *
 * Signature, issuer, audience and expiry are all verified by `jose` against the
 * provider's published JWKS. If the OIDC environment is absent the adapter is
 * NEVER constructed and every token verification fails — it does not fall back to
 * the development identity flow. That fallback is exactly how a staging misconfig
 * becomes an authentication bypass.
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { ApiError } from '@hi/contracts';
import type { OidcConfig } from '../config.js';

export interface VerifiedIdentity {
  readonly issuer: string;
  readonly subject: string;
}

export class OidcVerifier {
  readonly #config: OidcConfig;
  readonly #jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(config: OidcConfig) {
    this.#config = config;
    this.#jwks = createRemoteJWKSet(new URL(config.jwksUrl), {
      cacheMaxAge: 10 * 60 * 1000,
      cooldownDuration: 30 * 1000,
    });
  }

  async verify(token: string): Promise<VerifiedIdentity> {
    let payload: JWTPayload;
    try {
      const result = await jwtVerify(token, this.#jwks, {
        issuer: this.#config.issuer,
        audience: this.#config.audience,
        // Reject `alg: none` and symmetric confusion: only asymmetric JWS.
        algorithms: ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'PS256'],
        clockTolerance: 5,
      });
      payload = result.payload;
    } catch {
      // Never echo the provider's reason: it can contain the token itself.
      throw new ApiError('unauthenticated', 'the identity token could not be verified');
    }
    const subject = payload.sub;
    if (typeof subject !== 'string' || subject === '') {
      throw new ApiError('unauthenticated', 'the identity token has no subject');
    }
    if (typeof payload.exp !== 'number') {
      throw new ApiError('unauthenticated', 'the identity token has no expiry');
    }
    return { issuer: this.#config.issuer, subject };
  }
}

/**
 * Fails closed. Called only when AUTH_MODE=oidc, which `loadConfig` has already
 * proven carries a complete OIDC configuration.
 */
export function createOidcVerifier(config: OidcConfig | null): OidcVerifier {
  if (config === null) {
    throw new Error('OIDC verification requested without an OIDC configuration');
  }
  return new OidcVerifier(config);
}
