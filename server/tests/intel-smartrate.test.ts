import { describe, expect, it } from 'vitest';
import { addDays } from '../src/intel/dates';
import { affordabilityCap, suggestRate } from '../src/intel/smartrate';
import type { DailyTakings, SmartRateInput } from '../src/intel/types';

const AS_OF = '2026-11-12';
const naira = (n: number) => Math.round(n * 100);

/** `days` days ending on asOf, one row per day, amount from a function of the day index. */
function series(days: number, amount: (i: number) => number, asOf = AS_OF): { firstDay: string; takings: DailyTakings[] } {
  const firstDay = addDays(asOf, -(days - 1));
  return { firstDay, takings: Array.from({ length: days }, (_, i) => ({ day: addDays(firstDay, i), amountKobo: naira(amount(i)) })).filter((t) => t.amountKobo > 0) };
}

const steady = (level: number) => (i: number) => level * (1 + 0.04 * Math.sin(i));
const input = (over: Partial<SmartRateInput> & { days?: number; amount?: (i: number) => number }): SmartRateInput => {
  const { days = 40, amount = steady(80_000), ...rest } = over;
  const s = series(days, amount, rest.asOf ?? AS_OF);
  return { merchantId: 'm-1', asOf: AS_OF, currentRate: 2, ...s, ...rest };
};

describe('SmartRate: decisions', () => {
  it('suggests one step up for a steady, high-earning trader', () => {
    const r = suggestRate(input({}));
    expect(r.action).toBe('INCREASE');
    expect(r.recommendedRate).toBe(2.5);
    expect(r.holdReason).toBeNull();
    expect(r.regime === 'STABLE' || r.regime === 'GROWING').toBe(true);
    expect(r.confidence).toBeGreaterThanOrEqual(0.8);
    expect(r.confidence).toBeLessThanOrEqual(0.99);
    expect(r.monthlyChangeKobo).toBeGreaterThan(0);
    expect(r.rationale).toContain('steady');
    expect(r.checks.every((c) => c.passed)).toBe(true);
  });

  it('suggests easing off for an uneven trader', () => {
    // sales swing between roughly 25,000 and 150,000 from one day to the next, with no pattern
    const uneven = (i: number) => {
      const x = Math.sin(i * 12.9898 + 4.1414) * 43758.5453;
      return 60_000 * Math.exp(1.8 * (x - Math.floor(x) - 0.5));
    };
    const r = suggestRate(input({ currentRate: 3, amount: uneven }));
    expect(r.regime).toBe('VOLATILE');
    expect(r.action).toBe('DECREASE');
    expect(r.recommendedRate).toBeLessThan(3);
    expect(r.recommendedRate).toBeGreaterThanOrEqual(2); // never more than one point down
    expect(r.monthlyChangeKobo).toBeLessThan(0);
  });

  it('holds when the rate already fits', () => {
    const r = suggestRate(input({ amount: steady(30_000) }));
    expect(r.action).toBe('HOLD');
    expect(r.holdReason).toBe('RATE_FITS');
    expect(r.recommendedRate).toBe(2);
  });

  it('holds with INSUFFICIENT_DATA under two weeks of history', () => {
    const r = suggestRate(input({ days: 10 }));
    expect(r).toMatchObject({ action: 'HOLD', holdReason: 'INSUFFICIENT_DATA', regime: 'INSUFFICIENT_DATA', confidence: null });
  });

  it('holds when sweeps are paused', () => {
    const r = suggestRate(input({ isPaused: true }));
    expect(r.holdReason).toBe('PAUSED');
  });

  it('does not read a short bad patch as a decline', () => {
    const r = suggestRate(input({ amount: (i) => (i >= 36 ? 4000 : steady(80_000)(i)) }));
    expect(r.regime).toBe('TEMPORARY_DISRUPTION');
    expect(r.action).toBe('HOLD');
    expect(r.holdReason).toBe('TEMPORARY_DISRUPTION');
  });

  it('holds for a trader who has stopped selling', () => {
    const r = suggestRate(input({ amount: (i) => (i >= 26 ? 0 : steady(60_000)(i)) }));
    expect(r.regime).toBe('INACTIVE');
    expect(r.holdReason).toBe('INACTIVE');
  });

  it('does not raise the rate when the daily cap already binds', () => {
    const r = suggestRate(input({ amount: steady(400_000) }));
    expect(r.action).toBe('HOLD');
    expect(r.holdReason).toBe('DAILY_CAP_REACHED');
  });

  it('waits out the festive peak before raising a rate', () => {
    const asOf = '2026-12-12';
    const r = suggestRate(input({ asOf }));
    expect(r.action).toBe('HOLD');
    expect(r.holdReason).toBe('SEASONAL_PEAK');
  });

  it('respects the cooldown after a recent suggestion', () => {
    const r = suggestRate(
      input({ recentSuggestions: [{ createdAt: '2026-11-10T08:00:00Z', direction: 'INCREASE', status: 'PENDING', expiresAt: '2026-11-17T08:00:00Z' }], now: '2026-11-13T09:00:00Z' }),
    );
    expect(r.holdReason).toBe('COOLDOWN');
  });

  it('remembers a NO to an increase for 30 days', () => {
    const r = suggestRate(
      input({ recentSuggestions: [{ createdAt: '2026-10-25T08:00:00Z', direction: 'INCREASE', status: 'DECLINED', respondedAt: '2026-10-26T08:00:00Z' }], now: '2026-11-13T09:00:00Z' }),
    );
    expect(r.holdReason).toBe('COOLDOWN');
  });
});

describe('SmartRate: guarantees', () => {
  it('gives the same answer for the same input', () => {
    const i = input({ amount: (n) => 50_000 + ((n * 7919) % 30_000) });
    expect(suggestRate(i)).toEqual(suggestRate(i));
  });

  it('never recommends above the affordability cap or below 1%, and moves one step', () => {
    expect(affordabilityCap()).toBe(3.5);
    for (const level of [20_000, 60_000, 150_000, 400_000]) {
      for (const currentRate of [1, 2, 3.5, 5]) {
        const r = suggestRate(input({ currentRate, amount: steady(level) }));
        expect(r.recommendedRate).toBeGreaterThanOrEqual(1);
        if (r.action === 'INCREASE') {
          expect(r.recommendedRate).toBe(currentRate + 0.5);
          expect(r.recommendedRate).toBeLessThanOrEqual(3.5);
        }
        if (r.action === 'DECREASE') expect(currentRate - r.recommendedRate).toBeLessThanOrEqual(1);
        if (r.action === 'HOLD') expect(r.recommendedRate).toBe(currentRate);
      }
    }
  });

  it('returns kobo as whole numbers and keeps the rationale short enough to store', () => {
    const r = suggestRate(input({}));
    expect(Number.isInteger(r.metrics.avgDailyTakingsKobo)).toBe(true);
    expect(Number.isInteger(r.monthlyChangeKobo as number)).toBe(true);
    expect(r.rationale.length).toBeLessThanOrEqual(500);
  });

  it('ignores a regular day off instead of punishing it', () => {
    // never sells on Sundays (2026-11-08 is a Sunday)
    const r = suggestRate(input({ amount: (i) => (new Date(`${addDays(AS_OF, -39 + i)}T00:00:00Z`).getUTCDay() === 0 ? 0 : steady(80_000)(i)) }));
    expect(r.metrics.regularDaysOff).toEqual(['Sun']);
    expect(r.action).toBe('INCREASE');
  });
});
