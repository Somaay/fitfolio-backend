/**
 * Worker configuration.
 *
 * Every value is read ONCE at startup and validated before the process claims a
 * single job. A misconfigured worker must fail loudly at boot rather than fail
 * quietly halfway through a delivery, so `loadConfig` throws with the full list
 * of problems instead of falling back to defaults for security-relevant values.
 */

export type NotificationAdapterKind = 'log' | 'none' | 'resend';

export interface WorkerConfig {
  readonly nodeEnv: string;
  readonly isProduction: boolean;
  readonly databaseUrl: string;
  readonly logLevel: string;
  readonly pollIntervalMs: number;
  readonly leaseSeconds: number;
  readonly maxAttempts: number;
  readonly batchSize: number;
  readonly sweepIntervalMs: number;
  readonly retryBaseSeconds: number;
  readonly retryMaxSeconds: number;
  readonly notificationAdapter: NotificationAdapterKind;
  readonly notificationLogFile: string | null;
  /** Present if and only if notificationAdapter === 'resend'. */
  readonly resend: { readonly apiKey: string; readonly from: string } | null;
  readonly healthPort: number | null;
  readonly shutdownGraceMs: number;
}

export class ConfigError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`worker configuration is invalid:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

type Env = Record<string, string | undefined>;

function integer(env: Env, key: string, fallback: number, min: number, max: number, problems: string[]): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) {
    problems.push(`${key} must be a non-negative integer (got ${JSON.stringify(raw)})`);
    return fallback;
  }
  const value = Number(raw);
  if (value < min || value > max) {
    problems.push(`${key} must be between ${min} and ${max} (got ${value})`);
    return fallback;
  }
  return value;
}

/**
 * The connection string must be the RESTRICTED worker login. A worker running as
 * the migration owner would silently bypass every row-level security policy, so
 * we refuse the obvious cases outright rather than trusting the operator.
 */
function checkWorkerRole(url: string, isProduction: boolean, problems: string[]): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    problems.push('WORKER_DATABASE_URL is not a valid connection URL');
    return;
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    problems.push(`WORKER_DATABASE_URL must be a postgres:// URL (got ${parsed.protocol}//)`);
  }
  const user = decodeURIComponent(parsed.username);
  if (user === 'postgres' || user === '') {
    problems.push(
      'WORKER_DATABASE_URL must use the restricted worker login (e.g. hi_worker), ' +
      'never the superuser / migration owner: that role bypasses row-level security',
    );
  }
  if (isProduction && parsed.password === '') {
    problems.push('WORKER_DATABASE_URL must carry a password in production');
  }
  // `no-verify` is accepted alongside the verifying modes: it still encrypts,
  // and managed providers routinely present certificates that chain to a
  // private CA, where a verifying mode simply cannot connect. What is rejected
  // is NO TLS at all. See docs/deployment.md for the trade this makes.
  if (isProduction && !/sslmode=(no-verify|require|verify-ca|verify-full)/.test(parsed.search)) {
    problems.push(
      'WORKER_DATABASE_URL must set sslmode in production '
      + '(no-verify to encrypt without chain verification, or verify-full where the chain is trusted)');
  }
}

export function loadConfig(env: Env = process.env): WorkerConfig {
  const problems: string[] = [];
  const nodeEnv = env.NODE_ENV ?? 'development';
  const isProduction = nodeEnv === 'production';

  const databaseUrl = env.WORKER_DATABASE_URL ?? '';
  if (databaseUrl === '') {
    problems.push('WORKER_DATABASE_URL is required (the worker never uses MIGRATION_DATABASE_URL)');
  } else {
    checkWorkerRole(databaseUrl, isProduction, problems);
  }

  if (env.MIGRATION_DATABASE_URL !== undefined && env.MIGRATION_DATABASE_URL === databaseUrl && databaseUrl !== '') {
    problems.push('WORKER_DATABASE_URL and MIGRATION_DATABASE_URL must not be the same connection string');
  }

  const adapterRaw = env.NOTIFICATION_ADAPTER ?? 'log';
  let notificationAdapter: NotificationAdapterKind = 'log';
  let resend: { apiKey: string; from: string } | null = null;

  if (adapterRaw === 'log' || adapterRaw === 'none' || adapterRaw === 'resend') {
    notificationAdapter = adapterRaw;
  } else {
    problems.push(
      `NOTIFICATION_ADAPTER must be one of log|none|resend (got ${JSON.stringify(adapterRaw)}).`,
    );
  }

  if (notificationAdapter === 'resend') {
    // Fail closed: an adapter that claims real delivery but has no credentials
    // would silently drop password-reset links, which is worse than not
    // starting at all.
    const apiKey = (env.RESEND_API_KEY ?? '').trim();
    const from = (env.NOTIFICATION_FROM ?? '').trim();
    if (apiKey === '') problems.push('NOTIFICATION_ADAPTER=resend requires RESEND_API_KEY');
    if (from === '') {
      problems.push(
        'NOTIFICATION_ADAPTER=resend requires NOTIFICATION_FROM, e.g. "Fitfolio <no-reply@yourdomain.com>"',
      );
    } else if (!/^[^<>]*<[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>$|^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(from)) {
      problems.push(
        'NOTIFICATION_FROM must be an address or "Name <address>"; the domain must be verified with Resend',
      );
    }
    if (apiKey !== '' && from !== '') resend = { apiKey, from };
  }

  // A build that reaches real people must not also be shipping a development
  // convenience: catch the combination rather than trusting deploy discipline.
  if (isProduction && notificationAdapter === 'log') {
    problems.push(
      'NOTIFICATION_ADAPTER=log is a simulation and must not run in production; '
      + 'use resend, or none to disable delivery deliberately',
    );
  }

  const leaseSeconds = integer(env, 'WORKER_LEASE_SECONDS', 60, 5, 3600, problems);
  const pollIntervalMs = integer(env, 'WORKER_POLL_INTERVAL_MS', 2000, 100, 300_000, problems);
  const maxAttempts = integer(env, 'WORKER_MAX_ATTEMPTS', 5, 1, 100, problems);
  const batchSize = integer(env, 'WORKER_BATCH_SIZE', 5, 1, 100, problems);
  const sweepIntervalMs = integer(env, 'WORKER_SWEEP_INTERVAL_MS', 15_000, 1000, 600_000, problems);
  const retryBaseSeconds = integer(env, 'WORKER_RETRY_BASE_SECONDS', 10, 1, 3600, problems);
  const retryMaxSeconds = integer(env, 'WORKER_RETRY_MAX_SECONDS', 3600, 1, 86_400, problems);
  const shutdownGraceMs = integer(env, 'WORKER_SHUTDOWN_GRACE_MS', 15_000, 1000, 120_000, problems);

  if (retryMaxSeconds < retryBaseSeconds) {
    problems.push('WORKER_RETRY_MAX_SECONDS must be >= WORKER_RETRY_BASE_SECONDS');
  }

  // A lease shorter than the poll interval guarantees spurious reclaims.
  if (leaseSeconds * 1000 <= pollIntervalMs) {
    problems.push('WORKER_LEASE_SECONDS must exceed WORKER_POLL_INTERVAL_MS, or leases expire mid-poll');
  }

  const healthPortRaw = env.WORKER_HEALTH_PORT;
  const healthPort = healthPortRaw === undefined || healthPortRaw === ''
    ? null
    : integer(env, 'WORKER_HEALTH_PORT', 0, 1, 65_535, problems);

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    nodeEnv,
    isProduction,
    databaseUrl,
    logLevel: env.LOG_LEVEL ?? 'info',
    pollIntervalMs,
    leaseSeconds,
    maxAttempts,
    batchSize,
    sweepIntervalMs,
    retryBaseSeconds,
    retryMaxSeconds,
    notificationAdapter,
    notificationLogFile: env.NOTIFICATION_LOG_FILE ?? null,
    resend,
    healthPort,
    shutdownGraceMs,
  };
}
