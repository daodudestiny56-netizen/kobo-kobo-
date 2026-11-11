import type { Db } from '../db';
import { evaluateSweepGuard } from '../intel/sweepguard';
import { addDays, sweepCutoff, sweepDateOf, sweepWindow } from '../time';
import type { GuardContext, GuardFlag, SweepGuard } from './port';

/**
 * The statistical SweepGuard (PRD 9.1). Compares each credit with this trader's own last 30 sweep days and flags the
 * ones that are far outside it. Only the flagged credits are held out of takings; the rest of the day still sweeps.
 * `also` lets a fixed ceiling (GUARD_HOLD_ABOVE_NAIRA) run alongside the statistics.
 */
export class StatisticalGuard implements SweepGuard {
  constructor(
    private readonly db: Db,
    private readonly also: SweepGuard | null = null,
  ) {}

  async evaluate(ctx: GuardContext): Promise<GuardFlag[]> {
    const flags: GuardFlag[] = [];
    if (ctx.inflows.length) {
      const result = evaluateSweepGuard({
        sweepDate: ctx.sweepDate,
        credits: ctx.inflows.map((i) => ({ reference: i.bankReference, amountKobo: Number(i.amount), at: i.settledAt.toISOString() })),
        history: this.history(ctx),
        mode: 'partial',
      });
      const byReference = new Map(ctx.inflows.map((i) => [i.bankReference, i]));
      for (const e of result.excluded) {
        const inflow = byReference.get(e.reference);
        if (!inflow) continue;
        flags.push({
          inflowId: inflow.id,
          type: e.alertType === 'SUSPECTED_DUPLICATE' ? 'DUPLICATE' : 'ANOMALY',
          details: { reason: e.reason, severity: e.severity, score: e.score },
        });
      }
    }
    if (this.also) {
      const seen = new Set(flags.map((f) => f.inflowId));
      for (const f of await this.also.evaluate(ctx)) if (!seen.has(f.inflowId)) flags.push(f);
    }
    return flags;
  }

  /** Credits that settled before this sweep window, by the sweep day they belonged to. Held and confirmed credits never count. */
  private history(ctx: GuardContext): { day: string; amountKobo: number }[] {
    const since = sweepCutoff(addDays(ctx.sweepDate, -31)).toISOString();
    const until = sweepWindow(ctx.sweepDate).from.toISOString();
    const rows = this.db
      .prepare(
        `SELECT settled_at, amount_kobo FROM inflows
          WHERE merchant_id = ? AND counted = 1 AND (hold_status IS NULL OR hold_status = 'DISMISSED')
            AND settled_at >= ? AND settled_at < ?`,
      )
      .all(ctx.merchantId, since, until) as { settled_at: string; amount_kobo: number | bigint }[];
    return rows.map((r) => ({ day: sweepDateOf(new Date(r.settled_at)), amountKobo: Number(r.amount_kobo) }));
  }
}
