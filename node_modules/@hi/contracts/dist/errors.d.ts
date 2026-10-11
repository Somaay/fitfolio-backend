/** Uniform error contract: every API failure is `{code, message, fields, request_id}`. */
export declare const ERROR_CODES: {
    readonly malformed_request: 400;
    readonly unauthenticated: 401;
    readonly forbidden: 403;
    readonly not_found: 404;
    readonly state_conflict: 409;
    readonly idempotency_key_conflict: 409;
    readonly stale_version: 412;
    readonly validation_failed: 422;
    readonly rate_limited: 429;
    readonly internal_error: 500;
    readonly service_unavailable: 503;
};
export type ErrorCode = keyof typeof ERROR_CODES;
export interface FieldError {
    readonly path: string;
    readonly message: string;
}
export interface ApiErrorBody {
    readonly code: ErrorCode;
    readonly message: string;
    readonly fields: readonly FieldError[];
    readonly request_id: string;
}
export declare class ApiError extends Error {
    readonly code: ErrorCode;
    readonly status: number;
    readonly fields: readonly FieldError[];
    constructor(code: ErrorCode, message: string, fields?: readonly FieldError[]);
    toBody(requestId: string): ApiErrorBody;
    static notFound(what?: string): ApiError;
    static validation(message: string, fields?: readonly FieldError[]): ApiError;
    static conflict(message: string): ApiError;
    static stale(message?: string): ApiError;
}
//# sourceMappingURL=errors.d.ts.map