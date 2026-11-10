import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ledgerBalances } from '../src/ledger/ledger';
import { buildServer } from '../src/server';
import { addDaysToInstant, addMonthsToInstant } from '../src/time';
import { requestEmergencyWithdrawal, retryPendingWithdrawals } from '../src/withdrawals/service';
import { COOLDOWN_DAYS, withdrawalEligibility } from '../src/withdrawals/rules';
import { makeDeps, makeMerchant, makeTrader, NIGHT, resetDb, testPool } from './helpers';

const NOW = NIGHT;
const monthsAgo = (n: number) => addMonthsToInstant(NOW, -n);
const daysAgo = (n: number) => addDaysToInstant(NOW, -n);

describe('eligibility rules (pure)', () => {
  const base = { firstContributionAt: monthsAgo(4), lastWithdrawalAt: null, emergency: 45_000n };
  it('needs a first contribution', () => {
    expect(withdrawalEligibility({ ...base, firstContributionAt: null }, NOW)).toEqual({ eligible: false, reason: 'NO_CONTRIBUTIONS' });
  });
  it('opens exactly 3 months after the first contribution', () => {
    const first = new Date('2026-08-06T22:30:00Z');
    const p = { ...base, firstContributionAt: first };
    expect(withdrawalEligibility(p, new Date('2026-11-06T22:29:59Z'))).toMatchObject({ eligible: false, reason: 'NOT_VESTED' });
    expect(withdrawalEligibility(p, new Date('2026-11-06T22:30:00Z'))).toEqual({ eligible: true });
    expect(withdrawalEligibility(p, new Date('2026-11-06T22:29:59Z')).eligibleOn?.toISOString()).toBe('2026-11-06T22:30:00.000Z');
  });
  it('then limits to once every 60 days', () => {
    const last = daysAgo(COOLDOWN_DAYS - 1);
    expect(withdrawalEligibility({ ...base, lastWithdrawalAt: last }, NOW)).toMatchObject({ eligible: false, reason: 'COOLDOWN_ACTIVE' });
    expect(withdrawalEligibility({ ...base, lastWithdrawalAt: daysAgo(COOLDOWN_DAYS) }, NOW)).toEqual({ eligible: true });
  });
  it('flags an empty pot', () => {
    expect(withdrawalEligibility({ ...base, emergency: 0n }, NOW)).toEqual({ eligible: false, reason: 'EMPTY' });
  });
});

describe('emergency withdrawals (database)', () => {
  const pool = testPool();
  let deps: ReturnType<typeof makeDeps>;
  beforeEach(async () => {
    await resetDb(pool);
    deps = makeDeps(pool);
  });
  afterAll(() => pool.end());

  /** A trader with N450 in each pot who first contributed `months` ago. */
  const vested = async (o: { months?: number; lastWithdrawalAt?: Date | null; emergency?: string } = {}) => {
    const m = await makeTrader(pool, {
      pension: { emergency: o.emergency ?? '450.00', retirement: '450.00', firstContributionAt: monthsAgo(o.months ?? 4), lastWithdrawalAt: o.lastWithdrawalAt ?? null },
    });
    deps.executor.setBalance(m.access_nuban, 0n);
    return m;
  };
  const pot = async (id: string) => (await pool.query('SELECT emergency_balance::text e, retirement_balance::text r, last_withdrawal_at FROM pension_accounts WHERE merchant_id=$1', [id])).rows[0];
  const count = async (table: string, where = 'true') => (await pool.query(`SELECT count(*)::int n FROM ${table} WHERE ${where}`)).rows[0].n as number;

  it('pays out to the merchant\'s own Access account, reduces only the emergency pot, journals it and texts them', async () => {
    const m = await vested();
    const w = await requestEmergencyWithdrawal(deps, { merchantId: m.id, amount: 20_000n });
    expect(w).toMatchObject({ status: 'DISBURSED', amount: 20_000n, destinationNuban: m.access_nuban });
    expect(w.creditReference).toMatch(/^MOCK-CREDIT-/);
    expect(await pot(m.id)).toMatchObject({ e: '250.00', r: '450.00', last_withdrawal_at: NOW });
    expect(deps.executor.balances.get(m.access_nuban)).toBe(20_000n);
    const l = await ledgerBalances(pool, m.id);
    expect(l.EMERGENCY_POT).toBe(-20_000n); // only this withdrawal is in the ledger here
    expect(l.MERCHANT_CASH).toBe(20_000n);
    const sms = (await pool.query('SELECT kind, body FROM sms_outbox')).rows;
    expect(sms).toEqual([{ kind: 'WITHDRAWAL', body: `Kobo Kobo: N200 from your Emergency Pot is on its way to your Access account ****${m.access_nuban.slice(-4)}.` }]);
  });

  it('refuses before 3 months and says when it opens, without touching money or ledger', async () => {
    const m = await vested({ months: 2 });
    await expect(requestEmergencyWithdrawal(deps, { merchantId: m.id, amount: 10_000n })).rejects.toMatchObject({
      code: 'NOT_VESTED',
      status: 422,
      details: { eligible_on: addMonthsToInstant(monthsAgo(2), 3).toISOString() },
    });
    expect(await count('emergency_withdrawals')).toBe(0);
    expect((await pot(m.id)).e).toBe('450.00');
    expect(deps.executor.calls.credit).toBe(0);
  });

  it('refuses a merchant who has never contributed', async () => {
    const m = await makeTrader(pool);
    await expect(requestEmergencyWithdrawal(deps, { merchantId: m.id, amount: 100n })).rejects.toMatchObject({ code: 'NO_CONTRIBUTIONS' });
  });

  it('enforces the 60-day cooldown, then allows the next one', async () => {
    const m = await vested();
    await requestEmergencyWithdrawal(deps, { merchantId: m.id, amount: 10_000n });
    await expect(requestEmergencyWithdrawal(deps, { merchantId: m.id, amount: 10_000n })).rejects.toMatchObject({ code: 'COOLDOWN_ACTIVE' });
    deps.setNow(addDaysToInstant(NOW, COOLDOWN_DAYS));
    const second = await requestEmergencyWithdrawal(deps, { merchantId: m.id, amount: 10_000n });
    expect(second.status).toBe('DISBURSED');
    expect((await pot(m.id)).e).toBe('250.00');
  });

  it('cannot withdraw more than the emergency pot (and never touches the retirement pot)', async () => {
    const m = await vested();
    await expect(requestEmergencyWithdrawal(deps, { merchantId: m.id, amount: 45_001n })).rejects.toMatchObject({
      code: 'INSUFFICIENT_EMERGENCY_BALANCE',
      details: { available: '450.00' },
    });
    const all = await requestEmergencyWithdrawal(deps, { merchantId: m.id, amount: 45_000n });
    expect(all.status).toBe('DISBURSED');
    expect(await pot(m.id)).toMatchObject({ e: '0.00', r: '450.00' });
  });

  it('rejects non-positive amounts and unknown merchants', async () => {
    const m = await vested();
    await expect(requestEmergencyWithdrawal(deps, { merchantId: m.id, amount: 0n })).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
    await expect(requestEmergencyWithdrawal(deps, { merchantId: '00000000-0000-4000-8000-000000000000', amount: 100n })).rejects.toMatchObject({ code: 'MERCHANT_NOT_FOUND' });
    const noRsa = await makeMerchant(pool);
    await expect(requestEmergencyWithdrawal(deps, { merchantId: noRsa.id, amount: 100n })).rejects.toMatchObject({ code: 'PENSION_ACCOUNT_MISSING' });
  });

  it('two simultaneous requests cannot both succeed', async () => {
    const m = await vested({ emergency: '150.00' });
    const results = await Promise.allSettled([
      requestEmergencyWithdrawal(deps, { merchantId: m.id, amount: 10_000n }),
      requestEmergencyWithdrawal(deps, { merchantId: m.id, amount: 10_000n }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'COOLDOWN_ACTIVE' });
    expect((await pot(m.id)).e).toBe('50.00');
    expect(deps.executor.credits.size).toBe(1);
  });

  it('a final bank refusal puts the money back and lifts the cooldown it started', async () => {
    const m = await vested({ lastWithdrawalAt: daysAgo(90) });
    deps.executor.failNext('credit', 'ACCOUNT_BLOCKED');
    const w = await requestEmergencyWithdrawal(deps, { merchantId: m.id, amount: 20_000n });
    expect(w).toMatchObject({ status: 'REJECTED', failureReason: 'ACCOUNT_BLOCKED' });
    const p = await pot(m.id);
    expect(p.e).toBe('450.00');
    expect(p.last_withdrawal_at).toEqual(daysAgo(90)); // previous value restored, not "now"
    const l = await ledgerBalances(pool, m.id);
    expect(l.EMERGENCY_POT).toBe(0n); // withdrawal and its reversal cancel
    expect(l.MERCHANT_CASH).toBe(0n);
    expect(await count('sms_outbox')).toBe(0);
    // and they can try again straight away
    expect((await requestEmergencyWithdrawal(deps, { merchantId: m.id, amount: 20_000n })).status).toBe('DISBURSED');
  });

  it('a lost credit response never pays twice', async () => {
    const m = await vested();
    deps.executor.failNext('credit', 'TIMEOUT', { afterSuccess: true });
    const w = await requestEmergencyWithdrawal(deps, { merchantId: m.id, amount: 20_000n });
    expect(w.status).toBe('DISBURSED');
    expect(deps.executor.credits.size).toBe(1);
    expect(deps.executor.balances.get(m.access_nuban)).toBe(20_000n);
    expect(await count('sms_outbox')).toBe(1);
  });

  it('an unknown outcome stays PENDING (funds reserved, never reversed) until replayed', async () => {
    const m = await vested();
    deps.executor.failNext('credit', 'UNAVAILABLE', { times: 3 });
    const w = await requestEmergencyWithdrawal(deps, { merchantId: m.id, amount: 20_000n });
    expect(w.status).toBe('PENDING');
    expect((await pot(m.id)).e).toBe('250.00'); // still reserved
    expect(await count('sms_outbox')).toBe(0);

    deps.setNow(new Date(NOW.getTime() + 60_000));
    expect(await retryPendingWithdrawals(deps)).toBe(1);
    expect((await pool.query('SELECT status FROM emergency_withdrawals')).rows[0].status).toBe('DISBURSED');
    expect(deps.executor.credits.size).toBe(1);
    expect(await retryPendingWithdrawals(deps)).toBe(0);
    expect(await count('sms_outbox')).toBe(1);
  });
});

describe('withdrawal HTTP API', () => {
  const pool = testPool();
  let deps: ReturnType<typeof makeDeps>;
  let app: ReturnType<typeof buildServer>;
  beforeEach(async () => {
    await resetDb(pool);
    deps = makeDeps(pool);
    app = buildServer(deps);
  });
  afterAll(() => pool.end());

  it('POST /api/v1/withdrawals pays out; GET /merchants/:id/pension reports balances and eligibility', async () => {
    const m = await makeTrader(pool, { pin: '7391', pension: { emergency: '450.00', retirement: '450.00', firstContributionAt: monthsAgo(4) } });
    const before = await app.inject({ method: 'GET', url: `/api/v1/merchants/${m.id}/pension` });
    expect(before.json()).toMatchObject({
      emergency_pot: '450.00',
      retirement_pot: '450.00',
      total_saved: '900.00',
      emergency_withdrawal: { eligible: true, reason: null, eligible_on: null },
    });

    const res = await app.inject({ method: 'POST', url: '/api/v1/withdrawals', payload: { merchant_id: m.id, amount: '200.00', pin: '7391' } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ amount: '200.00', status: 'DISBURSED', destination_nuban: m.access_nuban });

    const after = (await app.inject({ method: 'GET', url: `/api/v1/merchants/${m.id}/pension` })).json();
    expect(after.emergency_pot).toBe('250.00');
    expect(after.emergency_withdrawal).toMatchObject({ eligible: false, reason: 'COOLDOWN_ACTIVE' });
    expect(after.emergency_withdrawal.eligible_on).toBe(addDaysToInstant(NOW, COOLDOWN_DAYS).toISOString());
  });

  it('maps rule violations to 422 and bad input to 400', async () => {
    const m = await makeTrader(pool, { pin: '7391', pension: { emergency: '450.00', firstContributionAt: monthsAgo(1) } });
    const early = await app.inject({ method: 'POST', url: '/api/v1/withdrawals', payload: { merchant_id: m.id, amount: '10', pin: '7391' } });
    expect(early.statusCode).toBe(422);
    expect(early.json().error.code).toBe('NOT_VESTED');
    const bad = await app.inject({ method: 'POST', url: '/api/v1/withdrawals', payload: { merchant_id: m.id, amount: '-5', pin: '7391' } });
    expect(bad.statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/v1/merchants/not-a-uuid/pension' })).statusCode).toBe(400);
  });
});
