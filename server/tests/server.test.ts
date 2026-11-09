import { describe, expect, it } from 'vitest';
import { loadConfig, productionProblems } from '../src/config';
import { openDb } from '../src/db';
import { buildServer } from '../src/server';
import { sweepWindow, sweepDateOf, sweepCutoff } from '../src/time';

const mk = () => buildServer({ db: openDb(), config: loadConfig({ LOG_LEVEL: 'silent' }), clock: () => new Date() });

describe('server', () => {
  it('answers /healthz with 200', async () => {
    const r = await mk().inject('/healthz');
    expect(r.statusCode).toBe(200);
  });
  it('refuses to boot in production without an ops token', () => {
    expect(productionProblems(loadConfig({ NODE_ENV: 'production' }))).toHaveLength(1);
    expect(productionProblems(loadConfig({ NODE_ENV: 'production', OPS_TOKEN: 'x' }))).toHaveLength(0);
  });
});

describe('rolling sweep window (PRD v3 6.1)', () => {
  it('runs from the previous 23:00 WAT to this 23:00 WAT', () => {
    const w = sweepWindow('2026-11-13');
    expect(w.from.toISOString()).toBe('2026-11-12T22:00:00.000Z');
    expect(w.to.toISOString()).toBe('2026-11-13T22:00:00.000Z');
  });
  it('puts a 23:30 WAT credit in the next sweep, with nothing lost between windows', () => {
    const late = new Date('2026-11-13T22:30:00Z'); // 23:30 WAT on the 13th
    expect(sweepDateOf(late)).toBe('2026-11-14');
    expect(sweepDateOf(new Date(sweepCutoff('2026-11-13').getTime() - 1))).toBe('2026-11-13');
    expect(sweepDateOf(sweepCutoff('2026-11-13'))).toBe('2026-11-14');
  });
});
