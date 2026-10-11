/**
 * Dashboard / cost-efficiency contract.
 *
 * Every value here is derived from persisted records that the caller has ALREADY
 * aggregated per fact-set. Callers must not hand this function rows produced by a
 * single multi-table join: joining expenses, weights and activities in one query
 * multiplies rows and silently inflates spending and attendance
 * (docs/decisions.md D-09).
 *
 * Vocabulary note: these are descriptive COST-EFFICIENCY figures — two observed
 * quantities divided by each other. They are not a financial return, and they do
 * not attribute weight change to any particular purchase.
 */
import { type IsoDate } from './plan-calendar.js';
import { type CurrencyCode } from './money.js';
import { type WeeklyTrendPoint } from './weight.js';
export declare const METRIC_VERSION = 1;
export type BudgetScope = 'total' | 'incremental';
/** Stable machine-readable reasons a metric is unavailable. */
export type MetricReason = 'no_measurements' | 'no_positive_loss' | 'no_spend' | 'zero_budget' | 'no_sessions';
export interface EffectiveBudget {
    readonly revisionId: string;
    readonly revision: number;
    readonly totalMinor: bigint;
    readonly effectiveOn: IsoDate;
}
export interface DashboardInput {
    readonly planStartDate: IsoDate;
    /** Inclusive plan-local cutoff, already capped at today and the plan's last day. */
    readonly asOf: IsoDate;
    readonly today: IsoDate;
    readonly currency: CurrencyCode;
    readonly scope: BudgetScope;
    readonly effectiveBudget: EffectiveBudget;
    readonly originalBudget: EffectiveBudget;
    /** Non-void scoped payments minus non-void scoped refunds, through the cutoff. */
    readonly netSpendMinor: bigint;
    /** Sum of max(0, expected - linked net payments) over pending commitments. */
    readonly outstandingCommitmentMinor: bigint;
    readonly baselineWeightKg: string;
    readonly targetWeightKg: string;
    readonly weeklySeries: readonly WeeklyTrendPoint[];
    readonly completedSessions: number;
    readonly sessionScopedSpendMinor: bigint;
    readonly latestMeasurementDate?: IsoDate | null;
}
export interface DashboardMetrics {
    readonly metricVersion: number;
    readonly currency: CurrencyCode;
    readonly scope: BudgetScope;
    readonly asOf: IsoDate;
    readonly effectiveBudgetRevisionId: string;
    readonly effectiveBudgetRevision: number;
    readonly budgetWasRevised: boolean;
    readonly budgetCapMinor: string;
    readonly netSpendMinor: string;
    readonly remainingBudgetMinor: string;
    readonly utilizationPercent: string | null;
    readonly utilizationReason: MetricReason | null;
    readonly originalBudgetCapMinor: string;
    readonly originalUtilizationPercent: string | null;
    readonly overBudget: boolean;
    readonly baselineWeightKg: string;
    readonly targetWeightKg: string;
    readonly latestTrendWeightKg: string | null;
    readonly latestTrendWeekIndex: number | null;
    readonly latestWeekProvisional: boolean;
    readonly weightLostKg: string | null;
    readonly weightLostReason: MetricReason | null;
    readonly goalProgressPercent: string | null;
    readonly costPerKgLostMinor: string | null;
    readonly costPerKgLostReason: MetricReason | null;
    readonly kgLostPerThousandMajor: string | null;
    readonly kgLostPerThousandReason: MetricReason | null;
    readonly forecastTotalMinor: string;
    readonly forecastIncludesOnlyScheduled: true;
    readonly outstandingCommitmentMinor: string;
    readonly completedSessions: number;
    readonly costPerCompletedSessionMinor: string | null;
    readonly costPerCompletedSessionReason: MetricReason | null;
    readonly measurementAgeDays: number | null;
    readonly weightDataStale: boolean;
    readonly missingWeekCount: number;
    readonly latestMeasurementDate: IsoDate | null;
}
export declare function computeDashboardMetrics(input: DashboardInput): DashboardMetrics;
//# sourceMappingURL=metrics.d.ts.map