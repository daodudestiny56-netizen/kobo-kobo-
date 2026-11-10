import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server';
import { makeDeps, makeMerchant, makeTrader, resetDb, testPool } from './helpers';

const pool = testPool();
const deps = makeDeps(pool);
const app = buildServer(deps);
beforeEach(() => resetDb(pool));
afterAll(async () => {
  await app.close();
  await pool.end();
});

const split = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/v1/split', payload });

describe('POST /api/v1/split', () => {
  it('returns the 50/50 allocation, a PEN reference and the ledger entries', async () => {
    const m = await makeTrader(pool);
    const res = await split({ merchant_id: m.id, sweep_date: '2026-11-06', sweep_amount: '900.00' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      merchant_id: m.id,
      sweep_date: '2026-11-06',
      currency: 'NGN',
      sweep_amount: '900.00',
      allocations: { emergency_pot: '450.00', retirement_pot: '450.00' },
      pension_reference: 'PEN-20261106-000001',
      ledger_entries: [
        { account_type: 'MERCHANT_CASH', entry_type: 'DEBIT', amount: '900.00' },
        { account_type: 'EMERGENCY_POT', entry_type: 'CREDIT', amount: '450.00' },
        { account_type: 'RETIREMENT_POT', entry_type: 'CREDIT', amount: '450.00' },
      ],
    });
  });

  it('accepts a JSON number and gives the odd kobo to retirement', async () => {
    const m = await makeTrader(pool);
    const res = await split({ merchant_id: m.id, sweep_date: '2026-11-06', sweep_amount: 100.01 });
    expect(res.json().allocations).toEqual({ emergency_pot: '50.00', retirement_pot: '50.01' });
  });

  it('is idempotent: same merchant+date returns the same reference', async () => {
    const m = await makeTrader(pool);
    const a = (await split({ merchant_id: m.id, sweep_date: '2026-11-06', sweep_amount: '900.00' })).json();
    const b = (await split({ merchant_id: m.id, sweep_date: '2026-11-06', sweep_amount: '850.00' })).json();
    expect(b.pension_reference).toBe(a.pension_reference);
  });

  it.each([
    ['zero', '0'],
    ['negative', '-5'],
    ['sub-kobo', '10.005'],
    ['text', 'abc'],
    ['exponent', '1e3'],
  ])('400 INVALID_AMOUNT for %s', async (_n, amount) => {
    const m = await makeTrader(pool);
    const res = await split({ merchant_id: m.id, sweep_date: '2026-11-06', sweep_amount: amount });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_AMOUNT');
  });

  it('400 on bad date or malformed body', async () => {
    const m = await makeTrader(pool);
    expect((await split({ merchant_id: m.id, sweep_date: '2026-13-40', sweep_amount: '10' })).json().error.code).toBe('INVALID_DATE');
    const bad = await split({ merchant_id: 'not-a-uuid', sweep_date: '2026-11-06' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('404 for an unknown merchant', async () => {
    const res = await split({ merchant_id: randomUUID(), sweep_date: '2026-11-06', sweep_amount: '10' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('MERCHANT_NOT_FOUND');
  });

  it('422 when the amount is over the merchant daily cap', async () => {
    const m = await makeTrader(pool, { cap: '5000.00' });
    const res = await split({ merchant_id: m.id, sweep_date: '2026-11-06', sweep_amount: '5000.01' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('AMOUNT_EXCEEDS_DAILY_CAP');
    expect((await split({ merchant_id: m.id, sweep_date: '2026-11-06', sweep_amount: '5000.00' })).statusCode).toBe(200);
  });

  it('422 when the merchant has no RSA yet', async () => {
    const m = await makeMerchant(pool);
    const res = await split({ merchant_id: m.id, sweep_date: '2026-11-06', sweep_amount: '10' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('PENSION_ACCOUNT_MISSING');
  });

  it('409 when the sweep for that date is already resolved', async () => {
    const m = await makeTrader(pool);
    await pool.query(
      `INSERT INTO daily_sweeps (merchant_id, sweep_date, total_takings, applied_rate, sweep_amount, emergency_amount, retirement_amount, pension_reference, status)
       VALUES ($1,'2026-11-06',45000,2,900,450,450,'PEN-20261106-000009','EXECUTED')`,
      [m.id],
    );
    const res = await split({ merchant_id: m.id, sweep_date: '2026-11-06', sweep_amount: '900.00' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SWEEP_ALREADY_EXECUTED');
  });
});

describe('POST /api/v1/pfa/rsa-pin', () => {
  it('issues an RSA PIN (201) then returns the same one (200)', async () => {
    const m = await makeMerchant(pool);
    const first = await app.inject({ method: 'POST', url: '/api/v1/pfa/rsa-pin', payload: { merchant_id: m.id } });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ merchant_id: m.id, pfa: 'Access ARM Pensions', pfa_code: 'ACCESS_ARM', created: true });
    expect(first.json().rsa_pin).toMatch(/^PEN\d{12}$/);
    const second = await app.inject({ method: 'POST', url: '/api/v1/pfa/rsa-pin', payload: { merchant_id: m.id } });
    expect(second.statusCode).toBe(200);
    expect(second.json().rsa_pin).toBe(first.json().rsa_pin);
    expect(second.json().created).toBe(false);
  });

  it('404 for an unknown merchant', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/pfa/rsa-pin', payload: { merchant_id: randomUUID() } });
    expect(res.statusCode).toBe(404);
  });
});

describe('service token', () => {
  it('guards internal routes when SERVICE_TOKEN is set, but not /health', async () => {
    const guarded = buildServer(makeDeps(pool, { config: { serviceToken: 's3cret' } }));
    const m = await makeTrader(pool);
    const payload = { merchant_id: m.id, sweep_date: '2026-11-06', sweep_amount: '10' };
    const no = await guarded.inject({ method: 'POST', url: '/api/v1/split', payload });
    expect(no.statusCode).toBe(401);
    const wrong = await guarded.inject({ method: 'POST', url: '/api/v1/split', payload, headers: { authorization: 'Bearer nope' } });
    expect(wrong.statusCode).toBe(401);
    const ok = await guarded.inject({ method: 'POST', url: '/api/v1/split', payload, headers: { authorization: 'Bearer s3cret' } });
    expect(ok.statusCode).toBe(200);
    expect((await guarded.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    await guarded.close();
  });
});
