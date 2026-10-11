import { ApiError, CreateWeightRequest, PaginationQuery, UpdateWeightRequest, compareIsoDate, localDateInZone, } from '@hi/contracts';
import { defineRoute } from '../openapi/registry.js';
import { mutate, readOnly, transact } from '../http/handlers.js';
import { parseOrThrow, requireUuidParam } from '../http/validate.js';
import { parseIfMatch, setEtag, assertFresh } from '../http/concurrency.js';
import { encodeCursor, decodeCursor } from '../http/cursor.js';
import { recordAudit } from '../http/audit.js';
import { loadPlan, lockPlan } from '../plans/repo.js';
import { assertEntryDate, planToday } from '../plans/window.js';
const COLUMNS = 'id, plan_id, measured_at, local_date, weight_kg, source, version, created_at, updated_at';
const params = (request) => request.params;
function serialize(row) {
    return {
        id: row.id, plan_id: row.plan_id, measured_at: row.measured_at, local_date: row.local_date,
        weight_kg: row.weight_kg, source: row.source, version: row.version,
        created_at: row.created_at, updated_at: row.updated_at,
    };
}
/** Server-side derivation plus the future check, in the plan's own zone. */
function deriveLocalDate(plan, measuredAt, field) {
    const localDate = localDateInZone(measuredAt, plan.timezone);
    // Compare INSTANTS, not calendar dates. A date-granular check accepts a
    // weigh-in stamped 23:59 when it is only 09:00, because both land on today.
    // A measurement that has not happened yet is not a measurement.
    const instant = new Date(measuredAt).getTime();
    if (Number.isFinite(instant) && instant > Date.now()) {
        throw ApiError.validation('a measurement cannot be in the future', [
            { path: field, message: 'must not be later than the current time' },
        ]);
    }
    const today = planToday(plan);
    if (compareIsoDate(localDate, today) > 0) {
        throw ApiError.validation('a measurement cannot be in the future', [
            { path: field, message: `must not be after ${today} in ${plan.timezone}` },
        ]);
    }
    assertEntryDate(plan, localDate, field);
    return localDate;
}
async function loadWeight(tx, userId, planId, id) {
    const { rows } = await tx.query(`SELECT ${COLUMNS} FROM weight_entries WHERE id = $1 AND user_id = $2 AND plan_id = $3`, [id, userId, planId]);
    const row = rows[0];
    if (!row)
        throw ApiError.notFound('weight entry');
    return row;
}
export function registerWeightRoutes(app) {
    defineRoute(app, {
        method: 'POST', url: '/v1/plans/:planId/weights', operationId: 'createWeight',
        tags: ['weights'], auth: true, body: CreateWeightRequest, idempotent: true,
        summary: 'Record a weight measurement',
        description: "local_date is derived server-side from measured_at and the plan's frozen time zone; clients never send it. Future measurements are rejected.",
        responses: { 201: 'the measurement', 409: 'the plan is a draft', 422: 'the instant is in the future or outside the plan' },
    }, async (request, reply) => {
        const planId = requireUuidParam(params(request).planId, 'planId');
        const body = parseOrThrow(CreateWeightRequest, request.body, 'body');
        await mutate(app, request, reply, `POST /v1/plans/${planId}/weights`, async ({ tx, user, requestId }) => {
            const plan = await lockPlan(tx, user.userId, planId);
            const localDate = deriveLocalDate(plan, body.measured_at, 'measured_at');
            const { rows } = await tx.query(`INSERT INTO weight_entries (user_id, plan_id, measured_at, local_date, weight_kg)
         VALUES ($1,$2,$3,$4,$5) RETURNING ${COLUMNS}`, [user.userId, planId, body.measured_at, localDate, body.weight_kg]);
            const row = rows[0];
            if (!row)
                throw new Error('weight insert returned no row');
            await recordAudit(tx, {
                userId: user.userId, action: 'weight.create', entityType: 'weight_entry', entityId: row.id, requestId,
            });
            return { status: 201, body: serialize(row), resourceId: row.id };
        });
    });
    defineRoute(app, {
        method: 'GET', url: '/v1/plans/:planId/weights', operationId: 'listWeights',
        tags: ['weights'], auth: true, query: PaginationQuery,
        summary: 'List measurements over a bounded range',
        responses: { 200: 'a page of measurements', 404: 'absent or not owned' },
    }, async (request, reply) => {
        const planId = requireUuidParam(params(request).planId, 'planId');
        const query = parseOrThrow(PaginationQuery, request.query, 'query');
        const result = await readOnly(app, request, async ({ tx, user }) => {
            await loadPlan(tx, user.userId, planId);
            const values = [user.userId, planId, query.limit + 1];
            const where = ['user_id = $1', 'plan_id = $2'];
            if (query.from) {
                values.push(query.from);
                where.push(`local_date >= $${values.length}::date`);
            }
            if (query.to) {
                values.push(query.to);
                where.push(`local_date <= $${values.length}::date`);
            }
            if (query.cursor) {
                const parts = decodeCursor(query.cursor, 2);
                values.push(parts[0], parts[1]);
                where.push(`(local_date, id) > ($${values.length - 1}::date, $${values.length}::uuid)`);
            }
            const { rows } = await tx.query(`SELECT ${COLUMNS} FROM weight_entries WHERE ${where.join(' AND ')}
          ORDER BY local_date ASC, id ASC LIMIT $3`, values);
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
        method: 'PATCH', url: '/v1/plans/:planId/weights/:weightId', operationId: 'updateWeight',
        tags: ['weights'], auth: true, body: UpdateWeightRequest, ifMatch: true,
        summary: 'Correct a measurement (audited)',
        responses: { 200: 'the corrected measurement', 412: 'stale version', 404: 'absent or not owned' },
    }, async (request, reply) => {
        const planId = requireUuidParam(params(request).planId, 'planId');
        const weightId = requireUuidParam(params(request).weightId, 'weightId');
        const patch = parseOrThrow(UpdateWeightRequest, request.body, 'body');
        const expected = parseIfMatch(request);
        const result = await transact(app, request, async ({ tx, user, requestId }) => {
            const plan = await loadPlan(tx, user.userId, planId);
            const current = await loadWeight(tx, user.userId, planId, weightId);
            const measuredAt = patch.measured_at ?? current.measured_at.toISOString();
            const localDate = deriveLocalDate(plan, measuredAt, 'measured_at');
            const { rowCount, rows } = await tx.query(`UPDATE weight_entries SET measured_at = $4, local_date = $5, weight_kg = $6
          WHERE id = $1 AND user_id = $2 AND plan_id = $7 AND version = $3
          RETURNING ${COLUMNS}`, [weightId, user.userId, expected, measuredAt, localDate, patch.weight_kg ?? current.weight_kg, planId]);
            assertFresh(rowCount);
            const row = rows[0];
            if (!row)
                throw ApiError.stale();
            await recordAudit(tx, {
                userId: user.userId, action: 'weight.update', entityType: 'weight_entry', entityId: weightId, requestId,
            });
            return row;
        });
        setEtag(reply, result.version);
        void reply.code(200);
        return serialize(result);
    });
    defineRoute(app, {
        method: 'DELETE', url: '/v1/plans/:planId/weights/:weightId', operationId: 'deleteWeight',
        tags: ['weights'], auth: true, ifMatch: true, summary: 'Delete a measurement (audited)',
        responses: { 204: 'deleted', 412: 'stale version', 404: 'absent or not owned' },
    }, async (request, reply) => {
        const planId = requireUuidParam(params(request).planId, 'planId');
        const weightId = requireUuidParam(params(request).weightId, 'weightId');
        const expected = parseIfMatch(request);
        await transact(app, request, async ({ tx, user, requestId }) => {
            await loadWeight(tx, user.userId, planId, weightId);
            const { rowCount } = await tx.query(`DELETE FROM weight_entries WHERE id = $1 AND user_id = $2 AND plan_id = $4 AND version = $3`, [weightId, user.userId, expected, planId]);
            assertFresh(rowCount);
            await recordAudit(tx, {
                userId: user.userId, action: 'weight.delete', entityType: 'weight_entry', entityId: weightId, requestId,
            });
        });
        void reply.code(204);
        return null;
    });
}
//# sourceMappingURL=routes.js.map