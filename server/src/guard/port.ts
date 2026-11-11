import type { Kobo } from '../money';

/**
 * SweepGuard (Tomiwa). Runs before every sweep, per merchant, and may flag individual credits. Only the flagged
 * credits are held out of takings: the rest of the day still sweeps (PRD 9.1). Statistics, not an LLM, decide.
 */
export interface GuardInflow {
  id: string;
  bankReference: string;
  amount: Kobo;
  settledAt: Date;
}

export interface GuardContext {
  merchantId: string;
  sweepDate: string;
  inflows: GuardInflow[];
}

export type GuardFlagType = 'ANOMALY' | 'DUPLICATE' | 'NAME_MISMATCH';

export interface GuardFlag {
  inflowId: string;
  type: GuardFlagType;
  details: Record<string, unknown>;
}

export interface SweepGuard {
  evaluate(ctx: GuardContext): Promise<GuardFlag[]>;
}

export class AllowAllGuard implements SweepGuard {
  async evaluate(): Promise<GuardFlag[]> {
    return [];
  }
}

/** Placeholder rule until the statistical guard lands: hold any single credit at or above a ceiling. */
export class ThresholdGuard implements SweepGuard {
  constructor(private readonly ceiling: Kobo) {}
  async evaluate(ctx: GuardContext): Promise<GuardFlag[]> {
    return ctx.inflows
      .filter((i) => i.amount >= this.ceiling)
      .map((i) => ({ inflowId: i.id, type: 'ANOMALY' as const, details: { rule: 'above_ceiling', ceiling_kobo: this.ceiling.toString(), amount_kobo: i.amount.toString() } }));
  }
}
