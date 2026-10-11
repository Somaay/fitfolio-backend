import type { FastifyInstance } from 'fastify';
import { BudgetRevisionRequest, minIsoDate } from '@hi/contracts';
import { defineRoute } from '../openapi/registry.js';
import { mutate, readOnly } from '../http/handlers.js';
import { parseOrThrow, requireUuidParam } from '../http/validate.js';
import { recordAudit } from '../http/audit.js';
import { lockPlan, loadPlan } from '../plans/repo.js';
import { planLastDay, planToday } from '../plans/window.js';
import { serializeRevision } from '../plans/serialize.js';
import { createRevisionLocked } from './service.js';
import { effectiveRevision, listRevisions, loadRevisionLines } from './repo.js';

export function registerBudgetRoutes(app: FastifyInstance): void {
  defineRoute(app, {
    method: 'POST', url: '/v1/plans/:planId/budget-revisions', operationId: 'createBudgetRevision',
    tags: ['budgets'], auth: true, body: BudgetRevisionRequest, idempotent: true,
    summary: 'Append an immutable, complete budget snapshot',
    description: 'Allocations must sum to at most total_minor (checked in bigint under a plan row lock). Revisions are never backdated; revision 1 is effective on the plan start date.',
    responses: { 201: 'the new revision', 409: 'the plan is closed', 422: 'allocations exceed the cap or the date is backdated' },
  }, async (request, reply) => {
    const planId = requireUuidParam((request.params as Record<string, unknown>).planId, 'planId');
    const body = parseOrThrow(BudgetRevisionRequest, request.body, 'body');
    await mutate(app, request, reply, `POST /v1/plans/${planId}/budget-revisions`, async ({ tx, user, requestId }) => {
      const plan = await lockPlan(tx, user.userId, planId);
      const revision = await createRevisionLocked(tx, plan, body);
      await recordAudit(tx, {
        userId: user.userId, action: 'budget_revision.create',
        entityType: 'budget_revision', entityId: revision.id, requestId,
      });
      const lines = await loadRevisionLines(tx, user.userId, [revision.id]);
      return {
        status: 201,
        body: serializeRevision({ ...revision, lines: lines.get(revision.id) ?? [] }, 1, revision.id),
        resourceId: revision.id,
      };
    });
  });

  defineRoute(app, {
    method: 'GET', url: '/v1/plans/:planId/budget-revisions', operationId: 'listBudgetRevisions',
    tags: ['budgets'], auth: true,
    summary: 'All revisions for a plan, marking the original and the effective one',
    responses: { 200: 'every revision, oldest first', 404: 'absent or not owned' },
  }, async (request, reply) => {
    const planId = requireUuidParam((request.params as Record<string, unknown>).planId, 'planId');
    const body = await readOnly(app, request, async ({ tx, user }) => {
      const plan = await loadPlan(tx, user.userId, planId);
      const asOf = minIsoDate(planToday(plan), planLastDay(plan));
      const [revisions, effective] = await Promise.all([
        listRevisions(tx, user.userId, planId),
        effectiveRevision(tx, user.userId, planId, asOf),
      ]);
      const originalNumber = revisions[0]?.revision ?? 1;
      const effectiveId = effective?.id ?? revisions[0]?.id ?? null;
      return { items: revisions.map((r) => serializeRevision(r, originalNumber, effectiveId)), next_cursor: null };
    });
    void reply.code(200);
    return body;
  });
}
