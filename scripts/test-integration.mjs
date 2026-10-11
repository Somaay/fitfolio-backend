#!/usr/bin/env node
/**
 * Integration test harness: `npm run test:integration`.
 *
 * Guarantees, in order of importance:
 *
 *  1. **It only ever touches a database it created itself.** The name is
 *     generated here with a reserved prefix and a random suffix, recorded in
 *     memory, and the drop at the end re-checks BOTH the recorded name and the
 *     prefix before issuing DROP DATABASE. An operator cannot point this script
 *     at a shared or production database by setting an environment variable:
 *     `DATABASE_URL` and friends are OVERWRITTEN, never read.
 *  2. Every run starts from an EMPTY database, migrated from zero. Tests never
 *     inherit another run's rows.
 *  3. Tests connect through the RESTRICTED logins (`hi_api`, `hi_worker`), so
 *     row-level security is actually exercised. The migration connection string
 *     is exported separately and is only for fixtures that need owner rights.
 *
 * Two topologies are supported and both are documented in docs/operations.md:
 *   - local  (default): the isolated cluster from scripts/pg.mjs on 127.0.0.1:55433,
 *                       started automatically.
 *   - service container (CI): set TEST_ADMIN_DATABASE_URL to the postgres:16
 *                       service, e.g. postgres://postgres:postgres@127.0.0.1:5432/postgres.
 *                       The cluster is NOT started or stopped by this script.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import process from 'node:process';
import pg from 'pg';

const ROOT = resolve(import.meta.dirname, '..');

/**
 * Reserved prefix. Nothing outside this harness may use it, and nothing without
 * it can ever be dropped by this script.
 */
const TEST_DB_PREFIX = 'hi_it_';

let apiProcess = null;

/** Poll a readiness URL until it answers 200 or the deadline passes. */
async function waitForApi(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (apiProcess && apiProcess.exitCode !== null) return false; // it died
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

const DEFAULT_ADMIN_URL = `postgres://postgres@127.0.0.1:${process.env.HI_PG_PORT ?? '55433'}/postgres`;
const adminUrl = process.env.TEST_ADMIN_DATABASE_URL ?? DEFAULT_ADMIN_URL;
const usingLocalCluster = process.env.TEST_ADMIN_DATABASE_URL === undefined;

const say = (message) => console.log(`[it] ${message}`);
const die = (message) => { console.error(`[it] ${message}`); process.exit(1); };

// ------------------------------------------------------------------- naming
/** e.g. hi_it_1736870000000_3f9ac1d2 — unique per run, and obviously disposable. */
const dbName = `${TEST_DB_PREFIX}${Date.now()}_${randomBytes(4).toString('hex')}`;
const SAFE_NAME = /^hi_it_\d+_[0-9a-f]{8}$/;
if (!SAFE_NAME.test(dbName)) die('internal error: generated an unsafe database name');

/** Per-run passwords. Never a default, never reused between runs. */
const apiPassword = randomBytes(18).toString('base64url');
const workerPassword = randomBytes(18).toString('base64url');

function urlFor(user, password, database) {
  const admin = new URL(adminUrl);
  const auth = password === null ? encodeURIComponent(user) : `${encodeURIComponent(user)}:${encodeURIComponent(password)}`;
  return `postgres://${auth}@${admin.hostname}:${admin.port || '5432'}/${database}`;
}

const migrationUrl = (() => {
  const admin = new URL(adminUrl);
  const auth = admin.password === '' ? admin.username : `${admin.username}:${admin.password}`;
  return `postgres://${auth}@${admin.hostname}:${admin.port || '5432'}/${dbName}`;
})();

// ------------------------------------------------------------------ helpers
function run(label, command, args, env = {}) {
  say(label);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) throw new Error(`${label} failed (exit ${result.status ?? 'signal'})`);
}

async function withAdmin(fn) {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Everything this harness created, so teardown can never guess. */
const created = { database: null };

async function createDatabase() {
  await withAdmin(async (client) => {
    const { rows } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (rows.length > 0) {
      // Astronomically unlikely, and a sign something is wrong. Do not reuse it.
      throw new Error(`generated database name ${dbName} already exists; aborting rather than reusing it`);
    }
    await client.query(`CREATE DATABASE "${dbName}"`);
  });
  created.database = dbName;
  say(`created fresh database ${dbName}`);
}

async function dropDatabase() {
  const target = created.database;
  if (target === null) {
    say('no database was created by this run; nothing to drop');
    return;
  }
  // Two independent checks. Both must hold.
  if (target !== dbName || !SAFE_NAME.test(target)) {
    console.error(`[it] REFUSING to drop ${target}: this harness did not create it`);
    return;
  }
  if (process.env.HI_KEEP_TEST_DB === '1') {
    say(`HI_KEEP_TEST_DB=1 — leaving ${target} in place for inspection`);
    return;
  }
  try {
    await withAdmin((client) => client.query(`DROP DATABASE IF EXISTS "${target}" WITH (FORCE)`));
    say(`dropped ${target}`);
  } catch (error) {
    console.error(`[it] could not drop ${target}: ${error.message}`);
  }
}

// --------------------------------------------------------------------- main
let exitCode = 1;
try {
  if (usingLocalCluster) {
    run('starting the isolated postgres cluster', 'node', ['scripts/pg.mjs', 'start']);
  } else {
    say(`using an external admin connection (${new URL(adminUrl).host}); not managing the cluster`);
  }

  await createDatabase();

  run('applying migrations', 'node', ['--experimental-strip-types', 'scripts/migrate.mjs'], {
    MIGRATION_DATABASE_URL: migrationUrl,
  });

  run('provisioning restricted roles', 'node', ['scripts/provision-roles.mjs'], {
    MIGRATION_DATABASE_URL: migrationUrl,
    API_DB_USER: 'hi_api',
    API_DB_PASSWORD: apiPassword,
    WORKER_DB_USER: 'hi_worker',
    WORKER_DB_PASSWORD: workerPassword,
  });

  // Connection strings handed to the tests. Anything the caller had in these
  // variables is deliberately discarded: a stray DATABASE_URL in a shell profile
  // must not be able to redirect the suite at a real database.
  const testEnv = {
    NODE_ENV: 'test',
    MIGRATION_DATABASE_URL: migrationUrl,
    DATABASE_URL: urlFor('hi_api', apiPassword, dbName),
    WORKER_DATABASE_URL: urlFor('hi_worker', workerPassword, dbName),
    HI_TEST_DATABASE: dbName,
    NOTIFICATION_ADAPTER: 'log',
    AUTH_MODE: 'password',
    AUTH_RATE_LIMIT_MAX: '100000',
    SESSION_SECRET: 'integration_test_session_secret_32_bytes_min!!',
    LOG_LEVEL: process.env.LOG_LEVEL ?? 'silent',
    // The suite drives hundreds of requests from one address in a few seconds,
    // which trips the production rate limiter and masks the assertion under a
    // 429. Raising the cap here exercises the same code path without letting
    // rate limiting hide real failures. Rate limiting itself is asserted by a
    // dedicated test that sets its own low cap.
    RATE_LIMIT_MAX: process.env.RATE_LIMIT_MAX ?? '100000',
    RATE_LIMIT_WINDOW_MS: process.env.RATE_LIMIT_WINDOW_MS ?? '1000',
  };

  // Boot the API against THIS run's database so the HTTP-contract tests always
  // execute. Previously they skipped whenever nothing happened to be listening,
  // which meant 35 tests could quietly not run and the suite still looked green.
  // HI_REQUIRE_API=1 then makes a missing API a hard failure rather than a skip.
  const apiPort = process.env.API_PORT ?? '8080';
  const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
  testEnv.API_PORT = apiPort;
  testEnv.API_BASE_URL = apiBaseUrl;
  testEnv.HI_REQUIRE_API = process.env.HI_REQUIRE_API ?? '1';

  say(`starting API on ${apiBaseUrl} against ${dbName}`);
  apiProcess = spawn('npx', ['tsx', 'apps/api/src/server.ts'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...testEnv },
  });
  const apiLog = [];
  apiProcess.stdout?.on('data', (d) => apiLog.push(d.toString()));
  apiProcess.stderr?.on('data', (d) => apiLog.push(d.toString()));
  apiProcess.on('exit', (code) => {
    if (code !== 0 && code !== null) apiLog.push(`api exited with code ${code}\n`);
  });

  const ready = await waitForApi(`${apiBaseUrl}/readyz`, 30_000);
  if (!ready) {
    console.error('[it] the API did not become ready; HTTP-contract tests cannot run');
    console.error(apiLog.join('').split('\n').slice(-25).join('\n'));
    throw new Error('API failed to start');
  }
  say('API ready');

  say(`running vitest against ${dbName} as hi_api / hi_worker`);
  exitCode = await new Promise((resolvePromise) => {
    const child = spawn('npx', ['vitest', 'run', '--project', 'integration', ...process.argv.slice(2)], {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, ...testEnv },
    });
    child.on('exit', (code, signal) => resolvePromise(signal !== null ? 1 : (code ?? 1)));
    child.on('error', () => resolvePromise(1));
  });
} catch (error) {
  console.error(`[it] ${error.message}`);
  exitCode = 1;
} finally {
  if (apiProcess && apiProcess.exitCode === null) {
    apiProcess.kill('SIGTERM');
    await new Promise((r) => {
      const t = setTimeout(() => { apiProcess.kill('SIGKILL'); r(); }, 5000);
      apiProcess.on('exit', () => { clearTimeout(t); r(); });
    });
  }
  await dropDatabase();
}

process.exit(exitCode);
