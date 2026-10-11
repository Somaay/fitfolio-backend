/** Uniform error contract: every API failure is `{code, message, fields, request_id}`. */
export const ERROR_CODES = {
    // 400 — the request could not be parsed or violates the schema
    malformed_request: 400,
    // 401 / 403
    unauthenticated: 401,
    forbidden: 403,
    // 404 — absent OR not owned. Never distinguish the two: that would leak existence.
    not_found: 404,
    // 409 — state conflict, including idempotency-key reuse with a different payload
    state_conflict: 409,
    idempotency_key_conflict: 409,
    // 412 — optimistic concurrency: If-Match did not match the current version
    stale_version: 412,
    // 422 — well-formed but fails a business rule
    validation_failed: 422,
    // 429 / 500 / 503
    rate_limited: 429,
    internal_error: 500,
    service_unavailable: 503,
};
export class ApiError extends Error {
    code;
    status;
    fields;
    constructor(code, message, fields = []) {
        super(message);
        this.name = 'ApiError';
        this.code = code;
        this.status = ERROR_CODES[code];
        this.fields = fields;
    }
    toBody(requestId) {
        return { code: this.code, message: this.message, fields: this.fields, request_id: requestId };
    }
    static notFound(what = 'resource') {
        return new ApiError('not_found', `${what} not found`);
    }
    static validation(message, fields = []) {
        return new ApiError('validation_failed', message, fields);
    }
    static conflict(message) {
        return new ApiError('state_conflict', message);
    }
    static stale(message = 'the resource changed since you last read it') {
        return new ApiError('stale_version', message);
    }
}
//# sourceMappingURL=errors.js.map