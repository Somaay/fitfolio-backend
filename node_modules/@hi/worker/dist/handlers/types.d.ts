import type { Logger } from 'pino';
import type { Sql } from '../db.js';
import type { NotificationAdapter } from '../notifications.js';
import type { OutboxJob } from '../queue.js';
export interface HandlerContext {
    /**
     * A transaction with `app.worker='on'` AND `app.user_id=<job owner>` already
     * set. Handlers must do all their work here so that success and the
     * acknowledgement commit together.
     */
    readonly sql: Sql;
    readonly job: OutboxJob;
    readonly logger: Logger;
    readonly adapter: NotificationAdapter;
    readonly now: Date;
}
/**
 * `done`      — work finished (or was correctly skipped); acknowledge.
 * `skipped`   — nothing to do, acknowledge. Carries a machine-readable reason.
 * `retry`     — transient problem; back off and try again within max_attempts.
 * `permanent` — the job can never succeed; fail it now without burning retries.
 */
export type HandlerResult = {
    readonly outcome: 'done';
} | {
    readonly outcome: 'skipped';
    readonly reason: string;
} | {
    readonly outcome: 'retry';
    readonly code: string;
} | {
    readonly outcome: 'permanent';
    readonly code: string;
};
export type Handler = (context: HandlerContext) => Promise<HandlerResult>;
/** Read a required string field from an untrusted job payload. */
export declare function requireStringField(payload: Record<string, unknown>, field: string): string | null;
//# sourceMappingURL=types.d.ts.map