import { ApiError } from '@hi/contracts';
const IF_MATCH = /^(?:W\/)?"?(\d{1,9})"?$/;
export function parseIfMatch(request) {
    const raw = request.headers['if-match'];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value === undefined || value.trim() === '') {
        throw new ApiError('malformed_request', 'If-Match is required for this operation', [
            { path: 'If-Match', message: 'send the version from your last read, e.g. If-Match: "3"' },
        ]);
    }
    if (value.trim() === '*') {
        throw new ApiError('malformed_request', 'If-Match: * is not accepted; send an exact version', [
            { path: 'If-Match', message: 'send the version from your last read' },
        ]);
    }
    const match = IF_MATCH.exec(value.trim());
    if (!match?.[1]) {
        throw new ApiError('malformed_request', 'If-Match must be a quoted integer version', [
            { path: 'If-Match', message: 'expected a value like "3"' },
        ]);
    }
    return Number(match[1]);
}
export function setEtag(reply, version) {
    void reply.header('ETag', `"${version}"`);
}
/** Zero affected rows on a version-guarded UPDATE is a stale write, never a 404. */
export function assertFresh(rowCount) {
    if ((rowCount ?? 0) === 0)
        throw ApiError.stale();
}
//# sourceMappingURL=concurrency.js.map