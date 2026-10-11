export interface OidcConfig {
    readonly issuer: string;
    readonly audience: string;
    readonly jwksUrl: string;
    readonly clientId: string | null;
}
export interface SupabaseConfig {
    readonly jwtSecret: string;
}
export interface AppConfig {
    readonly nodeEnv: 'development' | 'test' | 'production';
    readonly isProduction: boolean;
    readonly port: number;
    readonly host: string;
    readonly webOrigin: string;
    readonly logLevel: string;
    readonly databaseUrl: string;
    readonly dbPoolMax: number;
    readonly dbStatementTimeoutMs: number;
    readonly authMode: 'password' | 'oidc' | 'supabase';
    readonly loginMaxAttempts: number;
    readonly loginLockSeconds: number;
    readonly authRateLimitMax: number;
    readonly passwordResetTtlSeconds: number;
    readonly serveWeb: boolean;
    readonly authRateLimitWindow: string;
    readonly sessionCookieName: string;
    readonly sessionSecret: string;
    readonly sessionTtlSeconds: number;
    /** Present if and only if authMode === 'oidc'. The adapter never falls back. */
    readonly oidc: OidcConfig | null;
    /** Present if and only if authMode === 'supabase'. */
    readonly supabase: SupabaseConfig | null;
    readonly rateLimitMax: number;
    readonly rateLimitWindowMs: number;
    readonly bodyLimitBytes: number;
}
export declare class ConfigError extends Error {
    constructor(message: string);
}
export declare function loadConfig(source?: NodeJS.ProcessEnv): AppConfig;
//# sourceMappingURL=config.d.ts.map