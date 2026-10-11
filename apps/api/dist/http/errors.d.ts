/**
 * The single error boundary. Every failure leaves the API as
 * `{code, message, fields, request_id}` and nothing else.
 *
 * Privacy rule (D-10): weights, amounts, descriptions and tokens never reach a
 * log line or a client-visible message. Postgres error text routinely quotes the
 * offending VALUE, so raw driver messages are scrubbed before they are logged and
 * are never forwarded to the client.
 */
import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { ApiError } from '@hi/contracts';
/** Redact anything that could be a measurement, an amount or free text. */
export declare function scrubForLog(text: string): string;
export declare function zodToApiError(error: ZodError, where: 'body' | 'query' | 'params' | 'headers'): ApiError;
/** Translate a driver-level failure into a contract error, or null if unexpected. */
export declare function translatePgError(error: unknown): ApiError | null;
export declare function toApiError(error: unknown): {
    apiError: ApiError;
    unexpected: boolean;
};
export declare function registerErrorHandling(app: FastifyInstance): void;
//# sourceMappingURL=errors.d.ts.map