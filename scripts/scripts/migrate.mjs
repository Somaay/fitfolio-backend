#!/usr/bin/env node
/**
 * Versioned SQL migration runner.
 *
 * Each file in db/migrations runs once, in filename order, inside its own
 * transaction, and records itself in schema_migrations. Re-running is a no-op.
 * There is no "down" migration: reversal is a new forward migration, so history
 * is never rewritten under a deployed system.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import pg from 'pg';

const ROOT = resolve(import.meta.dirname, '..');
const DIR = resolve(ROOT, 'db/migrations');

const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('[migrate] set MIGRATION_DATABASE_URL (migration-owner credentials)');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();

async function appliedVersions() {
  const { rows } = await client.query(`
    SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present`);
  if (!rows[0].present) return new Set();
  const result = await client.query('SELECT version FROM schema_migrations');
  return new Set(result.rows.map((r) => r.version));
}

try {
  const applied = await appliedVersions();
  const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
  let ran = 0;

  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (applied.has(version)) { console.log(`  = ${version} (already applied)`); continue; }
    const sql = readFileSync(resolve(DIR, file), 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('COMMIT');
      console.log(`  + ${version}`);
      ran += 1;
    } catch (error) {
      await client.query('ROLLBACK');
      console.error(`[migrate] ${version} FAILED: ${error.message}`);
      process.exitCode = 1;
      break;
    }
  }
  if (process.exitCode !== 1) console.log(`[migrate] ${ran} migration(s) applied, ${files.length} total`);
} finally {
  await client.end();
}
