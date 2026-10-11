/**
 * Notification delivery adapters.
 *
 * `NOTIFICATION_ADAPTER=log` writes a redacted line to stdout (and optionally a
 * local file) and labels it a simulation — it reaches nobody. `none` drops
 * everything. `resend` (see resend.ts) is the one adapter that reaches a real
 * person; `isRealDelivery` is how every caller tells them apart, and the
 * at-least-once caveat in docs/operations.md applies to it.
 *
 * CONTENT RULE: a notification carries no weight, no calorie or protein figure,
 * no monetary amount and no expense description. Those are exactly the facts a
 * push preview leaks onto a lock screen. Reminders say "it is time to log", not
 * what was logged.
 */
import { appendFile } from 'node:fs/promises';
import type { Logger } from 'pino';
import { userRef } from './logger.js';

export interface Notification {
  /** Pseudonymous recipient. Never an email address or phone number. */
  readonly userId: string;
  /** Stable template identifier, e.g. `weekly_reminder`. */
  readonly template: string;
  /** Idempotency handle carried from the job. */
  readonly dedupeKey: string;
  /**
   * Substitutions. Only non-sensitive scalars are permitted; `assertSafeContent`
   * rejects anything else at runtime rather than trusting the caller.
   */
  readonly vars: Readonly<Record<string, string | number | boolean>>;
  /**
   * A one-time action link (today: a password reset). Held apart from `vars`
   * because it is a SECRET, not content: a real provider puts it in the message
   * body, and it must never be written to a log or an audit row.
   *
   * The simulated adapter is the one exception — it prints the link, clearly
   * marked, because that is the only way to complete the flow locally with no
   * email provider configured. An adapter with `isRealDelivery = true` must
   * never log it.
   */
  readonly link?: string;
}

export interface NotificationAdapter {
  readonly kind: string;
  /** True when this adapter actually reaches a human. Always false today. */
  readonly isRealDelivery: boolean;
  send(notification: Notification): Promise<void>;
}

/** Variable names that must never appear in a notification payload. */
const FORBIDDEN_VARS = [
  'weight', 'weight_kg', 'kg', 'lb', 'calorie', 'calories', 'protein', 'protein_g',
  'amount', 'amount_minor', 'minor', 'spend', 'spent', 'budget', 'total',
  'description', 'note', 'email', 'phone', 'name', 'display_name',
];

export class NotificationContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotificationContentError';
  }
}

/**
 * Enforce the content rule in code, not just in review. A future handler that
 * "just adds the weekly weight change" to a reminder fails here.
 */
export function assertSafeContent(notification: Notification): void {
  for (const [key, value] of Object.entries(notification.vars)) {
    const lowered = key.toLowerCase();
    if (FORBIDDEN_VARS.some((bad) => lowered === bad || lowered.endsWith(`_${bad}`) || lowered.startsWith(`${bad}_`))) {
      throw new NotificationContentError(`notification variable "${key}" is not permitted in delivered content`);
    }
    const type = typeof value;
    if (type !== 'string' && type !== 'number' && type !== 'boolean') {
      throw new NotificationContentError(`notification variable "${key}" must be a scalar`);
    }
    if (type === 'string' && (value as string).length > 64) {
      throw new NotificationContentError(`notification variable "${key}" is too long to be non-identifying`);
    }
  }
}

/**
 * Local, non-delivering adapter. Every line is explicitly labelled so a log
 * reader cannot mistake it for evidence that a user was contacted.
 */
export class LogNotificationAdapter implements NotificationAdapter {
  readonly kind = 'log';
  readonly isRealDelivery = false;
  readonly #logger: Logger;
  readonly #file: string | null;

  constructor(logger: Logger, file: string | null = null) {
    this.#logger = logger;
    this.#file = file;
  }

  async send(notification: Notification): Promise<void> {
    assertSafeContent(notification);
    const line = {
      delivery: 'SIMULATED — NOT REAL DELIVERY',
      adapter: this.kind,
      template: notification.template,
      recipient: userRef(notification.userId),
      dedupe_key: notification.dedupeKey,
      vars: notification.vars,
      // Printed ONLY because this adapter reaches no one. See the note on
      // Notification.link: a real adapter hands this to the provider instead.
      ...(notification.link === undefined ? {} : {
        dev_only_link: notification.link,
        link_warning: 'a real adapter must send this, never log it',
      }),
      at: new Date().toISOString(),
    };
    this.#logger.info(line, 'notification (simulated)');
    if (this.#file !== null) {
      await appendFile(this.#file, `${JSON.stringify(line)}\n`, 'utf8');
    }
  }
}

/** Drops everything. Useful when a deployment must be certain nothing is emitted. */
export class NullNotificationAdapter implements NotificationAdapter {
  readonly kind = 'none';
  readonly isRealDelivery = false;
  readonly #logger: Logger;

  constructor(logger: Logger) {
    this.#logger = logger;
  }

  async send(notification: Notification): Promise<void> {
    assertSafeContent(notification);
    this.#logger.debug(
      { template: notification.template, recipient: userRef(notification.userId), delivery: 'DISCARDED' },
      'notification discarded (adapter=none)',
    );
    return Promise.resolve();
  }
}

/**
 * Builds the configured adapter. `resend` is constructed in worker.ts instead,
 * because it needs a database-backed recipient lookup that this module has no
 * business knowing about.
 */
export function createAdapter(kind: 'log' | 'none', logger: Logger, file: string | null): NotificationAdapter {
  return kind === 'none' ? new NullNotificationAdapter(logger) : new LogNotificationAdapter(logger, file);
}
