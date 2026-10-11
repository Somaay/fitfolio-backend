/**
 * Attendance.
 *
 * A `completed` entry is the denominator of cost-per-session. A time-based
 * membership records VISITS: linking an activity to a commitment therefore
 * requires the commitment's category to match the activity kind, so a trainer
 * session can never be counted against a gym membership.
 */
import type { FastifyInstance } from 'fastify';
import {
  ApiError, CreateActivityRequest, PaginationQuery, UpdateActivityRequest,
  compareIsoDate, localDateInZone, type IsoDate,
} from '@hi/contracts';
import { defineRoute } from '../openapi/registry.js';
import { mutate, readOnly, transact } from '../http/handlers.js';
import { parseOrThrow, requireUuidParam } from '../http/validate.js';
import { parseIfMatch, setEtag, assertFresh } from '../http/concurrency.js';
import { encodeCursor, decodeCursor } from '../http/cursor.js';
import { recordAudit } from '../http/audit.js';
import { categoryCode } from '../db/categories.js';
import { loadPlan, lockPlan, type PlanRow } from '../plans/repo.js';
import { assertEntryDate, planToday } from '../plans/window.js';
import { lockCommitment } from '../commitments/repo.js';
import type { Tx } from '../db/pool.js';

interface ActivityRow {
  id: string;
  plan_id: string;
  commitment_id: string | null;
  occurred_at: Date;
  local_date: IsoDate;
  kind: 'gym' | 'trainer' | 'home_workout' | 'other';
  status: 'completed' | 'missed';
  duration_minutes: number | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `id, plan_id, commitment_id, occurred_at, local_date, kind, status,
  duration_minutes, version, created_at, updated_at`;
const params = (request: { params: unknown }) => request.params as Record<string, unknown>;

function serialize(row: ActivityRow): Record<string, unknown> {
  return {
    id: row.id, plan_id: row.plan_id, commitment_id: row.commitment_id,
    occurred_at: row.occurred_at, local_date: row.local_date, kind: row.kind, status: row.status,
    duration_minutes: row.duration_minutes, version: row.version,
    created_at: row.created_at, updated_at: row.updated_at,
  };
}

function deriveLocalDate(plan: PlanRow, occurredAt: string, field: string): IsoDate {
  const localDate = localDateInZone(occurredAt, plan.timezone);
  const today = planToday(plan);
  if (compareIsoDate(localDate, today) > 0) {
    throw ApiError.validation('attendance cannot be recorded in the future', [
      { path: field, message: `must not be after ${today} in ${plan.timezone}` },
    ]);
  }
  assertEntryDate(plan, localDate, field);
  return localDate;
}

/** Only a gym or trainer commitment tracks attendance, and only for its own kind. */
async function resolveCommitment(
  tx: Tx, plan: PlanRow, commitmentId: string | null | undefined,
  kind: ActivityRow['kind'],
): Promise<string | null> {
  if (!commitmentId) return null;
  const commitment = await lockCommitment(tx, plan.user_id, plan.id, commitmentId);
  const code = await categoryCode(tx, commitment.category_id);
  if (kind !== code) {
    throw ApiError.validation('this attendance does not match the commitment category', [
      { path: 'commitment_id', message: `the commitment is for ${code}; record a ${code} activity instead` },
    ]);
  }
  if (commitment.status === 'cancelled') {
    throw ApiError.validation('this commitment was cancelled', [
      { path: 'commitment_id', message: 'a cancelled commitment cannot receive attendance' },
    ]);
  }
  return commitment.id;
}

async function loadActivity(tx: Tx, userId: string, planId: string, id: string): Promise<ActivityRow> {
  const { rows } = await tx.query<ActivityRow>(
    `SELECT ${COLUMNS} FROM activity_entries WHERE id = $1 AND user_id = $2 AND plan_id = $3`,
    [id, userId, planId],
  );
  const row = rows[0];
  if (!row) throw ApiError.notFound('activity entry');
  return row;
}

export function registerActivityRoutes(app: FastifyInstance): void {
  defineRoute(app, {
    method: 'POST', url: '/v1/plans/:planId/activities', operationId: 'createActivity',
    tags: ['activities'], auth: true, body: CreateActivityRequest, idempotent: true,
    summary: 'Record attendance as completed or missed',
    description: "local_date is derived server-side from occurred_at and the plan's frozen zone.",
    responses: { 201: 'the activity', 409: 'the plan is a draft', 422: 'the instant is in the future or the commitment does not match' },
  }, async (request, reply) => {
    const planId = requireUuidParam(params(request).planId, 'planId');
    const body = parseOrThrow(CreateActivityRequest, request.body, 'body');
    await mutate(app, request, reply, `POST /v1/plans/${planId}/activities`, async ({ tx, user, requestId }) => {
      const plan = await lockPlan(tx, user.userId, planId);
      const localDate = deriveLocalDate(plan, body.occurred_at, 'occurred_at');
      const commitmentId = await resolveCommitment(tx, plan, body.commitment_id, body.kind);
      const { rows } = await tx.query<ActivityRow>(
        `INSERT INTO activity_entries (user_id, plan_id, commitment_id, occurred_at, local_date,
                                       kind, status, duration_minutes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${COLUMNS}`,
        [
          user.userId, planId, commitmentId, body.occurred_at, localDate,
          body.kind, body.status, body.duration_minutes ?? null,
        ],
      );
      const row = rows[0];
      if (!row) throw new Error('activity insert returned no row');
      await recordAudit(tx, {
        userId: user.userId, action: 'activity.create', entityType: 'activity_entry', entityId: row.id, requestId,
      });
      return { status: 201, body: serialize(row), resourceId: row.id };
    });
  });

  defineRoute(app, {
    method: 'GET', url: '/v1/plans/:planId/activities', operationId: 'listActivities',
    tags: ['activities'], auth: true, query: PaginationQuery,
    summary: 'List attendance over a bounded range',
    responses: { 200: 'a page of activity entries', 404: 'absent or not owned' },
  }, async (request, reply) => {
    const planId = requireUuidParam(params(request).planId, 'planId');
    const query = parseOrThrow(PaginationQuery, request.query, 'query');
    const result = await readOnly(app, request, async ({ tx, user }) => {
      await loadPlan(tx, user.userId, planId);
      const values: unknown[] = [user.userId, planId, query.limit + 1];
      const where = ['user_id = $1', 'plan_id = $2'];
      if (query.from) { values.push(query.from); where.push(`local_date >= $${values.length}::date`); }
      if (query.to) { values.push(query.to); where.push(`local_date <= $${values.length}::date`); }
      if (query.cursor) {
        const parts = decodeCursor(query.cursor, 2);
        values.push(parts[0], parts[1]);
        where.push(`(local_date, id) > ($${values.length - 1}::date, $${values.length}::uuid)`);
      }
      const { rows } = await tx.query<ActivityRow>(
        `SELECT ${COLUMNS} FROM activity_entries WHERE ${where.join(' AND ')}
          ORDER BY local_date ASC, id ASC LIMIT $3`,
        values,
      );
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return {
        items: page.map(serialize),
        next_cursor: rows.length > query.limit && last ? encodeCursor([last.local_date, last.id]) : null,
      };
    });
    void reply.code(200);
    return result;
  });

  defineRoute(app, {
    method: 'PATCH', url: '/v1/plans/:planId/activities/:activityId', operationId: 'updateActivity',
    tags: ['activities'], auth: true, body: UpdateActivityRequest, ifMatch: true,
    summary: 'Correct an attendance entry',
    responses: { 200: 'the updated entry', 412: 'stale version', 404: 'absent or not owned' },
  }, async (request, reply) => {
    const planId = requireUuidParam(params(request).planId, 'planId');
    const activityId = requireUuidParam(params(request).activityId, 'activityId');
    const patch = parseOrThrow(UpdateActivityRequest, request.body, 'body');
    const expected = parseIfMatch(request);
    const result = await transact(app, request, async ({ tx, user, requestId }) => {
      const plan = await lockPlan(tx, user.userId, planId);
      const current = await loadActivity(tx, user.userId, planId, activityId);
      const occurredAt = patch.occurred_at ?? current.occurred_at.toISOString();
      const localDate = deriveLocalDate(plan, occurredAt, 'occurred_at');
      const kind = patch.kind ?? current.kind;
      const commitmentId = Object.prototype.hasOwnProperty.call(patch, 'commitment_id')
        ? await resolveCommitment(tx, plan, patch.commitment_id, kind)
        : current.commitment_id;
      const { rowCount, rows } = await tx.query<ActivityRow>(
        `UPDATE activity_entries
            SET occurred_at = $4, local_date = $5, kind = $6, status = $7,
                duration_minutes = $8, commitment_id = $9
          WHERE id = $1 AND user_id = $2 AND plan_id = $10 AND version = $3
          RETURNING ${COLUMNS}`,
        [
          activityId, user.userId, expected, occurredAt, localDate, kind,
          patch.status ?? current.status,
          Object.prototype.hasOwnProperty.call(patch, 'duration_minutes')
            ? patch.duration_minutes ?? null : current.duration_minutes,
          commitmentId, planId,
        ],
      );
      assertFresh(rowCount);
      const row = rows[0];
      if (!row) throw ApiError.stale();
      await recordAudit(tx, {
        userId: user.userId, action: 'activity.update', entityType: 'activity_entry', entityId: activityId, requestId,
      });
      return row;
    });
    setEtag(reply, result.version);
    void reply.code(200);
    return serialize(result);
  });

  defineRoute(app, {
    method: 'DELETE', url: '/v1/plans/:planId/activities/:activityId', operationId: 'deleteActivity',
    tags: ['activities'], auth: true, ifMatch: true, summary: 'Remove an attendance entry',
    responses: { 204: 'deleted', 412: 'stale version', 404: 'absent or not owned' },
  }, async (request, reply) => {
    const planId = requireUuidParam(params(request).planId, 'planId');
    const activityId = requireUuidParam(params(request).activityId, 'activityId');
    const expected = parseIfMatch(request);
    await transact(app, request, async ({ tx, user, requestId }) => {
      await loadActivity(tx, user.userId, planId, activityId);
      const { rowCount } = await tx.query(
        `DELETE FROM activity_entries WHERE id = $1 AND user_id = $2 AND plan_id = $4 AND version = $3`,
        [activityId, user.userId, expected, planId],
      );
      assertFresh(rowCount);
      await recordAudit(tx, {
        userId: user.userId, action: 'activity.delete', entityType: 'activity_entry', entityId: activityId, requestId,
      });
    });
    void reply.code(204);
    return null;
  });
}
