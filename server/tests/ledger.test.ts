import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db';
import { balanceOf, ledgerProblems, pots, postGroup, reverseSweepGroups, settleSweepGroups } from '../src/ledger/ledger';
import { splitSweep, computeSweepAmount, applyBuffer } from '../src/split/engine';
import { nextPenReference, recordContribution } from '../src/arm/simulator';
import { makeMerchant, T0 } from './helpers';

function setup() {
  const db = openDb();
  const m = makeMerchant(db);
  db.prepare(`INSERT INTO sweeps (id, merchant_id, sweep_date, window_start, window_end, takings_kobo, rate_bps, status, idempotency_key, bank_reference, created_at, updated_at)
              VALUES ('s1', ?, '2026-11-13', 'a', 'b', 0, 200, 'PLANNED', 'k', 'r', 'x', 'x')`).run(m.id);
  return { db, m };
}
const args = (m: { id: string }, sweep: bigint) => ({ sweepId: 's1', merchantId: m.id, reference: 'PEN-20261113-000001', sweep, split: splitSweep(sweep), at: T0 });

describe('ledger', () => {
  it('posts a settled sweep as balanced groups and derives the pots from the entries', () => {
    const { db, m } = setup();
    for (const g of settleSweepGroups(args(m, 60_000n))) expect(postGroup(db, g)).toBe(true);
    expect(pots(db, m.id)).toEqual({ emergency: 30_000n, retirement: 30_000n, total: 60_000n });
    expect(balanceOf(db, m.id, 'MERCHANT_BANK')).toBe(-60_000n);
    expect(ledgerProblems(db)).toEqual([]);
  });
  it('is idempotent: replaying a settlement posts nothing twice', () => {
    const { db, m } = setup();
    for (const g of settleSweepGroups(args(m, 60_000n))) postGroup(db, g);
    for (const g of settleSweepGroups(args(m, 60_000n))) expect(postGroup(db, g)).toBe(false);
    expect(pots(db, m.id).total).toBe(60_000n);
  });
  it('a reversal posts the exact contra entries and returns every pot to zero', () => {
    const { db, m } = setup();
    for (const g of settleSweepGroups(args(m, 60_001n))) postGroup(db, g);
    for (const g of reverseSweepGroups(args(m, 60_001n))) postGroup(db, g);
    expect(pots(db, m.id).total).toBe(0n);
    expect(balanceOf(db, m.id, 'MERCHANT_BANK')).toBe(0n);
    expect(ledgerProblems(db)).toEqual([]);
  });
  it('rejects unbalanced groups, zero lines, and edits or deletes', () => {
    const { db, m } = setup();
    const base = { groupId: 'g', merchantId: m.id, reference: 'r', at: T0 };
    expect(() => postGroup(db, { ...base, lines: [{ account: 'EMERGENCY_POT', amount: 5n }, { account: 'PFA_COLLECTION', amount: -4n }] })).toThrow(/sum to zero/);
    expect(() => postGroup(db, { ...base, lines: [{ account: 'EMERGENCY_POT', amount: 0n }, { account: 'PFA_COLLECTION', amount: 0n }] })).toThrow(/zero/);
    for (const g of settleSweepGroups(args(m, 100n))) postGroup(db, g);
    expect(() => db.prepare('UPDATE ledger_entries SET amount_kobo = 1').run()).toThrow(/immutable/);
    expect(() => db.prepare('DELETE FROM ledger_entries').run()).toThrow(/immutable/);
  });
  it('a 1-kobo sweep puts the odd kobo in retirement and skips the zero line', () => {
    const { db, m } = setup();
    for (const g of settleSweepGroups(args(m, 1n))) postGroup(db, g);
    expect(pots(db, m.id)).toEqual({ emergency: 0n, retirement: 1n, total: 1n });
  });
});

describe('split engine edge cases', () => {
  it('rounds down to the kobo and caps', () => {
    expect(computeSweepAmount({ takings: 49n, rateHundredths: 200n, dailyCap: 500_000n }).sweep).toBe(0n);
    expect(computeSweepAmount({ takings: 50n, rateHundredths: 200n, dailyCap: 500_000n }).sweep).toBe(1n);
    expect(computeSweepAmount({ takings: 3_000_000_00n, rateHundredths: 200n, dailyCap: 500_000n })).toMatchObject({ sweep: 500_000n, capApplied: true });
    expect(computeSweepAmount({ takings: 10_000n, rateHundredths: 200n, dailyCap: 0n }).sweep).toBe(0n);
  });
  it('buffer: reduce, never below zero', () => {
    expect(applyBuffer({ sweep: 600n, balance: 1_000n, buffer: 500n })).toBe(500n);
    expect(applyBuffer({ sweep: 600n, balance: 500n, buffer: 500n })).toBe(0n);
    expect(applyBuffer({ sweep: 600n, balance: 100n, buffer: 500n })).toBe(0n);
  });
});

describe('ARM simulator', () => {
  it('issues unique, gap-free references per sweep date, and only the first contribution starts the vesting clock', () => {
    const { db, m } = setup();
    expect(nextPenReference(db, '2026-11-13')).toBe('PEN-20261113-000001');
    expect(nextPenReference(db, '2026-11-13')).toBe('PEN-20261113-000002');
    expect(nextPenReference(db, '2026-11-14')).toBe('PEN-20261114-000001');
    recordContribution(db, m.id, new Date('2026-11-13T22:00:00Z'));
    recordContribution(db, m.id, new Date('2026-12-01T22:00:00Z'));
    const r = db.prepare('SELECT first_contribution_at f, rsa_pin p FROM pension_accounts WHERE merchant_id = ?').get(m.id) as any;
    expect(r.f).toBe('2026-11-13T22:00:00.000Z');
    expect(r.p).toMatch(/^PEN\d{12}$/);
  });
});
