/**
 * Structured logging with redaction.
 *
 * Rule (mirrors D-10 on audit_events): worker logs carry IDENTIFIERS and STATE,
 * never body measurements, amounts, free text or contact details. Anything that
 * could describe a user's health or spending is redacted here as a last line of
 * defence — the call sites are also expected not to pass it.
 */
import { type Logger } from 'pino';
/**
 * Paths are redacted wherever they appear (`*.` wildcards), so a nested job
 * payload cannot smuggle a weight into a log line by being logged as an object.
 */
export declare const REDACTED_PATHS: readonly string[];
export declare function createLogger(options: {
    level: string;
    name?: string;
}): Logger;
/**
 * Collapse any thrown value to a SHORT, stable, user-data-free code.
 *
 * `last_error_code` is persisted and is capped at 64 characters by the schema.
 * A database error message can quote a row value, so the message is never used:
 * only the class of failure survives.
 */
export declare function errorCode(error: unknown): string;
/**
 * A user id is a pseudonymous UUID, but a full one still correlates a person
 * across log aggregation systems. Log lines carry a short prefix; the full id
 * stays in the database.
 */
export declare const userRef: (userId: string) => string;
//# sourceMappingURL=logger.d.ts.map