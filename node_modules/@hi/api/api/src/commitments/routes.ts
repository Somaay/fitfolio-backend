import type { FastifyInstance } from 'fastify';
import {
  CreateCommitmentRequest, GenerateCommitmentsRequest, PaginationQuery, UpdateCommitmentRequest,
} from '@hi/contracts';
import { defineRoute } from '../openapi/registry.js';
import { mutate, readOnly, transact } from '../http/handlers.js';
import { parseOrThrow, requireUuidParam } from '../http/validate.js';
import { parseIfMatch, setEtag } from '../http/concurrency.js';
import { encodeCursor } from '../http/cursor.js';
import { loadPlan, lockPlan } from '../plans/repo.js';
import { linkedNetByCommitment, listCommitments, loadCommitment, serializeCommitment } from './repo.js';
import { createCommitment, generateCommitments, updateCommitment } from './service.js';

const params = (request: { params: unknown }) => request.params as Record<string, unknown>;

export function registerCommitmentRoutes(app: FastifyInstance): void {
  defineRoute(app, {
    method: 'POST', url: '/v1/plans/:planId/commitments', operationId: 'createCommitment',
    tags: ['commitments'], auth: true, body: CreateCommitmentRequest, idempotent: true,
    summary: 'Create an unpaid dated forecast',
    description: "session_model is derived: omitting expected_sessions means 'unlimited' (visits, no session allowance).",
    responses: { 201: 'the commitment', 409: 'the plan is closed', 422: 'the due date is outside the plan' },
  }, async (request, reply) => {
    const planId = requireUuidParam(params(request).planId, 'planId');
    const body = parseOrThrow(CreateCommitmentRequest, request.body, 'body');
    await mutate(app, request, reply, `POST /v1/plans/${planId}/commitments`, async ({ tx, user, requestId }) => {
      const plan = await lockPlan(tx, user.userId, planId);
      const row = await createCommitment(tx, plan, body, requestId);
      return {
        status: 201,
        body: await serializeCommitment(tx, row, plan.budget_scope, 0n),
        resourceId: row.id,
      };
    });
  });

  defineRoute(app, {
    method: 'GET', url: '/v1/plans/:planId/commitments', operationId: 'listCommitments',
    tags: ['commitments'], auth: true, query: PaginationQuery,
    summary: 'List forecasts with their outstanding amounts',
    responses: { 200: 'a page of commitments', 404: 'absent or not owned' },
  }, async (request, reply) => {
    const planId = requireUuidParam(params(request).planId, 'planId');
    const query = parseOrThrow(PaginationQuery, request.query, 'query');
    const result = await readOnly(app, request, async ({ tx, user }) => {
      const plan = await loadPlan(tx, user.userId, planId);
      const rows = await listCommitments(tx, user.userId, planId, query.limit + 1, query.cursor ?? null, {
        ...(query.from ? { from: query.from } : {}),
        ...(query.to ? { to: query.to } : {}),
      });
      // Payments are aggregated on their own before being attached, never joined.
      const linked = await linkedNetByCommitment(tx, user.userId, planId, plan.budget_scope, null);
      const page = rows.slice(0, query.limit);
      const items = await Promise.all(
        page.map((row) => serializeCommitment(tx, row, plan.budget_scope, linked.get(row.id) ?? 0n)),
      );
      const last = page.at(-1);
      return {
        items,
        next_cursor: rows.length > query.limit && last ? encodeCursor([last.due_on, last.id]) : null,
      };
    });
    void reply.code(200);
    return result;
  });

  defineRoute(app, {
    method: 'POST', url: '/v1/plans/:planId/commitments/generate', operationId: 'generateCommitments',
    tags: ['commitments'], auth: true, body: GenerateCommitmentsRequest, idempotent: true,
    summary: 'Idempotently expand a recurring estimate into dated commitments',
    description: 'Backed by the commitments_generation_key unique index: re-running creates nothing new.',
    responses: { 201: 'created and skipped counts plus the created commitments', 422: 'the first due date is outside the plan' },
  }, async (request, reply) => {
    const planId = requireUuidParam(params(request).planId, 'planId');
    const body = parseOrThrow(GenerateCommitmentsRequest, request.body, 'body');
    await mutate(app, request, reply, `POST /v1/plans/${planId}/commitments/generate`, async ({ tx, user, requestId }) => {
      const plan = await lockPlan(tx, user.userId, planId);
      const { created, skipped } = await generateCommitments(tx, plan, body, requestId);
      const items = await Promise.all(created.map((row) => serializeCommitment(tx, row, plan.budget_scope, 0n)));
      return {
        status: 201,
        body: { created_count: created.length, skipped_count: skipped, items },
        resourceId: created[0]?.id ?? null,
      };
    });
  });

  defineRoute(app, {
    method: 'PATCH', url: '/v1/plans/:planId/commitments/:commitmentId', operationId: 'updateCommitment',
    tags: ['commitments'], auth: true, body: UpdateCommitmentRequest, ifMatch: true,
    summary: 'Update a pending estimate, or change status explicitly',
    description: "Setting status back to 'pending' from completed or cancelled is the explicit reopen action and stamps reopened_at. A refund never reopens a commitment on its own.",
    responses: { 200: 'the updated commitment', 409: 'the status change is not allowed', 412: 'stale version' },
  }, async (request, reply) => {
    const planId = requireUuidParam(params(request).planId, 'planId');
    const commitmentId = requireUuidParam(params(request).commitmentId, 'commitmentId');
    const patch = parseOrThrow(UpdateCommitmentRequest, request.body, 'body');
    const expected = parseIfMatch(request);
    const result = await transact(app, request, async ({ tx, user, requestId }) => {
      const plan = await lockPlan(tx, user.userId, planId);
      const row = await updateCommitment(tx, plan, commitmentId, expected, patch, requestId);
      const linked = await linkedNetByCommitment(tx, user.userId, planId, plan.budget_scope, null);
      return {
        version: row.version,
        body: await serializeCommitment(tx, row, plan.budget_scope, linked.get(row.id) ?? 0n),
      };
    });
    setEtag(reply, result.version);
    void reply.code(200);
    return result.body;
  });

  defineRoute(app, {
    method: 'GET', url: '/v1/plans/:planId/commitments/:commitmentId', operationId: 'getCommitment',
    tags: ['commitments'], auth: true, summary: 'Read one commitment',
    responses: { 200: 'the commitment', 404: 'absent or not owned' },
  }, async (request, reply) => {
    const planId = requireUuidParam(params(request).planId, 'planId');
    const commitmentId = requireUuidParam(params(request).commitmentId, 'commitmentId');
    const result = await readOnly(app, request, async ({ tx, user }) => {
      const plan = await loadPlan(tx, user.userId, planId);
      const row = await loadCommitment(tx, user.userId, planId, commitmentId);
      const linked = await linkedNetByCommitment(tx, user.userId, planId, plan.budget_scope, null);
      return {
        version: row.version,
        body: await serializeCommitment(tx, row, plan.budget_scope, linked.get(row.id) ?? 0n),
      };
    });
    setEtag(reply, result.version);
    void reply.code(200);
    return result.body;
  });
}
