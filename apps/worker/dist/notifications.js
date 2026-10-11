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
import { userRef } from './logger.js';
/** Variable names that must never appear in a notification payload. */
const FORBIDDEN_VARS = [
    'weight', 'weight_kg', 'kg', 'lb', 'calorie', 'calories', 'protein', 'protein_g',
    'amount', 'amount_minor', 'minor', 'spend', 'spent', 'budget', 'total',
    'description', 'note', 'email', 'phone', 'name', 'display_name',
];
export class NotificationContentError extends Error {
    constructor(message) {
        super(message);
        this.name = 'NotificationContentError';
    }
}
/**
 * Enforce the content rule in code, not just in review. A future handler that
 * "just adds the weekly weight change" to a reminder fails here.
 */
export function assertSafeContent(notification) {
    for (const [key, value] of Object.entries(notification.vars)) {
        const lowered = key.toLowerCase();
        if (FORBIDDEN_VARS.some((bad) => lowered === bad || lowered.endsWith(`_${bad}`) || lowered.startsWith(`${bad}_`))) {
            throw new NotificationContentError(`notification variable "${key}" is not permitted in delivered content`);
        }
        const type = typeof value;
        if (type !== 'string' && type !== 'number' && type !== 'boolean') {
            throw new NotificationContentError(`notification variable "${key}" must be a scalar`);
        }
        if (type === 'string' && value.length > 64) {
            throw new NotificationContentError(`notification variable "${key}" is too long to be non-identifying`);
        }
    }
}
/**
 * Local, non-delivering adapter. Every line is explicitly labelled so a log
 * reader cannot mistake it for evidence that a user was contacted.
 */
export class LogNotificationAdapter {
    kind = 'log';
    isRealDelivery = false;
    #logger;
    #file;
    constructor(logger, file = null) {
        this.#logger = logger;
        this.#file = file;
    }
    async send(notification) {
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
export class NullNotificationAdapter {
    kind = 'none';
    isRealDelivery = false;
    #logger;
    constructor(logger) {
        this.#logger = logger;
    }
    async send(notification) {
        assertSafeContent(notification);
        this.#logger.debug({ template: notification.template, recipient: userRef(notification.userId), delivery: 'DISCARDED' }, 'notification discarded (adapter=none)');
        return Promise.resolve();
    }
}
/**
 * Builds the configured adapter. `resend` is constructed in worker.ts instead,
 * because it needs a database-backed recipient lookup that this module has no
 * business knowing about.
 */
export function createAdapter(kind, logger, file) {
    return kind === 'none' ? new NullNotificationAdapter(logger) : new LogNotificationAdapter(logger, file);
}
//# sourceMappingURL=notifications.js.map