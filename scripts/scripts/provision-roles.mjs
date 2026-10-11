#!/usr/bin/env node
/**
 * Create LOGIN roles for the API and worker and grant them the least-privilege
 * group roles defined in migration 0002.
 *
 * Passwords come from the environment. The migration connection string is used
 * here and NOWHERE else at runtime: the deployed API and worker must use
 * DATABASE_URL / WORKER_DATABASE_URL, which point at these restricted logins.
 */
import process from 'node:process';
import pg from 'pg';

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) { console.error('[roles] MIGRATION_DATABASE_URL is required'); process.exit(1); }

const apiUser = process.env.API_DB_USER ?? 'hi_api';
const apiPassword = process.env.API_DB_PASSWORD;
const workerUser = process.env.WORKER_DB_USER ?? 'hi_worker';
const workerPassword = process.env.WORKER_DB_PASSWORD;

if (!apiPassword || !workerPassword) {
  console.error('[roles] API_DB_PASSWORD and WORKER_DB_PASSWORD are required (no defaults, ever)');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();

/** Identifiers are validated, not interpolated blindly. */
const safeIdent = (name) => {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error(`unsafe role name: ${name}`);
  return `"${name}"`;
};

async function ensureLogin(name, password, group) {
  const ident = safeIdent(name);
  const { rows } = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [name]);
  if (rows.length === 0) {
    await client.query(`CREATE ROLE ${ident} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
  }
  // Build the ALTER ROLE statement SERVER-SIDE with format(): %I and %L do the
  // identifier/literal quoting in PostgreSQL, so the password is never
  // concatenated by hand. Note that bind parameters inside a dollar-quoted DO
  // block would be literal text, not placeholders — hence this two-step form.
  const { rows: built } = await client.query(
    `SELECT format('ALTER ROLE %I WITH PASSWORD %L', $1::text, $2::text) AS stmt`,
    [name, password],
  );
  await client.query(built[0].stmt);
  await client.query(`GRANT ${safeIdent(group)} TO ${ident}`);
  console.log(`  + ${name} (member of ${group})`);
}

try {
  await ensureLogin(apiUser, apiPassword, 'app_api');
  await ensureLogin(workerUser, workerPassword, 'app_worker');
  console.log('[roles] provisioned');
} catch (error) {
  console.error(`[roles] ${error.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
