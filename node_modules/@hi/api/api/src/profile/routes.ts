/** Profile and consent. Consent history is append-only: the API role has no UPDATE grant. */
import type { FastifyInstance } from 'fastify';
import { ApiError, ConsentRequest, UpdateProfileRequest } from '@hi/contracts';
import { defineRoute } from '../openapi/registry.js';
import { mutate, readOnly, transact } from '../http/handlers.js';
import { parseOrThrow } from '../http/validate.js';
import { assertFresh, parseIfMatch, setEtag } from '../http/concurrency.js';
import { recordAudit } from '../http/audit.js';
import { activePlanId } from '../plans/repo.js';
import type { Tx } from '../db/pool.js';

interface UserRow {
  id: string;
  display_name: string | null;
  timezone: string;
  weight_unit: 'kg' | 'lb';
  notification_opt_in: boolean;
  deletion_requested_at: Date | null;
  deactivated_at: Date | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `id, display_name, timezone, weight_unit, notification_opt_in,
  deletion_requested_at, deactivated_at, version, created_at, updated_at`;

async function loadUser(tx: Tx, userId: string): Promise<UserRow> {
  const { rows } = await tx.query<UserRow>(`SELECT ${COLUMNS} FROM users WHERE id = $1`, [userId]);
  const row = rows[0];
  if (!row) throw ApiError.notFound('profile');
  return row;
}

function serialize(row: UserRow, activePlan: string | null): Record<string, unknown> {
  return {
    id: row.id,
    display_name: row.display_name,
    timezone: row.timezone,
    weight_unit: row.weight_unit,
    notification_opt_in: row.notification_opt_in,
    deletion_requested_at: row.deletion_requested_at,
    deactivated_at: row.deactivated_at,
    active_plan_id: activePlan,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function registerProfileRoutes(app: FastifyInstance): void {
  defineRoute(app, {
    method: 'GET', url: '/v1/me', operationId: 'getProfile', tags: ['profile'], auth: true,
    summary: 'Read the signed-in profile and the active plan id',
    responses: { 200: 'the profile', 401: 'no valid session' },
  }, async (request, reply) => {
    const result = await readOnly(app, request, async ({ tx, user }) => {
      const row = await loadUser(tx, user.userId);
      return { version: row.version, body: serialize(row, await activePlanId(tx, user.userId)) };
    });
    setEtag(reply, result.version);
    void reply.code(200);
    return result.body;
  });

  defineRoute(app, {
    method: 'PATCH', url: '/v1/me', operationId: 'updateProfile', tags: ['profile'], auth: true,
    body: UpdateProfileRequest, ifMatch: true, summary: 'Edit profile preferences',
    description: "Changing the profile time zone never moves historical entries: every plan keeps the zone it froze at creation.",
    responses: { 200: 'the updated profile', 412: 'stale version' },
  }, async (request, reply) => {
    const patch = parseOrThrow(UpdateProfileRequest, request.body, 'body');
    const expected = parseIfMatch(request);
    const result = await transact(app, request, async ({ tx, user, requestId }) => {
      const current = await loadUser(tx, user.userId);
      const { rowCount, rows } = await tx.query<UserRow>(
        `UPDATE users SET display_name = $3, timezone = $4, weight_unit = $5, notification_opt_in = $6
          WHERE id = $1 AND version = $2 RETURNING ${COLUMNS}`,
        [
          user.userId, expected,
          Object.prototype.hasOwnProperty.call(patch, 'display_name') ? patch.display_name ?? null : current.display_name,
          patch.timezone ?? current.timezone,
          patch.weight_unit ?? current.weight_unit,
          patch.notification_opt_in ?? current.notification_opt_in,
        ],
      );
      assertFresh(rowCount);
      const row = rows[0];
      if (!row) throw ApiError.stale();
      await recordAudit(tx, {
        userId: user.userId, action: 'profile.update', entityType: 'user', entityId: user.userId, requestId,
      });
      return { version: row.version, body: serialize(row, await activePlanId(tx, user.userId)) };
    });
    setEtag(reply, result.version);
    void reply.code(200);
    return result.body;
  });

  defineRoute(app, {
    method: 'POST', url: '/v1/me/consents', operationId: 'recordConsent', tags: ['profile'], auth: true,
    body: ConsentRequest, idempotent: true, summary: 'Record a consent grant or revocation',
    description: 'Append-only: a consent record is never rewritten, so the history of what was agreed and when stays intact.',
    responses: { 201: 'the recorded event' },
  }, async (request, reply) => {
    const body = parseOrThrow(ConsentRequest, request.body, 'body');
    await mutate(app, request, reply, 'POST /v1/me/consents', async ({ tx, user, requestId }) => {
      const { rows } = await tx.query<{ id: string; purpose: string; policy_version: string; action: string; created_at: Date }>(
        `INSERT INTO consent_events (user_id, purpose, policy_version, action)
         VALUES ($1,$2,$3,$4) RETURNING id, purpose, policy_version, action, created_at`,
        [user.userId, body.purpose, body.policy_version, body.action],
      );
      const row = rows[0];
      if (!row) throw new Error('consent insert returned no row');
      await recordAudit(tx, {
        userId: user.userId, action: 'consent.record', entityType: 'consent_event', entityId: row.id, requestId,
      });
      return { status: 201, body: row, resourceId: row.id };
    });
  });

  defineRoute(app, {
    method: 'GET', url: '/v1/me/consents', operationId: 'listConsents', tags: ['profile'], auth: true,
    summary: 'Current consent state per purpose',
    responses: { 200: 'the latest event for each purpose' },
  }, async (request, reply) => {
    const result = await readOnly(app, request, async ({ tx, user }) => {
      const { rows } = await tx.query(
        `SELECT DISTINCT ON (purpose) purpose, policy_version, action, created_at
           FROM consent_events WHERE user_id = $1
          ORDER BY purpose, created_at DESC, id DESC`,
        [user.userId],
      );
      return { items: rows, next_cursor: null };
    });
    void reply.code(200);
    return result;
  });
}
