import { describe, expect, it } from 'vitest';
import { dbToKobo, koboToNaira, nairaDisplay, parseNaira, parsePositiveNaira, percentOf, rateDisplay, rateToHundredths } from '../src/money';
import { addDays, assertDateString, currentSweepDate, formatWatDay, lateHour, sweepWindow, toWatDate } from '../src/time';
import { normalizePhone } from '../src/phone';

describe('money', () => {
  it('parses naira strings and numbers into kobo exactly', () => {
    expect(parseNaira('45000.00')).toBe(4_500_000n);
    expect(parseNaira(900.5)).toBe(90_050n);
    expect(parseNaira('0.01')).toBe(1n);
    expect(parseNaira('7')).toBe(700n);
  });

  it('rejects sub-kobo precision, negatives, exponents and junk', () => {
    for (const bad of ['1.234', '-5', '1e3', 'abc', '', ' ', NaN, Infinity, null, undefined, {}]) {
      expect(() => parseNaira(bad as unknown)).toThrow();
    }
    expect(() => parsePositiveNaira('0')).toThrow();
    expect(() => parsePositiveNaira('0.00')).toThrow();
  });

  it('formats kobo for APIs and for SMS/USSD', () => {
    expect(koboToNaira(90_050n)).toBe('900.50');
    expect(koboToNaira(5n)).toBe('0.05');
    expect(nairaDisplay(3_680_000n)).toBe('N36,800');
    expect(nairaDisplay(3_680_050n)).toBe('N36,800.50');
    expect(nairaDisplay(0n)).toBe('N0');
  });

  it('round-trips Postgres NUMERIC strings', () => {
    expect(dbToKobo('45000.00')).toBe(4_500_000n);
    expect(dbToKobo('0.50')).toBe(50n);
    expect(dbToKobo(null)).toBe(0n);
    expect(koboToNaira(dbToKobo('12345678901234.56'))).toBe('12345678901234.56');
  });

  it('computes percentages with floor rounding and no float error', () => {
    expect(percentOf(4_500_000n, rateToHundredths('2.00'))).toBe(90_000n); // N45,000 @ 2% = N900
    expect(percentOf(3_500_000n, rateToHundredths(2))).toBe(70_000n);
    expect(percentOf(1_234_567n, rateToHundredths('2.50'))).toBe(30_864n); // floor(30864.175)
    expect(percentOf(0n, rateToHundredths(5))).toBe(0n);
    expect(rateDisplay(250n)).toBe('2.5');
    expect(rateDisplay(200n)).toBe('2');
    expect(rateDisplay(125n)).toBe('1.25');
  });
});

describe('time (WAT)', () => {
  it('maps instants to WAT calendar dates', () => {
    expect(toWatDate(new Date('2026-11-06T22:59:59Z'))).toBe('2026-11-06');
    expect(toWatDate(new Date('2026-11-06T23:00:00Z'))).toBe('2026-11-07'); // 00:00 WAT
  });

  it('builds the PRD v2 sweep window: 00:00 to 23:00 WAT of the sweep date', () => {
    const w = sweepWindow('2026-11-06');
    expect(w.from.toISOString()).toBe('2026-11-05T23:00:00.000Z'); // 00:00 WAT
    expect(w.to.toISOString()).toBe('2026-11-06T22:00:00.000Z'); // 23:00 WAT
    // The 23:00-24:00 hour is covered by no window.
    expect(lateHour('2026-11-06').from.toISOString()).toBe(w.to.toISOString());
    expect(lateHour('2026-11-06').to.toISOString()).toBe(sweepWindow('2026-11-07').from.toISOString());
  });

  it('uses the WAT calendar date as the sweep date', () => {
    expect(currentSweepDate(new Date('2026-11-06T14:00:00Z'))).toBe('2026-11-06'); // 15:00 WAT
    expect(currentSweepDate(new Date('2026-11-06T22:30:00Z'))).toBe('2026-11-06'); // 23:30 WAT
    expect(currentSweepDate(new Date('2026-11-06T23:00:00Z'))).toBe('2026-11-07'); // 00:00 WAT
  });

  it('validates dates and does date arithmetic', () => {
    expect(assertDateString('2026-11-06')).toBe('2026-11-06');
    expect(() => assertDateString('2026-02-30')).toThrow();
    expect(() => assertDateString('06/11/2026')).toThrow();
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(formatWatDay(new Date('2027-02-12T10:00:00Z'))).toBe('12 Feb 2027');
  });
});

describe('phone', () => {
  it('normalises Nigerian formats', () => {
    expect(normalizePhone('08031234567')).toBe('+2348031234567');
    expect(normalizePhone('2348031234567')).toBe('+2348031234567');
    expect(normalizePhone('+234 803 123 4567')).toBe('+2348031234567');
    expect(normalizePhone('12345')).toBeNull();
  });
});
