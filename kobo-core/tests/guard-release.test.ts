import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { GuardAlertType, GuardVerdict } from '../src/guard';
import { reconcile } from '../src/reconciliation/report';
import { buildServer } from '../src/server';
import { resolveGuardAlert, resumeStalePendingSweeps } from '../src/sweeps/release';
import { executeSweepForMerchant } from '../src/sweeps/service';
import { addInflow, DAY, DURING, makeDeps, makeTrader, NIGHT, resetDb, testPool } from './helpers';

const pool = testPool();
let deps: ReturnType<typeof makeDeps>;
let app: ReturnType<typeof buildServer>;
beforeEach(async () => {
  await resetDb(pool);
  deps = makeDeps(pool);
  app = buildServer(deps);
});
afterAll(() => pool.end());

/** A trader whose sweep Sweep Guard holds. */
async function heldTrader(type: GuardAlertType = 'ANOMALOUS_INFLOW', o: Parameters<typeof makeTrader>[1] = {}) {
  const m = await makeTrader(pool, o);
  await addInflow(pool, m.id, '45000.00', DURING);
  deps.executor.setBalance(m.access_nuban, 100_000_000n);
  deps.guard = { async evaluate(): Promise<GuardVerdict> { return { verdict: 'HOLD', alertType: type, details: { zscore: 4.2 } }; } };
  const rec = await executeSweepForMerchant(deps, m.id, DAY);
  expect(rec.status).toBe('HELD_GUARD');
  const alertId = (await pool.query('SELECT id FROM sweep_guard_alerts WHERE merchant_id = $1', [m.id])).rows[0].id as string;
  deps.guard = { async evaluate() { return { verdict: 'CLEAR' }; } }; // from now on the guard is quiet
  return { m, alertId };
}
const resolve = (alertId: string, decision: 'RELEASE' | 'CONFIRM', extra: object = {}) =>
  resolveGuardAlert(deps, { alertId, decision, resolvedBy: 'ops:amaka', via: 'OPS', ...extra });
const code = (p: Promise<unknown>) => p.then(() => 'OK', (e) => e.code as string);
const smsBodies = async (kind?: string) => (await pool.query(`SELECT body FROM sms_outbox ${kind ? `WHERE kind = '${kind}'` : ''} ORDER BY created_at, body`)).rows.map((r) => r.body as string);
const sms = (phone: string, text: string) => app.inject({ method: 'POST', url: '/api/v1/sms/inbound', payload: { from: phone, text } }).then((r) => r.json().reply as string);

describe('a hold moves no money and asks the right question', () => {
  it('an anomalous-inflow hold invites the trader to reply OK; others say the team will call', async () => {
    await heldTrader('ANOMALOUS_INFLOW');
    await heldTrader('NAME_MISMATCH');
    expect(deps.executor.calls.debit).toBe(0);
    const held = await smsBodies('SWEEP_HELD');
    expect(held.filter((b) => b.includes('reply OK to continue'))).toHaveLength(1);
    expect(held.filter((b) => b.includes('Our team will contact you'))).toHaveLength(1);
  });
});

describe('ops resolves via HTTP', () => {
  it('lists the review queue', async () => {
    const { m, alertId } = await heldTrader();
    const res = await app.inject({ method: 'GET', url: '/api/v1/sweep-guard/alerts?status=PENDING_REVIEW' });
    expect(res.json().alerts).toEqual([expect.objectContaining({ alert_id: alertId, merchant_id: m.id, alert_type: 'ANOMALOUS_INFLOW', sweep_date: DAY, sweep_status: 'HELD_GUARD', status: 'PENDING_REVIEW' })]);
    expect((await app.inject({ method: 'GET', url: '/api/v1/sweep-guard/alerts?status=DISMISSED' })).json().alerts).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/api/v1/sweep-guard/alerts?status=nope' })).statusCode).toBe(400);
  });

  it('RELEASE executes the sweep: one debit, ledger posted, receipt sent, alert audited', async () => {
    const { m, alertId } = await heldTrader();
    const res = await app.inject({ method: 'POST', url: `/api/v1/sweep-guard/alerts/${alertId}/resolve`, payload: { decision: 'RELEASE', resolved_by: 'ops:amaka', note: 'Wedding order confirmed by phone' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ changed: true, alert: { status: 'DISMISSED', resolved_by: 'ops:amaka', resolved_via: 'OPS', resolution_note: 'Wedding order confirmed by phone' }, sweep: { status: 'EXECUTED', sweep_amount: '900.00', failure_reason: null } });
    expect(deps.executor.debits.size).toBe(1);
    expect(deps.executor.balances.get(m.access_nuban)).toBe(100_000_000n - 90_000n);
    const pots = (await pool.query('SELECT emergency_balance::text e, retirement_balance::text r FROM pension_accounts WHERE merchant_id=$1', [m.id])).rows[0];
    expect(pots).toEqual({ e: '450.00', r: '450.00' });
    expect((await pool.query("SELECT sum(CASE entry_type WHEN 'DEBIT' THEN amount ELSE -amount END)::text d FROM ledger_entries")).rows[0].d).toBe('0.00');
    expect(await smsBodies('SWEEP_RECEIPT')).toHaveLength(1);
    expect((await smsBodies('GUARD'))[0]).toMatch(/cleared your held sweep/);
  });

  it('repeating the same decision is safe; the opposite decision conflicts', async () => {
    const { alertId } = await heldTrader();
    await resolve(alertId, 'RELEASE');
    const again = await resolve(alertId, 'RELEASE');
    expect(again.changed).toBe(false);
    expect(deps.executor.debits.size).toBe(1);
    expect(await code(resolve(alertId, 'CONFIRM'))).toBe('ALERT_ALREADY_RESOLVED');
  });

  it('three simultaneous releases debit once', async () => {
    const { alertId } = await heldTrader();
    const results = await Promise.all([1, 2, 3].map(() => code(resolve(alertId, 'RELEASE'))));
    expect(results.every((r) => r === 'OK')).toBe(true);
    expect(deps.executor.debits.size).toBe(1);
    expect((await pool.query("SELECT count(*)::int n FROM ledger_entries")).rows[0].n).toBe(3);
  });

  it('CONFIRM keeps the sweep unswept, tells the trader, and cannot be released afterwards', async () => {
    const { alertId } = await heldTrader('SUSPECTED_DUPLICATE');
    const res = await app.inject({ method: 'POST', url: `/api/v1/sweep-guard/alerts/${alertId}/resolve`, payload: { decision: 'CONFIRM', resolved_by: 'ops:amaka', note: 'duplicate webhook' } });
    expect(res.json()).toMatchObject({ alert: { status: 'CONFIRMED' }, sweep: { status: 'HELD_GUARD', failure_reason: 'GUARD_CONFIRMED:SUSPECTED_DUPLICATE' } });
    expect(deps.executor.calls.debit).toBe(0);
    expect((await smsBodies('GUARD'))[0]).toMatch(/did not sweep that payment/);
    expect(await code(resolve(alertId, 'RELEASE'))).toBe('ALERT_ALREADY_RESOLVED');
  });

  it('validates input and maps unknown alerts', async () => {
    const post = (id: string, b: object) => app.inject({ method: 'POST', url: `/api/v1/sweep-guard/alerts/${id}/resolve`, payload: b });
    expect((await post('x', { decision: 'RELEASE', resolved_by: 'a' })).statusCode).toBe(400);
    expect((await post('00000000-0000-4000-8000-000000000000', { decision: 'RELEASE', resolved_by: 'a' })).statusCode).toBe(404);
    expect((await post('00000000-0000-4000-8000-000000000000', { decision: 'MAYBE', resolved_by: 'a' })).statusCode).toBe(400);
  });
});

describe('release re-plans from the facts at release time', () => {
  it('a trader who paused in the meantime is not swept', async () => {
    const { m, alertId } = await heldTrader();
    await pool.query('UPDATE merchants SET is_paused = true, paused_until = $2 WHERE id = $1', [m.id, new Date('2026-11-09T00:00:00Z')]);
    const r = await resolve(alertId, 'RELEASE');
    expect(r.sweep.status).toBe('SKIPPED_PAUSED');
    expect(r.alert.status).toBe('DISMISSED');
    expect(deps.executor.calls.debit).toBe(0);
  });

  it('a changed rate applies', async () => {
    const { m, alertId } = await heldTrader();
    await pool.query("UPDATE merchants SET sweep_percentage = 4.00 WHERE id = $1", [m.id]);
    const r = await resolve(alertId, 'RELEASE');
    expect(r.sweep).toMatchObject({ status: 'EXECUTED', sweepAmount: 180_000n });
  });

  it('a balance that has since dropped below the buffer skips the sweep and says why', async () => {
    const { m, alertId } = await heldTrader();
    deps.executor.setBalance(m.access_nuban, 100_000n); // N1,000 = exactly the buffer
    const r = await resolve(alertId, 'RELEASE');
    expect(r.sweep.status).toBe('SKIPPED_BUFFER');
    expect(deps.executor.calls.debit).toBe(0);
    expect((await smsBodies('SWEEP_SKIPPED'))[0]).toMatch(/keeps at least/);
  });

  it('is refused after the release window', async () => {
    const { alertId } = await heldTrader();
    deps.setNow(new Date('2026-11-10T10:00:00Z')); // 4 days after the 6th
    expect(await code(resolve(alertId, 'RELEASE'))).toBe('RELEASE_WINDOW_PASSED');
    expect(await code(resolve(alertId, 'CONFIRM'))).toBe('OK'); // closing it out is always allowed
  });
});

describe('bank trouble during release', () => {
  it('balance unavailable: 503 and nothing changes; retry works', async () => {
    const { alertId } = await heldTrader();
    deps.executor.failNext('balance', 'UNAVAILABLE');
    const res = await app.inject({ method: 'POST', url: `/api/v1/sweep-guard/alerts/${alertId}/resolve`, payload: { decision: 'RELEASE', resolved_by: 'ops:amaka' } });
    expect(res.statusCode).toBe(503);
    expect((await pool.query('SELECT status FROM sweep_guard_alerts')).rows[0].status).toBe('PENDING_REVIEW');
    expect((await resolve(alertId, 'RELEASE')).sweep.status).toBe('EXECUTED');
  });

  it('debit outage after release leaves PENDING; the stale-sweep resume completes it once, with the same key', async () => {
    const { m, alertId } = await heldTrader();
    deps.executor.failNext('debit', 'UNAVAILABLE', { times: 3 });
    const r = await resolve(alertId, 'RELEASE');
    expect(r.sweep.status).toBe('PENDING');
    expect(await resumeStalePendingSweeps(deps)).toBe(0); // still the same WAT day
    deps.setNow(new Date('2026-11-07T10:00:00Z'));
    expect(await resumeStalePendingSweeps(deps)).toBe(1);
    expect((await pool.query('SELECT status FROM daily_sweeps WHERE merchant_id=$1', [m.id])).rows[0].status).toBe('EXECUTED');
    expect(deps.executor.debits.size).toBe(1);
    expect(await resumeStalePendingSweeps(deps)).toBe(0);
  });
});

describe('trader self-release by SMS', () => {
  it('OK releases an anomalous-inflow hold and the receipt follows', async () => {
    const { m, alertId } = await heldTrader('ANOMALOUS_INFLOW');
    expect(await sms(m.phone_number, 'ok')).toBe('Kobo Kobo: Thank you. We are releasing your held sweep now. You will get a receipt shortly.');
    expect(deps.executor.debits.size).toBe(1);
    expect((await pool.query('SELECT status, resolved_via, resolved_by FROM sweep_guard_alerts WHERE id=$1', [alertId])).rows[0]).toEqual({ status: 'DISMISSED', resolved_via: 'SMS', resolved_by: `merchant:${m.id}` });
    expect(await smsBodies('SWEEP_RECEIPT')).toHaveLength(1);
    expect(await sms(m.phone_number, 'OK')).toMatch(/Nothing is waiting for your OK/);
    expect(deps.executor.debits.size).toBe(1);
  });

  it('OK cannot release a name mismatch or duplicate: ops only', async () => {
    const { m, alertId } = await heldTrader('NAME_MISMATCH');
    expect(await sms(m.phone_number, 'OK')).toMatch(/Nothing is waiting for your OK/);
    expect(await code(resolveGuardAlert(deps, { alertId, decision: 'RELEASE', resolvedBy: `merchant:${m.id}`, via: 'SMS' }))).toBe('NOT_SELF_RELEASABLE');
    expect(deps.executor.calls.debit).toBe(0);
  });

  it("OK from one trader never releases another trader's hold", async () => {
    const a = await heldTrader('ANOMALOUS_INFLOW');
    const b = await makeTrader(pool);
    expect(await sms(b.phone_number, 'OK')).toMatch(/Nothing is waiting/);
    expect((await pool.query('SELECT status FROM sweep_guard_alerts WHERE id=$1', [a.alertId])).rows[0].status).toBe('PENDING_REVIEW');
  });

  it('if the bank is down, the trader is told the team will follow up and the hold stays open', async () => {
    const { m, alertId } = await heldTrader();
    deps.executor.failNext('balance', 'UNAVAILABLE');
    expect(await sms(m.phone_number, 'OK')).toMatch(/could not release your held sweep right now/);
    expect((await pool.query('SELECT status FROM sweep_guard_alerts WHERE id=$1', [alertId])).rows[0].status).toBe('PENDING_REVIEW');
  });

  it('Pidgin copy', async () => {
    const { m } = await heldTrader('ANOMALOUS_INFLOW', { language: 'pidgin' });
    expect((await smsBodies('SWEEP_HELD'))[0]).toContain('reply OK make we continue');
    expect(await sms(m.phone_number, 'OK')).toMatch(/We dey release your held sweep now/);
  });
});

describe('reconciliation sees open holds', () => {
  it('flags HELD_FOR_REVIEW until resolved', async () => {
    const { alertId } = await heldTrader();
    deps.setNow(NIGHT);
    expect((await reconcile(deps, DAY)).flags.map((f) => f.code)).toEqual(['HELD_FOR_REVIEW']);
    await resolve(alertId, 'RELEASE');
    expect((await reconcile(deps, DAY)).ok).toBe(true);
  });
});
