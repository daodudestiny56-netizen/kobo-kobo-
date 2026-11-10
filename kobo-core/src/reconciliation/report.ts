import type { Deps } from '../deps';
import { lateHour } from '../time';
import { dbToKobo, koboToNaira, type Kobo } from '../money';

export type FlagCode =
  | 'MISSING_DEBIT' // we say EXECUTED, the bank has no debit
  | 'AMOUNT_MISMATCH' // bank debit differs from the sweep amount
  | 'ORPHAN_DEBIT' // bank debit with no EXECUTED sweep behind it
  | 'LEDGER_MISMATCH' // journal for the sweep does not equal the sweep amount/split
  | 'STUCK_SWEEP' // PENDING: debit not confirmed yet
  | 'FAILED_SWEEP'
  | 'POT_DRIFT' // pension_accounts balance differs from the ledger
  | 'HELD_FOR_REVIEW' // Sweep Guard hold waiting for a decision
  | 'PENDING_WITHDRAWAL';

export interface Flag {
  code: FlagCode;
  merchant_id: string;
  detail: string;
}

export interface ReconciliationReport {
  sweep_date: string;
  ok: boolean;
  totals: {
    merchants_with_sweep: number;
    executed_sweeps: number;
    total_takings: string;
    swept_per_core: string;
    debited_per_bank: string;
    credited_to_pots_per_ledger: string;
    difference_core_vs_bank: string;
  };
  /** Takings in the 23:00-24:00 hour: outside the PRD v2 window, so never swept. Informational, not a flag. */
  unswept_late_inflows: { count: number; total: string };
  flags: Flag[];
}

/** Compare, for one sweep date, what core recorded, what the bank did and what the ledger says. Read-only. */
export async function reconcile(deps: Deps, sweepDate: string): Promise<ReconciliationReport> {
  const flags: Flag[] = [];
  const add = (code: FlagCode, merchant_id: string, detail: string) => flags.push({ code, merchant_id, detail });

  const sweeps = (
    await deps.db.query(
      `SELECT id, merchant_id, status, total_takings::text AS takings, sweep_amount::text AS sweep,
              emergency_amount::text AS e, retirement_amount::text AS r
         FROM daily_sweeps WHERE sweep_date = $1`,
      [sweepDate],
    )
  ).rows;

  const ledger = (
    await deps.db.query(
      `SELECT sweep_id, account_type, entry_type, sum(amount)::text AS total
         FROM ledger_entries WHERE sweep_id IN (SELECT id FROM daily_sweeps WHERE sweep_date = $1)
        GROUP BY sweep_id, account_type, entry_type`,
      [sweepDate],
    )
  ).rows;
  const ledgerOf = (sweepId: string, account: string, type: string): Kobo => {
    const r = ledger.find((l) => l.sweep_id === sweepId && l.account_type === account && l.entry_type === type);
    return r ? dbToKobo(r.total) : 0n;
  };

  const bankDebits = new Map((await deps.executor.listDebits(sweepDate)).map((d) => [d.idempotencyKey, d]));
  const seenKeys = new Set<string>();

  let takings = 0n;
  let swept = 0n;
  let potCredits = 0n;
  let executed = 0;

  for (const s of sweeps) {
    const key = `sweep:${s.merchant_id}:${sweepDate}`;
    const bank = bankDebits.get(key);
    if (bank) seenKeys.add(key);
    const sweepAmt = dbToKobo(s.sweep);
    takings += dbToKobo(s.takings);

    if (s.status === 'EXECUTED') {
      executed++;
      swept += sweepAmt;
      const e = ledgerOf(s.id, 'EMERGENCY_POT', 'CREDIT');
      const r = ledgerOf(s.id, 'RETIREMENT_POT', 'CREDIT');
      potCredits += e + r;
      if (ledgerOf(s.id, 'MERCHANT_CASH', 'DEBIT') !== sweepAmt || e !== dbToKobo(s.e) || r !== dbToKobo(s.r) || e + r !== sweepAmt) {
        add('LEDGER_MISMATCH', s.merchant_id, `sweep ${koboToNaira(sweepAmt)} but ledger credits ${koboToNaira(e)} + ${koboToNaira(r)}`);
      }
      if (!bank) add('MISSING_DEBIT', s.merchant_id, `sweep ${koboToNaira(sweepAmt)} is EXECUTED but the bank has no debit`);
      else if (bank.amount !== sweepAmt) add('AMOUNT_MISMATCH', s.merchant_id, `sweep ${koboToNaira(sweepAmt)} vs bank ${koboToNaira(bank.amount)}`);
    } else if (s.status === 'PENDING') {
      add('STUCK_SWEEP', s.merchant_id, bank ? 'bank debited but core never settled it (call /sweeps/settle or re-run)' : 'debit outcome not yet known');
    } else if (s.status === 'HELD_GUARD') {
      const open = await deps.db.query(`SELECT alert_type FROM sweep_guard_alerts WHERE sweep_id = $1 AND status = 'PENDING_REVIEW'`, [s.id]);
      if (open.rows[0]) add('HELD_FOR_REVIEW', s.merchant_id, `held by Sweep Guard (${open.rows[0].alert_type}), takings ${koboToNaira(dbToKobo(s.takings))} not swept`);
    } else if (s.status === 'FAILED') {
      add('FAILED_SWEEP', s.merchant_id, 'bank refused the debit');
    }
    if (bank && s.status !== 'EXECUTED' && s.status !== 'PENDING') {
      add('ORPHAN_DEBIT', s.merchant_id, `bank debited ${koboToNaira(bank.amount)} but sweep is ${s.status}`);
    }
  }

  let bankTotal = 0n;
  for (const [key, d] of bankDebits) {
    bankTotal += d.amount;
    if (!seenKeys.has(key)) add('ORPHAN_DEBIT', key.split(':')[1] ?? '', `bank debit ${key} (${koboToNaira(d.amount)}) has no sweep record`);
  }

  // Pots vs ledger, all time, only merchants whose books are touched by this date or that drift.
  const drift = await deps.db.query(
    `SELECT p.merchant_id,
            p.emergency_balance::text AS e, p.retirement_balance::text AS r,
            COALESCE(sum(CASE WHEN l.account_type='EMERGENCY_POT'  THEN CASE l.entry_type WHEN 'CREDIT' THEN l.amount ELSE -l.amount END END),0)::text AS le,
            COALESCE(sum(CASE WHEN l.account_type='RETIREMENT_POT' THEN CASE l.entry_type WHEN 'CREDIT' THEN l.amount ELSE -l.amount END END),0)::text AS lr
       FROM pension_accounts p LEFT JOIN ledger_entries l ON l.merchant_id = p.merchant_id
      GROUP BY p.merchant_id, p.emergency_balance, p.retirement_balance
     HAVING p.emergency_balance <> COALESCE(sum(CASE WHEN l.account_type='EMERGENCY_POT'  THEN CASE l.entry_type WHEN 'CREDIT' THEN l.amount ELSE -l.amount END END),0)
         OR p.retirement_balance <> COALESCE(sum(CASE WHEN l.account_type='RETIREMENT_POT' THEN CASE l.entry_type WHEN 'CREDIT' THEN l.amount ELSE -l.amount END END),0)`,
  );
  for (const d of drift.rows) add('POT_DRIFT', d.merchant_id, `pots ${d.e}/${d.r} vs ledger ${d.le}/${d.lr}`);

  const pend = await deps.db.query(
    `SELECT p.merchant_id, w.id, w.amount::text AS amount FROM emergency_withdrawals w JOIN pension_accounts p ON p.id = w.pension_account_id WHERE w.status = 'PENDING'`,
  );
  for (const w of pend.rows) add('PENDING_WITHDRAWAL', w.merchant_id, `withdrawal ${w.id} of ${w.amount} awaiting bank confirmation`);

  const lh = lateHour(sweepDate);
  const late = (
    await deps.db.query(
      `SELECT count(*)::int AS n, COALESCE(sum(amount),0)::text AS total FROM inflow_transactions
        WHERE NOT is_excluded_from_sweep AND settled_at >= $1 AND settled_at < $2`,
      [lh.from, lh.to],
    )
  ).rows[0];

  return {
    sweep_date: sweepDate,
    ok: flags.length === 0,
    totals: {
      merchants_with_sweep: sweeps.length,
      executed_sweeps: executed,
      total_takings: koboToNaira(takings),
      swept_per_core: koboToNaira(swept),
      debited_per_bank: koboToNaira(bankTotal),
      credited_to_pots_per_ledger: koboToNaira(potCredits),
      difference_core_vs_bank: koboToNaira(swept - bankTotal),
    },
    unswept_late_inflows: { count: late.n, total: late.total },
    flags,
  };
}
