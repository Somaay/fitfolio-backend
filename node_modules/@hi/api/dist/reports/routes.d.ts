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
export declare function registerReportRoutes(app: FastifyInstance): void;
//# sourceMappingURL=routes.d.ts.map