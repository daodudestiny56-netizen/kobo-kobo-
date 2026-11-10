import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/server';
import { loadConfig } from '../src/config';
import { SimulatedBank } from '../src/bank/simulated';
import { makeDeps, fundedMerchant, AFTER_CUTOFF, DATE, T0 } from './helpers';
import { recordInflow } from '../src/inflows/service';
import { pots } from '../src/ledger/ledger';

const N = (n: number) => BigInt(n) * 100n;
const json = (r: { body: string }) => JSON.parse(r.body);

function setup(env: Record<string, string> = {}, now = T0) {
  const deps = makeDeps({ now, config: loadConfig({ LOG_LEVEL: 'silent', OPS_TOKEN: 'ops-secret', ...env }) });
  return { deps, app: buildServer(deps) };
}
const ops = { authorization: 'Bearer ops-secret' };

describe('recordInflow', () => {
  it('is idempotent on event id and bank reference', () => {
    const { deps } = setup();
    const m = fundedMerchant(deps);
    const a = recordInflow(deps, { merchantId: m.id, amount: N(100), eventId: 'E1', bankReference: 'R1' });
    const b = recordInflow(deps, { merchantId: m.id, amount: N(100), eventId: 'E1', bankReference: 'R1' });
    const c = recordInflow(deps, { merchantId: m.id, amount: N(100), eventId: 'E2', bankReference: 'R1' });
    expect([a.duplicate, b.duplicate, c.duplicate]).toEqual([false, true, true]);
    expect(deps.db.prepare('SELECT COUNT(*) n FROM inflows').get()).toEqual({ n: 1 });
  });
  it('rejects zero and unknown traders', () => {
    const { deps } = setup();
    const m = fundedMerchant(deps);
    expect(() => recordInflow(deps, { merchantId: m.id, amount: 0n })).toThrow();
    expect(() => recordInflow(deps, { merchantId: crypto.randomUUID(), amount: N(1) })).toThrow(/No such merchant/);
  });
});

describe('API', () => {
  it('onboards, summarises, patches settings and hides the full account number', async () => {
    const { app } = setup();
    const r = await app.inject({ method: 'POST', url: '/api/v1/merchants', payload: { phone: '08031234567', full_name: 'Test Trader', bvn: '22200000001', bank_account: '0123456789', language: 'pidgin' } });
    expect(r.statusCode).toBe(201);
    const { merchant } = json(r).data;
    expect(merchant.bank_account_masked).toBe('****6789');
    expect(r.body).not.toContain('0123456789');
    const id = merchant.id;
    const s = json(await app.inject({ url: `/api/v1/merchants/${id}/summary` })).data;
    expect(s).toMatchObject({ paused: false, estimated_sweep: 0, pots: { total: 0 }, eligibility: { eligible: false } });
    const p = await app.inject({ method: 'PATCH', url: `/api/v1/merchants/${id}/settings`, payload: { rate_bps: 350, paused: true, pause_hours: 48 } });
    expect(json(p).data.merchant).toMatchObject({ rate_bps: 350 });
    expect(json(p).data.merchant.paused_until).toBeTruthy();
    const bad = await app.inject({ method: 'PATCH', url: `/api/v1/merchants/${id}/settings`, payload: { rate_bps: 900 } });
    expect(bad.statusCode).toBe(400);
    const unknownField = await app.inject({ method: 'PATCH', url: `/api/v1/merchants/${id}/settings`, payload: { bank_account: '1' } });
    expect(unknownField.statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/v1/merchants', payload: { phone: '08031234567', full_name: 'Dup', bvn: '22200000002', bank_account: '0123456780' } })).statusCode).toBe(409);
  });

  it('USSD and SMS endpoints take JSON and form bodies', async () => {
    const { app, deps } = setup();
    const m = fundedMerchant(deps);
    const u = await app.inject({ method: 'POST', url: '/api/v1/ussd', payload: { sessionId: 's1', phoneNumber: m.phone, text: '' } });
    expect(u.headers['content-type']).toMatch(/text\/plain/);
    expect(u.body).toMatch(/^CON Kobo Kobo/);
    const f = await app.inject({ method: 'POST', url: '/api/v1/ussd', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: `phoneNumber=${encodeURIComponent(m.phone)}&text=1` });
    expect(f.body).toMatch(/^CON .*Balance/);
    const s = await app.inject({ method: 'POST', url: '/api/v1/sms/inbound', payload: { from: m.phone, text: 'HELP' } });
    expect(json(s).reply).toBeTruthy();
    expect((await app.inject({ method: 'POST', url: '/api/v1/sms/inbound', payload: { from: m.phone } })).statusCode).toBe(400);
  });

  it('withdrawals: a refusal is 200 accepted:false with the channel sentence', async () => {
    const { app, deps } = setup();
    const m = fundedMerchant(deps);
    const r = await app.inject({ method: 'POST', url: '/api/v1/withdrawals', payload: { merchant_id: m.id, amount_naira: '500' } });
    expect(r.statusCode).toBe(200);
    expect(json(r).data).toMatchObject({ accepted: false });
    expect(json(r).data.message).toBeTruthy();
  });

  it('ops endpoints need the token', async () => {
    const { app } = setup();
    for (const [method, url] of [['GET', '/api/v1/ops/alerts'], ['GET', '/api/v1/ops/reconciliation'], ['POST', '/api/v1/ops/sweeps/run']] as const) {
      expect((await app.inject({ method, url })).statusCode, url).toBe(401);
      expect((await app.inject({ method, url, headers: { authorization: 'Bearer wrong' } })).statusCode, url).toBe(401);
    }
    expect((await app.inject({ url: '/api/v1/ops/alerts', headers: ops })).statusCode).toBe(200);
  });

  it('demo inflow, run sweep early, reconcile: the whole nightly path over HTTP', async () => {
    const { app, deps } = setup({}, T0); // 10:00 WAT: the customer pays inside the window
    const m = fundedMerchant(deps, { dailyCap: N(100_000) });
    const paid = await app.inject({ method: 'POST', url: '/api/v1/demo/inflow', headers: ops, payload: { phone: m.phone, amount_naira: 50000 } });
    expect(paid.statusCode).toBe(201);
    deps.setNow(new Date(AFTER_CUTOFF.getTime() + 60_000));
    const run = await app.inject({ method: 'POST', url: '/api/v1/ops/sweeps/run', headers: ops, payload: { as_of: DATE, allow_early: true } });
    expect(json(run).data).toMatchObject({ sweep_date: DATE, merchants: 1, by_status: { SETTLED: 1 } });
    expect(pots(deps.db, m.id).total).toBe(N(1000));
    const rec = json(await app.inject({ url: '/api/v1/ops/reconciliation', headers: ops })).data;
    expect(rec).toMatchObject({ ok: true, ledger: { problems: [], pot_difference: 0 } });
    const list = json(await app.inject({ url: `/api/v1/ops/sweeps?date=${DATE}`, headers: ops })).data.sweeps;
    expect(list).toHaveLength(1);
    const msgs = json(await app.inject({ url: `/api/v1/merchants/${m.id}/messages` })).data.messages;
    expect(msgs.some((x: any) => x.kind === 'SWEEP_RECEIPT' || /1,000/.test(x.body))).toBe(true);
  });

  it('refuses an early run without allow_early', async () => {
    const { app } = setup();
    const r = await app.inject({ method: 'POST', url: '/api/v1/ops/sweeps/run', headers: ops, payload: { as_of: DATE } });
    expect(r.statusCode).toBe(409);
    expect(json(r).error.code).toBe('WINDOW_STILL_OPEN');
  });

  it('demo routes vanish outside demo mode and the clock endpoint works inside it', async () => {
    const off = setup({ DEMO_MODE: 'false' });
    expect((await off.app.inject({ method: 'POST', url: '/api/v1/demo/clock', headers: ops, payload: { offset_days: 5 } })).statusCode).toBe(404);
    const on = setup();
    expect(json(await on.app.inject({ method: 'POST', url: '/api/v1/demo/clock', headers: ops, payload: { offset_days: 100 } })).data.offset_days).toBe(100);
    expect(json(await on.app.inject({ url: '/api/v1/demo/clock', headers: ops })).data.offset_days).toBe(100);
  });

  it('no ops token is open only outside production', async () => {
    const dev = setup({ OPS_TOKEN: '' });
    expect((await dev.app.inject({ url: '/api/v1/ops/alerts' })).statusCode).toBe(200);
    const prod = setup({ OPS_TOKEN: '', NODE_ENV: 'production' });
    expect((await prod.app.inject({ url: '/api/v1/ops/alerts' })).statusCode).toBe(401);
  });

  it('ops can create a suggestion; the trader accepts it over the API', async () => {
    const { app, deps } = setup();
    const m = fundedMerchant(deps);
    const c = await app.inject({ method: 'POST', url: '/api/v1/ops/suggestions', headers: ops, payload: { merchant_id: m.id, suggested_bps: 300, reason: 'steady takings' } });
    expect(c.statusCode).toBe(201);
    const s = json(await app.inject({ url: `/api/v1/merchants/${m.id}/summary` })).data;
    expect(s.open_suggestion).toMatchObject({ suggested_bps: 300 });
    const r = await app.inject({ method: 'POST', url: `/api/v1/merchants/${m.id}/suggestion/respond`, payload: { decision: 'accept' } });
    expect(json(r).data).toMatchObject({ outcome: 'ACCEPTED', bps: 300 });
    expect((await app.inject({ method: 'POST', url: `/api/v1/merchants/${m.id}/suggestion/respond`, payload: { decision: 'accept' } })).statusCode).toBe(404);
  });
});
