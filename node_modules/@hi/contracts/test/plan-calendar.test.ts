import { describe, it, expect } from 'vitest';
import {
  addCalendarMonths, planEndDateExclusive, planLastIncludedDay,
  reportingWeeks, weekIndexForDate, localDateInZone, isValidTimeZone,
  compareIsoDate, addDays, differenceInDays,
} from '../src/plan-calendar.js';

describe('six calendar months (never 180 days / 26 weeks)', () => {
  it('matches the documented Sep 14 -> Mar 14 example', () => {
    expect(planEndDateExclusive('2026-09-14')).toBe('2027-03-14');
    expect(planLastIncludedDay('2026-09-14')).toBe('2027-03-13');
  });
  it('clamps month-end starts to a shorter target month', () => {
    expect(addCalendarMonths('2026-08-31', 6)).toBe('2027-02-28');
    expect(addCalendarMonths('2025-08-31', 6)).toBe('2026-02-28');
    expect(addCalendarMonths('2024-08-29', 6)).toBe('2025-02-28');
  });
  it('lands on Feb 29 in a leap year', () => {
    expect(addCalendarMonths('2023-08-29', 6)).toBe('2024-02-29');
    expect(addCalendarMonths('2023-08-31', 6)).toBe('2024-02-29');
  });
  it('is a varying calendar span, not a fixed 180 days / 26 weeks', () => {
    const spans = ['2026-01-31', '2026-02-28', '2026-03-01', '2026-09-14', '2026-06-30']
      .map((start) => differenceInDays(start, planEndDateExclusive(start)));
    // If six months were hard-coded as 180 days or 26 weeks (182), every span
    // would be identical. Real calendar months produce several distinct lengths.
    expect(new Set(spans).size).toBeGreaterThan(1);
    expect(spans).not.toContain(180);
    expect(Math.min(...spans)).toBeGreaterThanOrEqual(181);
    expect(Math.max(...spans)).toBeLessThanOrEqual(184);
  });
});

describe('reporting weeks', () => {
  const start = '2026-09-14';
  const weeks = reportingWeeks(start);

  it('starts week 1 on the plan start date', () => {
    expect(weeks[0]).toEqual({ index: 1, startDate: '2026-09-14', endDate: '2026-09-20' });
  });
  it('uses seven-day blocks', () => {
    expect(weeks[1]!.startDate).toBe('2026-09-21');
  });
  it('ends with a possibly short final block inside the plan', () => {
    const last = weeks[weeks.length - 1]!;
    expect(last.endDate).toBe(planLastIncludedDay(start));
    const days = Math.round(
      (Date.parse(last.endDate + 'T00:00:00Z') - Date.parse(last.startDate + 'T00:00:00Z')) / 86400000) + 1;
    expect(days).toBeGreaterThanOrEqual(1);
    expect(days).toBeLessThanOrEqual(7);
  });
  it('covers every day exactly once with no gaps', () => {
    for (let i = 1; i < weeks.length; i++) {
      expect(weeks[i]!.startDate).toBe(addDays(weeks[i - 1]!.endDate, 1));
    }
  });
  it('maps dates to the right week and rejects out-of-range dates', () => {
    expect(weekIndexForDate(start, '2026-09-14')).toBe(1);
    expect(weekIndexForDate(start, '2026-09-20')).toBe(1);
    expect(weekIndexForDate(start, '2026-09-21')).toBe(2);
    expect(weekIndexForDate(start, '2026-09-13')).toBeNull();
    expect(weekIndexForDate(start, '2027-03-14')).toBeNull(); // end is exclusive
  });
});

describe('server-side local date derivation', () => {
  it('derives the plan-local date from an instant, not the browser zone', () => {
    // 2026-09-14T18:45:00Z is already Sep 15 in Kolkata (+05:30)
    expect(localDateInZone('2026-09-14T18:45:00Z', 'Asia/Kolkata')).toBe('2026-09-15');
    expect(localDateInZone('2026-09-14T18:45:00Z', 'UTC')).toBe('2026-09-14');
    expect(localDateInZone('2026-09-14T18:45:00Z', 'America/Los_Angeles')).toBe('2026-09-14');
  });
  it('handles local midnight boundaries', () => {
    expect(localDateInZone('2026-09-14T18:30:00Z', 'Asia/Kolkata')).toBe('2026-09-15');
    expect(localDateInZone('2026-09-14T18:29:59Z', 'Asia/Kolkata')).toBe('2026-09-14');
  });
  it('is stable across a daylight-saving transition', () => {
    // US DST ends 2026-11-01; 06:30Z is still Oct 31 local in Los Angeles
    expect(localDateInZone('2026-11-01T06:30:00Z', 'America/Los_Angeles')).toBe('2026-10-31');
    expect(localDateInZone('2026-11-01T09:30:00Z', 'America/Los_Angeles')).toBe('2026-11-01');
  });
  it('validates IANA zones', () => {
    expect(isValidTimeZone('Asia/Kolkata')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('IST')).toBe(false);
  });
});

describe('date helpers', () => {
  it('compares and adds without float drift', () => {
    expect(compareIsoDate('2026-09-14', '2026-09-15')).toBeLessThan(0);
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
  });
});
