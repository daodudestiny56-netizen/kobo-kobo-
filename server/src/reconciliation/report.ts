import type { Deps } from '../deps';
import { ledgerProblems } from '../ledger/ledger';
import { toKobo } from '../money';

/**
 * What ops look at to know the books are right (PRD 15, GET /ops/reconciliation). Read-only.
 * `ok` is true only when nothing below needs a human.
 */
export async function reconciliationReport(deps: Deps) {
  const { db } = deps;
  const stuckBefore = new Date(deps.clock().getTime() - 15 * 60_000).toISOString();
  const rows = (sql: string, ...p: unknown[]) => db.prepare(sql).all(...p) as any[];

  const ledger = ledgerProblems(db);
  const sweepsByStatus = Object.fromEntries(rows('SELECT status, COUNT(*) n FROM sweeps GROUP BY status').map((r) => [r.status, r.n]));
  const stuckSweeps = rows(`SELECT id, merchant_id, sweep_date, status, attempts, last_error FROM sweeps WHERE status IN ('PLANNED','SUBMITTED','UNKNOWN') AND updated_at < ?`, stuckBefore);
  const stuckWithdrawals = rows(`SELECT id, merchant_id, status FROM withdrawals WHERE status IN ('REQUESTED','UNKNOWN') AND updated_at < ?`, stuckBefore);
  const settledWithoutLedger = rows(`SELECT id, merchant_id, sweep_date FROM sweeps s WHERE status = 'SETTLED' AND NOT EXISTS (SELECT 1 FROM ledger_entries WHERE group_id = s.id || ':allocate')`);
  const reversedWithoutLedger = rows(`SELECT id, merchant_id, sweep_date FROM sweeps s WHERE status = 'REVERSED' AND EXISTS (SELECT 1 FROM ledger_entries WHERE group_id = s.id || ':allocate') AND NOT EXISTS (SELECT 1 FROM ledger_entries WHERE group_id = s.id || ':reverse-allocate')`);
  const disbursedWithoutLedger = rows(`SELECT id, merchant_id FROM withdrawals w WHERE status = 'DISBURSED' AND NOT EXISTS (SELECT 1 FROM ledger_entries WHERE group_id = w.id || ':pay')`);

  // Money in the pots must equal what settled sweeps put in, less what withdrawals took out (reserved or paid).
  const sum = (sql: string) => toKobo((db.prepare(sql).get() as { s: number }).s);
  const inPots = sum(`SELECT COALESCE(SUM(amount_kobo),0) s FROM ledger_entries WHERE account IN ('EMERGENCY_POT','RETIREMENT_POT')`);
  const swept = sum(`SELECT COALESCE(SUM(sweep_kobo),0) s FROM sweeps WHERE status = 'SETTLED'`);
  const out = sum(`SELECT COALESCE(SUM(amount_kobo),0) s FROM withdrawals WHERE status IN ('REQUESTED','UNKNOWN','DISBURSED')`);
  const potDifference = inPots - (swept - out);

  const bank: { collectionAccount: string; balance?: bigint; error?: string } = { collectionAccount: deps.config.collectionAccount };
  try {
    bank.balance = await deps.bank.getBalance(deps.config.collectionAccount);
  } catch (e) {
    bank.error = (e as Error).message; // informational: an unreachable bank is not a ledger fault
  }

  const pendingReview = (db.prepare(`SELECT COUNT(*) n FROM guard_alerts WHERE status = 'PENDING_REVIEW'`).get() as { n: number }).n;
  const ok = !ledger.length && !stuckSweeps.length && !stuckWithdrawals.length && !settledWithoutLedger.length && !reversedWithoutLedger.length && !disbursedWithoutLedger.length && potDifference === 0n;
  return {
    ok,
    generatedAt: deps.clock(),
    ledger: { problems: ledger, potsTotal: inPots, sweptTotal: swept, withdrawnTotal: out, potDifference },
    sweeps: { byStatus: sweepsByStatus, stuck: stuckSweeps, settledWithoutLedger, reversedWithoutLedger },
    withdrawals: { stuck: stuckWithdrawals, disbursedWithoutLedger },
    guard: { pendingReview },
    bank,
  };
}
