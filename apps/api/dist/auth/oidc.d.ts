import type { OidcConfig } from '../config.js';
export interface VerifiedIdentity {
    readonly issuer: string;
    readonly subject: string;
}
export declare class OidcVerifier {
    #private;
    constructor(config: OidcConfig);
    verify(token: string): Promise<VerifiedIdentity>;
}
/**
 * Fails closed. Called only when AUTH_MODE=oidc, which `loadConfig` has already
 * proven carries a complete OIDC configuration.
 */
export declare function createOidcVerifier(config: OidcConfig | null): OidcVerifier;
//# sourceMappingURL=oidc.d.ts.map