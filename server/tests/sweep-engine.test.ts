import { describe, expect, it } from 'vitest';
import { ledgerProblems, pots } from '../src/ledger/ledger';
import { ThresholdGuard } from '../src/guard/port';
import { getSweep, requeryDue, runSweepForMerchant, applyResult } from '../src/sweeps/engine';
import { runBatch } from '../src/sweeps/batch';
import { listAlerts, resolveAlert } from '../src/sweeps/alerts';
import { listMessages } from '../src/messages/service';
import { pauseMerchant } from '../src/merchants/service';
import { addInflow, AFTER_CUTOFF, DATE, fundedMerchant, makeDeps } from './helpers';

const NAIRA = (n: number) => BigInt(n) * 100n;
const midday = new Date('2026-11-13T11:00:00Z');
const count = (deps: ReturnType<typeof makeDeps>, sql: string) => (deps.db.prepare(sql).get() as { c: number }).c;

function setup(o: Parameters<typeof fundedMerchant>[1] = {}, balance?: bigint) {
  const deps = makeDeps({ now: AFTER_CUTOFF });
  const m = fundedMerchant(deps, o, balance);
  return { deps, m };
}

describe('happy path', () => {
  it('settles: one transfer, balanced ledger, 50/50 pots, receipt with a PEN reference', async () => {
    const { deps, m } = setup();
    addInflow(deps.db, m.id, NAIRA(1000), midday);
    addInflow(deps.db, m.id, NAIRA(500), midday);
    const s = (await runSweepForMerchant(deps, m.id, DATE))!;
    expect(s).toMatchObject({ status: 'SETTLED', takings: NAIRA(1500), sweep: NAIRA(30), emergency: NAIRA(15), retirement: NAIRA(15), pensionReference: 'PEN-20261113-000001' });
    expect(pots(deps.db, m.id)).toEqual({ emergency: NAIRA(15), retirement: NAIRA(15), total: NAIRA(30) });
    expect(deps.bank.transfers).toHaveLength(1);
    expect(deps.bank.accounts.get(m.bankAccount)!.balance).toBe(NAIRA(100_000) - NAIRA(30));
    expect(deps.bank.accounts.get('0123456793')!.balance).toBe(NAIRA(12_000_000) + NAIRA(30));
    expect(listMessages(deps.db, m.id).map((x) => x.kind)).toEqual(['SWEEP_RECEIPT']);
    expect(ledgerProblems(deps.db)).toEqual([]);
  });

  it('running the same sweep twice, even concurrently, leaves exactly one transfer and one receipt', async () => {
    const { deps, m } = setup();
    addInflow(deps.db, m.id, NAIRA(1000), midday);
    await Promise.all([runSweepForMerchant(deps, m.id, DATE), runSweepForMerchant(deps, m.id, DATE)]);
    await runSweepForMerchant(deps, m.id, DATE);
    expect(deps.bank.transfers).toHaveLength(1);
    expect(count(deps, 'SELECT COUNT(*) c FROM sweeps')).toBe(1);
    expect(count(deps, `SELECT COUNT(*) c FROM messages WHERE kind = 'SWEEP_RECEIPT'`)).toBe(1);
    expect(pots(deps.db, m.id).total).toBe(NAIRA(20));
  });
});

describe('rolling window', () => {
  it('a credit at 23:30 WAT belongs to the next sweep, and nothing is lost or counted twice', async () => {
    const { deps, m } = setup();
    addInflow(deps.db, m.id, NAIRA(1000), new Date('2026-11-13T21:59:59.999Z')); // just inside the 13th
    addInflow(deps.db, m.id, NAIRA(2000), new Date('2026-11-13T22:30:00Z')); // 23:30 WAT: the 14th
    addInflow(deps.db, m.id, NAIRA(3000), new Date('2026-11-12T22:00:00Z')); // exactly the previous cutoff: the 13th
    addInflow(deps.db, m.id, NAIRA(4000), new Date('2026-11-12T21:59:59.999Z')); // belongs to the 12th
    expect((await runSweepForMerchant(deps, m.id, DATE))!.takings).toBe(NAIRA(4000));
    deps.setNow(new Date('2026-11-14T22:05:00Z'));
    expect((await runSweepForMerchant(deps, m.id, '2026-11-14'))!.takings).toBe(NAIRA(2000));
  });
});

describe('skips and the buffer', () => {
  it('skips zero sales, paused, and a sweep that rounds to zero, without touching the bank', async () => {
    const { deps, m } = setup();
    expect((await runSweepForMerchant(deps, m.id, DATE))!.status).toBe('SKIPPED_ZERO_SALES');
    const p = fundedMerchant(deps);
    addInflow(deps.db, p.id, NAIRA(1000), midday);
    pauseMerchant(deps.db, p.id, AFTER_CUTOFF);
    expect((await runSweepForMerchant(deps, p.id, DATE))!.status).toBe('SKIPPED_PAUSED');
    const tiny = fundedMerchant(deps);
    addInflow(deps.db, tiny.id, 49n, midday); // 49 kobo at 2% rounds to zero
    const t = (await runSweepForMerchant(deps, tiny.id, DATE))!;
    expect(t).toMatchObject({ status: 'SKIPPED_ZERO_SALES', failureReason: 'SWEEP_ROUNDS_TO_ZERO' });
    expect(deps.bank.calls.balance + deps.bank.calls.transfer).toBe(0);
  });

  it('reduces the sweep to keep the buffer, and skips with a message when nothing is left', async () => {
    const reduce = setup({ buffer: NAIRA(1000) }, NAIRA(1010));
    addInflow(reduce.deps.db, reduce.m.id, NAIRA(1000), midday); // wants N20, only N10 above the buffer
    expect((await runSweepForMerchant(reduce.deps, reduce.m.id, DATE))!).toMatchObject({ status: 'SETTLED', sweep: NAIRA(10) });
    const skip = setup({ buffer: NAIRA(1000) }, NAIRA(1000)); // balance == buffer
    addInflow(skip.deps.db, skip.m.id, NAIRA(1000), midday);
    expect((await runSweepForMerchant(skip.deps, skip.m.id, DATE))!.status).toBe('SKIPPED_LOW_BALANCE');
    expect(listMessages(skip.deps.db, skip.m.id)[0].kind).toBe('SWEEP_SKIPPED');
    expect(skip.deps.bank.transfers).toHaveLength(0);
  });

  it('caps the sweep at the daily cap', async () => {
    const { deps, m } = setup({ dailyCap: NAIRA(5000) });
    addInflow(deps.db, m.id, NAIRA(3_000_000), midday);
    expect((await runSweepForMerchant(deps, m.id, DATE))!.sweep).toBe(NAIRA(5000));
  });

  it('a bank that cannot give the balance records nothing; the next run succeeds', async () => {
    const { deps, m } = setup();
    addInflow(deps.db, m.id, NAIRA(1000), midday);
    deps.bank.fail('balance', 'UNAVAILABLE');
    await expect(runSweepForMerchant(deps, m.id, DATE)).rejects.toThrow();
    expect(getSweep(deps.db, m.id, DATE)).toBeNull();
    expect((await runSweepForMerchant(deps, m.id, DATE))!.status).toBe('SETTLED');
  });
});

describe('failure handling (PRD 7.4): every one ends in a correct ledger and message', () => {
  // takings chosen so that floor(takings x 2%) ends in the sandbox trigger digits
  const takingsFor = (sweepKobo: number) => BigInt(sweepKobo) * 50n;

  it('.02 timeout: UNKNOWN, requeried and never resent, then failed with no ledger entries', async () => {
    const { deps, m } = setup();
    addInflow(deps.db, m.id, takingsFor(1002), midday);
    expect((await runSweepForMerchant(deps, m.id, DATE))!.status).toBe('UNKNOWN');
    deps.advance(10_000);
    expect((await runSweepForMerchant(deps, m.id, DATE))!.status).toBe('UNKNOWN'); // still pending at the bank
    deps.advance(31_000);
    const s = (await runSweepForMerchant(deps, m.id, DATE))!;
    expect(s).toMatchObject({ status: 'FAILED' });
    expect(deps.bank.calls.transfer).toBe(1); // the sweep was NEVER resent
    expect(count(deps, 'SELECT COUNT(*) c FROM ledger_entries')).toBe(0);
    expect(listMessages(deps.db, m.id).map((x) => x.kind)).toEqual(['SWEEP_FAILED']);
  });

  it('.03 pending: UNKNOWN until the bank confirms, then settles once', async () => {
    const { deps, m } = setup();
    addInflow(deps.db, m.id, takingsFor(1003), midday);
    expect((await runSweepForMerchant(deps, m.id, DATE))!.status).toBe('UNKNOWN');
    deps.advance(121_000);
    await requeryDue(deps);
    expect(getSweep(deps.db, m.id, DATE)!.status).toBe('SETTLED');
    expect(deps.bank.calls.transfer).toBe(1);
    expect(pots(deps.db, m.id).total).toBe(1003n);
  });

  it('.04 reversed: settles, then the contra entries return every pot to zero and the trader is told', async () => {
    const { deps, m } = setup();
    addInflow(deps.db, m.id, takingsFor(1004), midday);
    expect((await runSweepForMerchant(deps, m.id, DATE))!.status).toBe('SETTLED');
    expect(pots(deps.db, m.id).total).toBe(1004n);
    deps.advance(61_000);
    await requeryDue(deps);
    expect(getSweep(deps.db, m.id, DATE)!.status).toBe('REVERSED');
    expect(pots(deps.db, m.id).total).toBe(0n);
    expect(ledgerProblems(deps.db)).toEqual([]);
    expect(deps.bank.accounts.get(m.bankAccount)!.balance).toBe(NAIRA(100_000)); // money is back
    expect(listMessages(deps.db, m.id).map((x) => x.kind)).toContain('SWEEP_REVERSED');
    expect(deps.db.prepare('SELECT first_contribution_at f FROM pension_accounts WHERE merchant_id = ?').get(m.id)).toEqual({ f: null });
  });

  it('.01 insufficient funds is final: FAILED, nothing posted', async () => {
    const { deps, m } = setup();
    addInflow(deps.db, m.id, takingsFor(1001), midday);
    expect((await runSweepForMerchant(deps, m.id, DATE))!).toMatchObject({ status: 'FAILED', failureReason: 'INSUFFICIENT_FUNDS' });
    expect(count(deps, 'SELECT COUNT(*) c FROM ledger_entries')).toBe(0);
  });

  it('crash before the bank answered, bank has the transfer: requery settles it without a second transfer', async () => {
    const { deps, m } = setup();
    addInflow(deps.db, m.id, NAIRA(1000), midday);
    deps.bank.fail('transfer', 'TIMEOUT'); // the call "lost" its response
    const first = (await runSweepForMerchant(deps, m.id, DATE))!;
    expect(first.status).toBe('UNKNOWN');
    // The bank DID process it (simulate by sending the same request directly).
    const ne = await deps.bank.nameEnquiry('0123456793');
    await deps.bank.transfer({ sourceAccount: m.bankAccount, destinationAccount: '0123456793', nameEnquiryRef: ne.nameEnquiryRef, amount: first.sweep, narration: 'x', reference: first.bankReference, idempotencyKey: first.idempotencyKey });
    deps.advance(31_000);
    expect((await runSweepForMerchant(deps, m.id, DATE))!.status).toBe('SETTLED');
    expect(deps.bank.transfers).toHaveLength(1);
  });

  it('crash before the bank saw anything: the bank has no record, so the SAME request is sent once', async () => {
    const { deps, m } = setup();
    addInflow(deps.db, m.id, NAIRA(1000), midday);
    deps.bank.fail('nameEnquiry', 'UNAVAILABLE');
    const s = (await runSweepForMerchant(deps, m.id, DATE))!;
    expect(s.status).toBe('SUBMITTED');
    expect(deps.bank.transfers).toHaveLength(0);
    deps.advance(20_000);
    expect((await runSweepForMerchant(deps, m.id, DATE))!.status).toBe('SETTLED');
    expect(deps.bank.transfers).toHaveLength(1);
    expect(deps.bank.transfers[0].idempotencyKey).toBe(s.idempotencyKey);
  });

  it('a transfer.reversed webhook on a settled sweep reverses it; replaying the webhook changes nothing', async () => {
    const { deps, m } = setup();
    addInflow(deps.db, m.id, NAIRA(1000), midday);
    const s = (await runSweepForMerchant(deps, m.id, DATE))!;
    const rev = { reference: s.bankReference, status: 'reversed' as const, amount: s.sweep, fee: 0n, vat: 0n, stampDuty: 0n, totalDebit: s.sweep };
    applyResult(deps, s.id, rev);
    applyResult(deps, s.id, rev);
    expect(getSweep(deps.db, m.id, DATE)!.status).toBe('REVERSED');
    expect(pots(deps.db, m.id).total).toBe(0n);
    expect(count(deps, `SELECT COUNT(*) c FROM messages WHERE kind = 'SWEEP_REVERSED'`)).toBe(1);
  });
});

describe('SweepGuard holds only the flagged credit', () => {
  it('sweeps the rest, raises an alert, and ops can dismiss (counts next window) or confirm (excluded for good)', async () => {
    const { deps, m } = setup();
    (deps as any).guard = new ThresholdGuard(NAIRA(1_000_000));
    addInflow(deps.db, m.id, NAIRA(1000), midday);
    const big = addInflow(deps.db, m.id, NAIRA(3_000_000), midday);
    const s = (await runSweepForMerchant(deps, m.id, DATE))!;
    expect(s).toMatchObject({ status: 'SETTLED', takings: NAIRA(1000), sweep: NAIRA(20) });
    const [alert] = listAlerts(deps.db, 'PENDING_REVIEW');
    expect(alert).toMatchObject({ inflowId: big, sweepId: s.id, type: 'ANOMALY' });
    expect(listMessages(deps.db, m.id).map((x) => x.kind)).toContain('CREDIT_HELD');

    resolveAlert(deps.db, alert.id, 'DISMISS', 'ops@kobo', 'verified with the trader', AFTER_CUTOFF);
    (deps as any).guard = { evaluate: async () => [] };
    deps.setNow(new Date('2026-11-14T22:05:00Z'));
    expect((await runSweepForMerchant(deps, m.id, '2026-11-14'))!.takings).toBe(NAIRA(3_000_000)); // released credit counts in the next window
    expect(() => resolveAlert(deps.db, alert.id, 'CONFIRM', 'x', null, AFTER_CUTOFF)).toThrow(/already/);
  });

  it('a confirmed hold is excluded forever, and a day of only held credits is HELD_GUARD', async () => {
    const { deps, m } = setup();
    (deps as any).guard = new ThresholdGuard(NAIRA(1000));
    addInflow(deps.db, m.id, NAIRA(5000), midday);
    const s = (await runSweepForMerchant(deps, m.id, DATE))!;
    expect(s).toMatchObject({ status: 'HELD_GUARD', takings: 0n });
    expect(deps.bank.calls.transfer).toBe(0);
    const [a] = listAlerts(deps.db);
    resolveAlert(deps.db, a.id, 'CONFIRM', 'ops@kobo', null, AFTER_CUTOFF);
    (deps as any).guard = { evaluate: async () => [] };
    deps.setNow(new Date('2026-11-14T22:05:00Z'));
    expect((await runSweepForMerchant(deps, m.id, '2026-11-14'))!.status).toBe('SKIPPED_ZERO_SALES');
  });
});

describe('nightly batch', () => {
  it('refuses to run before the cutoff unless allowed, and sweeps many merchants with unique, gap-free PEN references', async () => {
    const deps = makeDeps({ now: midday });
    await expect(runBatch(deps, DATE)).rejects.toMatchObject({ code: 'WINDOW_STILL_OPEN' });
    for (let i = 0; i < 40; i++) {
      const m = fundedMerchant(deps);
      addInflow(deps.db, m.id, NAIRA(1000 + i * 50), midday);
    }
    deps.setNow(AFTER_CUTOFF);
    const r: any = await runBatch(deps, DATE);
    expect(r.byStatus).toEqual({ SETTLED: 40 });
    expect(r.errors).toBe(0);
    const refs = (deps.db.prepare('SELECT pension_reference r FROM sweeps ORDER BY pension_reference').all() as { r: string }[]).map((x) => x.r);
    expect(refs).toEqual(Array.from({ length: 40 }, (_, i) => `PEN-20261113-${String(i + 1).padStart(6, '0')}`));
    expect(ledgerProblems(deps.db)).toEqual([]);
    const again: any = await runBatch(deps, DATE);
    expect(again.byStatus).toEqual({ SETTLED: 40 });
    expect(deps.bank.transfers).toHaveLength(40);
  });
});
