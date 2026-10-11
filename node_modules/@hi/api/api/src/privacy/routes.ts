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
import { ApiError } from '@hi/contracts';
import { z } from 'zod';
import { defineRoute } from '../openapi/registry.js';
import { mutate, readOnly, transact } from '../http/handlers.js';
import { parseOrThrow, requireUuidParam } from '../http/validate.js';
import { recordAudit } from '../http/audit.js';
import { clearSessionCookie } from '../auth/session.js';

/**
 * The confirmation is a BUSINESS rule, not a schema shape: a well-formed body
 * carrying the wrong word is a 422, so the UI can show it next to the input
 * rather than as a generic "malformed request".
 */
const DeleteAccountRequest = z.object({ confirm_text: z.string().max(32) });
const CONFIRMATION = 'DELETE';

const params = (request: { params: unknown }) => request.params as Record<string, unknown>;

export function registerPrivacyRoutes(app: FastifyInstance): void {
  defineRoute(app, {
    method: 'POST', url: '/v1/me/exports', operationId: 'requestExport',
    tags: ['privacy'], auth: true, idempotent: true,
    summary: 'Queue an owner-only, expiring export',
    responses: { 202: 'the export job is queued' },
  }, async (request, reply) => {
    await mutate(app, request, reply, 'POST /v1/me/exports', async ({ tx, user, requestId }) => {
      const { rows } = await tx.query<{ id: string; status: string; expires_at: Date; created_at: Date }>(
        `INSERT INTO account_exports (user_id) VALUES ($1)
         RETURNING id, status, expires_at, created_at`,
        [user.userId],
      );
      const row = rows[0];
      if (!row) throw new Error('export insert returned no row');
      // Queued in the SAME transaction as the export record: no orphan either way.
      await tx.query(
        `INSERT INTO outbox_jobs (user_id, kind, dedupe_key, payload)
         VALUES ($1, 'account_export', $2, $3::jsonb)
         ON CONFLICT (user_id, dedupe_key) DO NOTHING`,
        [user.userId, `account_export:${row.id}`, JSON.stringify({ export_id: row.id })],
      );
      await recordAudit(tx, {
        userId: user.userId, action: 'export.request', entityType: 'account_export', entityId: row.id, requestId,
      });
      return {
        status: 202,
        body: { id: row.id, status: row.status, expires_at: row.expires_at, created_at: row.created_at, payload: null },
        resourceId: row.id,
      };
    });
  });

  defineRoute(app, {
    method: 'GET', url: '/v1/me/exports/:exportId', operationId: 'getExport',
    tags: ['privacy'], auth: true, summary: 'Export status, and the payload once it is ready',
    description: 'Owner-only and expiring: an export past expires_at reports expired and returns no payload.',
    responses: { 200: 'the export status', 404: 'absent or not owned' },
  }, async (request, reply) => {
    const exportId = requireUuidParam(params(request).exportId, 'exportId');
    const body = await readOnly(app, request, async ({ tx, user }) => {
      const { rows } = await tx.query<{
        id: string; status: string; payload: unknown; expires_at: Date; created_at: Date; completed_at: Date | null;
      }>(
        `SELECT id, status, payload, expires_at, created_at, completed_at
           FROM account_exports WHERE id = $1 AND user_id = $2`,
        [exportId, user.userId],
      );
      const row = rows[0];
      if (!row) throw ApiError.notFound('export');
      const expired = row.expires_at.getTime() <= Date.now();
      return {
        id: row.id,
        status: expired && row.status !== 'failed' ? 'expired' : row.status,
        expires_at: row.expires_at,
        created_at: row.created_at,
        completed_at: row.completed_at,
        payload: !expired && row.status === 'ready' ? row.payload : null,
      };
    });
    void reply.code(200);
    return body;
  });

  defineRoute(app, {
    method: 'DELETE', url: '/v1/me', operationId: 'deleteAccount',
    tags: ['privacy'], auth: true, body: DeleteAccountRequest,
    summary: 'Deactivate immediately and queue erasure',
    description: 'Sets deactivated_at and deletion_requested_at and enqueues an account_erasure outbox job in one transaction. Access is refused from the next request onward.',
    responses: { 202: 'the account is deactivated and erasure is queued', 422: 'confirm_text was not DELETE' },
  }, async (request, reply) => {
    const body = parseOrThrow(DeleteAccountRequest, request.body, 'body');
    if (body.confirm_text !== CONFIRMATION) {
      throw ApiError.validation('the deletion was not confirmed', [
        { path: 'confirm_text', message: `type ${CONFIRMATION} to confirm` },
      ]);
    }
    const result = await transact(app, request, async ({ tx, user, requestId }) => {
      const { rows } = await tx.query<{ deactivated_at: Date; deletion_requested_at: Date }>(
        `UPDATE users
            SET deactivated_at = coalesce(deactivated_at, now()),
                deletion_requested_at = coalesce(deletion_requested_at, now())
          WHERE id = $1
          RETURNING deactivated_at, deletion_requested_at`,
        [user.userId],
      );
      const row = rows[0];
      if (!row) throw ApiError.notFound('profile');
      await tx.query(
        `INSERT INTO outbox_jobs (user_id, kind, dedupe_key, payload)
         VALUES ($1, 'account_erasure', $2, $3::jsonb)
         ON CONFLICT (user_id, dedupe_key) DO NOTHING`,
        [user.userId, `account_erasure:${user.userId}`, JSON.stringify({ user_id: user.userId })],
      );
      await recordAudit(tx, {
        userId: user.userId, action: 'account.deactivate', entityType: 'user', entityId: user.userId, requestId,
      });
      return row;
    });
    clearSessionCookie(reply, app.config);
    void reply.code(202);
    return {
      deactivated_at: result.deactivated_at,
      deletion_requested_at: result.deletion_requested_at,
      erasure_queued: true,
    };
  });
}
