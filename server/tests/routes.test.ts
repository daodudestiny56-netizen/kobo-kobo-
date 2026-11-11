import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/server';
import { loadConfig } from '../src/config';
import { makeDeps, fundedMerchant, AFTER_CUTOFF, DATE, T0 } from './helpers';
import { recordInflow } from '../src/inflows/service';
import { pots } from '../src/ledger/ledger';
import { setOffsetDays } from '../src/demo/clock';

const N = (n: number) => BigInt(n) * 100n;
const json = (r: { body: string }) => JSON.parse(r.body);
const data = (r: { body: string }) => json(r).data;

function setup(env: Record<string, string> = {}, now = T0) {
  const deps = makeDeps({ now, config: loadConfig({ LOG_LEVEL: 'silent', OPS_TOKEN: 'ops-secret', ...env }) });
  return { deps, app: buildServer(deps) };
}
const ops = { authorization: 'Bearer ops-secret' };
const A = '/api/v1';

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

describe('web contract (what web/src/lib/api/types.ts reads)', () => {
  it('sign-up helpers: OTP, identity, demo traders and sign-in', async () => {
    const { app } = setup();
    expect(data(await app.inject({ url: `${A}/demo/traders` }))).toHaveLength(4);
    expect((await app.inject({ method: 'POST', url: `${A}/auth/verify-otp`, payload: { phone: '+2348000000001', code: '000000' } })).statusCode).toBe(401);
    expect(data(await app.inject({ method: 'POST', url: `${A}/auth/verify-otp`, payload: { phone: '+2348000000001', code: '123456' } }))).toEqual({ merchantId: null });
    const r = await app.inject({ method: 'POST', url: `${A}/demo/sign-in`, payload: { account: '0123456789' } });
    const m = data(r);
    expect(m).toMatchObject({ fullName: 'Adaeze Chiamaka Okonkwo', bankAccount: '0123456789', language: 'pidgin', rateBps: 200, status: 'ACTIVE', pausedUntil: null });
    expect(m.rsaPin).toMatch(/^PEN\d{12}$/);
    expect(data(await app.inject({ method: 'POST', url: `${A}/demo/sign-in`, payload: { account: '0123456789' } })).id).toBe(m.id); // idempotent
    expect(data(await app.inject({ method: 'POST', url: `${A}/auth/verify-otp`, payload: { phone: '08000000001', code: '123456' } })).merchantId).toBe(m.id);
    expect((await app.inject({ method: 'POST', url: `${A}/demo/sign-in`, payload: { account: '0000000000' } })).statusCode).toBe(404);
    expect((await app.inject({ url: `${A}/identity/resolve?account=0123456789` })).statusCode).toBe(200);
    expect((await app.inject({ url: `${A}/identity/resolve?account=12` })).statusCode).toBe(400);
  });

  it('summary has every field the home screen reads, and money is integer kobo', async () => {
    const { app, deps } = setup();
    const m = fundedMerchant(deps, { dailyCap: N(100_000) });
    recordInflow(deps, { merchantId: m.id, amount: N(50_000), bankReference: 'S1' });
    const s = data(await app.inject({ url: `${A}/merchants/${m.id}/summary` }));
    expect(Object.keys(s).sort()).toEqual(['account', 'balanceSeries', 'bankBalanceKobo', 'clockOffsetDays', 'emergencyKobo', 'expectedSweepKobo', 'heldKobo', 'merchant', 'recent', 'retirementKobo', 'series', 'smartRate', 'stats', 'todayTakingsKobo', 'withdrawal'].sort());
    expect(s).toMatchObject({ todayTakingsKobo: 5_000_000, expectedSweepKobo: 100_000, emergencyKobo: 0, retirementKobo: 0, smartRate: null });
    expect(s.withdrawal.eligible).toBe(false);
    expect(s.withdrawal.maxKobo).toBe(0);
    expect(typeof s.withdrawal.reason).toBe('string');
    expect(s.series).toHaveLength(30);
    expect(s.balanceSeries).toHaveLength(90);
    expect(s.series[29].takingsKobo).toBe(5_000_000); // today shows what is waiting for tonight
    expect(Object.keys(s.stats).sort()).toEqual(['avgSales30Kobo', 'bestDay', 'memberSince', 'nightsSaved30', 'savedAllTimeKobo', 'savedThisMonthKobo']);
    expect(s.account).toMatchObject({ bankName: 'Access Bank', number: m.bankAccount });
  });

  it('settings: rate, pause (0 resumes), cancel and reactivate, each returning the summary', async () => {
    const { app, deps } = setup();
    const m = fundedMerchant(deps);
    const patch = (payload: object) => app.inject({ method: 'PATCH', url: `${A}/merchants/${m.id}/settings`, payload });
    let s = data(await patch({ rateBps: 350 }));
    expect(s.merchant.rateBps).toBe(350);
    s = data(await patch({ pauseHours: 48 }));
    expect(typeof s.merchant.pausedUntil).toBe('number');
    expect(s.merchant.pausedUntil).toBeGreaterThan(T0.getTime());
    s = data(await patch({ pauseHours: 0 }));
    expect(s.merchant.pausedUntil).toBeNull();
    expect((await patch({ rateBps: 900 })).statusCode).toBe(400);
    expect((await patch({ bankAccount: '1' })).statusCode).toBe(400);
    s = data(await patch({ cancel: true }));
    expect(s.merchant.status).toBe('CANCELLED');
    expect((await patch({ rateBps: 300 })).statusCode).toBe(409);
    s = data(await patch({ reactivate: true, rateBps: 300 }));
    expect(s.merchant).toMatchObject({ status: 'ACTIVE', rateBps: 300 });
  });

  it('feed and activity list payments, savings and withdrawals newest first', async () => {
    const { app, deps } = setup({}, T0);
    const m = fundedMerchant(deps, { dailyCap: N(100_000) });
    recordInflow(deps, { merchantId: m.id, amount: N(50_000), bankReference: 'F1' });
    deps.setNow(new Date(AFTER_CUTOFF.getTime() + 60_000));
    await app.inject({ method: 'POST', url: `${A}/ops/sweeps/run`, headers: ops, payload: { allowEarly: true, merchantId: m.id } });
    const feed = data(await app.inject({ url: `${A}/merchants/${m.id}/feed` }));
    expect(feed.map((f: any) => f.kind)).toEqual(['saving', 'sale']);
    expect(feed[0]).toMatchObject({ amountKobo: -100_000, status: 'completed' });
    expect(feed[1]).toMatchObject({ amountKobo: 5_000_000 });
    const act = data(await app.inject({ url: `${A}/merchants/${m.id}/activity` }));
    expect(act).toHaveLength(1);
    expect(act[0]).toMatchObject({ status: 'SETTLED', sweepKobo: 100_000, emergencyKobo: 50_000, retirementKobo: 50_000, merchantName: m.fullName });
    expect(act[0].pensionReference).toMatch(/^PEN-/);
  });

  it('USSD returns { type, body }; SMS returns { reply }; form bodies work', async () => {
    const { app, deps } = setup();
    const m = fundedMerchant(deps);
    const u = data(await app.inject({ method: 'POST', url: `${A}/ussd`, payload: { sessionId: 's1', phoneNumber: m.phone, text: '' } }));
    expect(u.type).toBe('CON');
    expect(u.body).toMatch(/^Kobo Kobo/);
    const f = data(await app.inject({ method: 'POST', url: `${A}/ussd`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: `phoneNumber=${encodeURIComponent(m.phone)}&text=1` }));
    expect(f.body).toMatch(/Balance/);
    const raw = await app.inject({ method: 'POST', url: `${A}/ussd?format=text`, payload: { phoneNumber: m.phone, text: '' } });
    expect(raw.headers['content-type']).toMatch(/text\/plain/);
    expect(raw.body).toMatch(/^CON /);
    expect(data(await app.inject({ method: 'POST', url: `${A}/sms/inbound`, payload: { from: m.phone, text: 'HELP' } })).reply).toBeTruthy();
    expect((await app.inject({ method: 'POST', url: `${A}/sms/inbound`, payload: { from: m.phone } })).statusCode).toBe(400);
  });

  it('withdrawals: a refusal is 200 ok:false with the channel sentence; the retirement pot is always refused', async () => {
    const { app, deps } = setup();
    const m = fundedMerchant(deps);
    const r = await app.inject({ method: 'POST', url: `${A}/withdrawals`, payload: { merchantId: m.id, amountKobo: 50_000 } });
    expect(r.statusCode).toBe(200);
    expect(data(r).ok).toBe(false);
    expect(data(r).message).toBeTruthy();
    const ret = data(await app.inject({ method: 'POST', url: `${A}/withdrawals`, payload: { merchantId: m.id, amountKobo: 50_000, pot: 'RETIREMENT' } }));
    expect(ret.ok).toBe(false);
    expect(ret.message).toMatch(/50/);
    expect((await app.inject({ method: 'POST', url: `${A}/withdrawals`, payload: { merchantId: m.id } })).statusCode).toBe(400);
  });

  it('a vested trader can withdraw over the API', async () => {
    const { app, deps } = setup({}, T0);
    const m = fundedMerchant(deps, { dailyCap: N(100_000) });
    recordInflow(deps, { merchantId: m.id, amount: N(50_000), bankReference: 'W1' });
    deps.setNow(new Date(AFTER_CUTOFF.getTime() + 60_000));
    await app.inject({ method: 'POST', url: `${A}/ops/sweeps/run`, headers: ops, payload: { allowEarly: true } });
    setOffsetDays(deps.db, 100);
    const s = data(await app.inject({ url: `${A}/merchants/${m.id}/summary` }));
    expect(s.withdrawal).toMatchObject({ eligible: true, maxKobo: 50_000 });
    expect(s.clockOffsetDays).toBe(100);
    const r = data(await app.inject({ method: 'POST', url: `${A}/withdrawals`, payload: { merchantId: m.id, amountKobo: 10_000 } }));
    expect(r.ok).toBe(true);
    expect(pots(deps.db, m.id).emergency).toBe(40_000n);
    const feed = data(await app.inject({ url: `${A}/merchants/${m.id}/feed` }));
    expect(feed.some((f: any) => f.kind === 'withdrawal' && f.amountKobo === 10_000)).toBe(true);
  });

  it('ops overview, run, requery and alert resolution use the dashboard shapes', async () => {
    const { app, deps } = setup({ GUARD_HOLD_ABOVE_NAIRA: '100000' }, T0);
    const { ThresholdGuard } = await import('../src/guard/port');
    deps.guard = new ThresholdGuard(N(100_000));
    const m = fundedMerchant(deps, { dailyCap: N(100_000) });
    recordInflow(deps, { merchantId: m.id, amount: N(50_000), bankReference: 'O1' });
    recordInflow(deps, { merchantId: m.id, amount: N(150_000), bankReference: 'O2' }); // held by the guard
    deps.setNow(new Date(AFTER_CUTOFF.getTime() + 60_000));
    const run = data(await app.inject({ method: 'POST', url: `${A}/ops/sweeps/run`, headers: ops, payload: { forceOutcome: 'none' } }));
    expect(Object.keys(run).sort()).toEqual(['alerts', 'clockOffsetDays', 'reconciliation', 'sweeps', 'totals']);
    expect(run.sweeps[0]).toMatchObject({ status: 'SETTLED', takingsKobo: 5_000_000, merchantName: m.fullName });
    expect(run.alerts).toHaveLength(1);
    expect(run.alerts[0]).toMatchObject({ type: 'ANOMALY', status: 'PENDING_REVIEW', amountKobo: 15_000_000, merchantName: m.fullName });
    expect(run.totals).toMatchObject({ merchants: 1, aumKobo: 100_000, sweptTodayKobo: 100_000 });
    expect(run.reconciliation).toEqual({ ledgerKobo: 100_000, armKobo: 100_000, diffKobo: 0 });
    const after = data(await app.inject({ method: 'POST', url: `${A}/ops/alerts/${run.alerts[0].id}/resolve`, headers: ops, payload: { decision: 'CONFIRMED' } }));
    expect(after.alerts[0].status).toBe('CONFIRMED');
    const rq = await app.inject({ method: 'POST', url: `${A}/ops/sweeps/${run.sweeps[0].id}/requery`, headers: ops });
    expect(rq.statusCode).toBe(200);
    expect(data(await app.inject({ url: `${A}/ops/merchants`, headers: ops }))).toHaveLength(1);
  });

  it('forceOutcome failed leaves a FAILED sweep with a note and no money moved', async () => {
    const { app, deps } = setup({}, T0);
    const m = fundedMerchant(deps, { dailyCap: N(100_000) });
    recordInflow(deps, { merchantId: m.id, amount: N(50_000), bankReference: 'X1' });
    deps.setNow(new Date(AFTER_CUTOFF.getTime() + 60_000));
    const run = data(await app.inject({ method: 'POST', url: `${A}/ops/sweeps/run`, headers: ops, payload: { forceOutcome: 'failed' } }));
    expect(run.sweeps[0].status).not.toBe('SETTLED');
    expect(pots(deps.db, m.id).total).toBe(0n);
    expect(data(await app.inject({ url: `${A}/ops/reconciliation`, headers: ops })).ok).toBe(true);
  });

  it('refuses an early run unless allowEarly (or demo mode, which allows it)', async () => {
    const strict = setup({ DEMO_MODE: 'false' });
    const r = await strict.app.inject({ method: 'POST', url: `${A}/ops/sweeps/run`, headers: ops, payload: { asOf: DATE } });
    expect(r.statusCode).toBe(409);
    expect(json(r).error.code).toBe('WINDOW_STILL_OPEN');
    const demo = setup({ DEMO_MODE: 'true' });
    expect((await demo.app.inject({ method: 'POST', url: `${A}/ops/sweeps/run`, headers: ops, payload: {} })).statusCode).toBe(200);
  });
});

describe('access control', () => {
  it('ops endpoints need the token, which may be sent three ways', async () => {
    const { app } = setup();
    for (const [method, url] of [['GET', `${A}/ops/overview`], ['GET', `${A}/ops/reconciliation`], ['POST', `${A}/ops/sweeps/run`]] as const) {
      expect((await app.inject({ method, url })).statusCode, url).toBe(401);
      expect((await app.inject({ method, url, headers: { authorization: 'Bearer wrong' } })).statusCode, url).toBe(401);
    }
    for (const headers of [ops, { 'x-ops-token': 'ops-secret' }, { 'x-demo-key': 'ops-secret' }]) {
      expect((await app.inject({ url: `${A}/ops/overview`, headers })).statusCode).toBe(200);
    }
  });

  it('DEMO_SECRET works as the demo key; DEMO_OPEN opens ops and demo controls without a token, in demo mode only', async () => {
    const secret = setup({ DEMO_SECRET: 'demo-secret', OPS_TOKEN: '' });
    expect((await secret.app.inject({ url: `${A}/ops/overview`, headers: { 'x-demo-key': 'demo-secret' } })).statusCode).toBe(200);
    expect((await secret.app.inject({ url: `${A}/ops/overview` })).statusCode).toBe(401);
    const open = setup({ DEMO_MODE: 'true', DEMO_OPEN: '1', NODE_ENV: 'production', BANK_API_KEY: 'x' });
    expect((await open.app.inject({ url: `${A}/ops/overview` })).statusCode).toBe(200);
    expect((await open.app.inject({ method: 'POST', url: `${A}/demo/clock`, payload: { days: 3 } })).statusCode).toBe(200);
    const notDemo = setup({ DEMO_MODE: 'false', DEMO_OPEN: '1', NODE_ENV: 'production', BANK_API_KEY: 'x' });
    expect((await notDemo.app.inject({ url: `${A}/ops/overview` })).statusCode).toBe(401);
  });

  it('no secret configured is open only outside production', async () => {
    const dev = setup({ OPS_TOKEN: '' });
    expect((await dev.app.inject({ url: `${A}/ops/overview` })).statusCode).toBe(200);
    const prod = setup({ OPS_TOKEN: '', NODE_ENV: 'production' });
    expect((await prod.app.inject({ url: `${A}/ops/overview` })).statusCode).toBe(401);
  });
});

describe('demo controls', () => {
  it('demo routes vanish outside demo mode; the clock endpoint works inside it', async () => {
    const off = setup({ DEMO_MODE: 'false' });
    expect((await off.app.inject({ url: `${A}/demo/traders` })).statusCode).toBe(404);
    expect((await off.app.inject({ method: 'POST', url: `${A}/demo/clock`, headers: ops, payload: { days: 5 } })).statusCode).toBe(404);
    const on = setup();
    expect(data(await on.app.inject({ method: 'POST', url: `${A}/demo/clock`, headers: ops, payload: { days: 100 } }))).toMatchObject({ offsetDays: 100, active: true });
    expect(data(await on.app.inject({ url: `${A}/demo/clock` })).offsetDays).toBe(100);
    expect((await on.app.inject({ method: 'POST', url: `${A}/demo/clock`, headers: ops, payload: { days: -1 } })).statusCode).toBe(400);
    expect((await on.app.inject({ method: 'POST', url: `${A}/demo/clock`, payload: { days: 5 } })).statusCode).toBe(401);
  });

  it('inflow, run, reconcile: the whole nightly path over HTTP', async () => {
    const { app, deps } = setup({}, T0);
    const m = fundedMerchant(deps, { dailyCap: N(100_000) });
    const paid = await app.inject({ method: 'POST', url: `${A}/demo/inflow`, headers: ops, payload: { merchantId: m.id, amountKobo: 5_000_000 } });
    expect(paid.statusCode).toBe(201);
    expect(data(paid).results[0].reference).toMatch(/^KOBO-IN-/);
    expect((await app.inject({ method: 'POST', url: `${A}/demo/inflow`, headers: ops, payload: { merchantId: m.id, amountKobo: 5 } })).statusCode).toBe(400);
    deps.setNow(new Date(AFTER_CUTOFF.getTime() + 60_000));
    await app.inject({ method: 'POST', url: `${A}/ops/sweeps/run`, headers: ops, payload: { allowEarly: true } });
    expect(pots(deps.db, m.id).total).toBe(N(1000));
    expect(data(await app.inject({ url: `${A}/ops/reconciliation`, headers: ops })).ok).toBe(true);
    const msgs = data(await app.inject({ url: `${A}/merchants/${m.id}/messages` })).messages;
    expect(msgs.some((x: any) => /1,000/.test(x.body))).toBe(true);
  });

  it('with a real bank connected the demo payment is a bank transfer, recorded once', async () => {
    const { app, deps } = setup({ DEMO_PAYER_ACCOUNT: '0123456793' }, T0);
    const m = fundedMerchant(deps);
    const sent: any[] = [];
    deps.bank.payIn = async (req) => {
      sent.push(req);
      return { reference: req.reference, status: 'successful', amount: req.amount, fee: 0n, vat: 0n, stampDuty: 0n, totalDebit: req.amount };
    };
    const r = await app.inject({ method: 'POST', url: `${A}/demo/inflow`, headers: ops, payload: { merchantId: m.id, amountKobo: 250_000, count: 2 } });
    expect(r.statusCode).toBe(201);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ sourceAccount: '0123456793', destinationAccount: m.bankAccount, amount: 250_000n });
    expect(deps.db.prepare('SELECT COUNT(*) n FROM inflows').get()).toEqual({ n: 2 });
    // the collector later sees the same references and must not double count
    recordInflow(deps, { merchantId: m.id, amount: 250_000n, bankReference: sent[0].reference });
    expect(deps.db.prepare('SELECT COUNT(*) n FROM inflows').get()).toEqual({ n: 2 });
  });

  it('a pending bank payment is left for the collector, not recorded twice', async () => {
    const { app, deps } = setup({}, T0);
    const m = fundedMerchant(deps);
    deps.bank.payIn = async (req) => ({ reference: req.reference, status: 'pending', amount: req.amount, fee: 0n, vat: 0n, stampDuty: 0n, totalDebit: req.amount });
    const r = await app.inject({ method: 'POST', url: `${A}/demo/inflow`, headers: ops, payload: { merchantId: m.id, amountKobo: 250_000 } });
    expect(data(r).results[0].recorded).toBe(false);
    expect(deps.db.prepare('SELECT COUNT(*) n FROM inflows').get()).toEqual({ n: 0 });
  });

  it('ops can create a suggestion; the trader accepts it over the API', async () => {
    const { app, deps } = setup();
    const m = fundedMerchant(deps);
    const c = await app.inject({ method: 'POST', url: `${A}/ops/suggestions`, headers: ops, payload: { merchantId: m.id, suggestedBps: 300, reason: 'steady takings' } });
    expect(c.statusCode).toBe(201);
    const s = data(await app.inject({ url: `${A}/merchants/${m.id}/summary` }));
    expect(s.smartRate).toEqual({ suggestedBps: 300, reason: 'steady takings' });
    const r = await app.inject({ method: 'POST', url: `${A}/merchants/${m.id}/suggestion/respond`, payload: { decision: 'accept' } });
    expect(data(r)).toMatchObject({ outcome: 'ACCEPTED', bps: 300 });
    expect((await app.inject({ method: 'POST', url: `${A}/merchants/${m.id}/suggestion/respond`, payload: { decision: 'accept' } })).statusCode).toBe(404);
  });
});
