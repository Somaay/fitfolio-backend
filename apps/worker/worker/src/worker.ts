#!/usr/bin/env node
/**
 * Worker entrypoint.
 *
 * A separate PROCESS from the API, built from the same repository, connecting as
 * the restricted `hi_worker` login. It is the only component granted
 * `app_erase_account`, and the only one allowed to read outbox jobs across users.
 *
 * Startup order is deliberate: validate configuration, prove the database
 * credentials are the restricted ones, and only then begin claiming work. A
 * misconfigured worker exits non-zero instead of running degraded.
 */
import process from 'node:process';
import { loadConfig, ConfigError } from './config.js';
import { Db } from './db.js';
import { startHealthServer } from './health.js';
import { createLogger, errorCode } from './logger.js';
import { createAdapter } from './notifications.js';
import { ResendNotificationAdapter } from './resend.js';
import { KNOWN_JOB_KINDS } from './handlers/index.js';
import { Runner } from './runner.js';

async function main(): Promise<number> {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      // Printed before the logger exists, on purpose: a config error must be
      // readable even if LOG_LEVEL itself is what is wrong.
      console.error(`[worker] ${error.message}`);
      return 78; // EX_CONFIG
    }
    throw error;
  }

  const logger = createLogger({ level: config.logLevel });
  const db = new Db({ connectionString: config.databaseUrl }, logger);

  let identity;
  try {
    identity = await db.verifyRole();
  } catch (error) {
    logger.error({ err_code: errorCode(error) }, 'database preflight failed; refusing to start');
    await db.close();
    return 1;
  }

  const adapter = config.notificationAdapter === 'resend' && config.resend !== null
    ? new ResendNotificationAdapter({
        apiKey: config.resend.apiKey,
        from: config.resend.from,
        logger,
        // The address is read from the database under the job owner's context,
        // never taken from a job payload.
        lookupRecipient: (userId) => db.recipientEmail(userId),
      })
    : createAdapter(config.notificationAdapter === 'resend' ? 'none' : config.notificationAdapter,
        logger, config.notificationLogFile);

  logger.info(
    {
      db_user: identity.user,
      database: identity.database,
      node_env: config.nodeEnv,
      adapter: adapter.kind,
      real_delivery: adapter.isRealDelivery,
      lease_seconds: config.leaseSeconds,
      poll_interval_ms: config.pollIntervalMs,
      sweep_interval_ms: config.sweepIntervalMs,
      handlers: KNOWN_JOB_KINDS,
    },
    'worker starting',
  );
  if (!adapter.isRealDelivery) {
    logger.warn('notification adapter does NOT deliver to real recipients; output is a local simulation');
  }

  const runner = new Runner(config, db, adapter, logger);

  const health = config.healthPort === null ? null : startHealthServer(config.healthPort, {
    snapshot: () => ({ draining: runner.draining, ...runner.stats }),
    ready: async () => {
      if (runner.draining) return { ok: false, detail: 'draining' };
      try {
        await db.withWorkerTx(null, (sql) => sql.query('SELECT 1'));
        return { ok: true, detail: 'database reachable' };
      } catch (error) {
        return { ok: false, detail: `database unreachable: ${errorCode(error)}` };
      }
    },
  }, logger);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      logger.warn({ signal }, 'second signal during shutdown; exiting immediately');
      process.exit(1);
    }
    shuttingDown = true;
    logger.info({ signal }, 'shutdown signal received; draining');
    void runner.drain().then(async (result) => {
      health?.close();
      await db.close();
      logger.info({ clean: result.finished, ...runner.stats }, 'worker stopped');
      process.exit(result.finished ? 0 : 0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await runner.start();
  health?.close();
  await db.close();
  return 0;
}

main().then(
  (code) => { process.exitCode = code; },
  (error: unknown) => {
    console.error(`[worker] fatal: ${errorCode(error)}`);
    process.exitCode = 1;
  },
);
