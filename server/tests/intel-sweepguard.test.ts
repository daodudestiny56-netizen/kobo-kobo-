import { describe, expect, it } from 'vitest';
import { evaluateSweepGuard } from '../src/intel/sweepguard';
import type { Credit, PastCredit } from '../src/intel/types';

const naira = (n: number) => n * 100;
const at = (day: string, time = '10:00:00') => `${day}T${time}Z`;
const credit = (reference: string, amountNaira: number, extra: Partial<Credit> = {}): Credit => ({ reference, amountKobo: naira(amountNaira), at: at('2026-11-13'), ...extra });

/** 40 credits over 10 sweep days (Nov 3 to Nov 12). */
const history = (amountNaira: number): PastCredit[] =>
  Array.from({ length: 40 }, (_, i) => ({ day: `2026-11-${String(3 + (i % 10)).padStart(2, '0')}`, amountKobo: naira(amountNaira) }));

const base = { sweepDate: '2026-11-13' };

describe('SweepGuard: cold start (thin history)', () => {
  it('clears ordinary sales', () => {
    const r = evaluateSweepGuard({ ...base, credits: [credit('A', 5000), credit('B', 12_000)], history: [] });
    expect(r.verdict).toBe('CLEAR');
    expect(r.sweepableKobo).toBe(naira(17_000));
    expect(r.excluded).toEqual([]);
  });

  it('holds out only the huge credit and still sweeps the rest', () => {
    const r = evaluateSweepGuard({ ...base, credits: [credit('A', 5000), credit('BIG', 3_000_000), credit('B', 7000)], history: [] });
    expect(r.verdict).toBe('HOLD');
    expect(r.alertType).toBe('ANOMALOUS_INFLOW');
    expect(r.excluded.map((e) => e.reference)).toEqual(['BIG']);
    expect(r.excluded[0].severity).toBe('HIGH');
    expect(r.sweepableReferences).toEqual(['A', 'B']);
    expect(r.sweepableKobo).toBe(naira(12_000));
    expect(r.excludedKobo).toBe(naira(3_000_000));
  });

  it('uses absolute thresholds: 500,000 is MEDIUM, 1,000,000 is HIGH, under 100,000 is never flagged', () => {
    const run = (n: number) => evaluateSweepGuard({ ...base, credits: [credit('X', n)], history: [] });
    expect(run(99_000).verdict).toBe('CLEAR');
    expect(run(499_000).verdict).toBe('CLEAR');
    expect(run(500_000).excluded[0].severity).toBe('MEDIUM');
    expect(run(1_000_000).excluded[0].severity).toBe('HIGH');
  });
});

describe('SweepGuard: against the trader\'s own history', () => {
  it('flags a credit far above a small trader\'s pattern as HIGH', () => {
    const r = evaluateSweepGuard({ ...base, credits: [credit('OK', 7000), credit('BIG', 600_000)], history: history(7000) });
    expect(r.excluded.map((e) => e.reference)).toEqual(['BIG']);
    expect(r.excluded[0].severity).toBe('HIGH');
    expect(r.excluded[0].reason).toContain('typical sale');
  });

  it('does not flag a credit that is large but normal for this trader', () => {
    const r = evaluateSweepGuard({ ...base, credits: [credit('N', 120_000)], history: history(100_000) });
    expect(r.verdict).toBe('CLEAR');
  });

  it('flags a moderate outlier as MEDIUM, held in partial mode but not in whole mode', () => {
    const credits = [credit('M', 300_000)];
    const partial = evaluateSweepGuard({ ...base, credits, history: history(100_000) });
    expect(partial.excluded[0].severity).toBe('MEDIUM');
    expect(partial.verdict).toBe('HOLD');
    const whole = evaluateSweepGuard({ ...base, credits, history: history(100_000), mode: 'whole' });
    expect(whole.verdict).toBe('CLEAR'); // whole mode needs HIGH by default
  });

  it('falls back to absolute thresholds with fewer than 7 days of history', () => {
    const thin = history(7000).slice(0, 12).map((h, i) => ({ ...h, day: `2026-11-${String(10 + (i % 3)).padStart(2, '0')}` }));
    const r = evaluateSweepGuard({ ...base, credits: [credit('M', 300_000)], history: thin });
    expect(r.verdict).toBe('CLEAR'); // under 500,000 with thin history
  });

  it('ignores history older than 30 sweep days', () => {
    const old = history(100_000).map((h) => ({ ...h, day: '2026-09-01' }));
    const r = evaluateSweepGuard({ ...base, credits: [credit('M', 300_000)], history: old });
    expect(r.verdict).toBe('CLEAR');
  });
});

describe('SweepGuard: duplicates', () => {
  it('counts an exact duplicate reference once and raises no alarm', () => {
    const r = evaluateSweepGuard({ ...base, credits: [credit('A', 5000), credit('A', 5000), credit('B', 3000)], history: [] });
    expect(r.verdict).toBe('CLEAR');
    expect(r.sweepableKobo).toBe(naira(8000));
    expect(r.ignoredDuplicates).toEqual(['A']);
  });

  it('ignores a reference already counted on another day', () => {
    const r = evaluateSweepGuard({ ...base, credits: [credit('OLD', 5000), credit('NEW', 3000)], history: [], seenReferences: { OLD: '2026-11-12', NEW: '2026-11-13' } });
    expect(r.sweepableReferences).toEqual(['NEW']);
    expect(r.ignoredDuplicates).toEqual(['OLD']);
  });

  it('flags a look-alike (same sender, amount, narration within 5 minutes) and holds the later one', () => {
    const a = credit('A', 20_000, { sender: 'Ada O', narration: 'rice', at: at('2026-11-13', '10:00:00') });
    const b = credit('B', 20_000, { sender: 'ada o ', narration: 'Rice', at: at('2026-11-13', '10:03:00') });
    const r = evaluateSweepGuard({ ...base, credits: [a, b], history: [] });
    expect(r.excluded).toHaveLength(1);
    expect(r.excluded[0]).toMatchObject({ reference: 'B', alertType: 'SUSPECTED_DUPLICATE', severity: 'MEDIUM' });
    expect(r.sweepableReferences).toEqual(['A']);
  });

  it('does not flag the same sender and amount more than 5 minutes apart', () => {
    const a = credit('A', 20_000, { sender: 'Ada O', narration: 'rice', at: at('2026-11-13', '10:00:00') });
    const b = credit('B', 20_000, { sender: 'Ada O', narration: 'rice', at: at('2026-11-13', '10:06:00') });
    expect(evaluateSweepGuard({ ...base, credits: [a, b], history: [] }).verdict).toBe('CLEAR');
  });
});

describe('SweepGuard: modes and shape', () => {
  it('whole mode blocks the entire sweep on a HIGH anomaly', () => {
    const r = evaluateSweepGuard({ ...base, credits: [credit('A', 5000), credit('BIG', 3_000_000)], history: [], mode: 'whole' });
    expect(r.verdict).toBe('HOLD');
    expect(r.sweepableReferences).toEqual([]);
    expect(r.sweepableKobo).toBe(0);
  });

  it('is deterministic and handles no credits', () => {
    const input = { ...base, credits: [credit('A', 5000), credit('BIG', 3_000_000)], history: history(7000) };
    expect(evaluateSweepGuard(input)).toEqual(evaluateSweepGuard(input));
    const none = evaluateSweepGuard({ ...base, credits: [], history: [] });
    expect(none).toMatchObject({ verdict: 'CLEAR', sweepableKobo: 0, excluded: [] });
  });

  it('returns integer kobo and scores between 0 and 1', () => {
    const r = evaluateSweepGuard({ ...base, credits: [credit('BIG', 3_000_000)], history: history(7000) });
    expect(Number.isInteger(r.sweepableKobo)).toBe(true);
    expect(r.excluded[0].score).toBeGreaterThan(0);
    expect(r.excluded[0].score).toBeLessThanOrEqual(0.99);
  });
});
