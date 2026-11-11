import { addDays } from './dates';
import type { AlertType, Credit, EvaluateSweepGuard, ExcludedCredit, Severity, SweepGuardInput, SweepGuardResult } from './types';

/**
 * SweepGuard: which of tonight's credits may be swept? Statistics decide, not a model. Ported from the Python
 * reference (kobo_ai_kit/kobo_ai_service.py). All amounts are integer kobo; the Python thresholds are in naira.
 *
 *  - exact duplicate references are ignored (counted once, no alarm);
 *  - a credit far above this trader's own pattern is an anomaly (robust z-score on log amounts);
 *  - with thin history (under 30 credits over 7 days) absolute thresholds apply;
 *  - look-alikes (same sender, amount and narration within 5 minutes) are flagged;
 *  - partial mode (default) excludes only the flagged credits; whole mode blocks the sweep.
 */
const NAIRA = 100;
export const GUARD = {
  windowDays: 30,
  minHistoryCredits: 30,
  minHistoryDays: 7,
  minFlagKobo: 100_000 * NAIRA,
  zFlag: 3,
  zHigh: 5,
  ratioHigh: 50,
  madFloor: 0.35,
  coldMediumKobo: 500_000 * NAIRA,
  coldHighKobo: 1_000_000 * NAIRA,
  lookalikeSeconds: 300,
};

const RANK: Record<Severity, number> = { LOW: 1, MEDIUM: 2, HIGH: 3 };
const naira = (kobo: number) => `₦${Math.round(kobo / NAIRA).toLocaleString('en-US')}`;
const median = (v: number[]): number => {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function anomaly(credit: Credit, amounts: number[], days: number): ExcludedCredit | null {
  const x = credit.amountKobo;
  if (x < GUARD.minFlagKobo) return null;
  if (amounts.length >= GUARD.minHistoryCredits && days >= GUARD.minHistoryDays) {
    const logs = amounts.map(Math.log);
    const center = median(logs);
    const scale = Math.max(median(logs.map((l) => Math.abs(l - center))) * 1.4826, GUARD.madFloor);
    const z = (Math.log(x) - center) / scale;
    if (z < GUARD.zFlag) return null;
    const typical = Math.exp(center);
    const ratio = x / typical;
    return {
      reference: credit.reference,
      alertType: 'ANOMALOUS_INFLOW',
      severity: z >= GUARD.zHigh || ratio >= GUARD.ratioHigh ? 'HIGH' : 'MEDIUM',
      score: Math.round(Math.min(0.99, 1 - Math.exp(-Math.max(z, 0) / 4)) * 100) / 100,
      reason: `${naira(x)} is ${Math.round(ratio).toLocaleString('en-US')}x this trader's typical sale (${naira(typical)}). Held until ops reviews it.`,
    };
  }
  const severity: Severity | null = x >= GUARD.coldHighKobo ? 'HIGH' : x >= GUARD.coldMediumKobo ? 'MEDIUM' : null;
  if (!severity) return null;
  return {
    reference: credit.reference,
    alertType: 'ANOMALOUS_INFLOW',
    severity,
    score: severity === 'HIGH' ? 0.9 : 0.6,
    reason: `${naira(x)} is unusually large for a trader with under ${GUARD.minHistoryDays} days of history. Held until ops reviews it.`,
  };
}

export const evaluateSweepGuard: EvaluateSweepGuard = (input: SweepGuardInput): SweepGuardResult => {
  const mode = input.mode ?? 'partial';
  const minRank = RANK[input.minSeverity ?? (mode === 'partial' ? 'MEDIUM' : 'HIGH')];
  const seen = input.seenReferences ?? {};

  // 1) exact duplicates: the same reference twice, or already counted on another day. Counted once, no alarm.
  const kept: Credit[] = [];
  const ignored: string[] = [];
  const inBatch = new Set<string>();
  for (const c of input.credits) {
    const earlier = seen[c.reference];
    if (inBatch.has(c.reference) || (earlier !== undefined && earlier !== input.sweepDate)) {
      ignored.push(c.reference);
      continue;
    }
    inBatch.add(c.reference);
    kept.push(c);
  }

  // 2) look-alikes: same sender + amount + narration within five minutes; the later one is held out.
  const groups = new Map<string, Credit[]>();
  for (const c of kept) {
    if (!c.sender || !c.narration) continue;
    const key = `${c.sender.trim().toLowerCase()}|${c.amountKobo}|${c.narration.trim().toLowerCase()}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const excluded = new Map<string, ExcludedCredit>();
  for (const list of groups.values()) {
    list.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    for (let i = 1; i < list.length; i++) {
      if (Date.parse(list[i].at) - Date.parse(list[i - 1].at) <= GUARD.lookalikeSeconds * 1000) {
        excluded.set(list[i].reference, {
          reference: list[i].reference,
          alertType: 'SUSPECTED_DUPLICATE',
          severity: 'MEDIUM',
          score: 0.6,
          reason: "Same sender, amount and narration as another credit within 5 minutes. Held out of tonight's sweep until ops reviews it.",
        });
      }
    }
  }

  // 3) statistical anomalies against the trader's own last 30 sweep days
  const from = addDays(input.sweepDate, -GUARD.windowDays);
  const past = input.history.filter((h) => h.day >= from && h.day < input.sweepDate);
  const amounts = past.map((h) => h.amountKobo);
  const days = new Set(past.map((h) => h.day)).size;
  for (const c of kept) {
    if (excluded.has(c.reference)) continue;
    const a = anomaly(c, amounts, days);
    if (a && RANK[a.severity] >= minRank) excluded.set(c.reference, a);
  }

  const out = kept.filter((c) => excluded.has(c.reference));
  const ok = kept.filter((c) => !excluded.has(c.reference));
  const total = (list: Credit[]) => list.reduce((s, c) => s + c.amountKobo, 0);
  const excludedList = out.map((c) => excluded.get(c.reference)!);

  if (excludedList.length === 0) {
    return { verdict: 'CLEAR', sweepableReferences: ok.map((c) => c.reference), sweepableKobo: total(ok), excluded: [], excludedKobo: 0, ignoredDuplicates: ignored };
  }
  const top = excludedList.reduce((a, b) => (RANK[b.severity] > RANK[a.severity] ? b : a));
  const alertType: AlertType = top.alertType;
  if (mode === 'whole') {
    return { verdict: 'HOLD', alertType, sweepableReferences: [], sweepableKobo: 0, excluded: excludedList, excludedKobo: total(kept), ignoredDuplicates: ignored };
  }
  return {
    verdict: 'HOLD',
    alertType,
    sweepableReferences: ok.map((c) => c.reference),
    sweepableKobo: total(ok),
    excluded: excludedList,
    excludedKobo: total(out),
    ignoredDuplicates: ignored,
  };
};
