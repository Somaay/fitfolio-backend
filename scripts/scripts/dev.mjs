#!/usr/bin/env node
/**
 * One command to get a working development environment: `npm run dev`.
 *
 * Steps, in this order and for a reason:
 *   1. Start the ISOLATED PostgreSQL cluster under .pgdata on 127.0.0.1:55433.
 *      Never a system or shared server (scripts/pg.mjs).
 *   2. Create the development database if — and only if — it does not exist.
 *      This script never drops a database. `pg.mjs create-db` does, which is why
 *      it is not used here.
 *   3. Run migrations as the migration OWNER.
 *   4. Provision the restricted `hi_api` / `hi_worker` logins.
 *   5. Run the API, the worker and the web dev server concurrently, with prefixed
 *      output and a single clean shutdown.
 *
 * Every step is idempotent: re-running changes nothing that is already correct.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import process from 'node:process';
import pg from 'pg';

const ROOT = resolve(import.meta.dirname, '..');
const PG_HOST = '127.0.0.1';
const PG_PORT = process.env.HI_PG_PORT ?? '55433';
const DB_NAME = process.env.HI_DEV_DB ?? 'health_investment';

/** A password used ONLY by this local, loopback-only, throwaway cluster. */
const LOCAL_DEV_PASSWORD = 'local_dev_only_not_a_secret';

const ESC = String.fromCharCode(27);
const COLORS = { api: `${ESC}[36m`, worker: `${ESC}[35m`, web: `${ESC}[32m`, dev: `${ESC}[33m` };
const RESET = `${ESC}[0m`;
const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const tag = (name) => (useColor ? `${COLORS[name] ?? ''}[${name}]${RESET}` : `[${name}]`);
const say = (message) => console.log(`${tag('dev')} ${message}`);
const die = (message) => { console.error(`${tag('dev')} ${message}`); process.exit(1); };

// ------------------------------------------------------------------ .env
/** Minimal KEY=VALUE loader. Existing environment variables always win. */
function loadDotEnv() {
  const file = resolve(ROOT, '.env');
  if (!existsSync(file)) return 0;
  let loaded = 0;
  for (const rawLine of readFileSync(file, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) { process.env[key] = value; loaded += 1; }
  }
  return loaded;
}

/**
 * Fill in local-only defaults. This is development ergonomics, never a
 * production path: if NODE_ENV is production we refuse to invent credentials.
 */
function applyDevDefaults() {
  if (process.env.NODE_ENV === 'production') {
    die('refusing to run the development orchestrator with NODE_ENV=production');
  }
  process.env.NODE_ENV ??= 'development';

  const base = `${PG_HOST}:${PG_PORT}/${DB_NAME}`;
  process.env.MIGRATION_DATABASE_URL ??= `postgres://postgres@${base}`;

  const placeholder = (value) => value === undefined || value === '' || value === 'CHANGE_ME';
  if (placeholder(process.env.API_DB_PASSWORD)) process.env.API_DB_PASSWORD = LOCAL_DEV_PASSWORD;
  if (placeholder(process.env.WORKER_DB_PASSWORD)) process.env.WORKER_DB_PASSWORD = LOCAL_DEV_PASSWORD;

  const apiUser = (process.env.API_DB_USER ??= 'hi_api');
  const workerUser = (process.env.WORKER_DB_USER ??= 'hi_worker');
  const url = (user, password) => `postgres://${user}:${encodeURIComponent(password)}@${base}`;

  if (placeholder(process.env.DATABASE_URL) || String(process.env.DATABASE_URL).includes('CHANGE_ME')) {
    process.env.DATABASE_URL = url(apiUser, process.env.API_DB_PASSWORD);
  }
  if (placeholder(process.env.WORKER_DATABASE_URL) || String(process.env.WORKER_DATABASE_URL).includes('CHANGE_ME')) {
    process.env.WORKER_DATABASE_URL = url(workerUser, process.env.WORKER_DB_PASSWORD);
  }

  process.env.AUTH_MODE ??= 'password';
  process.env.SESSION_SECRET ??= 'local_dev_session_secret_at_least_32_bytes_long!!';
  process.env.NOTIFICATION_ADAPTER ??= 'log';
  process.env.WEB_ORIGIN ??= 'http://localhost:5173';
  process.env.API_PORT ??= '8080';
  process.env.WORKER_HEALTH_PORT ??= '8081';
}

// --------------------------------------------------------------- steps 1-4
function step(label, command, args, options = {}) {
  say(label);
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', env: process.env, ...options });
  if (result.status !== 0) die(`${label} failed (exit ${result.status ?? 'signal'})`);
}

async function ensureDatabase() {
  const admin = new pg.Client({ host: PG_HOST, port: Number(PG_PORT), user: 'postgres', database: 'postgres' });
  await admin.connect();
  try {
    const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [DB_NAME]);
    if (rows.length > 0) { say(`database "${DB_NAME}" already exists`); return; }
    // An identifier cannot be a bind parameter, so it is validated instead.
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(DB_NAME)) die(`unsafe database name: ${DB_NAME}`);
    await admin.query(`CREATE DATABASE "${DB_NAME}"`);
    say(`created database "${DB_NAME}"`);
  } finally {
    await admin.end();
  }
}

// ------------------------------------------------------------------ step 5
const children = [];
let shuttingDown = false;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  say('shutting down...');
  for (const { child } of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
  const deadline = setTimeout(() => {
    for (const { name, child } of children) {
      if (child.exitCode === null && child.signalCode === null) {
        console.error(`${tag(name)} did not stop in time; sending SIGKILL`);
        child.kill('SIGKILL');
      }
    }
    process.exit(code);
  }, 8000);
  deadline.unref();

  const poll = setInterval(() => {
    if (children.every(({ child }) => child.exitCode !== null || child.signalCode !== null)) {
      clearInterval(poll);
      clearTimeout(deadline);
      say('stopped. The database cluster is still running; `npm run db:stop` to stop it.');
      process.exit(code);
    }
  }, 100);
}

function startService(name, args) {
  const child = spawn('npm', args, { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push({ name, child });

  for (const [stream, sink] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    createInterface({ input: stream }).on('line', (line) => sink.write(`${tag(name)} ${line}\n`));
  }
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(`${tag(name)} exited (${signal ?? `code ${code}`})`);
    // One dead service makes the environment a lie. Take the whole thing down so
    // nobody debugs against a half-running stack.
    shutdown(code === 0 ? 0 : 1);
  });
  return child;
}

// ---------------------------------------------------------------------- main
const loaded = loadDotEnv();
if (loaded > 0) say(`loaded ${loaded} value(s) from .env`);
applyDevDefaults();

step('starting the isolated postgres cluster', 'node', ['scripts/pg.mjs', 'start']);
await ensureDatabase();
step('applying migrations (as the migration owner)', 'node', ['--experimental-strip-types', 'scripts/migrate.mjs']);
step('provisioning restricted runtime roles', 'node', ['scripts/provision-roles.mjs']);

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

const services = [
  { name: 'api', dir: 'apps/api', args: ['run', 'dev', '-w', '@hi/api'] },
  { name: 'worker', dir: 'apps/worker', args: ['run', 'dev', '-w', '@hi/worker'] },
  { name: 'web', dir: 'apps/web', args: ['run', 'dev', '-w', '@hi/web'] },
];

let started = 0;
for (const service of services) {
  // The workspaces are built by different people in parallel; skip anything that
  // has no source yet rather than failing the whole environment.
  if (!existsSync(resolve(ROOT, service.dir, 'src'))) {
    say(`skipping ${service.name}: ${service.dir}/src does not exist yet`);
    continue;
  }
  startService(service.name, service.args);
  started += 1;
}

if (started === 0) die('no runnable services found');
say(`running ${started} service(s). Ctrl-C to stop everything.`);
