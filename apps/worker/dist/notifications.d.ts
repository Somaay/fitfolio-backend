import type { Logger } from 'pino';
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
export declare class NotificationContentError extends Error {
    constructor(message: string);
}
/**
 * Enforce the content rule in code, not just in review. A future handler that
 * "just adds the weekly weight change" to a reminder fails here.
 */
export declare function assertSafeContent(notification: Notification): void;
/**
 * Local, non-delivering adapter. Every line is explicitly labelled so a log
 * reader cannot mistake it for evidence that a user was contacted.
 */
export declare class LogNotificationAdapter implements NotificationAdapter {
    #private;
    readonly kind = "log";
    readonly isRealDelivery = false;
    constructor(logger: Logger, file?: string | null);
    send(notification: Notification): Promise<void>;
}
/** Drops everything. Useful when a deployment must be certain nothing is emitted. */
export declare class NullNotificationAdapter implements NotificationAdapter {
    #private;
    readonly kind = "none";
    readonly isRealDelivery = false;
    constructor(logger: Logger);
    send(notification: Notification): Promise<void>;
}
/**
 * Builds the configured adapter. `resend` is constructed in worker.ts instead,
 * because it needs a database-backed recipient lookup that this module has no
 * business knowing about.
 */
export declare function createAdapter(kind: 'log' | 'none', logger: Logger, file: string | null): NotificationAdapter;
//# sourceMappingURL=notifications.d.ts.map