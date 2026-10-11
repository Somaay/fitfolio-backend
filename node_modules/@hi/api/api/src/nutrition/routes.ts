/**
 * Daily nutrition.
 *
 * `null` means UNKNOWN and `0` means zero: they are DIFFERENT FACTS and are never
 * coalesced. A day with `calories: 0` is a day the user recorded as zero; a day
 * with `calories: null` is a day nobody recorded.
 */
import type { FastifyInstance } from 'fastify';
import {
  ApiError, IsoDateSchema, PutNutritionRequest, assertIsoDate, differenceInDays, type IsoDate,
} from '@hi/contracts';
import { z } from 'zod';
import { defineRoute } from '../openapi/registry.js';
import { readOnly, transact } from '../http/handlers.js';
import { parseOrThrow, requireUuidParam } from '../http/validate.js';
import { parseIfMatch, setEtag, assertFresh } from '../http/concurrency.js';
import { recordAudit } from '../http/audit.js';
import { loadPlan, lockPlan } from '../plans/repo.js';
import { assertEntryDate } from '../plans/window.js';

interface NutritionRow {
  id: string;
  plan_id: string;
  local_date: IsoDate;
  calories: number | null;
  protein_g: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = 'id, plan_id, local_date, calories, protein_g, version, created_at, updated_at';
const MAX_RANGE_DAYS = 366;

/** There is no unbounded account history endpoint: the range is required. */
const NutritionRangeQuery = z.object({ from: IsoDateSchema, to: IsoDateSchema });

const params = (request: { params: unknown }) => request.params as Record<string, unknown>;

function serialize(row: NutritionRow): Record<string, unknown> {
  return {
    id: row.id, plan_id: row.plan_id, local_date: row.local_date,
    calories: row.calories, protein_g: row.protein_g,
    version: row.version, created_at: row.created_at, updated_at: row.updated_at,
  };
}

export function registerNutritionRoutes(app: FastifyInstance): void {
  defineRoute(app, {
    method: 'GET', url: '/v1/plans/:planId/nutrition', operationId: 'listNutrition',
    tags: ['nutrition'], auth: true, query: NutritionRangeQuery,
    summary: 'Daily summaries over a bounded date range',
    description: `from and to are both required and may span at most ${MAX_RANGE_DAYS} days.`,
    responses: { 200: 'the days that have a record', 400: 'the range is missing or too wide' },
  }, async (request, reply) => {
    const planId = requireUuidParam(params(request).planId, 'planId');
    const query = parseOrThrow(NutritionRangeQuery, request.query, 'query');
    const span = differenceInDays(assertIsoDate(query.from), assertIsoDate(query.to));
    if (span < 0 || span > MAX_RANGE_DAYS) {
      throw new ApiError('malformed_request', `the range must be ordered and at most ${MAX_RANGE_DAYS} days`, [
        { path: 'to', message: 'must be on or after from, and within the maximum span' },
      ]);
    }
    const result = await readOnly(app, request, async ({ tx, user }) => {
      await loadPlan(tx, user.userId, planId);
      const { rows } = await tx.query<NutritionRow>(
        `SELECT ${COLUMNS} FROM nutrition_days
          WHERE user_id = $1 AND plan_id = $2 AND local_date BETWEEN $3::date AND $4::date
          ORDER BY local_date ASC`,
        [user.userId, planId, query.from, query.to],
      );
      return { items: rows.map(serialize), next_cursor: null };
    });
    void reply.code(200);
    return result;
  });

  defineRoute(app, {
    method: 'PUT', url: '/v1/plans/:planId/nutrition/:date', operationId: 'putNutritionDay',
    tags: ['nutrition'], auth: true, body: PutNutritionRequest,
    summary: 'Replace one day of nutrition',
    description: 'An explicit null stores UNKNOWN for that measure; 0 stores zero. At least one of the two must be present.',
    responses: { 200: 'the stored day', 409: 'the plan is a draft', 422: 'the date is outside the plan or in the future' },
  }, async (request, reply) => {
    const planId = requireUuidParam(params(request).planId, 'planId');
    const dateParam = parseOrThrow(IsoDateSchema, params(request).date, 'params');
    const body = parseOrThrow(PutNutritionRequest, request.body, 'body');
    const result = await transact(app, request, async ({ tx, user, requestId }) => {
      const plan = await lockPlan(tx, user.userId, planId);
      const localDate = assertIsoDate(dateParam);
      assertEntryDate(plan, localDate, 'date');
      const { rows } = await tx.query<NutritionRow>(
        `INSERT INTO nutrition_days (user_id, plan_id, local_date, calories, protein_g)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (user_id, plan_id, local_date)
         DO UPDATE SET calories = EXCLUDED.calories, protein_g = EXCLUDED.protein_g
         RETURNING ${COLUMNS}`,
        [user.userId, planId, localDate, body.calories, body.protein_g],
      );
      const row = rows[0];
      if (!row) throw new Error('nutrition upsert returned no row');
      await recordAudit(tx, {
        userId: user.userId, action: 'nutrition.upsert', entityType: 'nutrition_day', entityId: row.id, requestId,
      });
      return row;
    });
    setEtag(reply, result.version);
    void reply.code(200);
    return serialize(result);
  });

  defineRoute(app, {
    method: 'DELETE', url: '/v1/plans/:planId/nutrition/:date', operationId: 'deleteNutritionDay',
    tags: ['nutrition'], auth: true, ifMatch: true, summary: 'Remove one day of nutrition',
    responses: { 204: 'deleted', 412: 'stale version', 404: 'absent or not owned' },
  }, async (request, reply) => {
    const planId = requireUuidParam(params(request).planId, 'planId');
    const dateParam = parseOrThrow(IsoDateSchema, params(request).date, 'params');
    const expected = parseIfMatch(request);
    await transact(app, request, async ({ tx, user, requestId }) => {
      const { rows } = await tx.query<{ id: string }>(
        `SELECT id FROM nutrition_days WHERE user_id = $1 AND plan_id = $2 AND local_date = $3::date`,
        [user.userId, planId, dateParam],
      );
      const existing = rows[0];
      if (!existing) throw ApiError.notFound('nutrition day');
      const { rowCount } = await tx.query(
        `DELETE FROM nutrition_days WHERE id = $1 AND user_id = $2 AND version = $3`,
        [existing.id, user.userId, expected],
      );
      assertFresh(rowCount);
      await recordAudit(tx, {
        userId: user.userId, action: 'nutrition.delete', entityType: 'nutrition_day',
        entityId: existing.id, requestId,
      });
    });
    void reply.code(204);
    return null;
  });
}
