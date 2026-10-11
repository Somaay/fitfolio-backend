#!/usr/bin/env node
/**
 * Isolated local PostgreSQL cluster for development and integration tests.
 *
 * Deliberately NOT a shared or system database: `npm run db:start` initialises a
 * throwaway cluster under .pgdata/ on a non-default port. Tests must never run
 * against a shared instance.
 *
 * macOS note: the Unix socket path is capped at ~103 bytes, so the socket lives
 * in a short directory and we listen on 127.0.0.1. (An earlier design note
 * attributed a start-up failure to shared memory; the real cause was this path
 * limit — see docs/decisions.md D-01.)
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

const ROOT = resolve(import.meta.dirname, '..');
const DATA_DIR = resolve(ROOT, '.pgdata/data');
const SOCKET_DIR = process.env.HI_PG_SOCKET_DIR ?? '/tmp/hi-pg';
const PORT = process.env.HI_PG_PORT ?? '55433';
const SUPERUSER = 'postgres';

const CANDIDATE_BIN_DIRS = [
  process.env.HI_PG_BIN,
  '/opt/homebrew/opt/postgresql@16/bin',
  '/opt/homebrew/opt/postgresql@15/bin',
  '/usr/lib/postgresql/16/bin',
  '/usr/lib/postgresql/15/bin',
  '/usr/local/opt/postgresql@15/bin',
].filter(Boolean);

function findBinDir() {
  for (const dir of CANDIDATE_BIN_DIRS) {
    if (existsSync(`${dir}/pg_ctl`)) return dir;
  }
  const which = spawnSync('which', ['pg_ctl'], { encoding: 'utf8' });
  if (which.status === 0) return resolve(which.stdout.trim(), '..');
  throw new Error(
    'PostgreSQL binaries not found. Install PostgreSQL 15+ (macOS: `brew install postgresql@15`) ' +
    'or set HI_PG_BIN to the directory containing pg_ctl.',
  );
}

const BIN = findBinDir();
const bin = (name) => `${BIN}/${name}`;

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', encoding: 'utf8', ...opts });
  if (result.status !== 0 && !opts.allowFailure) {
    throw new Error(`${cmd} ${args.join(' ')} exited ${result.status}`);
  }
  return result;
}

function isRunning() {
  return spawnSync(bin('pg_ctl'), ['-D', DATA_DIR, 'status'], { stdio: 'ignore' }).status === 0;
}

function start() {
  mkdirSync(SOCKET_DIR, { recursive: true });
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
    run(bin('initdb'), ['-D', DATA_DIR, '-U', SUPERUSER, '--auth=trust', '-E', 'UTF8'], { stdio: 'ignore' });
  }
  if (isRunning()) {
    console.log(`postgres already running on 127.0.0.1:${PORT}`);
    return;
  }
  run(bin('pg_ctl'), [
    '-D', DATA_DIR, '-w', '-l', resolve(ROOT, '.pgdata/server.log'),
    '-o', `-p ${PORT} -k ${SOCKET_DIR} -c listen_addresses=127.0.0.1 -c fsync=off -c full_page_writes=off`,
    'start',
  ]);
  console.log(`postgres listening on 127.0.0.1:${PORT}`);
}

function stop() {
  if (!existsSync(DATA_DIR) || !isRunning()) { console.log('postgres not running'); return; }
  run(bin('pg_ctl'), ['-D', DATA_DIR, '-m', 'fast', 'stop']);
}

function destroy() {
  if (existsSync(DATA_DIR) && isRunning()) stop();
  rmSync(resolve(ROOT, '.pgdata'), { recursive: true, force: true });
  console.log('cluster destroyed');
}

/** Create a fresh, EMPTY database and print its connection URL. */
function createDb(name) {
  run(bin('psql'), ['-h', '127.0.0.1', '-p', PORT, '-U', SUPERUSER, '-d', 'postgres', '-q', '-c',
    `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`], { stdio: 'ignore' });
  run(bin('psql'), ['-h', '127.0.0.1', '-p', PORT, '-U', SUPERUSER, '-d', 'postgres', '-q', '-c',
    `CREATE DATABASE "${name}"`], { stdio: 'ignore' });
  console.log(`postgres://${SUPERUSER}@127.0.0.1:${PORT}/${name}`);
}

const [, , command, arg] = process.argv;
try {
  switch (command) {
    case 'start': start(); break;
    case 'stop': stop(); break;
    case 'destroy': destroy(); break;
    case 'create-db': createDb(arg ?? 'health_investment'); break;
    case 'bin': console.log(BIN); break;
    default:
      console.error('usage: pg.mjs <start|stop|destroy|create-db [name]|bin>');
      process.exit(1);
  }
} catch (error) {
  console.error(`[pg] ${error.message}`);
  process.exit(1);
}
