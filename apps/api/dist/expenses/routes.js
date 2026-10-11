import { CorrectExpenseRequest, CreateExpenseRequest, CreateRefundRequest, PaginationQuery, } from '@hi/contracts';
import { defineRoute } from '../openapi/registry.js';
import { mutate, readOnly } from '../http/handlers.js';
import { parseOrThrow, requireUuidParam } from '../http/validate.js';
import { encodeCursor } from '../http/cursor.js';
import { loadPlan, lockPlan } from '../plans/repo.js';
import { listExpenses, loadExpense, serializeExpense } from './repo.js';
import { correctExpense, createExpense, createRefund } from './service.js';
const params = (request) => request.params;
export function registerExpenseRoutes(app) {
    defineRoute(app, {
        method: 'POST', url: '/v1/plans/:planId/expenses', operationId: 'createExpense',
        tags: ['expenses'], auth: true, body: CreateExpenseRequest, idempotent: true,
        summary: 'Record a paid transaction',
        description: 'paid_on must lie inside [start_date, end_date) and must not be in the plan-local future. Draft plans reject spending entirely.',
        responses: { 201: 'the expense', 409: 'the plan is a draft', 422: 'the date or the amounts are invalid' },
    }, async (request, reply) => {
        const planId = requireUuidParam(params(request).planId, 'planId');
        const body = parseOrThrow(CreateExpenseRequest, request.body, 'body');
        await mutate(app, request, reply, `POST /v1/plans/${planId}/expenses`, async ({ tx, user, requestId }) => {
            const plan = await lockPlan(tx, user.userId, planId);
            const row = await createExpense(tx, plan, body, requestId);
            return { status: 201, body: await serializeExpense(tx, row), resourceId: row.id };
        });
    });
    defineRoute(app, {
        method: 'GET', url: '/v1/plans/:planId/expenses', operationId: 'listExpenses',
        tags: ['expenses'], auth: true, query: PaginationQuery,
        summary: 'List paid transactions and refunds over a bounded range',
        responses: { 200: 'a page of expenses', 404: 'absent or not owned' },
    }, async (request, reply) => {
        const planId = requireUuidParam(params(request).planId, 'planId');
        const query = parseOrThrow(PaginationQuery, request.query, 'query');
        const result = await readOnly(app, request, async ({ tx, user }) => {
            await loadPlan(tx, user.userId, planId);
            const rows = await listExpenses(tx, user.userId, planId, query.limit + 1, query.cursor ?? null, {
                ...(query.from ? { from: query.from } : {}),
                ...(query.to ? { to: query.to } : {}),
            });
            const page = rows.slice(0, query.limit);
            const last = page.at(-1);
            return {
                items: await Promise.all(page.map((row) => serializeExpense(tx, row))),
                next_cursor: rows.length > query.limit && last ? encodeCursor([last.paid_on, last.id]) : null,
            };
        });
        void reply.code(200);
        return result;
    });
    defineRoute(app, {
        method: 'POST', url: '/v1/plans/:planId/expenses/:expenseId/refunds', operationId: 'createRefund',
        tags: ['expenses'], auth: true, body: CreateRefundRequest, idempotent: true,
        summary: 'Record a refund against a non-void payment',
        description: 'Category and commitment are inherited from the original. Cumulative full, attributable AND non-attributable refunds are each capped at the original, checked under a row lock on the payment.',
        responses: { 201: 'the refund', 409: 'the payment is voided', 422: 'a refund ceiling would be exceeded' },
    }, async (request, reply) => {
        const planId = requireUuidParam(params(request).planId, 'planId');
        const expenseId = requireUuidParam(params(request).expenseId, 'expenseId');
        const body = parseOrThrow(CreateRefundRequest, request.body, 'body');
        await mutate(app, request, reply, `POST /v1/plans/${planId}/expenses/${expenseId}/refunds`, async ({ tx, user, requestId }) => {
            const plan = await lockPlan(tx, user.userId, planId);
            const row = await createRefund(tx, plan, expenseId, body, requestId);
            return { status: 201, body: await serializeExpense(tx, row), resourceId: row.id };
        });
    });
    defineRoute(app, {
        method: 'POST', url: '/v1/plans/:planId/expenses/:expenseId/correct', operationId: 'correctExpense',
        tags: ['expenses'], auth: true, body: CorrectExpenseRequest, idempotent: true,
        summary: 'Atomic void-and-replace correction',
        description: 'If the payment carries refunds they are re-issued against the replacement in the same transaction; if the replacement cannot hold them, the request is rejected with a 422 naming the refunds.',
        responses: { 200: 'the voided entry, its replacement and any carried refunds', 409: 'already voided', 422: 'the refund chain cannot be carried' },
    }, async (request, reply) => {
        const planId = requireUuidParam(params(request).planId, 'planId');
        const expenseId = requireUuidParam(params(request).expenseId, 'expenseId');
        const body = parseOrThrow(CorrectExpenseRequest, request.body, 'body');
        await mutate(app, request, reply, `POST /v1/plans/${planId}/expenses/${expenseId}/correct`, async ({ tx, user, requestId }) => {
            const plan = await lockPlan(tx, user.userId, planId);
            const result = await correctExpense(tx, plan, expenseId, body, requestId);
            return {
                status: 200,
                body: {
                    voided: await serializeExpense(tx, result.voided),
                    replacement: await serializeExpense(tx, result.replacement),
                    carried_refund_ids: result.carriedRefundIds,
                },
                resourceId: result.replacement.id,
            };
        });
    });
    defineRoute(app, {
        method: 'GET', url: '/v1/plans/:planId/expenses/:expenseId', operationId: 'getExpense',
        tags: ['expenses'], auth: true, summary: 'Read one expense',
        responses: { 200: 'the expense', 404: 'absent or not owned' },
    }, async (request, reply) => {
        const planId = requireUuidParam(params(request).planId, 'planId');
        const expenseId = requireUuidParam(params(request).expenseId, 'expenseId');
        const body = await readOnly(app, request, async ({ tx, user }) => {
            await loadPlan(tx, user.userId, planId);
            return serializeExpense(tx, await loadExpense(tx, user.userId, planId, expenseId));
        });
        void reply.code(200);
        return body;
    });
}
//# sourceMappingURL=routes.js.map