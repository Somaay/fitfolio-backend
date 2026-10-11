/**
 * Structured logging with redaction.
 *
 * Rule (mirrors D-10 on audit_events): worker logs carry IDENTIFIERS and STATE,
 * never body measurements, amounts, free text or contact details. Anything that
 * could describe a user's health or spending is redacted here as a last line of
 * defence — the call sites are also expected not to pass it.
 */
import pino from 'pino';
/**
 * Paths are redacted wherever they appear (`*.` wildcards), so a nested job
 * payload cannot smuggle a weight into a log line by being logged as an object.
 */
export const REDACTED_PATHS = [
    'payload',
    '*.payload',
    '*.*.payload',
    'password',
    '*.password',
    'connectionString',
    '*.connectionString',
    'email',
    '*.email',
    'to',
    '*.to',
    'description',
    '*.description',
    'weight_kg',
    '*.weight_kg',
    'calories',
    '*.calories',
    'protein_g',
    '*.protein_g',
    'amount_minor',
    '*.amount_minor',
    'display_name',
    '*.display_name',
    'body',
    '*.body',
    'err.message',
];
export function createLogger(options) {
    return pino({
        name: options.name ?? 'hi-worker',
        level: options.level,
        base: { service: 'worker' },
        redact: { paths: [...REDACTED_PATHS], censor: '[redacted]' },
        formatters: {
            level: (label) => ({ level: label }),
        },
        timestamp: pino.stdTimeFunctions.isoTime,
    });
}
/**
 * Collapse any thrown value to a SHORT, stable, user-data-free code.
 *
 * `last_error_code` is persisted and is capped at 64 characters by the schema.
 * A database error message can quote a row value, so the message is never used:
 * only the class of failure survives.
 */
export function errorCode(error) {
    if (error !== null && typeof error === 'object') {
        const candidate = error;
        if (typeof candidate.code === 'string' && candidate.code !== '') {
            return sanitizeCode(`pg_${candidate.code}`);
        }
        if (typeof candidate.name === 'string' && candidate.name !== '') {
            return sanitizeCode(candidate.name);
        }
    }
    return 'unknown_error';
}
function sanitizeCode(value) {
    const normalized = value.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
    return (normalized === '' ? 'unknown_error' : normalized).slice(0, 64);
}
/**
 * A user id is a pseudonymous UUID, but a full one still correlates a person
 * across log aggregation systems. Log lines carry a short prefix; the full id
 * stays in the database.
 */
export const userRef = (userId) => `u:${userId.slice(0, 8)}`;
//# sourceMappingURL=logger.js.map