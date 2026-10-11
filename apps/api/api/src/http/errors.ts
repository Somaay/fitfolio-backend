/**
 * The single error boundary. Every failure leaves the API as
 * `{code, message, fields, request_id}` and nothing else.
 *
 * Privacy rule (D-10): weights, amounts, descriptions and tokens never reach a
 * log line or a client-visible message. Postgres error text routinely quotes the
 * offending VALUE, so raw driver messages are scrubbed before they are logged and
 * are never forwarded to the client.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError, type ZodIssue } from 'zod';
import { ApiError, type FieldError, MoneyError, CalendarError, WeightError } from '@hi/contracts';
import { PG, pgConstraint, pgErrorCode } from '../db/pool.js';

/** Redact anything that could be a measurement, an amount or free text. */
export function scrubForLog(text: string): string {
  return text
    .replace(/'[^']*'/g, "'<redacted>'")
    .replace(/"[^"]*"/g, '"<redacted>"')
    .replace(/\([^)]*\)=\([^)]*\)/g, '(<redacted>)=(<redacted>)')
    .replace(/\d/g, '#')
    .slice(0, 300);
}

function issueToField(issue: ZodIssue): FieldError {
  return { path: issue.path.join('.') || '(body)', message: issue.message };
}

export function zodToApiError(error: ZodError, where: 'body' | 'query' | 'params' | 'headers'): ApiError {
  const fields = error.issues.map(issueToField);
  // A malformed shape is a 400; a well-formed shape failing a business refinement
  // is a 422. Zod reports both, so the distinction is made on issue kind.
  const onlyRefinements = error.issues.every((i) => i.code === 'custom');
  return new ApiError(
    onlyRefinements ? 'validation_failed' : 'malformed_request',
    onlyRefinements ? 'the request failed a validation rule' : `the request ${where} is not valid`,
    fields,
  );
}

/** Translate a driver-level failure into a contract error, or null if unexpected. */
export function translatePgError(error: unknown): ApiError | null {
  const code = pgErrorCode(error);
  if (code === null) return null;
  const constraint = pgConstraint(error);
  switch (code) {
    case PG.uniqueViolation:
      if (constraint === 'one_active_plan_per_user') {
        return new ApiError('state_conflict', 'you already have an active plan');
      }
      if (constraint === 'idempotency_keys_pkey') {
        return new ApiError('state_conflict', 'a concurrent request with this idempotency key is in flight');
      }
      return new ApiError('state_conflict', 'that record already exists');
    case PG.foreignKeyViolation:
      // A composite (user_id, plan_id, ...) FK failure means the referenced row is
      // not owned by this user or not in this plan. Never say which: that leaks existence.
      return ApiError.notFound('referenced resource');
    case PG.checkViolation:
      return ApiError.validation('the request violates a stored data rule');
    case PG.notNullViolation:
      return new ApiError('malformed_request', 'a required field is missing');
    case PG.serializationFailure:
    case PG.deadlockDetected:
      return new ApiError('state_conflict', 'the request conflicted with a concurrent change; retry');
    case PG.insufficientPrivilege:
      return ApiError.notFound('resource');
    default:
      return null;
  }
}

export function toApiError(error: unknown): { apiError: ApiError; unexpected: boolean } {
  if (error instanceof ApiError) return { apiError: error, unexpected: false };
  if (error instanceof ZodError) return { apiError: zodToApiError(error, 'body'), unexpected: false };
  if (error instanceof MoneyError || error instanceof WeightError || error instanceof CalendarError) {
    // These carry only the shape of the offending value, never a stored fact.
    return { apiError: ApiError.validation(error.message), unexpected: false };
  }
  const translated = translatePgError(error);
  if (translated) return { apiError: translated, unexpected: false };

  // Body parsing fails BEFORE any route handler runs, so these never pass through
  // the validation layer. They are client mistakes and must never surface as a 500.
  // The parser's own message is deliberately dropped: it quotes the offending body.
  const fastifyCode = pgErrorCode(error);
  const statusCode = (error as { statusCode?: number } | null)?.statusCode;

  if (fastifyCode === 'FST_ERR_CTP_BODY_TOO_LARGE' || statusCode === 413) {
    return { apiError: new ApiError('malformed_request', 'request body too large'), unexpected: false };
  }
  if (fastifyCode?.startsWith('FST_ERR_CTP_') === true || statusCode === 415) {
    return {
      apiError: new ApiError('malformed_request', 'the request body could not be parsed as JSON', [
        { path: '(body)', message: 'send a valid JSON document with content-type: application/json' },
      ]),
      unexpected: false,
    };
  }
  if (error instanceof SyntaxError || fastifyCode === 'FST_ERR_VALIDATION' || statusCode === 400) {
    return {
      apiError: new ApiError('malformed_request', 'the request body could not be parsed as JSON', [
        { path: '(body)', message: 'send a valid JSON document' },
      ]),
      unexpected: false,
    };
  }

  return { apiError: new ApiError('internal_error', 'the request could not be completed'), unexpected: true };
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    // When this process also serves the built SPA, a GET for an unknown path is
    // usually a client route (/spending, /progress) being loaded or refreshed —
    // the app owns its own routing, so hand it index.html. Anything under /v1/
    // and every non-GET stays a real 404 in the standard error shape: a missing
    // API route must never answer with an HTML page.
    const isClientRoute = app.config.serveWeb
      && request.method === 'GET'
      && !request.url.startsWith('/v1/')
      && !request.url.startsWith('/healthz')
      && !request.url.startsWith('/readyz');

    if (isClientRoute) {
      void reply.type('text/html').sendFile('index.html');
      return;
    }
    const error = ApiError.notFound('route');
    void reply.code(404).send(error.toBody(request.id));
  });

  app.setErrorHandler((error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    // Fastify's own rate limiter reports 429 through statusCode.
    const statusCode = (error as { statusCode?: number } | null)?.statusCode;
    if (statusCode === 429) {
      const limited = new ApiError('rate_limited', 'too many requests; slow down');
      void reply.code(429).send(limited.toBody(request.id));
      return;
    }

    const { apiError, unexpected } = toApiError(error);
    const detail = error instanceof Error ? scrubForLog(error.message) : 'non-error thrown';

    if (unexpected) {
      request.log.error(
        { err_code: pgErrorCode(error), err_constraint: pgConstraint(error), detail },
        'unhandled request failure',
      );
    } else if (apiError.status >= 500) {
      request.log.error({ code: apiError.code, detail }, 'request failed');
    } else {
      request.log.info({ code: apiError.code, status: apiError.status }, 'request rejected');
    }

    void reply.code(apiError.status).send(apiError.toBody(request.id));
  });
}
