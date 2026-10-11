import { ApiError } from '@hi/contracts';
import { zodToApiError } from './errors.js';
export function parseOrThrow(schema, value, where) {
    const result = schema.safeParse(value);
    if (!result.success)
        throw zodToApiError(result.error, where);
    return result.data;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * An id that is not even a uuid cannot be owned, so it is a 404 — exactly the
 * same answer as a uuid belonging to someone else. Never distinguish the two.
 */
export function requireUuidParam(value, _name) {
    if (typeof value !== 'string' || !UUID.test(value))
        throw ApiError.notFound('resource');
    return value;
}
//# sourceMappingURL=validate.js.map