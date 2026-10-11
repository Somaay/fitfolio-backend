/**
 * Optimistic concurrency.
 *
 * A mutable read returns `version` and an `ETag`. A PATCH/DELETE carries
 * `If-Match: "<version>"`, the UPDATE is guarded by `WHERE version = $expected`,
 * and zero affected rows means someone else changed the row first -> 412.
 * A last-write-wins UPDATE would silently discard the other edit.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from '@hi/contracts';

const IF_MATCH = /^(?:W\/)?"?(\d{1,9})"?$/;

export function parseIfMatch(request: FastifyRequest): number {
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

export function setEtag(reply: FastifyReply, version: number): void {
  void reply.header('ETag', `"${version}"`);
}

/** Zero affected rows on a version-guarded UPDATE is a stale write, never a 404. */
export function assertFresh(rowCount: number | null): void {
  if ((rowCount ?? 0) === 0) throw ApiError.stale();
}
