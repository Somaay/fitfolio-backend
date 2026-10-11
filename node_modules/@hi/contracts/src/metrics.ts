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
import {
  type IsoDate, differenceInDays, STALE_MEASUREMENT_DAYS,
} from './plan-calendar.js';
import { type CurrencyCode, minorUnitExponent } from './money.js';
import {
  type WeeklyTrendPoint, kgToGrams, gramsToKg, latestPopulatedTrend, countMissingWeeks,
} from './weight.js';

export const METRIC_VERSION = 1;

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

/** Half-up division producing a fixed-decimal string. Exact bigint arithmetic. */
function ratioToFixed(numerator: bigint, denominator: bigint, decimals: number): string {
  if (denominator === 0n) throw new Error('ratioToFixed: zero denominator');
  const scale = 10n ** BigInt(decimals);
  const negative = (numerator < 0n) !== (denominator < 0n);
  const a = numerator < 0n ? -numerator : numerator;
  const b = denominator < 0n ? -denominator : denominator;
  const scaled = a * scale;
  const quotient = scaled / b;
  const remainder = scaled % b;
  const rounded = remainder * 2n >= b ? quotient + 1n : quotient;
  const digits = rounded.toString(10).padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = decimals === 0 ? '' : `.${digits.slice(digits.length - decimals)}`;
  const body = `${whole}${fraction}`;
  return negative && rounded !== 0n ? `-${body}` : body;
}

export function computeDashboardMetrics(input: DashboardInput): DashboardMetrics {
  const {
    currency, scope, asOf, effectiveBudget, originalBudget,
    netSpendMinor, outstandingCommitmentMinor,
    baselineWeightKg, targetWeightKg, weeklySeries,
    completedSessions, sessionScopedSpendMinor,
  } = input;

  // ---- Budget ------------------------------------------------------------
  const capMinor = effectiveBudget.totalMinor;
  const remainingMinor = capMinor - netSpendMinor;           // may legitimately be negative
  const hasBudget = capMinor > 0n;
  const utilizationPercent = hasBudget ? ratioToFixed(netSpendMinor * 100n, capMinor, 2) : null;
  const originalUtilizationPercent =
    originalBudget.totalMinor > 0n ? ratioToFixed(netSpendMinor * 100n, originalBudget.totalMinor, 2) : null;

  // ---- Weight ------------------------------------------------------------
  const baselineGrams = kgToGrams(baselineWeightKg);
  const targetGrams = kgToGrams(targetWeightKg);
  const latest = latestPopulatedTrend(weeklySeries);
  const latestGrams = latest?.trendKg != null ? kgToGrams(latest.trendKg) : null;

  const hasMeasurement = latestGrams !== null;
  const lostGrams = hasMeasurement ? baselineGrams - latestGrams : null;   // negative == gain
  const goalSpanGrams = baselineGrams - targetGrams;

  const goalProgressPercent =
    lostGrams !== null && goalSpanGrams > 0n
      ? ratioToFixed(lostGrams * 100n, goalSpanGrams, 2)   // uncapped and signed: honest
      : null;

  // ---- Cost efficiency ---------------------------------------------------
  // Eligible only when BOTH a positive loss and positive net spending exist.
  // Otherwise return a stable reason so the UI can explain the gap instead of
  // rendering a zero or a nonsensical negative price.
  let costReason: MetricReason | null = null;
  if (!hasMeasurement) costReason = 'no_measurements';
  else if (lostGrams === null || lostGrams <= 0n) costReason = 'no_positive_loss';
  else if (netSpendMinor <= 0n) costReason = 'no_spend';

  const eligible = costReason === null && lostGrams !== null && lostGrams > 0n;

  // Cost per kg, in MINOR units: netSpend / (lostGrams / 1000)
  const costPerKgLostMinor = eligible ? ratioToFixed(netSpendMinor * 1000n, lostGrams!, 0) : null;

  // Kg lost per 1,000 MAJOR units. Major units = minor / 10^exponent, so
  // kgPer1000 = (lostGrams/1000) / (netSpendMinor / 10^exp) * 1000.
  const exponent = BigInt(minorUnitExponent(currency));
  const kgLostPerThousandMajor = eligible
    ? ratioToFixed(lostGrams! * (10n ** exponent) * 1000n, netSpendMinor * 1000n, 3)
    : null;

  // ---- Freshness ---------------------------------------------------------
  const latestMeasurementDate = input.latestMeasurementDate ?? null;
  const measurementAgeDays =
    latestMeasurementDate !== null ? differenceInDays(latestMeasurementDate, input.today) : null;
  const weightDataStale =
    measurementAgeDays !== null && measurementAgeDays > STALE_MEASUREMENT_DAYS;

  // ---- Sessions ----------------------------------------------------------
  const costPerCompletedSessionMinor =
    completedSessions > 0 ? ratioToFixed(sessionScopedSpendMinor, BigInt(completedSessions), 0) : null;

  return {
    metricVersion: METRIC_VERSION,
    currency, scope, asOf,
    effectiveBudgetRevisionId: effectiveBudget.revisionId,
    effectiveBudgetRevision: effectiveBudget.revision,
    budgetWasRevised: effectiveBudget.revision > originalBudget.revision,

    budgetCapMinor: capMinor.toString(10),
    netSpendMinor: netSpendMinor.toString(10),
    remainingBudgetMinor: remainingMinor.toString(10),
    utilizationPercent,
    utilizationReason: hasBudget ? null : 'zero_budget',
    originalBudgetCapMinor: originalBudget.totalMinor.toString(10),
    originalUtilizationPercent,
    overBudget: remainingMinor < 0n,

    baselineWeightKg: gramsToKg(baselineGrams),
    targetWeightKg: gramsToKg(targetGrams),
    latestTrendWeightKg: latestGrams === null ? null : gramsToKg(latestGrams),
    latestTrendWeekIndex: latest?.weekIndex ?? null,
    latestWeekProvisional: latest?.provisional ?? false,
    weightLostKg: lostGrams === null ? null : gramsToKg(lostGrams),
    weightLostReason: hasMeasurement ? null : 'no_measurements',
    goalProgressPercent,

    costPerKgLostMinor,
    costPerKgLostReason: costReason,
    kgLostPerThousandMajor,
    kgLostPerThousandReason: costReason,

    forecastTotalMinor: (netSpendMinor + outstandingCommitmentMinor).toString(10),
    forecastIncludesOnlyScheduled: true,
    outstandingCommitmentMinor: outstandingCommitmentMinor.toString(10),

    completedSessions,
    costPerCompletedSessionMinor,
    costPerCompletedSessionReason: completedSessions > 0 ? null : 'no_sessions',

    measurementAgeDays,
    weightDataStale,
    missingWeekCount: countMissingWeeks(weeklySeries),
    latestMeasurementDate,
  };
}
