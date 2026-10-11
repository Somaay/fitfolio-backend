/**
 * Optimistic concurrency.
 *
 * A mutable read returns `version` and an `ETag`. A PATCH/DELETE carries
 * `If-Match: "<version>"`, the UPDATE is guarded by `WHERE version = $expected`,
 * and zero affected rows means someone else changed the row first -> 412.
 * A last-write-wins UPDATE would silently discard the other edit.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
export declare function parseIfMatch(request: FastifyRequest): number;
export declare function setEtag(reply: FastifyReply, version: number): void;
/** Zero affected rows on a version-guarded UPDATE is a stale write, never a 404. */
export declare function assertFresh(rowCount: number | null): void;
//# sourceMappingURL=concurrency.d.ts.map