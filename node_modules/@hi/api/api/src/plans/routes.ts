import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  CreatePlanRequest, PaginationQuery, UpdatePlanRequest, minIsoDate, ApiError,
} from '@hi/contracts';
import { defineRoute } from '../openapi/registry.js';
import { mutate, readOnly, transact } from '../http/handlers.js';
import { parseOrThrow, requireUuidParam } from '../http/validate.js';
import { parseIfMatch, setEtag } from '../http/concurrency.js';
import { encodeCursor } from '../http/cursor.js';
import {
  effectiveRevision, latestRevision, originalRevision,
} from '../budgets/repo.js';
import { serializePlan, summarizeBudget } from './serialize.js';
import { activePlanId, listPlans, loadPlan } from './repo.js';
import { activatePlan, cancelPlan, completePlan, createPlan, updateDraftPlan } from './service.js';
import { planLastDay, planToday } from './window.js';
import type { Tx } from '../db/pool.js';
import type { PlanRow } from './repo.js';

async function withBudget(tx: Tx, userId: string, plan: PlanRow): Promise<Record<string, unknown>> {
  const asOf = minIsoDate(planToday(plan), planLastDay(plan));
  const [effective, original, latest] = await Promise.all([
    effectiveRevision(tx, userId, plan.id, asOf),
    originalRevision(tx, userId, plan.id),
    latestRevision(tx, userId, plan.id),
  ]);
  // A draft whose start_date was moved forward can have no revision dated on or
  // before `asOf`; the original still governs, so fall back to it.
  return serializePlan(plan, summarizeBudget(effective ?? original, original, latest));
}

export function registerPlanRoutes(app: FastifyInstance): void {
  defineRoute(app, {
    method: 'POST', url: '/v1/plans', operationId: 'createPlan', tags: ['plans'], auth: true,
    summary: 'Create a draft plan and budget revision 1 atomically',
    description: 'end_date is derived server-side as six calendar months after start_date; clients never send it.',
    body: CreatePlanRequest, idempotent: true,
    responses: { 201: 'the created draft plan', 409: 'idempotency key reused with a different body', 422: 'business rule violated' },
  }, async (request, reply) => {
    const body = parseOrThrow(CreatePlanRequest, request.body, 'body');
    await mutate(app, request, reply, 'POST /v1/plans', async ({ tx, user, requestId }) => {
      const plan = await createPlan(tx, user.userId, body, requestId);
      return { status: 201, body: await withBudget(tx, user.userId, plan), resourceId: plan.id };
    });
  });

  defineRoute(app, {
    method: 'GET', url: '/v1/plans', operationId: 'listPlans', tags: ['plans'], auth: true,
    summary: 'List owned plans, newest first', query: PaginationQuery,
    responses: { 200: 'a page of plans' },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const query = parseOrThrow(PaginationQuery, request.query, 'query');
    const items = await readOnly(app, request, async ({ tx, user }) => {
      const rows = await listPlans(tx, user.userId, query.limit + 1, query.cursor ?? null);
      return rows;
    });
    const page = items.slice(0, query.limit);
    const last = page.at(-1);
    void reply.code(200);
    return {
      items: page.map((plan) => serializePlan(plan)),
      next_cursor: items.length > query.limit && last ? encodeCursor([last.created_at.toISOString(), last.id]) : null,
    };
  });

  defineRoute(app, {
    method: 'GET', url: '/v1/plans/:planId', operationId: 'getPlan', tags: ['plans'], auth: true,
    summary: 'Read one owned plan with its budget summary',
    responses: { 200: 'the plan', 404: 'absent or not owned' },
  }, async (request, reply) => {
    const planId = requireUuidParam((request.params as Record<string, unknown>).planId, 'planId');
    const result = await readOnly(app, request, async ({ tx, user }) => {
      const plan = await loadPlan(tx, user.userId, planId);
      return { version: plan.version, body: await withBudget(tx, user.userId, plan) };
    });
    setEtag(reply, result.version);
    void reply.code(200);
    return result.body;
  });

  defineRoute(app, {
    method: 'PATCH', url: '/v1/plans/:planId', operationId: 'updatePlan', tags: ['plans'], auth: true,
    summary: 'Edit draft-only fields', body: UpdatePlanRequest, ifMatch: true,
    description: 'Dates, currency, scope, baseline and target are frozen once the plan is activated.',
    responses: { 200: 'the updated plan', 409: 'the plan is not a draft', 412: 'stale version' },
  }, async (request, reply) => {
    const planId = requireUuidParam((request.params as Record<string, unknown>).planId, 'planId');
    const patch = parseOrThrow(UpdatePlanRequest, request.body, 'body');
    const expected = parseIfMatch(request);
    const result = await transact(app, request, async ({ tx, user, requestId }) => {
      const plan = await updateDraftPlan(tx, user.userId, planId, expected, patch as Record<string, unknown>, requestId);
      return { version: plan.version, body: await withBudget(tx, user.userId, plan) };
    });
    setEtag(reply, result.version);
    void reply.code(200);
    return result.body;
  });

  const lifecycle = [
    { action: 'activate', op: 'activatePlan', summary: 'Activate a draft plan', run: activatePlan },
    { action: 'complete', op: 'completePlan', summary: 'Complete a finished plan', run: completePlan },
    { action: 'cancel', op: 'cancelPlan', summary: 'Cancel a draft or active plan', run: cancelPlan },
  ] as const;

  for (const step of lifecycle) {
    defineRoute(app, {
      method: 'POST', url: `/v1/plans/:planId/${step.action}`, operationId: step.op,
      tags: ['plans'], auth: true, summary: step.summary, idempotent: true,
      responses: { 200: 'the plan in its new state', 409: 'the transition is not allowed from the current state, or a lifecycle precondition is unmet' },
    }, async (request, reply) => {
      const planId = requireUuidParam((request.params as Record<string, unknown>).planId, 'planId');
      await mutate(app, request, reply, `POST /v1/plans/${planId}/${step.action}`, async ({ tx, user, requestId }) => {
        const plan = await step.run(tx, user.userId, planId, requestId);
        return { status: 200, body: await withBudget(tx, user.userId, plan), resourceId: plan.id };
      });
    });
  }
}

export async function requireOwnedPlan(tx: Tx, userId: string, planIdRaw: unknown): Promise<PlanRow> {
  const planId = requireUuidParam(planIdRaw, 'planId');
  const plan = await loadPlan(tx, userId, planId);
  if (plan.user_id !== userId) throw ApiError.notFound('plan');
  return plan;
}

export { activePlanId };
