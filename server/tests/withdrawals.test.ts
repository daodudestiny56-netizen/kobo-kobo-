import { describe, expect, it } from 'vitest';
import { ledgerProblems, pots } from '../src/ledger/ledger';
import { setOffsetDays } from '../src/demo/clock';
import { merchantSummary } from '../src/merchants/summary';
import { requestWithdrawal, requeryWithdrawalsDue, listWithdrawals } from '../src/withdrawals/service';
import { runSweepForMerchant } from '../src/sweeps/engine';
import { listMessages } from '../src/messages/service';
import { addInflow, AFTER_CUTOFF, DATE, fundedMerchant, makeDeps } from './helpers';

const N = (n: number) => BigInt(n) * 100n;

/** A trader with N1,000 in each pot after one settled sweep on 13 Nov 2026. */
async function saver(o: { language?: 'en' | 'pidgin' } = {}) {
  const deps = makeDeps({ now: AFTER_CUTOFF });
  const m = fundedMerchant(deps, { dailyCap: N(100_000), language: o.language });
  addInflow(deps.db, m.id, N(100_000), new Date('2026-11-13T11:00:00Z'));
  await runSweepForMerchant(deps, m.id, DATE); // sweeps N2,000: N1,000 emergency, N1,000 retirement
  expect(pots(deps.db, m.id)).toMatchObject({ emergency: N(1000), retirement: N(1000) });
  return { deps, m };
}
const setFirstContribution = (deps: ReturnType<typeof makeDeps>, id: string, at: string) =>
  deps.db.prepare('UPDATE pension_accounts SET first_contribution_at = ? WHERE merchant_id = ?').run(at, id);

describe('eligibility (3 months to vest, then once every 2 months)', () => {
  it('refuses before vesting with the date, and touches neither the bank nor the ledger', async () => {
    const { deps, m } = await saver();
    const before = deps.bank.transfers.length;
    const r = await requestWithdrawal(deps, m.id, N(500));
    expect(r.accepted).toBe(false);
    expect(r.withdrawal).toMatchObject({ status: 'REJECTED', rejectReason: 'NOT_VESTED' });
    expect(r.message).toMatch(/open 13 Feb 2027/); // 3 months after the 13 Nov 2026 settlement
    expect(deps.bank.transfers.length).toBe(before);
    expect(pots(deps.db, m.id).emergency).toBe(N(1000));
  });

  it('the demo clock offset makes the same trader eligible, and the app, USSD and SMS read one decision', async () => {
    const { deps, m } = await saver();
    expect(merchantSummary(deps, m.id).eligibility.eligible).toBe(false);
    setOffsetDays(deps.db, 100);
    expect(merchantSummary(deps, m.id)).toMatchObject({ eligibility: { eligible: true }, demoClockOffsetDays: 100 });
    expect((await requestWithdrawal(deps, m.id, N(500))).accepted).toBe(true);
  });

  it('the retirement pot is always refused', async () => {
    const { deps, m } = await saver();
    setOffsetDays(deps.db, 3000);
    const r = await requestWithdrawal(deps, m.id, N(500), 'RETIREMENT');
    expect(r).toMatchObject({ accepted: false });
    expect(r.withdrawal.rejectReason).toBe('RETIREMENT_LOCKED');
    expect(pots(deps.db, m.id).retirement).toBe(N(1000));
  });

  it('refuses in Pidgin when the trader speaks Pidgin', async () => {
    const { deps, m } = await saver({ language: 'pidgin' });
    expect((await requestWithdrawal(deps, m.id, N(500))).message).toMatch(/no fit collect/);
  });
});

describe('paying out', () => {
  it('reserves, pays from the collection account, posts balanced entries and sends a message', async () => {
    const { deps, m } = await saver();
    setOffsetDays(deps.db, 100);
    const collection0 = deps.bank.accounts.get('0123456793')!.balance;
    const r = await requestWithdrawal(deps, m.id, N(400));
    expect(r.withdrawal.status).toBe('DISBURSED');
    expect(pots(deps.db, m.id).emergency).toBe(N(600));
    expect(deps.bank.accounts.get('0123456793')!.balance).toBe(collection0 - N(400));
    expect(ledgerProblems(deps.db)).toEqual([]);
    expect(listMessages(deps.db, m.id).map((x) => x.kind)).toContain('WITHDRAWAL_PAID');
  });

  it('cooldown: a second withdrawal is refused, then allowed two months later', async () => {
    const { deps, m } = await saver();
    setOffsetDays(deps.db, 100);
    await requestWithdrawal(deps, m.id, N(400));
    const again = await requestWithdrawal(deps, m.id, N(100));
    expect(again.withdrawal.rejectReason).toBe('COOLDOWN_ACTIVE');
    setOffsetDays(deps.db, 100 + 62);
    expect((await requestWithdrawal(deps, m.id, N(100))).accepted).toBe(true);
  });

  it('cannot withdraw more than the emergency pot, and two simultaneous requests cannot overdraw it', async () => {
    const { deps, m } = await saver();
    setOffsetDays(deps.db, 100);
    expect((await requestWithdrawal(deps, m.id, N(1001))).withdrawal.rejectReason).toBe('EXCEEDS_BALANCE');
    const [a, b] = await Promise.all([requestWithdrawal(deps, m.id, N(700)), requestWithdrawal(deps, m.id, N(700))]);
    expect([a.accepted, b.accepted].sort()).toEqual([false, true]);
    expect(pots(deps.db, m.id).emergency).toBe(N(300));
    expect(ledgerProblems(deps.db)).toEqual([]);
  });

  it('a payout that times out is requeried, never paid twice, and a definitive failure releases the reservation', async () => {
    const { deps, m } = await saver();
    setOffsetDays(deps.db, 100);
    const r = await requestWithdrawal(deps, m.id, 50_002n); // N500.02: the sandbox "timeout, then failed" trigger
    expect(r.withdrawal.status).toBe('UNKNOWN');
    expect(pots(deps.db, m.id).emergency).toBe(N(1000) - 50_002n); // reserved while unknown
    deps.advance(10_000);
    await requeryWithdrawalsDue(deps);
    expect(listWithdrawals(deps.db, m.id)[0].status).toBe('UNKNOWN');
    deps.advance(31_000);
    await requeryWithdrawalsDue(deps);
    const w = listWithdrawals(deps.db, m.id)[0];
    expect(w.status).toBe('FAILED');
    expect(pots(deps.db, m.id).emergency).toBe(N(1000)); // pot whole again
    expect(deps.bank.calls.transfer).toBe(2); // one sweep + ONE payout attempt, never resent
    expect(merchantSummary(deps, m.id).lastWithdrawalAt).toBeNull(); // the cooldown does not start on a failed payout
    expect(ledgerProblems(deps.db)).toEqual([]);
    expect(listMessages(deps.db, m.id).map((x) => x.kind)).toContain('WITHDRAWAL_FAILED');
  });
});
