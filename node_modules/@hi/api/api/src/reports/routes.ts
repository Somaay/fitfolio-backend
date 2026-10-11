/**
 * Dashboard and weekly progress.
 *
 * Both endpoints read ONE `REPEATABLE READ` snapshot and apply the SAME cutoff to
 * spending and to measurements, so the two panels of the UI can never be computed
 * from different moments. The numbers themselves come from `@hi/contracts`
 * (`computeDashboardMetrics`, `buildWeeklySeries`) — the metric definition lives in
 * one place, shared with the web app and the test suite.
 */
import type { FastifyInstance } from 'fastify';
import {
  ApiError, AsOfQuery, buildWeeklySeries, computeDashboardMetrics,
  isSupportedCurrency, type CurrencyCode, type DashboardMetrics, type EffectiveBudget,
} from '@hi/contracts';
import { defineRoute } from '../openapi/registry.js';
import { snapshot } from '../http/handlers.js';
import { parseOrThrow, requireUuidParam } from '../http/validate.js';
import { effectiveRevision, originalRevision, type RevisionRow } from '../budgets/repo.js';
import { loadPlan } from '../plans/repo.js';
import { planToday } from '../plans/window.js';
import {
  completedSessions, latestMeasurementDate, netSpendMinor, outstandingCommitmentMinor,
  resolveAsOf, sessionScopedSpendMinor, weightObservations,
} from './aggregate.js';

const params = (request: { params: unknown }) => request.params as Record<string, unknown>;

function toEffectiveBudget(revision: RevisionRow): EffectiveBudget {
  return {
    revisionId: revision.id,
    revision: revision.revision,
    totalMinor: BigInt(revision.total_minor),
    effectiveOn: revision.effective_on,
  };
}

export function registerReportRoutes(app: FastifyInstance): void {
  defineRoute(app, {
    method: 'GET', url: '/v1/plans/:planId/dashboard', operationId: 'getDashboard',
    tags: ['reports'], auth: true, query: AsOfQuery,
    summary: 'Budget, progress, cost efficiency and scheduled forecast',
    description: 'Returns the DashboardMetrics shape from @hi/contracts. as_of defaults to plan-local today and is capped at today and the plan last day. Unavailable metrics are null with a stable reason.',
    responses: { 200: 'the DashboardMetrics document', 404: 'absent or not owned' },
  }, async (request, reply) => {
    const planId = requireUuidParam(params(request).planId, 'planId');
    const query = parseOrThrow(AsOfQuery, request.query, 'query');
    const metrics = await snapshot(app, request, async ({ tx, user }) => {
      const plan = await loadPlan(tx, user.userId, planId);
      const asOf = resolveAsOf(plan, query.as_of);
      const scope = plan.budget_scope;

      if (!isSupportedCurrency(plan.currency_code)) {
        throw new ApiError('internal_error', 'this plan uses an unsupported currency');
      }
      const currency: CurrencyCode = plan.currency_code;

      // Each fact set is aggregated on its own; nothing here is a cross-table join.
      const [effective, original, netSpend, outstanding, observations, latest, sessions, sessionSpend] =
        await Promise.all([
          effectiveRevision(tx, user.userId, planId, asOf),
          originalRevision(tx, user.userId, planId),
          netSpendMinor(tx, user.userId, planId, scope, asOf),
          outstandingCommitmentMinor(tx, user.userId, planId, scope, asOf),
          weightObservations(tx, user.userId, planId, asOf),
          latestMeasurementDate(tx, user.userId, planId, asOf),
          completedSessions(tx, user.userId, planId, asOf),
          sessionScopedSpendMinor(tx, user.userId, planId, scope, asOf),
        ]);

      const originalRow = original;
      if (!originalRow) throw new ApiError('internal_error', 'this plan has no budget revision');
      // A draft whose start moved forward can leave nothing dated on or before
      // as_of; the original still governs that period.
      const effectiveRow = effective ?? originalRow;

      const result: DashboardMetrics = computeDashboardMetrics({
        planStartDate: plan.start_date,
        asOf,
        today: planToday(plan),
        currency,
        scope,
        effectiveBudget: toEffectiveBudget(effectiveRow),
        originalBudget: toEffectiveBudget(originalRow),
        netSpendMinor: netSpend,
        outstandingCommitmentMinor: outstanding,
        baselineWeightKg: plan.baseline_weight_kg,
        targetWeightKg: plan.target_weight_kg,
        weeklySeries: buildWeeklySeries(plan.start_date, observations, asOf),
        completedSessions: sessions,
        sessionScopedSpendMinor: sessionSpend,
        latestMeasurementDate: latest,
      });
      return result;
    });
    void reply.code(200);
    return metrics;
  });

  defineRoute(app, {
    method: 'GET', url: '/v1/plans/:planId/weekly-progress', operationId: 'getWeeklyProgress',
    tags: ['reports'], auth: true, query: AsOfQuery,
    summary: 'Weekly weight trend, including explicit null gaps',
    description: 'Returns WeeklyTrendPoint[] from @hi/contracts as a JSON array. Weeks inside the plan with no readings are emitted with trendKg: null and missing: true; weeks entirely after the cutoff are not emitted.',
    responses: { 200: 'the WeeklyTrendPoint array', 404: 'absent or not owned' },
  }, async (request, reply) => {
    const planId = requireUuidParam(params(request).planId, 'planId');
    const query = parseOrThrow(AsOfQuery, request.query, 'query');
    const series = await snapshot(app, request, async ({ tx, user }) => {
      const plan = await loadPlan(tx, user.userId, planId);
      const asOf = resolveAsOf(plan, query.as_of);
      const observations = await weightObservations(tx, user.userId, planId, asOf);
      return buildWeeklySeries(plan.start_date, observations, asOf);
    });
    void reply.code(200);
    return series;
  });
}
