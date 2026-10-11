/**
 * Unit tests for the parts of the worker that are pure: configuration
 * validation, retry backoff, notification content safety and error-code
 * sanitisation. Everything that needs a database is covered by the integration
 * suite instead.
 */
import { describe, expect, it } from 'vitest';
import { loadConfig, ConfigError } from '../../src/config.js';
import { backoffSeconds } from '../../src/queue.js';
import { assertSafeContent, NotificationContentError } from '../../src/notifications.js';
import { errorCode, userRef } from '../../src/logger.js';

const baseEnv = (overrides: Record<string, string | undefined> = {}) => ({
  NODE_ENV: 'test',
  WORKER_DATABASE_URL: 'postgres://hi_worker:pw@127.0.0.1:55433/health_investment',
  ...overrides,
});

describe('loadConfig', () => {
  it('accepts a restricted worker connection string', () => {
    const config = loadConfig(baseEnv());
    expect(config.databaseUrl).toContain('hi_worker');
    expect(config.notificationAdapter).toBe('log');
  });

  it('refuses a superuser connection string, because it would bypass RLS', () => {
    expect(() => loadConfig(baseEnv({ WORKER_DATABASE_URL: 'postgres://postgres@127.0.0.1:55433/health_investment' })))
      .toThrow(ConfigError);
  });

  it('refuses to reuse the migration connection string', () => {
    const url = 'postgres://hi_worker:pw@127.0.0.1:55433/health_investment';
    expect(() => loadConfig(baseEnv({ MIGRATION_DATABASE_URL: url }))).toThrow(ConfigError);
  });

  it('requires a connection string at all', () => {
    expect(() => loadConfig({ NODE_ENV: 'test' })).toThrow(ConfigError);
  });

  it('rejects an unknown notification adapter rather than silently logging', () => {
    expect(() => loadConfig(baseEnv({ NOTIFICATION_ADAPTER: 'sendgrid' }))).toThrow(ConfigError);
  });

  it('rejects a lease shorter than the poll interval', () => {
    expect(() => loadConfig(baseEnv({ WORKER_LEASE_SECONDS: '5', WORKER_POLL_INTERVAL_MS: '60000' })))
      .toThrow(ConfigError);
  });

  it('demands TLS and a password in production', () => {
    let problems: readonly string[] = [];
    try {
      loadConfig(baseEnv({ NODE_ENV: 'production', WORKER_DATABASE_URL: 'postgres://hi_worker@db/health' }));
    } catch (error) {
      problems = (error as ConfigError).problems;
    }
    // Asserts the RULE (TLS is demanded), not one spelling of it: no-verify is
    // also accepted now, because managed providers present private CA chains
    // that a verifying mode cannot validate. What must never pass is no TLS.
    expect(problems.join(' ')).toContain('sslmode');
    expect(problems.join(' ')).toContain('password');
  });

  it('rejects a non-numeric interval instead of falling back silently', () => {
    expect(() => loadConfig(baseEnv({ WORKER_POLL_INTERVAL_MS: 'soon' }))).toThrow(ConfigError);
  });
});

describe('backoffSeconds', () => {
  const options = { baseSeconds: 10, maxSeconds: 3600 };

  it('grows exponentially with the attempt count', () => {
    const noJitter = () => 1;
    expect(backoffSeconds(1, options, noJitter)).toBe(10);
    expect(backoffSeconds(2, options, noJitter)).toBe(20);
    expect(backoffSeconds(3, options, noJitter)).toBe(40);
    expect(backoffSeconds(4, options, noJitter)).toBe(80);
  });

  it('is capped, so a long-failing job does not disappear for days', () => {
    expect(backoffSeconds(40, options, () => 1)).toBe(3600);
  });

  it('applies jitter between half the ceiling and the ceiling', () => {
    expect(backoffSeconds(3, options, () => 0)).toBe(20);
    expect(backoffSeconds(3, options, () => 1)).toBe(40);
  });

  it('never schedules a retry in the past', () => {
    expect(backoffSeconds(0, { baseSeconds: 1, maxSeconds: 1 }, () => 0)).toBeGreaterThanOrEqual(1);
  });
});

describe('assertSafeContent', () => {
  const notification = (vars: Record<string, string | number | boolean>) => ({
    userId: '11111111-1111-1111-1111-111111111111',
    template: 'weekly_reminder',
    dedupeKey: 'reminder:2026-W37',
    vars,
  });

  it('allows a week number and a plan reference', () => {
    expect(() => assertSafeContent(notification({ week: 4, plan_ref: '22222222' }))).not.toThrow();
  });

  it('rejects a weight', () => {
    expect(() => assertSafeContent(notification({ weight_kg: '90.500' }))).toThrow(NotificationContentError);
  });

  it('rejects calories and protein', () => {
    expect(() => assertSafeContent(notification({ calories: 2100 }))).toThrow(NotificationContentError);
    expect(() => assertSafeContent(notification({ protein_g: 140 }))).toThrow(NotificationContentError);
  });

  it('rejects money and expense descriptions', () => {
    expect(() => assertSafeContent(notification({ amount_minor: '180000' }))).toThrow(NotificationContentError);
    expect(() => assertSafeContent(notification({ description: 'Gold gym annual' }))).toThrow(NotificationContentError);
  });

  it('rejects contact details', () => {
    expect(() => assertSafeContent(notification({ email: 'a@b.c' }))).toThrow(NotificationContentError);
  });

  it('rejects a value long enough to carry free text', () => {
    expect(() => assertSafeContent(notification({ note_for_user: 'x'.repeat(65) }))).toThrow(NotificationContentError);
  });
});

describe('errorCode', () => {
  it('prefers the PostgreSQL SQLSTATE, never the message', () => {
    expect(errorCode({ code: '42501', message: 'permission denied for table users (alice@example.com)' }))
      .toBe('pg_42501');
  });

  it('falls back to the error class name', () => {
    expect(errorCode(new TypeError('weight 90.5 is not a number'))).toBe('typeerror');
  });

  it('never exceeds the 64-character column limit', () => {
    expect(errorCode({ name: 'x'.repeat(200) })).toHaveLength(64);
  });

  it('handles non-error throws', () => {
    expect(errorCode('boom')).toBe('unknown_error');
    expect(errorCode(null)).toBe('unknown_error');
  });
});

describe('userRef', () => {
  it('logs a short prefix rather than the whole identifier', () => {
    expect(userRef('11111111-2222-3333-4444-555555555555')).toBe('u:11111111');
  });
});
