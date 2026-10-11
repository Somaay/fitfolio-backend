/** Opaque keyset cursors. Stable `(sort key, id)` ordering, never an offset. */
import { ApiError } from '@hi/contracts';
const SEPARATOR = '|';
export function encodeCursor(parts) {
    return Buffer.from(parts.join(SEPARATOR), 'utf8').toString('base64url');
}
export function decodeCursor(cursor, expectedParts) {
    let decoded;
    try {
        decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    }
    catch {
        throw new ApiError('malformed_request', 'cursor is not valid');
    }
    const parts = decoded.split(SEPARATOR);
    if (parts.length !== expectedParts || parts.some((p) => p === '')) {
        throw new ApiError('malformed_request', 'cursor is not valid');
    }
    return parts;
}
//# sourceMappingURL=cursor.js.map