import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { withTx } from '../src/db/pool';
import { makeMerchant, makeTrader, resetDb, testPool } from './helpers';

const pool = testPool();
beforeEach(() => resetDb(pool));
afterAll(() => pool.end());

const insertSweep = (merchantId: string, date: string, status = 'SKIPPED_ZERO_SALES', extra: { ref?: string; amount?: string } = {}) =>
  pool.query(
    `INSERT INTO daily_sweeps (merchant_id, sweep_date, total_takings, applied_rate, sweep_amount, emergency_amount, retirement_amount, pension_reference, status)
     VALUES ($1,$2,0,2.00,$3,0,$3,$4,$5)`,
    [merchantId, date, extra.amount ?? '0.00', extra.ref ?? null, status],
  );

describe('schema invariants', () => {
  it('enforces one sweep per merchant per day', async () => {
    const m = await makeMerchant(pool);
    await insertSweep(m.id, '2026-11-06');
    await expect(insertSweep(m.id, '2026-11-06')).rejects.toThrow(/unique_merchant_sweep_per_day/);
    await insertSweep(m.id, '2026-11-07'); // other day is fine
  });

  it('allows many NULL pension references but keeps real ones unique', async () => {
    const a = await makeMerchant(pool);
    const b = await makeMerchant(pool);
    await insertSweep(a.id, '2026-11-06');
    await insertSweep(b.id, '2026-11-06'); // both NULL: fine
    await insertSweep(a.id, '2026-11-07', 'PENDING', { ref: 'PEN-20261107-000001', amount: '10.00' });
    await expect(insertSweep(b.id, '2026-11-07', 'PENDING', { ref: 'PEN-20261107-000001', amount: '10.00' })).rejects.toThrow(/pension_reference/);
  });

  it('refuses an EXECUTED sweep that has no reference or no money', async () => {
    const m = await makeMerchant(pool);
    await expect(insertSweep(m.id, '2026-11-06', 'EXECUTED', { amount: '10.00' })).rejects.toThrow(/chk_executed_ref/);
    await expect(insertSweep(m.id, '2026-11-06', 'EXECUTED', { ref: 'PEN-X', amount: '0.00' })).rejects.toThrow(/chk_executed_ref/);
  });

  it('refuses a split that does not add up', async () => {
    const m = await makeMerchant(pool);
    await expect(
      pool.query(
        `INSERT INTO daily_sweeps (merchant_id, sweep_date, total_takings, applied_rate, sweep_amount, emergency_amount, retirement_amount, status)
         VALUES ($1,'2026-11-06',45000,2.00,900,450,451,'PENDING')`,
        [m.id],
      ),
    ).rejects.toThrow(/chk_sweep_split/);
  });

  it('enforces sweep rate 1-5%, and unique bank references on inflows', async () => {
    await expect(makeMerchant(pool, { rate: '0.50' })).rejects.toThrow(/chk_rate/);
    await expect(makeMerchant(pool, { rate: '5.01' })).rejects.toThrow(/chk_rate/);
    const m = await makeMerchant(pool);
    const ins = () =>
      pool.query(`INSERT INTO inflow_transactions (merchant_id, bank_reference, amount, channel, settled_at) VALUES ($1,'HYD-1',100,'POS',now())`, [m.id]);
    await ins();
    await expect(ins()).rejects.toThrow(/bank_reference/);
  });

  it('keeps one RSA per merchant', async () => {
    const m = await makeTrader(pool);
    await expect(
      pool.query(`INSERT INTO pension_accounts (merchant_id, rsa_pin) VALUES ($1,'PEN999')`, [m.id]),
    ).rejects.toThrow(/merchant_id/);
  });
});

describe('ledger', () => {
  const lines = (journal: string, merchant: string, rows: Array<[string, 'DEBIT' | 'CREDIT', string]>) =>
    rows.map(([account, type, amount]) => [journal, merchant, account, type, amount, 'REF'] as const);

  async function post(rows: ReturnType<typeof lines>) {
    await withTx(pool, async (c) => {
      for (const r of rows) {
        await c.query(
          `INSERT INTO ledger_entries (journal_id, merchant_id, account_type, entry_type, amount, reference) VALUES ($1,$2,$3,$4,$5,$6)`,
          [...r],
        );
      }
    });
  }

  it('accepts a balanced journal', async () => {
    const m = await makeMerchant(pool);
    await post(lines(randomUUID(), m.id, [['MERCHANT_CASH', 'DEBIT', '900.00'], ['EMERGENCY_POT', 'CREDIT', '450.00'], ['RETIREMENT_POT', 'CREDIT', '450.00']]));
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM ledger_entries');
    expect(rows[0].n).toBe(3);
  });

  it('rejects an unbalanced journal at commit', async () => {
    const m = await makeMerchant(pool);
    await expect(
      post(lines(randomUUID(), m.id, [['MERCHANT_CASH', 'DEBIT', '900.00'], ['EMERGENCY_POT', 'CREDIT', '450.00'], ['RETIREMENT_POT', 'CREDIT', '449.99']])),
    ).rejects.toThrow(/unbalanced journal/);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM ledger_entries');
    expect(rows[0].n).toBe(0);
  });

  it('is immutable: no UPDATE, no DELETE', async () => {
    const m = await makeMerchant(pool);
    await post(lines(randomUUID(), m.id, [['MERCHANT_CASH', 'DEBIT', '10.00'], ['EMERGENCY_POT', 'CREDIT', '10.00']]));
    await expect(pool.query(`UPDATE ledger_entries SET amount = 1`)).rejects.toThrow(/immutable/);
    await expect(pool.query(`DELETE FROM ledger_entries`)).rejects.toThrow(/immutable/);
  });

  it('rejects zero/negative amounts and duplicate lines in a journal', async () => {
    const m = await makeMerchant(pool);
    await expect(post(lines(randomUUID(), m.id, [['MERCHANT_CASH', 'DEBIT', '0.00']]))).rejects.toThrow(/chk_ledger_amount/);
    const j = randomUUID();
    await expect(
      post(lines(j, m.id, [['MERCHANT_CASH', 'DEBIT', '5.00'], ['MERCHANT_CASH', 'DEBIT', '5.00'], ['EMERGENCY_POT', 'CREDIT', '10.00']])),
    ).rejects.toThrow(/uq_ledger_line/);
  });
});
