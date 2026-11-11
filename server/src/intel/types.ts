// SweepGuard and SmartRate as pure functions for the Node app. Ported from the Python reference in kobo_ai_kit
// (kobo_ai_service.py for SweepGuard, smart_rate.py for SmartRate). Money is integer KOBO. Times are ISO-8601 UTC.
// Days are WAT sweep days "YYYY-MM-DD" (the sweep window ends at the 23:00 WAT cutoff: a credit at 23:30 belongs to the
// NEXT sweep day). No I/O, no clock, no network, no randomness except a seeded PRNG: the same input always gives the same output.

// ----------------------------------------------------------------------------- SweepGuard
/** One counted credit in the sweep window (loans, own transfers, withdrawals and reversals are NOT counted). */
export interface Credit {
  reference: string;       // bank_reference
  amountKobo: number;      // integer kobo, > 0
  at: string;              // ISO-8601 UTC
  sender?: string;         // optional: enables look-alike duplicate detection
  narration?: string;
}

/** A credit that was counted in an earlier sweep (trailing 30+ sweep days; the October statements bootstrap this). */
export interface PastCredit { day: string; amountKobo: number }

export type Severity = 'LOW' | 'MEDIUM' | 'HIGH';
export type AlertType = 'ANOMALOUS_INFLOW' | 'SUSPECTED_DUPLICATE';

export interface SweepGuardInput {
  sweepDate: string;                         // "YYYY-MM-DD"
  credits: Credit[];
  history: PastCredit[];                     // the function ignores anything outside the 30 sweep days before sweepDate
  seenReferences?: Record<string, string>;   // reference -> sweep day it was already counted on (replay detection)
  mode?: 'partial' | 'whole';                // default 'partial' (PRD v3 9.1): only flagged credits are excluded
  minSeverity?: 'MEDIUM' | 'HIGH';           // anomaly severity that excludes/holds. Default MEDIUM (partial) / HIGH (whole)
}

export interface ExcludedCredit {
  reference: string;
  alertType: AlertType;
  severity: Severity;
  score: number;                             // 0..1, for the ops dashboard
  reason: string;                            // plain English for ops
}

export interface SweepGuardResult {
  verdict: 'CLEAR' | 'HOLD';                 // HOLD = at least one credit excluded (partial) / the whole sweep blocked (whole)
  alertType?: AlertType;                     // the most severe alert
  sweepableReferences: string[];             // what may be swept (all credits when CLEAR; none when mode 'whole' + HOLD)
  sweepableKobo: number;                     // sum of the above
  excluded: ExcludedCredit[];
  excludedKobo: number;
  ignoredDuplicates: string[];               // exact duplicate references: counted once, no alarm
}

export type EvaluateSweepGuard = (input: SweepGuardInput) => SweepGuardResult;

// ----------------------------------------------------------------------------- SmartRate
/** One row per day WITH sales. Days with no row count as zero-sales days from firstDay up to asOf. */
export interface DailyTakings { day: string; amountKobo: number }

export interface PastSuggestion {            // optional: only if the app wants the engine to apply cooldown rules itself
  createdAt: string;
  direction: 'INCREASE' | 'DECREASE';
  status: 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'EXPIRED';
  respondedAt?: string;
  expiresAt?: string;
}

export interface SmartRateInput {
  merchantId: string;                        // seeds the deterministic bootstrap (merchantId + asOf)
  asOf: string;                              // last COMPLETE sweep day
  firstDay: string;                          // first day the merchant could trade
  currentRate: number;                       // percent, e.g. 2 or 2.5
  takings: DailyTakings[];
  isPaused?: boolean;
  dailyCapKobo?: number;                     // default 500_000 (N5,000)
  recentSuggestions?: PastSuggestion[];
  now?: string;                              // ISO UTC; only used with recentSuggestions
}

export type Regime = 'INSUFFICIENT_DATA' | 'INACTIVE' | 'TEMPORARY_DISRUPTION' | 'DECLINING' | 'VOLATILE' | 'GROWING' | 'STABLE';

export interface SmartRateResult {
  action: 'INCREASE' | 'DECREASE' | 'HOLD';
  recommendedRate: number;                   // equals currentRate on HOLD; changes by one step (+0.5 / at most -1.0)
  holdReason: string | null;                 // e.g. INSUFFICIENT_DATA, TEMPORARY_DISRUPTION, SEASONAL_PEAK, DAILY_CAP_REACHED, COOLDOWN
  regime: Regime;
  confidence: number | null;                 // share of 500 re-samples that agree (max 0.99); null for rule-driven holds
  rationale: string;                         // plain English, safe to store as the suggestion `reason` (<= 500 chars once trimmed)
  monthlyChangeKobo: number | null;          // estimated change in monthly saving, respecting the daily cap
  metrics: {
    avgDailyTakingsKobo: number; medianActiveDayKobo: number; zeroSalesDaysLast14: number; zeroSalesDaysLast30: number;
    volatilityCv: number | null; trend14dVsPrior: number | null; regularDaysOff: string[];
  };
  checks: { name: string; passed: boolean; detail: string }[];   // the audit trail
}

export type SuggestRate = (input: SmartRateInput) => SmartRateResult;
