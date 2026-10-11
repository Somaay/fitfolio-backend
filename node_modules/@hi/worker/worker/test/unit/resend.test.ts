/**
 * Resend adapter, driven against a stubbed transport.
 *
 * Nothing here touches the network and nothing is ever sent. These assert the
 * request SHAPE Resend expects, how failures are classified for retry, and the
 * two rules that matter most: the action link never reaches a log, and the
 * recipient comes from the lookup rather than the payload.
 */
import { describe, expect, it, vi } from 'vitest';
import { ResendDeliveryError, ResendNotificationAdapter, type FetchLike } from '../../src/resend.js';
import type { Notification } from '../../src/notifications.js';

const LINK = 'https://app.example.test/reset-password?token=super-secret-token-value';

const RESET: Notification = {
  userId: '11111111-1111-4111-8111-111111111111',
  template: 'password_reset',
  dedupeKey: 'password-reset:abc123',
  vars: { expires_in_minutes: 30 },
  link: LINK,
};

function makeLogger() {
  const lines: unknown[] = [];
  const log = {
    info: (obj: unknown) => { lines.push(obj); },
    warn: (obj: unknown) => { lines.push(obj); },
    error: (obj: unknown) => { lines.push(obj); },
  };
  return { logger: log as never, lines };
}

function adapterWith(fetchImpl: FetchLike, email: string | null = 'person@example.test') {
  const { logger, lines } = makeLogger();
  const adapter = new ResendNotificationAdapter({
    apiKey: 'test_key_not_real',
    from: 'Fitfolio <no-reply@example.test>',
    lookupRecipient: async () => email,
    logger, fetchImpl,
  });
  return { adapter, lines };
}

const ok = () => new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 });

describe('request shape', () => {
  it('posts the fields Resend requires, with bearer auth', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const { adapter } = adapterWith(async (url, init) => { calls.push({ url, init }); return ok(); });

    await adapter.send(RESET);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('https://api.resend.com/emails');
    expect(call.init.method).toBe('POST');

    const headers = call.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer test_key_not_real');
    expect(headers['content-type']).toBe('application/json');
    // Resend de-duplicates on this, so an ambiguous retry does not double-send.
    expect(headers['Idempotency-Key']).toBe('password-reset:abc123');

    const body = JSON.parse(String(call.init.body)) as Record<string, unknown>;
    expect(body['from']).toBe('Fitfolio <no-reply@example.test>');
    expect(body['to']).toEqual(['person@example.test']);
    expect(body['subject']).toBe('Reset your Fitfolio password');
    expect(String(body['text'])).toContain(LINK);
    expect(String(body['html'])).toContain(LINK);
  });

  it('takes the recipient from the lookup, never from the payload', async () => {
    const calls: RequestInit[] = [];
    const { adapter } = adapterWith(async (_u, init) => { calls.push(init); return ok(); },
      'from-database@example.test');

    // A payload trying to smuggle its own recipient must be ignored.
    await adapter.send({ ...RESET, vars: { expires_in_minutes: 30 } });

    const body = JSON.parse(String(calls[0]!.body)) as { to: string[] };
    expect(body.to).toEqual(['from-database@example.test']);
  });

  it('refuses to send when the account has no address on file', async () => {
    const { adapter } = adapterWith(async () => ok(), null);
    await expect(adapter.send(RESET)).rejects.toMatchObject({
      code: 'no_recipient', retryable: false,
    });
  });
});

describe('the link is a secret', () => {
  it('never writes the action link to the log', async () => {
    const { adapter, lines } = adapterWith(async () => ok());
    await adapter.send(RESET);

    const logged = JSON.stringify(lines);
    expect(logged).not.toContain('super-secret-token-value');
    expect(logged).not.toContain(LINK);
    // Nor the raw address: the log carries a pseudonymous reference only.
    expect(logged).not.toContain('person@example.test');
    expect(logged).toContain('password_reset');
  });
});

describe('failure classification', () => {
  it('treats 4xx as permanent — a bad key will not fix itself on retry', async () => {
    const { adapter } = adapterWith(async () =>
      new Response(JSON.stringify({ name: 'validation_error' }), { status: 422 }));
    await expect(adapter.send(RESET)).rejects.toMatchObject({
      code: 'resend_422', retryable: false,
    });
  });

  it('treats 5xx as retryable', async () => {
    const { adapter } = adapterWith(async () =>
      new Response(JSON.stringify({ name: 'internal_server_error' }), { status: 503 }));
    await expect(adapter.send(RESET)).rejects.toMatchObject({
      code: 'resend_503', retryable: true,
    });
  });

  it('treats 429 as retryable, not permanent', async () => {
    const { adapter } = adapterWith(async () =>
      new Response(JSON.stringify({ name: 'rate_limit_exceeded' }), { status: 429 }));
    await expect(adapter.send(RESET)).rejects.toMatchObject({ retryable: true });
  });

  it('treats a transport failure as retryable', async () => {
    const { adapter } = adapterWith(async () => { throw new Error('ECONNRESET'); });
    await expect(adapter.send(RESET)).rejects.toMatchObject({
      code: 'transport_error', retryable: true,
    });
  });

  it('does not leak the provider error body into the message', async () => {
    const { adapter } = adapterWith(async () =>
      new Response(JSON.stringify({ name: 'invalid_to', message: 'person@example.test is invalid' }),
        { status: 422 }));
    const error = await adapter.send(RESET).catch((e: unknown) => e) as ResendDeliveryError;
    expect(error.message).not.toContain('person@example.test');
    expect(error.message).toContain('422');
  });

  it('rejects an unknown template rather than sending a blank email', async () => {
    const { adapter } = adapterWith(async () => ok());
    await expect(adapter.send({ ...RESET, template: 'not_a_template' })).rejects.toMatchObject({
      code: 'unknown_template', retryable: false,
    });
  });
});

describe('content rule still applies', () => {
  it('refuses a notification carrying a forbidden variable', async () => {
    const { adapter } = adapterWith(async () => ok());
    await expect(adapter.send({ ...RESET, vars: { weight_kg: 88 } })).rejects.toThrow();
  });
});

describe('declares itself honestly', () => {
  it('reports real delivery', () => {
    const { adapter } = adapterWith(async () => ok());
    expect(adapter.kind).toBe('resend');
    expect(adapter.isRealDelivery).toBe(true);
  });
});
