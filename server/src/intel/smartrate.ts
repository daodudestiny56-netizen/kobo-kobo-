import { addDays, daysBetween, weekday } from './dates';
import { randomInt, seededRandom, shuffle } from './prng';
import type { PastSuggestion, Regime, SmartRateInput, SmartRateResult, SuggestRate } from './types';

/**
 * SmartRate: "is the sweep rate still right?" It only SUGGESTS; a rate changes after the trader says YES.
 * Ported from the Python reference (kobo_ai_kit/smart_rate.py). The Python works in naira, the app in kobo, so
 * takings are converted at the edge of this file and converted back in the result.
 *
 * In short: learn the weekly rhythm, ignore regular days off and finished breaks, cap freak days, tell a short
 * bad patch from a real decline, turn income level x stability x zero-sales frequency into a target rate, move one
 * step at a time (up 0.5, down at most 1.0), and re-sample the last 30 days to get a confidence. Raise only with
 * strong evidence (80%), lower with less (60%). Honest limit: calibrated on synthetic traders, every threshold is a
 * constant below so it can be re-tuned on real data.
 */
export const RATE = {
  min: 1,
  step: 0.5,
  ceiling: 3.5,
  margin: 0.15,
  maxProfitShare: 0.25,
  maxStepUp: 0.5,
  maxStepDown: 1,
  hardMax: 5,
};
const WINDOW_MAX_DAYS = 56;
const MIN_DAYS_ANY = 14;
const MIN_DAYS_INCREASE = 21;
const MIN_ACTIVE_DAYS = 8;
const MIN_DAYS_SEASONALITY = 24;
const SEASON_K = 2;
const WINSOR_SIGMAS = 3;
const BOOTSTRAP_B = 500;
const UP_CONF = 0.8;
const DOWN_CONF = 0.6;
const DECLINE_CONF = 0.95;
const MAX_CONFIDENCE = 0.99;
const DECLINE_RATIO = 0.75;
const GROWTH_RATIO = 1.1;
const TREND_MIN_FOR_INCREASE = 0.9;
const CV_VOLATILE = 0.45;
const ZERO_VOLATILE = 0.15;
const CV_STEADY_FOR_INCREASE = 0.35;
const ZERO_STEADY_FOR_INCREASE = 0.1;
const INACTIVE_ZERO_SHARE = 0.85;
const SHOCK_LOW_FRACTION = 0.65;
const SHOCK_MIN_RUN = 3;
const SHOCK_MAX_RUN = 10;
const SHOCK_BASELINE_CV = 0.45;
const COOLDOWN_UP_DAYS = 14;
const COOLDOWN_DOWN_DAYS = 7;
const DECLINED_QUIET_DAYS = 30;
const ACCEPTED_SETTLE_DAYS = 28;
const DAY_MS = 86_400_000;
const DEFAULT_DAILY_CAP_KOBO = 500_000;
/** December is the festive peak, so a December surge is not read as lasting growth (to validate on real data). */
const PEAK_MONTHS = [12];

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export const affordabilityCap = (): number =>
  Math.min(RATE.ceiling, Math.floor((100 * RATE.margin * RATE.maxProfitShare) / RATE.step) * RATE.step);
const snap = (r: number): number => Math.floor(r / RATE.step + 0.5) * RATE.step;

// ---------------------------------------------------------------------------------- small numeric helpers
const sum = (v: number[]) => v.reduce((s, x) => s + x, 0);
const mean = (v: number[]) => (v.length ? sum(v) / v.length : NaN);
const median = (v: number[]): number => {
  if (!v.length) return NaN;
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const clip = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi);
const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
const comma = (n: number) => Math.round(n).toLocaleString('en-US');
const pct = (v: number) => `${v}%`;
const pct0 = (v: number) => `${Math.round(v * 100)}%`;

function robustCv(v: number[], minN = 8): number | null {
  if (v.length < minN) return null;
  const med = median(v);
  if (med <= 0) return null;
  return (1.4826 * median(v.map((x) => Math.abs(x - med)))) / med;
}

function approx(v: number): number {
  const a = Math.abs(v);
  const step = a < 1000 ? 50 : 100;
  return Math.round(a / step) * step;
}

function stabilityNeeded(cv: number | null, zeroRate: number): boolean {
  return cv !== null && cv <= CV_STEADY_FOR_INCREASE && zeroRate <= ZERO_STEADY_FOR_INCREASE;
}

function batchStats(y: number[]): { E: number; zeroRate: number; cv: number } {
  const E = mean(y);
  const zeroRate = y.length ? y.filter((v) => v <= 0).length / y.length : 1;
  const z = y.filter((v) => v > 0);
  const med = median(z);
  const cv = z.length ? (1.4826 * median(z.map((v) => Math.abs(v - med)))) / med : NaN;
  return { E, zeroRate, cv };
}

function rateFor(E: number, zeroRate: number, cvIn: number, cap: number): { rate: number; capacity: number } {
  const cv = Number.isNaN(cvIn) ? 1 : cvIn;
  const g = clip((Math.log(Math.max(E, 1)) - Math.log(10_000)) / (Math.log(100_000) - Math.log(10_000)), 0, 1);
  const h = 1 - 0.65 * clip((cv - 0.2) / 0.6, 0, 1);
  const k = 1 - 0.6 * clip((zeroRate - 0.05) / 0.25, 0, 1);
  const capacity = g * h * k;
  return { rate: RATE.min + (cap - RATE.min) * capacity, capacity };
}

// ---------------------------------------------------------------------------------- data preparation
interface Prepared {
  days: string[];
  x: number[];
  y: number[];
  factors: number[];
  seasonal: boolean;
  closed: number[];
  capped: number;
  breaks: { from: string; to: string; length: number }[];
}

function prepare(allDays: string[], xAll: number[]): Prepared {
  let days = allDays.slice(-WINDOW_MAX_DAYS);
  let x = xAll.slice(-WINDOW_MAX_DAYS);
  let dows = days.map(weekday);

  // a weekday that is (almost) always zero over >= 4 occurrences is a regular day off
  let closed: number[] = [];
  for (let k = 0; k < 7; k++) {
    const idx = dows.map((d, i) => (d === k ? i : -1)).filter((i) => i >= 0);
    if (idx.length >= 4 && idx.filter((i) => x[i] <= 0).length / idx.length >= 0.75) closed.push(k);
  }
  if (closed.length > 2) closed = []; // that is inactivity, not a weekly rhythm
  const keepIdx = days.map((_, i) => i).filter((i) => !closed.includes(dows[i]));
  days = keepIdx.map((i) => days[i]);
  x = keepIdx.map((i) => x[i]);
  dows = keepIdx.map((i) => dows[i]);

  // finished breaks: >= 3 trading days in a row with no sales, followed by sales again. A break still in progress stays.
  const breaks: Prepared['breaks'] = [];
  const keep = x.map(() => true);
  let i = 0;
  while (i < x.length) {
    if (x[i] > 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < x.length && !(x[j] > 0)) j++;
    if (j - i >= SHOCK_MIN_RUN && j < x.length) {
      for (let t = i; t < j; t++) keep[t] = false;
      breaks.push({ from: days[i], to: days[j - 1], length: j - i });
    }
    i = j;
  }
  days = days.filter((_, t) => keep[t]);
  x = x.filter((_, t) => keep[t]);
  dows = dows.filter((_, t) => keep[t]);

  // winsorise freak days: cap at median x exp(3 x this trader's own log-spread)
  let capped = 0;
  let xw = [...x];
  const nz = x.filter((v) => v > 0);
  if (nz.length >= 5) {
    const lg = nz.map(Math.log);
    const sig = Math.max(1.4826 * median(lg.map((l) => Math.abs(l - median(lg)))), 0.25);
    const cap = median(nz) * Math.exp(WINSOR_SIGMAS * sig);
    capped = x.filter((v) => v > cap).length;
    xw = x.map((v) => Math.min(v, cap));
  }

  // weekly rhythm (multiplicative, shrunk toward 1)
  let f = [1, 1, 1, 1, 1, 1, 1];
  let seasonal = false;
  if (xw.length >= MIN_DAYS_SEASONALITY && mean(xw) > 0) {
    const overall = mean(xw);
    for (let k = 0; k < 7; k++) {
      const vals = xw.filter((_, t) => dows[t] === k);
      if (!vals.length) continue;
      f[k] = (vals.length * (mean(vals) / overall) + SEASON_K) / (vals.length + SEASON_K);
    }
    const norm = mean(dows.map((d) => f[d]));
    f = f.map((v) => v / norm);
    seasonal = true;
  }
  const y = xw.map((v, t) => v / f[dows[t]]);
  return { days, x, y, factors: f, seasonal, closed, capped, breaks };
}

/** Trailing run of low days (below 65% of the normal active day) and how steady the trader was before it. */
function lowRun(y: number[]): { run: number; preCv: number | null } {
  const nz = y.filter((v) => v > 0);
  if (nz.length < 8) return { run: 0, preCv: null };
  const base = median(nz);
  let run = 0;
  for (let t = y.length - 1; t >= 0 && y[t] < SHOCK_LOW_FRACTION * base; t--) run++;
  const pre = run ? y.slice(0, y.length - run) : y;
  return { run, preCv: robustCv(pre.filter((v) => v > 0).slice(-30)) };
}

interface Record_ {
  createdAt: number;
  direction: 'INCREASE' | 'DECREASE';
  status: PastSuggestion['status'];
  expiresAt?: number;
  respondedAt?: number;
}

function cooldown(records: Record_[], direction: 'INCREASE' | 'DECREASE', now: number): { ok: boolean; detail: string } {
  if (!records.length) return { ok: true, detail: 'No earlier suggestions.' };
  const recs = [...records].sort((a, b) => a.createdAt - b.createdAt);
  const last = recs[recs.length - 1];
  if (last.status === 'PENDING' && (last.expiresAt === undefined || now < last.expiresAt)) {
    return { ok: false, detail: "An earlier suggestion is still waiting for the trader's reply." };
  }
  const gap = direction === 'DECREASE' ? COOLDOWN_DOWN_DAYS : COOLDOWN_UP_DAYS;
  const age = Math.floor((now - last.createdAt) / DAY_MS);
  if (age < gap) return { ok: false, detail: `The last suggestion was ${age} day(s) ago (minimum gap ${gap}).` };
  for (const r of recs) {
    if (r.status === 'DECLINED' && r.direction === direction && r.respondedAt !== undefined && Math.floor((now - r.respondedAt) / DAY_MS) < DECLINED_QUIET_DAYS) {
      return { ok: false, detail: `The trader said NO to a ${direction.toLowerCase()} less than ${DECLINED_QUIET_DAYS} days ago.` };
    }
  }
  if (direction === 'INCREASE') {
    for (const r of recs) {
      if (r.status === 'ACCEPTED' && r.respondedAt !== undefined && Math.floor((now - r.respondedAt) / DAY_MS) < ACCEPTED_SETTLE_DAYS) {
        return { ok: false, detail: `The rate was changed less than ${ACCEPTED_SETTLE_DAYS} days ago; letting it settle.` };
      }
    }
  }
  return { ok: true, detail: 'OK.' };
}

// ---------------------------------------------------------------------------------- the recommendation
export const suggestRate: SuggestRate = (input: SmartRateInput): SmartRateResult => {
  const cap = affordabilityCap();
  const asOf = input.asOf;
  const cur = clip(snap(input.currentRate), RATE.min, RATE.hardMax);
  const dailyCap = (input.dailyCapKobo ?? DEFAULT_DAILY_CAP_KOBO) / 100;
  const now = input.now ? Date.parse(input.now) : Date.parse(`${addDays(asOf, 1)}T00:00:00Z`);
  const records: Record_[] = (input.recentSuggestions ?? []).map((r) => ({
    createdAt: Date.parse(r.createdAt),
    direction: r.direction,
    status: r.status,
    expiresAt: r.expiresAt ? Date.parse(r.expiresAt) : undefined,
    respondedAt: r.respondedAt ? Date.parse(r.respondedAt) : undefined,
  }));

  const byDay = new Map(input.takings.map((t) => [t.day, t.amountKobo / 100]));
  const allDays: string[] = [];
  for (let n = 0, total = Math.max(daysBetween(input.firstDay, asOf) + 1, 0); n < total; n++) allDays.push(addDays(input.firstDay, n));
  const xAll = allDays.map((d) => byDay.get(d) ?? 0);
  const activeDays = xAll.filter((v) => v > 0).length;
  const checks: SmartRateResult['checks'] = [];
  const check = (name: string, passed: boolean, detail: string): boolean => {
    checks.push({ name, passed, detail });
    return passed;
  };

  const emptyMetrics: SmartRateResult['metrics'] = {
    avgDailyTakingsKobo: 0, medianActiveDayKobo: 0, zeroSalesDaysLast14: 0, zeroSalesDaysLast30: 0, volatilityCv: null, trend14dVsPrior: null, regularDaysOff: [],
  };
  const hold = (reason: string, regime: Regime, rationale: string, metrics: SmartRateResult['metrics'], confidence: number | null = null): SmartRateResult => ({
    action: 'HOLD', recommendedRate: cur, holdReason: reason, regime, confidence, rationale, monthlyChangeKobo: null, metrics, checks,
  });

  // 1. enough data?
  if (!check('enough_history', allDays.length >= MIN_DAYS_ANY && activeDays >= MIN_ACTIVE_DAYS,
    `${allDays.length} days of history, ${activeDays} with sales (need ${MIN_DAYS_ANY} days and ${MIN_ACTIVE_DAYS} with sales).`)) {
    return hold('INSUFFICIENT_DATA', 'INSUFFICIENT_DATA',
      'We need at least 2 weeks of sales history before we can suggest a rate. Keep selling and we will check again.', emptyMetrics);
  }

  // 2. clean the series
  const P = prepare(allDays, xAll);
  const inWindow = (k: number) => P.y.filter((_, t) => P.days[t] >= addDays(asOf, -(k - 1)) && P.days[t] <= asOf);
  const y30 = inWindow(30);
  const y14 = inWindow(14);
  if (!y30.length) {
    return hold('INSUFFICIENT_DATA', 'INSUFFICIENT_DATA', 'There are no recent trading days to look at yet, so we are not suggesting a change.', emptyMetrics);
  }
  const n14 = y14.length;
  const { E, zeroRate: zr30, cv: cv30 } = batchStats(y30);
  const cv30f = Number.isNaN(cv30) ? null : cv30;
  const zero30 = y30.filter((v) => v <= 0).length;
  const zero14 = y14.filter((v) => v <= 0).length;
  const medianActive = median(y30.filter((v) => v > 0)) || 0;

  const lo = addDays(asOf, -41);
  const hi = addDays(asOf, -14);
  const yPrior = P.y.filter((_, t) => P.days[t] >= lo && P.days[t] <= hi);
  const trend = yPrior.length >= 7 && mean(yPrior) > 0 && n14 > 0 ? mean(y14) / mean(yPrior) : null;
  const { run, preCv } = lowRun(P.y);

  // a decline only means something for a trader who was steady before the drop
  const priorCv = robustCv(yPrior.filter((v) => v > 0));
  const priorZero = yPrior.length ? yPrior.filter((v) => v <= 0).length / yPrior.length : 1;
  const baselineSteady = priorCv !== null && priorCv <= CV_VOLATILE && priorZero <= ZERO_VOLATILE;

  // 3. bootstrap (seeded: deterministic)
  const rand = seededRandom(`${input.merchantId}|${asOf}`);
  let up = 0;
  let down = 0;
  for (let b = 0; b < BOOTSTRAP_B; b++) {
    const sample = Array.from({ length: y30.length }, () => y30[randomInt(rand, y30.length)]);
    const s = batchStats(sample);
    const r = snap(rateFor(s.E, s.zeroRate, s.cv, cap).rate);
    if (r >= cur + RATE.step - 1e-9) up++;
    if (r <= cur - RATE.step + 1e-9) down++;
  }
  const pUp = up / BOOTSTRAP_B;
  const pDown = down / BOOTSTRAP_B;
  const pHold = Math.max(0, 1 - pUp - pDown);
  const point = rateFor(E, zr30, cv30, cap);
  const rSnap = snap(point.rate);

  // is the recent drop bigger than this trader's own normal noise? Shuffle the 42 days many ways.
  let pDecline: number | null = null;
  if (trend !== null) {
    const pool = [...y14, ...yPrior];
    let valid = 0;
    let noise = 0;
    for (let b = 0; b < BOOTSTRAP_B; b++) {
      const perm = shuffle(rand, [...pool]);
      const mb = mean(perm.slice(n14));
      if (mb > 0) {
        valid++;
        if (mean(perm.slice(0, n14)) / mb <= trend) noise++;
      }
    }
    pDecline = 1 - noise / Math.max(valid, 1);
  }

  // 4. what kind of trader is this right now?
  let regime: Regime;
  if (n14 >= 7 && zero14 / n14 >= INACTIVE_ZERO_SHARE) regime = 'INACTIVE';
  else if (run >= SHOCK_MIN_RUN && run <= SHOCK_MAX_RUN && preCv !== null && preCv <= SHOCK_BASELINE_CV) regime = 'TEMPORARY_DISRUPTION';
  else if (baselineSteady && trend !== null && trend < DECLINE_RATIO && pDecline !== null && pDecline >= DECLINE_CONF) regime = 'DECLINING';
  else if (cv30f === null || cv30f > CV_VOLATILE || zr30 > ZERO_VOLATILE) regime = 'VOLATILE';
  else if (trend !== null && trend >= GROWTH_RATIO) regime = 'GROWING';
  else regime = 'STABLE';

  const peak = PEAK_MONTHS.includes(Number(asOf.slice(5, 7)));
  const tradingPerMonth = (30 * (7 - P.closed.length)) / 7;
  const metrics: SmartRateResult['metrics'] = {
    avgDailyTakingsKobo: Math.round(E * 100),
    medianActiveDayKobo: Math.round(medianActive * 100),
    zeroSalesDaysLast14: zero14,
    zeroSalesDaysLast30: zero30,
    volatilityCv: cv30f === null ? null : round(cv30f, 3),
    trend14dVsPrior: trend === null ? null : round(trend, 3),
    regularDaysOff: P.closed.map((k) => DOW[k]),
  };
  const held = (code: string, text: string, conf: number | null = null) => hold(code, regime, text, metrics, conf);

  // 5. rule-driven holds
  if (!check('not_paused', !input.isPaused, input.isPaused ? 'Sweeps are paused, so no suggestions are made.' : 'Sweeps are active.')) {
    return held('PAUSED', 'Your sweeps are paused, so we are not suggesting any rate change.');
  }
  if (!check('trader_active', regime !== 'INACTIVE', `${zero14} of the last ${n14} trading days had no sales.`)) {
    return held('INACTIVE', 'There were almost no sales in the last 2 weeks, so there is nothing to adjust.');
  }
  if (!check('no_short_term_disruption', regime !== 'TEMPORARY_DISRUPTION', `${run} slow day(s) in a row after a steady stretch.`)) {
    return held('TEMPORARY_DISRUPTION',
      `Sales have been very low for the last ${run} days after a steady stretch. We think this is a short break (illness, holiday or weather), so we are not changing your rate. We will check again next week.`);
  }

  // 6. candidate direction
  let candidate: 'INCREASE' | 'DECREASE' | null = null;
  if (regime === 'DECLINING') candidate = 'DECREASE';
  else if (regime === 'VOLATILE' && rSnap <= cur - RATE.step) candidate = 'DECREASE';
  else if ((regime === 'STABLE' || regime === 'GROWING') && rSnap >= cur + RATE.step) candidate = 'INCREASE';

  if (candidate === null) {
    if ((regime === 'VOLATILE' || regime === 'DECLINING') && cur <= RATE.min) {
      return held('AT_MIN', `Your sales are uneven, but you are already at the lowest rate (${pct(RATE.min)}).`, pHold);
    }
    if ((regime === 'STABLE' || regime === 'GROWING') && cur >= cap && rSnap >= cap) {
      return held('AT_CAP', `Your sales are steady and you are already at the highest rate we recommend (${pct(cap)}).`, pHold);
    }
    return held('RATE_FITS', `Your sales are ${regime === 'STABLE' || regime === 'GROWING' ? 'steady' : 'uneven'} and your current rate of ${pct(cur)} fits. We are not suggesting a change.`, pHold);
  }

  // a sweep never exceeds the daily cap, so above it a higher rate adds nothing
  if (candidate === 'INCREASE' && (cur / 100) * E >= dailyCap) {
    check('below_daily_cap', false, `At ${pct(cur)} the average day already reaches the daily cap of ₦${comma(dailyCap)}.`);
    return held('DAILY_CAP_REACHED', `Your saving already reaches the daily limit of ₦${comma(dailyCap)}, so a higher rate would not add anything.`);
  }

  // 7. gates (the audit trail)
  const cool = cooldown(records, candidate, now);
  const gates: [string, boolean, string, string, string][] =
    candidate === 'INCREASE'
      ? [
          ['three_weeks_of_history', allDays.length >= MIN_DAYS_INCREASE, 'NEEDS_3_WEEKS', `${allDays.length} days of history (need ${MIN_DAYS_INCREASE} before raising a rate).`,
            `You have ${allDays.length} days with us. We need 3 weeks of sales before we suggest a higher rate.`],
          ['steady_enough', stabilityNeeded(cv30f, zr30), 'NOT_STEADY_ENOUGH',
            `volatility ${cv30f === null ? 'unknown' : round(cv30f, 2)}, zero-sales share ${pct0(zr30)} (need <= ${CV_STEADY_FOR_INCREASE} and <= ${pct0(ZERO_STEADY_FOR_INCREASE)}).`,
            'Your sales are not steady enough yet for a higher rate.'],
          ['trend_not_falling', trend === null || trend >= TREND_MIN_FOR_INCREASE, 'TREND_FALLING',
            `last 14 days vs the 4 weeks before: ${trend === null ? 'unknown' : round(trend, 2)}x (need >= ${TREND_MIN_FOR_INCREASE}).`,
            'Your recent sales are lower than before, so we are not suggesting a higher rate.'],
          ['not_seasonal_peak', !peak, 'SEASONAL_PEAK', peak ? 'Date is inside a festive peak window.' : 'Not a seasonal peak.',
            'Your sales are steady and a higher rate would fit. But this is the festive peak, so we will wait to see if sales hold after the season before suggesting an increase.'],
          ['cooldown_ok', cool.ok, 'COOLDOWN', cool.detail, 'We made a suggestion recently, so we are giving you space before asking again.'],
          ['statistical_confidence', pUp >= UP_CONF, 'LOW_CONFIDENCE', `${pct0(pUp)} of re-checks support ${pct(cur + RATE.step)} (need ${pct0(UP_CONF)}).`,
            'The data is close to the line, so we are keeping your current rate for now.'],
        ]
      : (() => {
          const declining = regime === 'DECLINING';
          const evidence = declining ? pDecline : pDown;
          return [
            ['above_minimum_rate', cur > RATE.min, 'AT_MIN', `Current ${pct(cur)}, minimum ${pct(RATE.min)}.`, `You are already at the lowest rate (${pct(RATE.min)}).`],
            ['cooldown_ok', cool.ok, 'COOLDOWN', cool.detail, 'We made a suggestion recently, so we are giving you space before asking again.'],
            ['statistical_confidence', evidence !== null && evidence >= (declining ? DECLINE_CONF : DOWN_CONF), 'LOW_CONFIDENCE',
              declining
                ? `Normal ups and downs would give a drop this big ${pct0(1 - (pDecline ?? 0))} of the time (need <= ${pct0(1 - DECLINE_CONF)}).`
                : `${pct0(pDown)} of re-checks support ${pct(Math.max(cur - RATE.step, RATE.min))} or lower (need ${pct0(DOWN_CONF)}).`,
              'The data is close to the line, so we are keeping your current rate for now.'],
          ] as [string, boolean, string, string, string][];
        })();
  let failed: { code: string; text: string } | null = null;
  for (const [name, passed, code, detail, text] of gates) {
    if (!check(name, passed, detail) && failed === null) failed = { code, text };
  }
  if (failed) return held(failed.code, failed.text, failed.code === 'LOW_CONFIDENCE' ? pHold : null);

  // 8. build the suggestion
  let rec: number;
  let conf: number;
  if (candidate === 'INCREASE') {
    rec = Math.min(cur + RATE.maxStepUp, cap);
    conf = pUp;
  } else if (regime === 'DECLINING') {
    rec = Math.max(cur - (trend !== null && trend < 0.5 ? RATE.maxStepDown : RATE.step), RATE.min);
    conf = pDecline ?? 0;
  } else {
    rec = Math.max(rSnap, cur - RATE.maxStepDown, RATE.min);
    conf = pDown;
  }
  conf = Math.min(conf, MAX_CONFIDENCE);
  const delta = (Math.min((rec / 100) * E, dailyCap) - Math.min((cur / 100) * E, dailyCap)) * tradingPerMonth;

  const eShow = `₦${comma(approx(E))}`;
  let rationale: string;
  if (candidate === 'INCREASE') {
    rationale = `Your sales have been steady: about ${eShow} a day over the last 30 days, with ${zero30} day(s) of no sales. At this level ${pct(rec)} is comfortable and adds about ₦${comma(approx(delta))} a month to your pension. We re-checked your last 30 days ${BOOTSTRAP_B} different ways and ${pct0(conf)} still support at least ${pct(rec)}.`;
  } else if (regime === 'DECLINING') {
    rationale = `Your average daily sales over the last 2 weeks are about ${pct0(1 - (trend ?? 1))} lower than in the 4 weeks before, and this has lasted more than ${SHOCK_MAX_RUN} days, so it is not just a short break. To protect your business money we suggest easing to ${pct(rec)}, which lowers your monthly saving by about ₦${comma(approx(delta))}. Normal ups and downs would give a drop this big only ${pct0(1 - conf)} of the time.`;
  } else {
    rationale = `Your sales have been uneven (a typical day swings by about ${pct0(cv30f ?? 0)}${zero30 ? `, ${zero30} day(s) with no sales in the last 30` : ''}). To protect your business money we suggest easing to ${pct(rec)}, which lowers your monthly saving by about ₦${comma(approx(delta))}. ${pct0(conf)} of our re-checks agree.`;
  }
  return {
    action: candidate,
    recommendedRate: rec,
    holdReason: null,
    regime,
    confidence: round(conf, 2),
    rationale,
    monthlyChangeKobo: Math.round(delta * 100),
    metrics,
    checks,
  };
};
