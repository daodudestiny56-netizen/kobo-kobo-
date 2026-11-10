import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server';
import { createSuggestion, expireStaleSuggestions, getPendingSuggestion, respondToSuggestion } from '../src/smart-rate/service';
import { executeSweepForMerchant } from '../src/sweeps/service';
import { addDaysToInstant } from '../src/time';
import { addInflow, DAY, DURING, makeDeps, makeTrader, resetDb, testPool } from './helpers';

const pool = testPool();
let deps: ReturnType<typeof makeDeps>;
let app: ReturnType<typeof buildServer>;
beforeEach(async () => {
  await resetDb(pool);
  deps = makeDeps(pool, { now: DURING });
  app = buildServer(deps);
});
afterAll(() => pool.end());

const rate = async (id: string) => (await pool.query('SELECT sweep_percentage::text r FROM merchants WHERE id=$1', [id])).rows[0].r;
const sms = (phone: string, text: string) => app.inject({ method: 'POST', url: '/api/v1/sms/inbound', payload: { from: phone, text } }).then((r) => r.json().reply as string);
const code = (p: Promise<unknown>) => p.then(() => 'OK', (e) => e.code as string);
const outbox = async () => (await pool.query("SELECT body FROM sms_outbox WHERE kind = 'SMART_RATE' ORDER BY created_at, body")).rows.map((r) => r.body as string);

describe('Smart Rate suggestions', () => {
  it('suggesting texts the trader and changes NOTHING', async () => {
    const m = await makeTrader(pool, { rate: '2.00' });
    const s = await createSuggestion(deps, { merchantId: m.id, suggestedRate: 300n, reason: 'steady 8-week takings' });
    expect(s).toMatchObject({ status: 'PENDING', currentRate: 200n, suggestedRate: 300n, reason: 'steady 8-week takings' });
    expect(await rate(m.id)).toBe('2.00');
    expect(await outbox()).toEqual([expect.stringMatching(/from 2% to 3%.*Reply YES.*Nothing changes unless you reply YES/)]);
    expect(s.expiresAt).toEqual(new Date(DURING.getTime() + 72 * 3_600_000));
  });

  it('the suggested rate does not reach the nightly sweep until confirmed', async () => {
    const m = await makeTrader(pool, { rate: '2.00' });
    await addInflow(pool, m.id, '45000.00', DURING);
    deps.executor.setBalance(m.access_nuban, 100_000_000n);
    await createSuggestion(deps, { merchantId: m.id, suggestedRate: 400n });
    deps.setNow(new Date('2026-11-06T22:30:00Z'));
    const rec = await executeSweepForMerchant(deps, m.id, DAY);
    expect(rec.sweepAmount).toBe(90_000n); // 2% of N45,000, not 4%
  });

  it('SMS YES applies the rate; the next sweep uses it', async () => {
    const m = await makeTrader(pool, { rate: '2.00' });
    await createSuggestion(deps, { merchantId: m.id, suggestedRate: 350n });
    expect(await sms(m.phone_number, 'yes')).toBe('Kobo Kobo: Done. Your sweep rate is now 3.5% from the next nightly sweep. Text RATE 2 anytime to change it.');
    expect(await rate(m.id)).toBe('3.50');
    expect((await pool.query("SELECT status, responded_via FROM rate_suggestions")).rows).toEqual([{ status: 'ACCEPTED', responded_via: 'SMS' }]);
    expect(await sms(m.phone_number, 'YES')).toMatch(/no rate suggestion waiting/); // cannot be replayed
    expect(await rate(m.id)).toBe('3.50');
  });

  it('SMS NO keeps the rate and starts a cooldown before the next suggestion', async () => {
    const m = await makeTrader(pool, { rate: '2.00' });
    await createSuggestion(deps, { merchantId: m.id, suggestedRate: 300n });
    expect(await sms(m.phone_number, 'NO')).toBe('Kobo Kobo: No problem. Your sweep rate stays at 2%.');
    expect(await rate(m.id)).toBe('2.00');
    expect(await code(createSuggestion(deps, { merchantId: m.id, suggestedRate: 300n }))).toBe('SUGGESTION_COOLDOWN');
    deps.setNow(addDaysToInstant(DURING, 15));
    expect(await code(createSuggestion(deps, { merchantId: m.id, suggestedRate: 300n }))).toBe('OK');
  });

  it('YES or NO with nothing open changes nothing', async () => {
    const m = await makeTrader(pool, { rate: '2.00' });
    expect(await sms(m.phone_number, 'YES')).toMatch(/no rate suggestion waiting/);
    expect(await sms(m.phone_number, 'NO')).toMatch(/no rate suggestion waiting/);
    expect(await rate(m.id)).toBe('2.00');
  });

  it('an unanswered suggestion expires after 72h and a late YES is ignored', async () => {
    const m = await makeTrader(pool, { rate: '2.00' });
    await createSuggestion(deps, { merchantId: m.id, suggestedRate: 300n });
    deps.setNow(new Date(DURING.getTime() + 72 * 3_600_000 + 1000));
    expect(await sms(m.phone_number, 'YES')).toMatch(/no rate suggestion waiting/);
    expect(await rate(m.id)).toBe('2.00');
    expect((await pool.query('SELECT status FROM rate_suggestions')).rows).toEqual([{ status: 'EXPIRED' }]);
    expect(await code(createSuggestion(deps, { merchantId: m.id, suggestedRate: 300n }))).toBe('OK'); // an expired one does not block a new one
  });

  it('the scheduler tick expires stale suggestions', async () => {
    const m = await makeTrader(pool);
    await createSuggestion(deps, { merchantId: m.id, suggestedRate: 300n });
    expect(await expireStaleSuggestions(deps)).toBe(0);
    deps.setNow(new Date(DURING.getTime() + 73 * 3_600_000));
    expect(await expireStaleSuggestions(deps)).toBe(1);
    expect(await getPendingSuggestion(deps, m.id)).toBeNull();
  });

  it('a rate the trader sets themselves supersedes the open suggestion, so a later YES cannot undo it', async () => {
    const m = await makeTrader(pool, { rate: '2.00' });
    await createSuggestion(deps, { merchantId: m.id, suggestedRate: 400n });
    await sms(m.phone_number, 'RATE 1');
    expect(await rate(m.id)).toBe('1.00');
    expect(await sms(m.phone_number, 'YES')).toMatch(/no rate suggestion waiting/);
    expect(await rate(m.id)).toBe('1.00');
    expect((await pool.query('SELECT status FROM rate_suggestions')).rows).toEqual([{ status: 'SUPERSEDED' }]);
  });

  it('guard rails: range, same rate, one open suggestion, unknown merchant', async () => {
    const m = await makeTrader(pool, { rate: '2.00' });
    expect(await code(createSuggestion(deps, { merchantId: m.id, suggestedRate: 600n }))).toBe('INVALID_RATE');
    expect(await code(createSuggestion(deps, { merchantId: m.id, suggestedRate: 50n }))).toBe('INVALID_RATE');
    expect(await code(createSuggestion(deps, { merchantId: m.id, suggestedRate: 200n }))).toBe('RATE_UNCHANGED');
    await createSuggestion(deps, { merchantId: m.id, suggestedRate: 300n });
    expect(await code(createSuggestion(deps, { merchantId: m.id, suggestedRate: 400n }))).toBe('SUGGESTION_PENDING');
    expect(await code(createSuggestion(deps, { merchantId: '00000000-0000-4000-8000-000000000000', suggestedRate: 300n }))).toBe('MERCHANT_NOT_FOUND');
  });

  it('only one trader is affected: YES from another number does nothing to this one', async () => {
    const a = await makeTrader(pool, { rate: '2.00' });
    const b = await makeTrader(pool, { rate: '2.00' });
    await createSuggestion(deps, { merchantId: a.id, suggestedRate: 300n });
    expect(await sms(b.phone_number, 'YES')).toMatch(/no rate suggestion waiting/);
    expect(await rate(a.id)).toBe('2.00');
    expect(await rate(b.id)).toBe('2.00');
  });

  it('Pidgin copy', async () => {
    const m = await makeTrader(pool, { rate: '2.00', language: 'pidgin' });
    await createSuggestion(deps, { merchantId: m.id, suggestedRate: 300n });
    expect((await outbox())[0]).toMatch(/Your sales don dey steady.*Reply YES if you gree/);
    expect(await sms(m.phone_number, 'YES')).toMatch(/E don do. Your sweep rate na 3%/);
  });
});

describe('Smart Rate over HTTP (AI service and PWA)', () => {
  it('create -> read -> accept in app, with an SMS confirmation', async () => {
    const m = await makeTrader(pool, { rate: '2.00' });
    const created = await app.inject({ method: 'POST', url: '/api/v1/smart-rate/suggestions', payload: { merchant_id: m.id, suggested_rate: '3', reason: 'stable' } });
    expect(created.statusCode).toBe(201);
    const id = created.json().suggestion_id;
    expect(created.json()).toMatchObject({ current_rate: '2', suggested_rate: '3', status: 'PENDING' });
    expect((await app.inject({ method: 'GET', url: `/api/v1/merchants/${m.id}/smart-rate` })).json().suggestion.suggestion_id).toBe(id);

    const wrong = await app.inject({ method: 'POST', url: `/api/v1/smart-rate/suggestions/00000000-0000-4000-8000-000000000000/respond`, payload: { merchant_id: m.id, decision: 'ACCEPT' } });
    expect(wrong.statusCode).toBe(409);
    const ok = await app.inject({ method: 'POST', url: `/api/v1/smart-rate/suggestions/${id}/respond`, payload: { merchant_id: m.id, decision: 'ACCEPT' } });
    expect(ok.json()).toMatchObject({ status: 'ACCEPTED', responded_via: 'APP', sweep_percentage: '3' });
    expect(await rate(m.id)).toBe('3.00');
    expect((await app.inject({ method: 'GET', url: `/api/v1/merchants/${m.id}/smart-rate` })).json()).toEqual({ suggestion: null });
    expect((await outbox()).some((b) => b.includes('Done. Your sweep rate is now 3%'))).toBe(true);
    // answering twice is a conflict, not a second change
    const again = await app.inject({ method: 'POST', url: `/api/v1/smart-rate/suggestions/${id}/respond`, payload: { merchant_id: m.id, decision: 'DECLINE' } });
    expect(again.statusCode).toBe(409);
  });

  it('validates input and maps errors', async () => {
    const m = await makeTrader(pool, { rate: '2.00' });
    const post = (b: object) => app.inject({ method: 'POST', url: '/api/v1/smart-rate/suggestions', payload: b });
    expect((await post({ merchant_id: m.id, suggested_rate: '9' })).statusCode).toBe(400);
    expect((await post({ merchant_id: m.id, suggested_rate: 'abc' })).statusCode).toBe(400);
    expect((await post({ merchant_id: 'x', suggested_rate: '3' })).statusCode).toBe(400);
    expect((await post({ merchant_id: m.id, suggested_rate: '2' })).statusCode).toBe(422);
    expect((await post({ merchant_id: m.id, suggested_rate: '3' })).statusCode).toBe(201);
    expect((await post({ merchant_id: m.id, suggested_rate: '4' })).statusCode).toBe(409);
  });

  it('respondToSuggestion is atomic: the rate and the status move together', async () => {
    const m = await makeTrader(pool, { rate: '2.00' });
    await createSuggestion(deps, { merchantId: m.id, suggestedRate: 300n });
    const results = await Promise.all([1, 2, 3].map(() => respondToSuggestion(deps, { merchantId: m.id, decision: 'ACCEPT', via: 'SMS' })));
    expect(results.filter((r) => r.outcome === 'ACCEPTED')).toHaveLength(1);
    expect(await rate(m.id)).toBe('3.00');
  });
});
