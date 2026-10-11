/**
 * Environment configuration. Validated once, at startup, and FAILS CLOSED:
 * a misconfigured deployment must refuse to boot rather than silently run with
 * development authentication or an unsigned session cookie.
 */
import { z } from 'zod';

const RawEnv = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // Platforms (Render, Heroku, Fly) inject PORT and expect the process to bind
  // it on 0.0.0.0. API_PORT/API_HOST stay as the explicit local override.
  PORT: z.coerce.number().int().min(1).max(65535).optional(),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  API_HOST: z.string().min(1).optional(),
  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().min(1),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(10_000),

  // Two real modes. There is no development bypass to accidentally ship.
  AUTH_MODE: z.enum(['password', 'oidc', 'supabase', 'jwt']).default('password'),
  /** Failed sign-ins before the credential locks. */
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(3).max(50).default(8),
  /** How long the lock lasts, in seconds. */
  LOGIN_LOCK_SECONDS: z.coerce.number().int().min(30).max(86_400).default(900),
  /**
   * Per-IP budget on the credential endpoints, far tighter than the global
   * limiter. Raised only by the test harness, which drives hundreds of
   * registrations from one address; the per-account lockout above is the
   * defence that must never be relaxed.
   */
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(3).max(1_000_000).default(10),
  /** Reset links are short-lived: long enough to find the email, no longer. */
  PASSWORD_RESET_TTL_SECONDS: z.coerce.number().int().min(300).max(86_400).default(1800),
  /** Serve the built web app from this process (single-origin deployment). */
  SERVE_WEB: z.enum(['true', 'false']).default('false'),
  AUTH_RATE_LIMIT_WINDOW: z.string().min(2).max(32).default('10 minutes'),
  SESSION_COOKIE_NAME: z.string().min(1).max(64).default('hi_session'),
  SESSION_SECRET: z.string().default(''),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(12),

  OIDC_ISSUER: z.string().default(''),
  OIDC_AUDIENCE: z.string().default(''),
  OIDC_JWKS_URL: z.string().default(''),
  OIDC_CLIENT_ID: z.string().default(''),
  OIDC_CLIENT_SECRET: z.string().default(''),

  SUPABASE_JWT_SECRET: z.string().default(''),
  JWT_SECRET: z.string().default(''),

  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(300),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60_000),
  BODY_LIMIT_BYTES: z.coerce.number().int().min(1024).max(2_000_000).default(64 * 1024),
});

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
  readonly authMode: 'password' | 'oidc' | 'supabase' | 'jwt';
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
  /** The custom JWT secret, used when authMode === 'jwt'. */
  readonly jwtSecret: string;
  readonly rateLimitMax: number;
  readonly rateLimitWindowMs: number;
  readonly bodyLimitBytes: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(`invalid configuration: ${message}`);
    this.name = 'ConfigError';
  }
}

/** Minimum session secret entropy. 32 bytes is the floor for HMAC signing keys. */
const MIN_SESSION_SECRET_LENGTH = 32;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = RawEnv.safeParse(source);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new ConfigError(detail);
  }
  const env = parsed.data;
  const isProduction = env.NODE_ENV === 'production';

  // --- fail-closed rule 1: production must not run without TLS-only cookies.
  // (The former rule here forbade AUTH_MODE=dev in production. The development
  // sign-in has since been removed outright, so there is nothing left to forbid:
  // both remaining modes verify a real credential.)
  if (isProduction && env.WEB_ORIGIN.startsWith('http://')) {
    throw new ConfigError(
      'WEB_ORIGIN must be https:// in production; the session cookie is set Secure and would never be sent',
    );
  }

  // --- fail-closed rule 2: an unsigned or weak session cookie is not a session.
  if ((env.AUTH_MODE === 'password' || env.AUTH_MODE === 'oidc') && env.SESSION_SECRET.length < MIN_SESSION_SECRET_LENGTH) {
    throw new ConfigError(
      `SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters (got ${env.SESSION_SECRET.length})`,
    );
  }

  // --- fail-closed rule 3: oidc mode without a verifiable issuer is not oidc.
  let oidc: OidcConfig | null = null;
  if (env.AUTH_MODE === 'oidc') {
    const missing = (['OIDC_ISSUER', 'OIDC_AUDIENCE', 'OIDC_JWKS_URL'] as const)
      .filter((key) => env[key].trim() === '');
    if (missing.length > 0) {
      throw new ConfigError(`AUTH_MODE=oidc requires ${missing.join(', ')}`);
    }
    for (const key of ['OIDC_ISSUER', 'OIDC_JWKS_URL'] as const) {
      try {
        void new URL(env[key]).href;
      } catch {
        throw new ConfigError(`${key} must be an absolute URL`);
      }
    }
    oidc = {
      issuer: env.OIDC_ISSUER,
      audience: env.OIDC_AUDIENCE,
      jwksUrl: env.OIDC_JWKS_URL,
      clientId: env.OIDC_CLIENT_ID.trim() === '' ? null : env.OIDC_CLIENT_ID,
    };
  }

  // --- fail-closed rule 4: supabase mode without a JWT secret is not supabase.
  let supabase: SupabaseConfig | null = null;
  if (env.AUTH_MODE === 'supabase') {
    if (env.SUPABASE_JWT_SECRET.trim() === '') {
      throw new ConfigError('AUTH_MODE=supabase requires SUPABASE_JWT_SECRET');
    }
    supabase = { jwtSecret: env.SUPABASE_JWT_SECRET };
  }

  if (env.AUTH_MODE === 'jwt' && env.JWT_SECRET.length < MIN_SESSION_SECRET_LENGTH) {
    throw new ConfigError(`AUTH_MODE=jwt requires JWT_SECRET to be at least ${MIN_SESSION_SECRET_LENGTH} characters`);
  }

  // --- fail-closed rule 5: production must not accidentally use the migration owner.
  // Match the USERINFO only. Matching the string 'postgres' anywhere would reject
  // every connection string, because that is also the URL scheme.
  if (isProduction) {
    let user = '';
    try {
      user = decodeURIComponent(new URL(env.DATABASE_URL).username);
    } catch {
      throw new ConfigError('DATABASE_URL must be a valid connection URL');
    }
    if (user === 'postgres' || user === '') {
      throw new ConfigError('DATABASE_URL must name the restricted API login, not the migration owner');
    }
  }

  return {
    nodeEnv: env.NODE_ENV,
    isProduction,
    port: env.PORT ?? env.API_PORT,
    // Loopback is right for local development, but a container behind a proxy
    // must listen on every interface or the platform sees no open port and
    // routes nothing to it. If the platform gave us PORT, bind accordingly.
    host: env.API_HOST ?? (env.PORT === undefined ? '127.0.0.1' : '0.0.0.0'),
    webOrigin: env.WEB_ORIGIN,
    logLevel: env.LOG_LEVEL,
    databaseUrl: env.DATABASE_URL,
    dbPoolMax: env.DB_POOL_MAX,
    dbStatementTimeoutMs: env.DB_STATEMENT_TIMEOUT_MS,
    authMode: env.AUTH_MODE,
    sessionCookieName: env.SESSION_COOKIE_NAME,
    sessionSecret: env.SESSION_SECRET,
    sessionTtlSeconds: env.SESSION_TTL_HOURS * 3600,
    oidc,
    supabase,
    jwtSecret: env.JWT_SECRET,
    rateLimitMax: env.RATE_LIMIT_MAX,
    loginMaxAttempts: env.LOGIN_MAX_ATTEMPTS,
    loginLockSeconds: env.LOGIN_LOCK_SECONDS,
    authRateLimitMax: env.AUTH_RATE_LIMIT_MAX,
    passwordResetTtlSeconds: env.PASSWORD_RESET_TTL_SECONDS,
    serveWeb: env.SERVE_WEB === 'true',
    authRateLimitWindow: env.AUTH_RATE_LIMIT_WINDOW,
    rateLimitWindowMs: env.RATE_LIMIT_WINDOW_MS,
    bodyLimitBytes: env.BODY_LIMIT_BYTES,
  };
}
