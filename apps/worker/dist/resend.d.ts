/**
 * Resend delivery adapter — the first transport in this build that reaches a
 * real person.
 *
 * Plain HTTPS against https://api.resend.com/emails. No SDK: the API is one
 * POST, Node has `fetch`, and a dependency that only wraps a single request is
 * a dependency to keep patched for nothing.
 *
 * Two rules this adapter must never break (docs/operations.md):
 *   1. The action link is NEVER logged. It is the entire secret of a password
 *      reset. Only the simulated adapter prints it.
 *   2. The recipient address comes from the DATABASE via `userId`, never from a
 *      job payload — `email` is a forbidden notification variable precisely so
 *      addresses do not end up in logs.
 */
import type { Logger } from 'pino';
import { type Notification, type NotificationAdapter } from './notifications.js';
/** Resolves a recipient address for a user id. Backed by the database. */
export type RecipientLookup = (userId: string) => Promise<string | null>;
/** Injected so tests can drive the adapter without touching the network. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
export interface ResendOptions {
    readonly apiKey: string;
    /** e.g. `Fitfolio <no-reply@yourdomain.com>` — must be a verified domain. */
    readonly from: string;
    readonly lookupRecipient: RecipientLookup;
    readonly logger: Logger;
    readonly fetchImpl?: FetchLike;
    readonly timeoutMs?: number;
}
/**
 * A 4xx will fail the same way on the fifth attempt (bad key, unverified
 * domain, malformed address), so it is permanent. A 5xx, a timeout or a
 * transport error is worth retrying.
 */
export declare class ResendDeliveryError extends Error {
    readonly retryable: boolean;
    readonly code: string;
    constructor(code: string, retryable: boolean, message: string);
}
export declare class ResendNotificationAdapter implements NotificationAdapter {
    #private;
    readonly kind = "resend";
    readonly isRealDelivery = true;
    constructor(options: ResendOptions);
    send(notification: Notification): Promise<void>;
}
//# sourceMappingURL=resend.d.ts.map