/**
 * Exports and account deletion.
 *
 * D-11: `DELETE /v1/me` must kill ACCESS IMMEDIATELY, not eventually. It stamps
 * `deactivated_at` and `deletion_requested_at` and enqueues the erasure job in the
 * SAME transaction, so the account cannot be left deactivated with no job, or
 * queued for erasure while still usable. `requireAuth` rejects a deactivated user
 * with 403 from the very next request onward. The worker performs the actual
 * erasure through `app_erase_account`, the one routine allowed to delete the
 * append-only history the API role may not touch.
 */
import type { FastifyInstance } from 'fastify';
export declare function registerPrivacyRoutes(app: FastifyInstance): void;
//# sourceMappingURL=routes.d.ts.map