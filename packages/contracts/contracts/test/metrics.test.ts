import { describe, it, expect } from 'vitest';
import { computeDashboardMetrics, METRIC_VERSION } from '../src/metrics.js';
import { buildWeeklySeries } from '../src/weight.js';

const START = '2026-09-14';

const base = {
  planStartDate: START,
  asOf: '2026-10-11',
  currency: 'INR' as const,
  scope: 'total' as const,
  effectiveBudget: { revisionId: 'r1', revision: 1, totalMinor: 6_000_000n, effectiveOn: START },
  originalBudget: { revisionId: 'r1', revision: 1, totalMinor: 6_000_000n, effectiveOn: START },
  netSpendMinor: 1_800_000n,
  outstandingCommitmentMinor: 0n,
  baselineWeightKg: '90.000',
  targetWeightKg: '85.000',
  weeklySeries: buildWeeklySeries(START, [
    { localDate: '2026-09-14', weightKg: '90.000' },
    { localDate: '2026-10-05', weightKg: '87.000' },
  ], '2026-10-11'),
  completedSessions: 0,
  sessionScopedSpendMinor: 0n,
  today: '2026-10-11',
};

describe('reference example from the specification', () => {
  const m = computeDashboardMetrics(base);

  it('reports 30% utilization and INR 42,000 remaining', () => {
    expect(m.utilizationPercent).toBe('30.00');
    expect(m.remainingBudgetMinor).toBe('4200000');
    expect(m.netSpendMinor).toBe('1800000');
  });
  it('reports 3 kg lost against the frozen baseline', () => {
    expect(m.weightLostKg).toBe('3.000');
    expect(m.latestTrendWeightKg).toBe('87.000');
  });
  it('reports INR 6,000 per kg and ~0.167 kg per INR 1,000', () => {
    expect(m.costPerKgLostMinor).toBe('600000');       // 6000.00 INR in paise
    expect(m.kgLostPerThousandMajor).toBe('0.167');
  });
  it('reports goal progress against the declared target', () => {
    expect(m.goalProgressPercent).toBe('60.00');        // 3 of 5 kg
  });
  it('stamps the contract metadata', () => {
    expect(m.metricVersion).toBe(METRIC_VERSION);
    expect(m.currency).toBe('INR');
    expect(m.scope).toBe('total');
    expect(m.asOf).toBe('2026-10-11');
    expect(m.effectiveBudgetRevision).toBe(1);
  });
});

describe('currency exponent is honoured in cost efficiency', () => {
  it('computes kg per 1,000 MAJOR units for a zero-decimal currency', () => {
    const m = computeDashboardMetrics({
      ...base, currency: 'JPY',
      effectiveBudget: { ...base.effectiveBudget, totalMinor: 60_000n },
      originalBudget: { ...base.originalBudget, totalMinor: 60_000n },
      netSpendMinor: 18_000n, // 18,000 JPY (exponent 0)
    });
    expect(m.utilizationPercent).toBe('30.00');
    expect(m.costPerKgLostMinor).toBe('6000');          // 6,000 JPY per kg
    expect(m.kgLostPerThousandMajor).toBe('0.167');     // same major-unit maths
  });
});

describe('unavailable metrics return stable reasons, never zero', () => {
  it('no_measurements when nothing was recorded', () => {
    const m = computeDashboardMetrics({ ...base, weeklySeries: [] });
    expect(m.latestTrendWeightKg).toBeNull();
    expect(m.weightLostKg).toBeNull();
    expect(m.costPerKgLostMinor).toBeNull();
    expect(m.costPerKgLostReason).toBe('no_measurements');
    expect(m.goalProgressPercent).toBeNull();
  });

  it('no_positive_loss on a gain, without a nonsense negative price', () => {
    const m = computeDashboardMetrics({
      ...base,
      weeklySeries: buildWeeklySeries(START, [
        { localDate: '2026-09-14', weightKg: '90.000' },
        { localDate: '2026-10-05', weightKg: '92.000' },
      ], '2026-10-11'),
    });
    expect(m.weightLostKg).toBe('-2.000');              // gain is retained, not hidden
    expect(m.costPerKgLostMinor).toBeNull();
    expect(m.costPerKgLostReason).toBe('no_positive_loss');
    expect(m.goalProgressPercent).toBe('-40.00');       // uncapped, honest
  });

  it('no_positive_loss when weight is unchanged', () => {
    const m = computeDashboardMetrics({
      ...base,
      weeklySeries: buildWeeklySeries(START, [{ localDate: '2026-09-14', weightKg: '90.000' }], '2026-10-11'),
    });
    expect(m.weightLostKg).toBe('0.000');
    expect(m.costPerKgLostReason).toBe('no_positive_loss');
  });

  it('no_spend when nothing has been paid', () => {
    const m = computeDashboardMetrics({ ...base, netSpendMinor: 0n });
    expect(m.costPerKgLostMinor).toBeNull();
    expect(m.costPerKgLostReason).toBe('no_spend');
    expect(m.utilizationPercent).toBe('0.00');
  });

  it('zero_budget returns null utilization rather than throwing', () => {
    const m = computeDashboardMetrics({
      ...base,
      effectiveBudget: { ...base.effectiveBudget, totalMinor: 0n },
    });
    expect(m.utilizationPercent).toBeNull();
    expect(m.utilizationReason).toBe('zero_budget');
    expect(m.remainingBudgetMinor).toBe('-1800000');    // still honest about overspend
  });
});

describe('overspend and negative balances stay visible', () => {
  it('allows utilization above 100% and a negative remaining balance', () => {
    const m = computeDashboardMetrics({ ...base, netSpendMinor: 7_500_000n });
    expect(m.utilizationPercent).toBe('125.00');
    expect(m.remainingBudgetMinor).toBe('-1500000');
    expect(m.overBudget).toBe(true);
  });
});

describe('budget revisions', () => {
  it('keeps the original comparison visible alongside the effective revision', () => {
    const m = computeDashboardMetrics({
      ...base,
      effectiveBudget: { revisionId: 'r2', revision: 2, totalMinor: 9_000_000n, effectiveOn: '2026-10-01' },
    });
    expect(m.effectiveBudgetRevision).toBe(2);
    expect(m.utilizationPercent).toBe('20.00');                 // against the revised cap
    expect(m.originalUtilizationPercent).toBe('30.00');         // against revision 1
    expect(m.budgetWasRevised).toBe(true);
  });
});

describe('forecast', () => {
  it('adds outstanding commitments and labels them as scheduled only', () => {
    const m = computeDashboardMetrics({ ...base, outstandingCommitmentMinor: 1_200_000n });
    expect(m.forecastTotalMinor).toBe('3000000');
    expect(m.netSpendMinor).toBe('1800000');  // forecast never leaks into actual
    expect(m.forecastIncludesOnlyScheduled).toBe(true);
  });
});

describe('session cost', () => {
  it('is null with no completed sessions, not zero', () => {
    const m = computeDashboardMetrics({ ...base, completedSessions: 0, sessionScopedSpendMinor: 500_000n });
    expect(m.costPerCompletedSessionMinor).toBeNull();
    expect(m.costPerCompletedSessionReason).toBe('no_sessions');
  });
  it('divides relevant spend by completed attendance', () => {
    const m = computeDashboardMetrics({ ...base, completedSessions: 10, sessionScopedSpendMinor: 500_000n });
    expect(m.costPerCompletedSessionMinor).toBe('50000');
  });
});

describe('freshness', () => {
  it('marks weight metrics stale after 14 days without a reading', () => {
    const m = computeDashboardMetrics({
      ...base, asOf: '2026-10-25', today: '2026-10-25',
      weeklySeries: buildWeeklySeries(START, [
        { localDate: '2026-09-14', weightKg: '90.000' },
        { localDate: '2026-10-05', weightKg: '87.000' },
      ], '2026-10-25'),
      latestMeasurementDate: '2026-10-05',
    });
    expect(m.measurementAgeDays).toBe(20);
    expect(m.weightDataStale).toBe(true);
  });
  it('is not stale within 14 days', () => {
    const m = computeDashboardMetrics({ ...base, latestMeasurementDate: '2026-10-05' });
    expect(m.measurementAgeDays).toBe(6);
    expect(m.weightDataStale).toBe(false);
  });
  it('counts missing weeks and flags a provisional current week', () => {
    const m = computeDashboardMetrics(base);
    expect(m.missingWeekCount).toBeGreaterThan(0);
    expect(typeof m.latestWeekProvisional).toBe('boolean');
  });
});
