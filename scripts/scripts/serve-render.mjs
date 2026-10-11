#!/usr/bin/env node
/**
 * Combined API + worker process, for hosts where a separate background worker
 * is not available (Render's free tier being the case this exists for).
 *
 * Both entrypoints self-start on import, so this is a launcher, not a wrapper:
 * it runs migrations first, then brings up the API, then optionally the worker
 * in the SAME process.
 *
 * What this trades away, stated plainly:
 *   - API and worker share a process, so a worker crash can take the API with
 *     it. In the split deployment they fail independently.
 *   - On a host that sleeps idle instances, jobs are only processed while the
 *     API is awake. A password reset still works, because requesting one is
 *     itself the request that wakes the instance — but a scheduled reminder
 *     will not fire on a sleeping instance.
 *
 * Set RUN_WORKER_IN_PROCESS=false once the worker has its own service.
 */
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const log = (msg) => process.stdout.write(`[render] ${msg}\n`);

/**
 * Managed Postgres hands you ONE connection string, and it owns everything.
 * Running the app on it would hand the API a role that bypasses row-level
 * security — the entire ownership model depends on that not happening. So we
 * provision the restricted logins on first boot and derive their URLs from the
 * owner's, keeping host, database and sslmode intact.
 */
function restrictedUrl(ownerUrl, user, password) {
  const url = new URL(ownerUrl);
  url.username = encodeURIComponent(user);
  url.password = encodeURIComponent(password);
  // Render's INTERNAL connection string carries no sslmode, and both the API
  // and worker refuse to run in production without one — correctly, since the
  // link crosses the provider's network.
  //
  // no-verify, NOT require: node-postgres maps `require` to verify-full, and
  // the managed database presents a certificate that does not chain to a public
  // CA, so every connection fails. `no-verify` keeps the traffic ENCRYPTED but
  // does not authenticate the server, which is the accepted trade for a link
  // that never leaves the provider's private network. Override with
  // DATABASE_SSLMODE if your provider gives you a verifiable chain.
  if (!/sslmode=/.test(url.search)) {
    url.searchParams.set('sslmode', process.env.DATABASE_SSLMODE ?? 'no-verify');
  }
  return url.toString();
}

// ---- 1. migrate before anything serves traffic -------------------------
// Render runs this on every deploy; the runner is idempotent, so an unchanged
// schema is a no-op rather than an error.
if (process.env.MIGRATION_DATABASE_URL) {
  log('applying migrations');
  const migrate = spawnSync(process.execPath, ['scripts/migrate.mjs'], {
    stdio: 'inherit',
    env: process.env,
  });
  if (migrate.status !== 0) {
    log('migrations failed; refusing to start');
    process.exit(1);
  }
} else {
  log('MIGRATION_DATABASE_URL not set; skipping migrations');
}

// ---- 1b. provision least-privilege roles, then use them -----------------
const ownerUrl = process.env.MIGRATION_DATABASE_URL;
const apiPassword = process.env.API_DB_PASSWORD;
const workerPassword = process.env.WORKER_DB_PASSWORD;

if (ownerUrl && apiPassword && workerPassword) {
  log('provisioning restricted database roles');
  const roles = spawnSync(process.execPath, ['scripts/provision-roles.mjs'], {
    stdio: 'inherit',
    env: { ...process.env, MIGRATION_DATABASE_URL: ownerUrl },
  });
  if (roles.status !== 0) {
    log('role provisioning failed; refusing to start');
    process.exit(1);
  }

  // Point the API and worker at their own logins. Set explicitly rather than
  // defaulted, so a misconfigured deploy fails loudly instead of silently
  // running the app as the database owner.
  const apiUser = process.env.API_DB_USER ?? 'hi_api';
  const workerUser = process.env.WORKER_DB_USER ?? 'hi_worker';
  process.env.DATABASE_URL = restrictedUrl(ownerUrl, apiUser, apiPassword);
  process.env.WORKER_DATABASE_URL = restrictedUrl(ownerUrl, workerUser, workerPassword);
  log(`API runs as ${apiUser}, worker as ${workerUser} (not the database owner)`);
} else if (ownerUrl) {
  log('API_DB_PASSWORD / WORKER_DB_PASSWORD not set; refusing to run the app as the database owner');
  process.exit(1);
}

// ---- 2. the API ---------------------------------------------------------
log('starting API');
await import('../apps/api/dist/server.js');

// ---- 3. the worker, in the same process ---------------------------------
if (process.env.RUN_WORKER_IN_PROCESS !== 'false') {
  log('starting worker in-process (no separate worker service on this plan)');
  await import('../apps/worker/dist/worker.js');
} else {
  log('worker runs as its own service; not started here');
}
