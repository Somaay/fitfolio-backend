import { describe, it, expect } from 'vitest';
import {
  kgToGrams, gramsToKg, dailyMeanGrams, weeklyTrendGrams,
  buildWeeklySeries, kgToLbDisplay, lbToKg,
} from '../src/weight.js';

const w = (localDate: string, kg: string) => ({ localDate, weightKg: kg });

describe('exact kg storage (3 decimals == whole grams)', () => {
  it('round-trips without drift', () => {
    expect(kgToGrams('90.500')).toBe(90500n);
    expect(kgToGrams('90')).toBe(90000n);
    expect(gramsToKg(90500n)).toBe('90.500');
    expect(gramsToKg(-1500n)).toBe('-1.500');
  });
  it('rejects more than three decimals rather than silently rounding', () => {
    expect(() => kgToGrams('90.5005')).toThrow();
  });
  it('converts lb for display without degrading the stored value', () => {
    const stored = kgToGrams('90.500');
    // display conversion is one-way; the stored grams are untouched
    expect(kgToLbDisplay(stored)).toBeCloseTo(199.5, 1);
    expect(stored).toBe(90500n);
  });
  it('converts entered lb to kg once, at the edge', () => {
    expect(gramsToKg(lbToKg('200'))).toBe('90.718');
  });
});

describe('daily mean then weekly median', () => {
  it('averages multiple readings on the same day first', () => {
    expect(dailyMeanGrams([kgToGrams('90.000'), kgToGrams('91.000')])).toBe(90500n);
  });
  it('rounds daily means deterministically (half-up)', () => {
    expect(dailyMeanGrams([1n, 2n])).toBe(2n);
    expect(dailyMeanGrams([kgToGrams('90.000'), kgToGrams('90.001')])).toBe(90001n);
  });
  it('does not let repeated same-day readings dominate the week', () => {
    // Five readings on Monday at 95, one on each other day at 90.
    const entries = [
      ...Array.from({ length: 5 }, () => w('2026-09-14', '95.000')),
      w('2026-09-15', '90.000'), w('2026-09-16', '90.000'), w('2026-09-17', '90.000'),
    ];
    // Daily means: 95, 90, 90, 90 -> median of [90,90,90,95] = 90
    expect(weeklyTrendGrams(entries)).toBe(90000n);
  });
  it('takes the median, not the mean, of daily means', () => {
    const entries = [w('2026-09-14', '90.000'), w('2026-09-15', '91.000'), w('2026-09-16', '100.000')];
    expect(weeklyTrendGrams(entries)).toBe(91000n); // median 91, not mean 93.667
  });
  it('averages the two middle daily means for an even count', () => {
    const entries = [w('2026-09-14', '90.000'), w('2026-09-15', '92.000')];
    expect(weeklyTrendGrams(entries)).toBe(91000n);
  });
  it('returns null for a week with no readings', () => {
    expect(weeklyTrendGrams([])).toBeNull();
  });
});

describe('weekly series', () => {
  const start = '2026-09-14';

  it('marks missing weeks null with a visible gap, never zero or the target', () => {
    const series = buildWeeklySeries(start, [w('2026-09-14', '90.000'), w('2026-09-28', '89.000')], '2026-10-04');
    expect(series[0]!.trendKg).toBe('90.000');
    expect(series[1]!.trendKg).toBeNull();   // week 2 genuinely missing
    expect(series[1]!.missing).toBe(true);
    expect(series[2]!.trendKg).toBe('89.000');
  });

  it('computes week-on-week change only between adjacent weeks', () => {
    const series = buildWeeklySeries(start, [w('2026-09-14', '90.000'), w('2026-09-28', '89.000')], '2026-10-04');
    expect(series[0]!.changeFromPreviousKg).toBeNull();  // no prior week
    expect(series[1]!.changeFromPreviousKg).toBeNull();  // this week missing
    expect(series[2]!.changeFromPreviousKg).toBeNull();  // previous week missing
  });

  it('reports negative change for loss and positive for gain', () => {
    const series = buildWeeklySeries(start, [w('2026-09-14', '90.000'), w('2026-09-21', '89.250')], '2026-09-27');
    expect(series[1]!.changeFromPreviousKg).toBe('-0.750');
    const gain = buildWeeklySeries(start, [w('2026-09-14', '90.000'), w('2026-09-21', '90.500')], '2026-09-27');
    expect(gain[1]!.changeFromPreviousKg).toBe('0.500');
  });

  it('marks the current incomplete week provisional', () => {
    // as_of falls inside week 1 (Sep 14-20)
    const series = buildWeeklySeries(start, [w('2026-09-14', '90.000')], '2026-09-17');
    expect(series[0]!.provisional).toBe(true);
    expect(series).toHaveLength(1); // no future weeks emitted
  });

  it('does not mark a completed week provisional', () => {
    const series = buildWeeklySeries(start, [w('2026-09-14', '90.000')], '2026-09-21');
    expect(series[0]!.provisional).toBe(false);
  });

  it('ignores entries after the cutoff', () => {
    const series = buildWeeklySeries(start, [w('2026-09-14', '90.000'), w('2026-09-21', '80.000')], '2026-09-20');
    expect(series).toHaveLength(1);
  });
});
