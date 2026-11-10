import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { withTx } from '../src/db/pool';
import { assertBalanced, ledgerBalances, postJournal, reverseLines, sweepJournalLines, withdrawalJournalLines } from '../src/ledger/ledger';
import { creditContribution, issueRsaPin, reservePenReference } from '../src/pfa/simulator';
import { applyBuffer, computeSweepAmount, splitSweep } from '../src/split/engine';
import { makeMerchant, makeTrader, resetDb, testPool } from './helpers';

describe('split engine (pure)', () => {
  it('splits evenly', () => {
    expect(splitSweep(90_000n)).toEqual({ emergency: 45_000n, retirement: 45_000n });
  });

  it('gives the odd kobo to retirement', () => {
    expect(splitSweep(90_001n)).toEqual({ emergency: 45_000n, retirement: 45_001n });
    expect(splitSweep(1n)).toEqual({ emergency: 0n, retirement: 1n });
  });

  it('always adds back up to the sweep, for any amount', () => {
    for (const s of [1n, 2n, 3n, 99n, 100n, 12_345n, 4_999_999n, 500_000n]) {
      const { emergency, retirement } = splitSweep(s);
      expect(emergency + retirement).toBe(s);
      expect(retirement - emergency).toBeGreaterThanOrEqual(0n);
      expect(retirement - emergency).toBeLessThanOrEqual(1n);
    }
  });

  it('rejects zero and negative sweeps', () => {
    expect(() => splitSweep(0n)).toThrow(/greater than zero/);
    expect(() => splitSweep(-5n)).toThrow();
  });

  it('computes min(takings x rate, cap)', () => {
    const base = { takings: 4_500_000n, rateHundredths: 200n, dailyCap: 500_000n };
    expect(computeSweepAmount(base)).toEqual({ sweep: 90_000n, uncapped: 90_000n, capApplied: false });
    // N400,000 @ 2% = N8,000 but the cap is N5,000
    expect(computeSweepAmount({ ...base, takings: 40_000_000n })).toEqual({ sweep: 500_000n, uncapped: 800_000n, capApplied: true });
    expect(computeSweepAmount({ ...base, takings: 0n }).sweep).toBe(0n);
  });

  it('shrinks the sweep to protect the working-capital buffer', () => {
    // balance N1,500, buffer N1,000 -> at most N500 can leave
    expect(applyBuffer({ sweep: 90_000n, balance: 150_000n, buffer: 100_000n })).toBe(50_000n);
    expect(applyBuffer({ sweep: 90_000n, balance: 500_000n, buffer: 100_000n })).toBe(90_000n);
    expect(applyBuffer({ sweep: 90_000n, balance: 100_000n, buffer: 100_000n })).toBe(0n);
    expect(applyBuffer({ sweep: 90_000n, balance: 20_000n, buffer: 100_000n })).toBe(0n);
  });
});

describe('ledger lines', () => {
  it('builds a balanced sweep journal and omits zero legs', () => {
    const lines = sweepJournalLines(90_001n, splitSweep(90_001n));
    expect(lines).toEqual([
      { accountType: 'MERCHANT_CASH', entryType: 'DEBIT', amount: 90_001n },
      { accountType: 'EMERGENCY_POT', entryType: 'CREDIT', amount: 45_000n },
      { accountType: 'RETIREMENT_POT', entryType: 'CREDIT', amount: 45_001n },
    ]);
    expect(() => assertBalanced(lines)).not.toThrow();
    expect(sweepJournalLines(1n, splitSweep(1n)).map((l) => l.accountType)).toEqual(['MERCHANT_CASH', 'RETIREMENT_POT']);
  });

  it('refuses an inconsistent split and unbalanced lines', () => {
    expect(() => sweepJournalLines(100n, { emergency: 40n, retirement: 50n })).toThrow();
    expect(() => assertBalanced([{ accountType: 'MERCHANT_CASH', entryType: 'DEBIT', amount: 5n }])).toThrow(/Unbalanced/);
  });

  it('reversal mirrors every line', () => {
    const w = withdrawalJournalLines(50_000n);
    const r = reverseLines(w);
    expect(r.map((l) => l.entryType)).toEqual(['CREDIT', 'DEBIT']);
    expect(() => assertBalanced([...w, ...r])).not.toThrow();
  });
});

describe('ledger + PFA simulator (database)', () => {
  const pool = testPool();
  beforeEach(() => resetDb(pool));
  afterAll(() => pool.end());

  it('posts a sweep and derives balances purely from the ledger', async () => {
    const m = await makeMerchant(pool);
    await withTx(pool, (c) => postJournal(c, { merchantId: m.id, reference: 'PEN-1', lines: sweepJournalLines(90_000n, splitSweep(90_000n)) }));
    await withTx(pool, (c) => postJournal(c, { merchantId: m.id, reference: 'WDR-1', lines: withdrawalJournalLines(20_000n) }));
    const b = await ledgerBalances(pool, m.id);
    expect(b.EMERGENCY_POT).toBe(25_000n); // 45,000 in - 20,000 out
    expect(b.RETIREMENT_POT).toBe(45_000n);
    expect(b.MERCHANT_CASH).toBe(-70_000n); // 90,000 left, 20,000 came back
  });

  it('rolls the journal back with the surrounding transaction', async () => {
    const m = await makeMerchant(pool);
    await expect(
      withTx(pool, async (c) => {
        await postJournal(c, { merchantId: m.id, reference: 'X', lines: sweepJournalLines(100n, splitSweep(100n)) });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect((await ledgerBalances(pool, m.id)).RETIREMENT_POT).toBe(0n);
  });

  it('issues one RSA PIN per merchant, idempotently, in the PRD format', async () => {
    const m = await makeMerchant(pool);
    const a = await issueRsaPin(pool, m.id);
    const b = await issueRsaPin(pool, m.id);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.rsaPin).toBe(a.rsaPin);
    expect(a.rsaPin).toMatch(/^PEN\d{12}$/);
    await expect(issueRsaPin(pool, randomUUID())).rejects.toMatchObject({ code: 'MERCHANT_NOT_FOUND', status: 404 });
  });

  it('concurrent RSA issuance still yields exactly one PIN', async () => {
    const m = await makeMerchant(pool);
    const results = await Promise.all(Array.from({ length: 8 }, () => issueRsaPin(pool, m.id)));
    expect(new Set(results.map((r) => r.rsaPin)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
  });

  it('reserves PEN references: idempotent per merchant+date, sequential per date', async () => {
    const a = await makeMerchant(pool);
    const b = await makeMerchant(pool);
    const a1 = await reservePenReference(pool, a.id, '2026-11-06');
    expect(a1).toBe('PEN-20261106-000001');
    expect(await reservePenReference(pool, a.id, '2026-11-06')).toBe(a1); // same call, same reference
    expect(await reservePenReference(pool, b.id, '2026-11-06')).toBe('PEN-20261106-000002');
    expect(await reservePenReference(pool, a.id, '2026-11-07')).toBe('PEN-20261107-000001'); // counter resets per date
  });

  it('never hands out the same reference twice under concurrency', async () => {
    const merchants = await Promise.all(Array.from({ length: 25 }, () => makeMerchant(pool)));
    const refs = await Promise.all(merchants.map((m) => reservePenReference(pool, m.id, '2026-11-06')));
    expect(new Set(refs).size).toBe(25);
    const again = await Promise.all(merchants.map((m) => reservePenReference(pool, m.id, '2026-11-06')));
    expect(again).toEqual(refs);
  });

  it('credits both pots and starts the vesting clock only once', async () => {
    const m = await makeTrader(pool);
    const t1 = new Date('2026-11-06T22:00:00Z');
    const r1 = await creditContribution(pool, m.id, splitSweep(90_001n), t1);
    expect(r1).toEqual({ emergency: 45_000n, retirement: 45_001n });
    await creditContribution(pool, m.id, splitSweep(100n), new Date('2026-11-07T22:00:00Z'));
    const { rows } = await pool.query('SELECT first_contribution_at, emergency_balance::text e FROM pension_accounts WHERE merchant_id=$1', [m.id]);
    expect(rows[0].first_contribution_at.toISOString()).toBe(t1.toISOString());
    expect(rows[0].e).toBe('450.50');
  });

  it('refuses to credit a merchant that has no RSA', async () => {
    const m = await makeMerchant(pool);
    await expect(creditContribution(pool, m.id, splitSweep(100n), new Date())).rejects.toMatchObject({ code: 'PENSION_ACCOUNT_MISSING' });
  });
});
