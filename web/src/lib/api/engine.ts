// In-browser stand-in for the backend, following PRD section 6 so the UI can be built before the API exists.
// This is a UI aid, not the real engine. The rules here are the spec the backend has to match.
import type {
  BalancePoint,
  DayPoint,
  DemoTrader,
  FeedItem,
  ForceOutcome,
  GuardAlert,
  Lang,
  Merchant,
  Consent,
  OnboardRequest,
  OnboardResult,
  OpsOverview,
  SettingsPatch,
  SmartRate,
  Stats,
  Summary,
  SweepRecord,
  WithdrawalEligibility,
} from './types';
import { fmtDate, naira, nairaPlain } from '../money';
import { ApiError } from './errors';
import { DEMO_TRADERS } from './fixtures';
import { SMS_HELP, balanceSms, receiptSms } from '../messages';

const DAY = 86_400_000;
const BUFFER_KOBO = 100_000; // 1,000 naira
const DAILY_CAP_KOBO = 500_000; // 5,000 naira
const HOLD_THRESHOLD_KOBO = 50_000_000; // mock guard rule only; the real one is mean + 3 sigma (PRD 9.1)

const OPENING_BALANCE_KOBO: Record<string, number> = {
  '0123456789': 150_000_000,
  '0123456790': 500_000_000,
  '0123456791': 25_000_000,
  '0123456792': 4_000_000,
};

const BANK_NAME = 'Xtradot Bank';

// How long each demo trader has been saving and what their trade looks like, so the app opens with real history.
const PROFILES: Record<string, { days: number; base: number; zero: number; trend: number; withdrewDaysAgo?: number; withdrewKobo?: number }> = {
  '0123456789': { days: 128, base: 3_000_000, zero: 0.05, trend: 0.45, withdrewDaysAgo: 71, withdrewKobo: 300_000 },
  '0123456790': { days: 96, base: 2_400_000, zero: 0.14, trend: 0.1 },
  '0123456791': { days: 58, base: 1_150_000, zero: 0.08, trend: 0.15 },
  '0123456792': { days: 26, base: 900_000, zero: 0.3, trend: 0 },
};

const PAYERS = ['Chioma Eze', 'Tunde Bakare', 'Amina Yusuf', 'Ngozi Obi', 'Segun Alade', 'Fatima Bello', 'Emeka Nwosu', 'Bisi Adeyemi', 'Kelechi Okoro', 'Hauwa Ibrahim', 'Uche Okafor', 'Folake Ojo', 'Ibrahim Sani', 'Blessing Okon'];
const CHANNELS = ['POS', 'POS', 'POS', 'Transfer', 'Transfer', 'Transfer', 'QR'] as const;

interface Inflow {
  id: string;
  amountKobo: number;
  at: number;
  swept: boolean;
  hold: null | 'HELD' | 'DISMISSED' | 'CONFIRMED';
  payer: string;
  channel: string;
  ref: string;
}

interface Withdrawal {
  id: string;
  at: number;
  amountKobo: number;
}

interface MState {
  merchant: Merchant;
  balanceKobo: number;
  emergencyKobo: number;
  retirementKobo: number;
  firstContribAt: number | null;
  lastWithdrawAt: number | null;
  withdrawnKobo: number;
  withdrawals: Withdrawal[];
  inflows: Inflow[];
}

interface Store {
  merchants: Record<string, MState>;
  sweeps: SweepRecord[];
  alerts: GuardAlert[];
  clockOffsetDays: number;
  seq: number;
}

const KEY = 'kobokobo.mock.v3';

function fresh(): Store {
  return { merchants: {}, sweeps: [], alerts: [], clockOffsetDays: 0, seq: 1 };
}

function load(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as Store;
  } catch {
    /* storage unavailable: run in memory */
  }
  return fresh();
}

let store: Store = load();

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* ignore */
  }
}

const now = () => Date.now() + store.clockOffsetDays * DAY;
const id = (p: string) => `${p}_${(store.seq++).toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

// WAT is UTC+1 with no daylight saving.
function sweepDate(ts: number): string {
  return new Date(ts + 3_600_000).toISOString().slice(0, 10);
}

function addMonths(ts: number, n: number): number {
  const d = new Date(ts);
  d.setMonth(d.getMonth() + n);
  return d.getTime();
}

// ---------- rules ----------

export function calcSweep(takings: number, rateBps: number, balanceKobo: number) {
  const raw = Math.floor((takings * rateBps) / 10_000);
  const capped = Math.min(raw, DAILY_CAP_KOBO);
  const affordable = Math.min(capped, balanceKobo - BUFFER_KOBO);
  const sweep = Math.max(affordable, 0);
  const emergency = Math.floor(sweep / 2);
  return { sweep, emergency, retirement: sweep - emergency };
}

function eligibility(m: MState): WithdrawalEligibility {
  const t = now();
  if (m.firstContribAt === null) {
    return {
      eligible: false,
      maxKobo: 0,
      reason: 'No contribution yet. The emergency pot opens 3 months after your first contribution.',
    };
  }
  const vests = addMonths(m.firstContribAt, 3);
  if (t < vests) {
    return { eligible: false, maxKobo: 0, availableFrom: vests, reason: `Emergency withdrawals open on ${fmtDate(vests)} (3 months after your first contribution).` };
  }
  if (m.lastWithdrawAt !== null) {
    const next = addMonths(m.lastWithdrawAt, 2);
    if (t < next) {
      return { eligible: false, maxKobo: 0, availableFrom: next, reason: `You can withdraw once every 2 months. Next withdrawal: ${fmtDate(next)}.` };
    }
  }
  if (m.emergencyKobo <= 0) return { eligible: false, maxKobo: 0, reason: 'The emergency pot is empty.' };
  return { eligible: true, maxKobo: m.emergencyKobo };
}

function median(a: number[]): number {
  const s = [...a].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

// Takings per day for the last `n` nights (zero for nights with no sweep record), oldest first.
function dailyTakings(mid: string, n: number): number[] {
  const byDate = new Map(store.sweeps.filter((x) => x.merchantId === mid).map((x) => [x.sweepDate, x.takingsKobo]));
  const out: number[] = [];
  for (let i = n; i >= 1; i--) out.push(byDate.get(sweepDate(now() - i * DAY)) ?? 0);
  return out;
}

// Statistics only (PRD 9.2); thresholds are placeholders for Tomiwa to tune.
function smartRate(m: MState): SmartRate | null {
  const h = dailyTakings(m.merchant.id, 14);
  if (h.every((x) => x === 0)) return null;
  const med = median(h);
  const mean = h.reduce((a, b) => a + b, 0) / h.length;
  const sd = Math.sqrt(h.reduce((a, b) => a + (b - mean) ** 2, 0) / h.length);
  const cv = mean ? sd / mean : 0;
  const zeroShare = h.filter((x) => x === 0).length / h.length;
  const cur = m.merchant.rateBps;
  if (med >= 4_000_000 && cv < 0.5 && cur < 250) {
    return { suggestedBps: 250, reason: 'Your sales have been steady and rising over the last 14 days.' };
  }
  if ((zeroShare >= 0.25 || cv > 0.8) && cur > 200) {
    return { suggestedBps: 200, reason: 'Your sales swing a lot, so a lower rate is safer.' };
  }
  return null;
}

function pendingTakings(m: MState) {
  const counted = m.inflows.filter((i) => !i.swept && i.hold !== 'HELD' && i.hold !== 'CONFIRMED');
  const held = m.inflows.filter((i) => !i.swept && i.hold === 'HELD');
  return {
    takings: counted.reduce((a, i) => a + i.amountKobo, 0),
    held: held.reduce((a, i) => a + i.amountKobo, 0),
    counted,
  };
}

function isPaused(m: MState): boolean {
  return m.merchant.pausedUntil !== null && m.merchant.pausedUntil > now();
}

function dateRange(days: number): string[] {
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) out.push(sweepDate(now() - i * DAY));
  return out;
}

function buildSummary(m: MState): Summary {
  const { takings, held } = pendingTakings(m);
  const expected = isPaused(m) ? 0 : calcSweep(takings, m.merchant.rateBps, m.balanceKobo).sweep;
  const mine = store.sweeps.filter((x) => x.merchantId === m.merchant.id);
  const settled = mine.filter((x) => x.status === 'SETTLED');
  const today = sweepDate(now());
  const month = today.slice(0, 7);
  const byDate = new Map(mine.map((x) => [x.sweepDate, x]));

  // Last 30 days of sales and savings. Today shows what is waiting for tonight's run.
  const series: DayPoint[] = dateRange(30).map((d) => {
    const sw = byDate.get(d);
    if (sw) return { date: d, takingsKobo: sw.takingsKobo, savedKobo: sw.status === 'SETTLED' ? sw.sweepKobo : 0 };
    if (d === today) return { date: d, takingsKobo: takings, savedKobo: expected };
    return { date: d, takingsKobo: 0, savedKobo: 0 };
  });

  // Pension balance over the last 90 days: everything saved up to each day, less withdrawals.
  const balanceSeries: BalancePoint[] = dateRange(90).map((d) => {
    const saved = settled.filter((x) => x.sweepDate <= d).reduce((a, x) => a + x.sweepKobo, 0);
    const out = m.withdrawals.filter((w) => sweepDate(w.at) <= d).reduce((a, w) => a + w.amountKobo, 0);
    return { date: d, totalKobo: Math.max(saved - out, 0) };
  });

  const last30 = new Set(dateRange(30));
  const last90 = new Set(dateRange(90));
  const takings30 = series.filter((p) => p.date !== today).map((p) => p.takingsKobo);
  const best = mine.filter((x) => last90.has(x.sweepDate)).sort((a, b) => b.takingsKobo - a.takingsKobo)[0];

  const stats: Stats = {
    savedThisMonthKobo: settled.filter((x) => x.sweepDate.startsWith(month)).reduce((a, x) => a + x.sweepKobo, 0),
    savedAllTimeKobo: settled.reduce((a, x) => a + x.sweepKobo, 0),
    nightsSaved30: settled.filter((x) => last30.has(x.sweepDate)).length,
    avgSales30Kobo: takings30.length ? Math.round(takings30.reduce((a, b) => a + b, 0) / takings30.length) : 0,
    bestDay: best && best.takingsKobo > 0 ? { date: best.sweepDate, takingsKobo: best.takingsKobo } : null,
    memberSince: m.firstContribAt,
  };

  const tier = DEMO_TRADERS.find((x) => x.bankAccount === m.merchant.bankAccount)?.tier ?? 1;

  return {
    merchant: m.merchant,
    bankBalanceKobo: m.balanceKobo,
    todayTakingsKobo: takings,
    heldKobo: held,
    expectedSweepKobo: expected,
    emergencyKobo: m.emergencyKobo,
    retirementKobo: m.retirementKobo,
    withdrawal: eligibility(m),
    smartRate: smartRate(m),
    recent: mine.slice(-8).reverse(),
    clockOffsetDays: store.clockOffsetDays,
    account: { bankName: BANK_NAME, number: m.merchant.bankAccount, balanceKobo: m.balanceKobo, tier },
    stats,
    series,
    balanceSeries,
  };
}

// ---------- demo bank: months of believable history ----------

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 22:00 UTC is 23:00 WAT, when the nightly saving runs.
const runTime = (date: string) => Date.parse(`${date}T22:00:00Z`);

function seedHistory(m: MState, account: string) {
  const prof = PROFILES[account];
  if (!prof) return;
  const rnd = mulberry32(Number(account.slice(-6)));
  const mid = m.merchant.id;
  let seq = 1;

  for (let i = prof.days; i >= 1; i--) {
    const ts = now() - i * DAY;
    const date = sweepDate(ts);
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    const progress = 1 - i / prof.days;
    const dayFactor = weekday === 6 ? 1.25 : weekday === 0 ? 0.7 : 1;
    const zero = rnd() < prof.zero;
    const takings = zero ? 0 : Math.round((prof.base * (1 + prof.trend * progress) * (0.65 + 0.7 * rnd()) * dayFactor) / 100) * 100;

    // Customer payments for the last 45 days (older days keep only the totals, which keeps stored data small).
    if (takings > 0 && i <= 45) {
      const n = 3 + Math.floor(rnd() * 6);
      const weights = Array.from({ length: n }, () => 0.4 + rnd());
      const total = weights.reduce((a, b) => a + b, 0);
      let left = takings;
      for (let k = 0; k < n; k++) {
        const amt = k === n - 1 ? left : Math.min(left, Math.round((takings * weights[k]) / total / 100) * 100);
        left -= amt;
        if (amt <= 0) continue;
        const at = Date.parse(`${date}T00:00:00Z`) - 3_600_000 + (7 + Math.floor(rnd() * 13)) * 3_600_000 + Math.floor(rnd() * 60) * 60_000;
        m.inflows.push({
          id: id('in'),
          amountKobo: amt,
          at,
          swept: true,
          hold: null,
          payer: PAYERS[Math.floor(rnd() * PAYERS.length)],
          channel: CHANNELS[Math.floor(rnd() * CHANNELS.length)],
          ref: `NIP${Math.floor(rnd() * 1e9).toString().padStart(9, '0')}`,
        });
      }
    }

    const base = {
      id: id('sw'),
      merchantId: mid,
      merchantName: m.merchant.fullName,
      sweepDate: date,
      rateBps: 200,
      bankReference: `SWP-${mid}-${date.replace(/-/g, '')}`,
      executedAt: runTime(date),
    };
    if (takings === 0) {
      store.sweeps.push({ ...base, takingsKobo: 0, sweepKobo: 0, emergencyKobo: 0, retirementKobo: 0, pensionReference: null, status: 'SKIPPED_ZERO_SALES' });
      continue;
    }
    const c = calcSweep(takings, 200, m.balanceKobo);
    m.emergencyKobo += c.emergency;
    m.retirementKobo += c.retirement;
    m.firstContribAt ??= runTime(date);
    store.sweeps.push({
      ...base,
      takingsKobo: takings,
      sweepKobo: c.sweep,
      emergencyKobo: c.emergency,
      retirementKobo: c.retirement,
      pensionReference: `PEN-${date.replace(/-/g, '')}-${String(seq++).padStart(4, '0')}`,
      status: 'SETTLED',
    });
  }

  // Today's payments so far, waiting for tonight's saving.
  const t0 = now();
  const dayStart = Date.parse(`${sweepDate(t0)}T00:00:00Z`) - 3_600_000; // midnight in WAT
  if (t0 - dayStart > 45 * 60_000) {
    const n = 2 + Math.floor(rnd() * 4);
    const total = Math.round((prof.base * (0.3 + 0.35 * rnd())) / 100) * 100;
    let left = total;
    for (let k = 0; k < n; k++) {
      const amt = k === n - 1 ? left : Math.min(left, Math.round(total / n / 100) * 100);
      left -= amt;
      if (amt <= 0) continue;
      const at = dayStart + 10 * 60_000 + Math.floor(rnd() * (t0 - dayStart - 20 * 60_000));
      m.inflows.push({
        id: id('in'),
        amountKobo: amt,
        at,
        swept: false,
        hold: null,
        payer: PAYERS[Math.floor(rnd() * PAYERS.length)],
        channel: CHANNELS[Math.floor(rnd() * CHANNELS.length)],
        ref: `NIP${Math.floor(rnd() * 1e9).toString().padStart(9, '0')}`,
      });
    }
  }

  if (prof.withdrewDaysAgo && prof.withdrewKobo) {
    const at = now() - prof.withdrewDaysAgo * DAY;
    m.withdrawals.push({ id: id('wd'), at, amountKobo: prof.withdrewKobo });
    m.emergencyKobo -= prof.withdrewKobo;
    m.withdrawnKobo += prof.withdrewKobo;
    m.lastWithdrawAt = at;
  }
}

function buildFeed(m: MState): FeedItem[] {
  const items: FeedItem[] = [];
  for (const i of m.inflows) {
    items.push({
      id: i.id,
      kind: 'sale',
      at: i.at,
      title: `Payment from ${i.payer}`,
      subtitle: `${i.channel} · ${i.ref}`,
      amountKobo: i.amountKobo,
      reference: i.ref,
      status: 'completed',
    });
  }
  for (const s of store.sweeps.filter((x) => x.merchantId === m.merchant.id)) {
    const at = s.executedAt ?? runTime(s.sweepDate);
    const v = { id: s.id, at, reference: s.pensionReference ?? s.bankReference, sweepId: s.id };
    if (s.status === 'SETTLED') {
      items.push({ ...v, kind: 'saving', title: 'Saved to pension', subtitle: `${s.rateBps / 100}% of ${naira(s.takingsKobo)} · ${s.pensionReference}`, amountKobo: -s.sweepKobo, status: 'completed' });
    } else if (s.status === 'SKIPPED_ZERO_SALES' || s.status === 'SKIPPED_PAUSED') {
      items.push({ ...v, kind: 'skipped', title: s.status === 'SKIPPED_PAUSED' ? 'Paused, nothing taken' : 'No sales, nothing taken', subtitle: 'Nightly saving', amountKobo: 0, status: 'completed' });
    } else {
      const status = s.status === 'UNKNOWN' ? 'pending' : s.status === 'REVERSED' ? 'reversed' : 'failed';
      const title = s.status === 'REVERSED' ? 'Saving reversed by the bank' : s.status === 'UNKNOWN' ? 'Saving being confirmed' : s.status === 'HELD_GUARD' ? 'Payment held for a safety check' : 'Saving did not go through';
      items.push({ ...v, kind: 'attention', title, subtitle: s.note ?? 'Nightly saving', amountKobo: -s.sweepKobo, status });
    }
  }
  for (const w of m.withdrawals) {
    items.push({ id: w.id, kind: 'withdrawal', at: w.at, title: 'Emergency withdrawal', subtitle: 'From emergency pot to your account', amountKobo: w.amountKobo, reference: w.id.toUpperCase(), status: 'completed' });
  }
  // Newest first. If two lines share a moment, the saving that followed a payment comes first.
  const rank = { saving: 0, attention: 0, withdrawal: 1, sale: 2, skipped: 3 } as const;
  return items.sort((a, b) => b.at - a.at || rank[a.kind] - rank[b.kind]);
}

function need(idv: string): MState {
  const m = store.merchants[idv];
  if (!m) throw new Error('Unknown merchant');
  return m;
}

// ---------- onboarding (mirrors src/onboarding/service.ts) ----------

const CONSENT_VERSION = '2026-11-v1';
const CONSENT_TEXT =
  'I agree that Kobo Kobo may move a percentage of my daily takings (starting at 2%; I can choose 1% to 5%) ' +
  'from my own bank account into my pension each night, split 50/50 between an emergency pot and a retirement pot. ' +
  'Nothing is taken on days with no sales. The emergency pot can be withdrawn from 3 months after my first ' +
  'contribution, then once every 2 months. The retirement pot is locked until age 50. I can pause, change or stop ' +
  'at any time. Returns are not guaranteed and may be negative. This is a sandbox demo with simulated components.';

const LANGS: Lang[] = ['en', 'pidgin', 'yoruba', 'hausa', 'igbo'];
let attempts: number[] = []; // the backend allows 5 onboarding attempts a minute per address

// BVN 22200000005 stands in for "names are close but not identical" so that path can be shown. It is mock-only.
const NEEDS_REVIEW_BVN = '22200000005';

function enrol(t: DemoTrader, phone: string, language: Lang): Merchant {
  const mid = id('m');
  const merchant: Merchant = {
    id: mid,
    fullName: t.fullName,
    phone,
    bankAccount: t.bankAccount,
    virtualAccount: `88${t.bankAccount.slice(2)}`,
    rsaPin: `PEN${String(Math.floor(Math.random() * 1e12)).padStart(12, '0')}`,
    language,
    rateBps: 200,
    pausedUntil: null,
    status: 'ACTIVE',
  };
  store.merchants[mid] = {
    merchant,
    balanceKobo: OPENING_BALANCE_KOBO[t.bankAccount] ?? 10_000_000,
    emergencyKobo: 0,
    retirementKobo: 0,
    firstContribAt: null,
    lastWithdrawAt: null,
    withdrawnKobo: 0,
    withdrawals: [],
    inflows: [],
  };
  seedHistory(store.merchants[mid], t.bankAccount);
  save();
  return merchant;
}

// ---------- API surface ----------

export const engine = {
  traders: () => DEMO_TRADERS,

  merchants: (): Merchant[] => Object.values(store.merchants).map((m) => m.merchant),

  consent: (): Consent => ({ version: CONSENT_VERSION, text: CONSENT_TEXT }),

  onboard(req: OnboardRequest): OnboardResult {
    const t0 = Date.now();
    attempts = attempts.filter((t) => t0 - t < 60_000);
    if (attempts.length >= 5) throw new ApiError(429, 'RATE_LIMITED', 'Too many attempts, try again in a minute');
    attempts.push(t0);

    const phone = String(req.phone ?? '').replace(/[\s-]/g, '');
    if (!/^\+?\d{10,15}$/.test(phone)) throw new ApiError(400, 'INVALID_REQUEST', 'phone must be 10 to 15 digits', 'phone');
    const account = String(req.bankAccount ?? '');
    if (!/^\d{10}$/.test(account)) throw new ApiError(400, 'INVALID_REQUEST', 'bankAccount must be 10 digits', 'bankAccount');
    const bvn = String(req.bvn ?? '');
    if (!/^\d{11}$/.test(bvn)) throw new ApiError(400, 'INVALID_REQUEST', 'bvn must be 11 digits', 'bvn');
    const language = (req.language ?? 'pidgin') as Lang;
    if (!LANGS.includes(language)) throw new ApiError(400, 'INVALID_REQUEST', 'unsupported language', 'language');
    if (req.consentAccepted !== true) throw new ApiError(400, 'CONSENT_REQUIRED', 'Consent must be accepted', 'consentAccepted');
    if (req.consentVersion !== CONSENT_VERSION) {
      throw new ApiError(400, 'CONSENT_VERSION_MISMATCH', 'The consent text has changed. Reload and accept again', 'consentVersion');
    }

    const bvnAccount = DEMO_TRADERS.find((x) => x.bvn === bvn)?.bankAccount;
    const dup = Object.values(store.merchants).some((m) => m.merchant.bankAccount === account || m.merchant.phone === phone || m.merchant.bankAccount === bvnAccount);
    if (dup) throw new ApiError(409, 'ALREADY_ENROLLED', 'These details are already enrolled');

    const owner = DEMO_TRADERS.find((x) => x.bvn === bvn);
    if (!owner && bvn !== NEEDS_REVIEW_BVN) throw new ApiError(422, 'IDENTITY_NOT_VERIFIED', 'BVN could not be verified', 'bvn');
    const t = DEMO_TRADERS.find((x) => x.bankAccount === account);
    if (!t) throw new ApiError(422, 'ACCOUNT_NOT_FOUND', 'Account not found', 'bankAccount');
    if (bvn === NEEDS_REVIEW_BVN) throw new ApiError(422, 'NAME_NEEDS_REVIEW', 'Names are close but not identical, so this needs manual review');
    if (owner && owner.bankAccount !== t.bankAccount) throw new ApiError(422, 'NAME_MISMATCH', 'The BVN name does not match the account name');

    const m = enrol(t, phone, language);
    return { merchantId: m.id, fullName: m.fullName, language, rateBps: 200 };
  },

  summary: (mid: string): Summary => buildSummary(need(mid)),

  feed: (mid: string): FeedItem[] => buildFeed(need(mid)),

  activity: (mid: string): SweepRecord[] =>
    store.sweeps.filter((s) => s.merchantId === mid).slice().reverse(),

  // The sandbox accepts OTP 123456 for cards and consents (Forge guide 5.4); we reuse it for sign-in.
  verifyOtp(phone: string, code: string) {
    if (code !== '123456') throw new ApiError(400, 'INVALID_OTP', 'that code is not right.');
    const m = engine.byPhone(phone);
    return { merchantId: m ? m.merchant.id : null };
  },

  // Demo-only shortcut: open a sandbox trader with their own synthetic details (or return the one already open).
  demoSignIn(account: string): { merchantId: string } {
    const t = DEMO_TRADERS.find((x) => x.bankAccount === account);
    if (!t) throw new ApiError(422, 'ACCOUNT_NOT_FOUND', 'Account not found', 'bankAccount');
    const existing = Object.values(store.merchants).find((m) => m.merchant.bankAccount === account);
    if (existing) {
      existing.merchant.status = 'ACTIVE';
      save();
      return { merchantId: existing.merchant.id };
    }
    return { merchantId: enrol(t, t.phone, t.language).id };
  },

  updateSettings(mid: string, p: SettingsPatch): Summary {
    const m = need(mid);
    if (p.rateBps !== undefined) {
      if (p.rateBps < 100 || p.rateBps > 500) throw new Error('Rate must be between 1% and 5%.');
      m.merchant.rateBps = p.rateBps;
    }
    if (p.language) m.merchant.language = p.language;
    if (p.pauseHours !== undefined) m.merchant.pausedUntil = p.pauseHours > 0 ? now() + p.pauseHours * 3_600_000 : null;
    if (p.cancel) m.merchant.status = 'CANCELLED';
    if (p.reactivate) m.merchant.status = 'ACTIVE';
    save();
    return buildSummary(m);
  },

  withdraw(mid: string, amountKobo: number) {
    const m = need(mid);
    const e = eligibility(m);
    if (!e.eligible) return { ok: false, message: e.reason ?? 'Not available.' };
    if (amountKobo <= 0 || amountKobo > e.maxKobo) return { ok: false, message: 'Amount must be within your emergency pot.' };
    m.emergencyKobo -= amountKobo;
    m.balanceKobo += amountKobo;
    m.lastWithdrawAt = now();
    m.withdrawnKobo = (m.withdrawnKobo ?? 0) + amountKobo;
    m.withdrawals.push({ id: id('wd'), at: now(), amountKobo });
    save();
    return { ok: true, message: `${nairaPlain(amountKobo)} sent to account ${m.merchant.bankAccount}.` };
  },

  demoInflow(mid: string, amountKobo: number) {
    const m = need(mid);
    m.balanceKobo += amountKobo;
    const ch = CHANNELS[Math.floor(Math.random() * CHANNELS.length)];
    m.inflows.push({ id: id('in'), amountKobo, at: now(), swept: false, hold: null, payer: PAYERS[Math.floor(Math.random() * PAYERS.length)], channel: ch, ref: `NIP${Math.floor(Math.random() * 1e9).toString().padStart(9, '0')}` });
    save();
  },

  demoClock(days: number) {
    store.clockOffsetDays += days;
    save();
  },

  demoReset() {
    store = fresh();
    save();
  },

  // PRD 6.2 and 6.3.
  runSweep(force: ForceOutcome): OpsOverview {
    const date = sweepDate(now());
    for (const m of Object.values(store.merchants)) {
      if (m.merchant.status !== 'ACTIVE') continue;
      const prior = store.sweeps.find((s) => s.merchantId === m.merchant.id && s.sweepDate === date && s.status !== 'FAILED');
      if (prior) continue; // one sweep per merchant per date (idempotent)
      store.sweeps = store.sweeps.filter((s) => !(s.merchantId === m.merchant.id && s.sweepDate === date)); // drop an earlier FAILED run
      const bankRef = `SWP-${m.merchant.id}-${date.replace(/-/g, '')}`;
      const base = { id: id('sw'), merchantId: m.merchant.id, merchantName: m.merchant.fullName, sweepDate: date, rateBps: m.merchant.rateBps, bankReference: bankRef, executedAt: now() };

      // SweepGuard (mock rule): hold only the flagged credit, sweep the rest.
      for (const i of m.inflows) {
        if (!i.swept && i.hold === null && i.amountKobo >= HOLD_THRESHOLD_KOBO) {
          i.hold = 'HELD';
          store.alerts.push({
            id: id('al'),
            merchantId: m.merchant.id,
            merchantName: m.merchant.fullName,
            amountKobo: i.amountKobo,
            type: 'ANOMALY',
            status: 'PENDING_REVIEW',
            detail: `Credit of ${naira(i.amountKobo)} is far above this trader's normal daily takings.`,
          });
        }
      }

      const { takings, counted } = pendingTakings(m);
      const empty = { takingsKobo: takings, sweepKobo: 0, emergencyKobo: 0, retirementKobo: 0, pensionReference: null };

      if (isPaused(m)) { store.sweeps.push({ ...base, ...empty, status: 'SKIPPED_PAUSED' }); continue; }
      if (takings === 0) { store.sweeps.push({ ...base, ...empty, status: 'SKIPPED_ZERO_SALES' }); continue; }
      const c = calcSweep(takings, m.merchant.rateBps, m.balanceKobo);
      if (c.sweep === 0) { store.sweeps.push({ ...base, ...empty, status: 'SKIPPED_LOW_BALANCE' }); continue; }

      const ref = `PEN-${date.replace(/-/g, '')}-${String(store.seq).padStart(4, '0')}`;
      const rec: SweepRecord = { ...base, takingsKobo: takings, sweepKobo: c.sweep, emergencyKobo: c.emergency, retirementKobo: c.retirement, pensionReference: ref, status: 'SETTLED' };

      if (force === 'failed') {
        rec.status = 'FAILED';
        rec.pensionReference = null;
        rec.note = 'Transfer failed. Nothing was debited; the credits stay in the next window.';
      } else if (force === 'timeout') {
        rec.status = 'UNKNOWN';
        rec.note = 'Bank timed out. The outcome is unknown, so we requery and never resend.';
        for (const i of counted) i.swept = true;
      } else if (force === 'reversed') {
        rec.status = 'REVERSED';
        rec.note = 'Settled, then reversed by the bank. Contra entries posted; the pots are back to where they were.';
        for (const i of counted) i.swept = true;
      } else {
        m.balanceKobo -= c.sweep;
        m.emergencyKobo += c.emergency;
        m.retirementKobo += c.retirement;
        m.firstContribAt ??= now();
        for (const i of counted) i.swept = true;
      }
      store.sweeps.push(rec);
    }
    save();
    return engine.ops();
  },

  requery(sweepId: string): OpsOverview {
    const s = store.sweeps.find((x) => x.id === sweepId);
    if (s && s.status === 'UNKNOWN') {
      const m = need(s.merchantId);
      m.balanceKobo -= s.sweepKobo;
      m.emergencyKobo += s.emergencyKobo;
      m.retirementKobo += s.retirementKobo;
      m.firstContribAt ??= now();
      s.status = 'SETTLED';
      s.note = 'Requery confirmed the original transfer settled. No second transfer was sent.';
    }
    save();
    return engine.ops();
  },

  resolveAlert(alertId: string, decision: 'DISMISSED' | 'CONFIRMED'): OpsOverview {
    const a = store.alerts.find((x) => x.id === alertId);
    if (a && a.status === 'PENDING_REVIEW') {
      a.status = decision;
      const m = store.merchants[a.merchantId];
      const i = m?.inflows.find((x) => x.hold === 'HELD' && x.amountKobo === a.amountKobo);
      if (i) i.hold = decision; // DISMISSED joins the next window; CONFIRMED stays excluded
    }
    save();
    return engine.ops();
  },

  ops(): OpsOverview {
    const ms = Object.values(store.merchants);
    const aum = ms.reduce((a, m) => a + m.emergencyKobo + m.retirementKobo, 0);
    const date = sweepDate(now());
    const sweptToday = store.sweeps.filter((s) => s.sweepDate === date && s.status === 'SETTLED').reduce((a, s) => a + s.sweepKobo, 0);
    // Reconciliation: cash swept to the collection account vs pots we hold plus withdrawals already paid out.
    const ledger = store.sweeps.filter((s) => s.status === 'SETTLED').reduce((a, s) => a + s.sweepKobo, 0);
    const arm = aum + ms.reduce((a, m) => a + (m.withdrawnKobo ?? 0), 0);
    return {
      sweeps: [...store.sweeps].reverse(),
      alerts: [...store.alerts].reverse(),
      totals: { merchants: ms.length, aumKobo: aum, sweptTodayKobo: sweptToday },
      reconciliation: { ledgerKobo: ledger, armKobo: arm, diffKobo: ledger - arm },
      clockOffsetDays: store.clockOffsetDays,
    };
  },

  // ---------- channels (PRD 8.2, 8.3) ----------

  byPhone(phone: string): MState | undefined {
    return Object.values(store.merchants).find((m) => m.merchant.phone === phone);
  },

  ussd(phone: string, text: string): { type: 'CON' | 'END'; body: string } {
    const m = engine.byPhone(phone);
    if (!m) return { type: 'END', body: 'Kobo Kobo: this number is not registered. Join on the web app first.' };
    const s = buildSummary(m);
    const parts = text === '' ? [] : text.split('*');
    const root =
      'Kobo Kobo\n1 Balance\n2 Today and tonight\n3 Change rate (now ' + s.merchant.rateBps / 100 + '%)\n4 ' +
      (isPaused(m) ? 'Resume sweeps' : 'Pause sweeps') + '\n5 Emergency cashout\n6 Spoken balance';
    if (parts.length === 0) return { type: 'CON', body: root };

    switch (parts[0]) {
      case '1': {
        const avail = s.withdrawal.eligible ? 'available now' : s.withdrawal.availableFrom ? `from ${fmtDate(s.withdrawal.availableFrom)}` : 'not yet';
        return { type: 'END', body: `Total ${nairaPlain(s.emergencyKobo + s.retirementKobo)}\nEmergency ${nairaPlain(s.emergencyKobo)} (${avail})\nRetirement ${nairaPlain(s.retirementKobo)} (locked to 50)` };
      }
      case '2':
        return { type: 'END', body: `Today's takings ${nairaPlain(s.todayTakingsKobo)}\nSweep tonight ${nairaPlain(s.expectedSweepKobo)}${isPaused(m) ? ' (paused)' : ''}` };
      case '3': {
        if (parts.length === 1) return { type: 'CON', body: 'Choose rate\n1 1%\n2 2%\n3 3%\n4 4%\n5 5%' };
        const n = Number(parts[1]);
        if (n >= 1 && n <= 5) { m.merchant.rateBps = n * 100; save(); return { type: 'END', body: `Rate set to ${n}%. Applies from tonight.` }; }
        return { type: 'END', body: 'Invalid choice.' };
      }
      case '4': {
        const paused = isPaused(m);
        m.merchant.pausedUntil = paused ? null : now() + 48 * 3_600_000;
        save();
        return { type: 'END', body: paused ? 'Sweeps resumed.' : 'Sweeps paused for 48 hours.' };
      }
      case '5': {
        if (!s.withdrawal.eligible) return { type: 'END', body: s.withdrawal.reason ?? 'Not available.' };
        if (parts.length === 1) return { type: 'CON', body: `Cash out ${nairaPlain(s.withdrawal.maxKobo)}?\n1 Yes\n2 No` };
        if (parts[1] === '1') return { type: 'END', body: engine.withdraw(m.merchant.id, s.withdrawal.maxKobo).message };
        return { type: 'END', body: 'Cancelled.' };
      }
      case '6':
        return { type: 'END', body: 'Your balance will be read aloud. Use "Hear balance" in the app for the demo.' };
      default:
        return { type: 'END', body: 'Invalid choice.' };
    }
  },

  sms(phone: string, text: string): { reply: string } {
    const m = engine.byPhone(phone);
    if (!m) return { reply: 'Kobo Kobo: this number is not registered.' };
    const [cmd, arg] = text.trim().toUpperCase().split(/\s+/);
    const lang: Lang = m.merchant.language;
    switch (cmd) {
      case 'BAL':
        return { reply: balanceSms(buildSummary(m), lang) };
      case 'PAUSE':
        m.merchant.pausedUntil = now() + 48 * 3_600_000; save();
        return { reply: 'Kobo Kobo: sweeps paused for 48 hours. Text RESUME to restart.' };
      case 'RESUME':
        m.merchant.pausedUntil = null; save();
        return { reply: 'Kobo Kobo: sweeps resumed from tonight.' };
      case 'RATE': {
        const n = Number(arg);
        if (!(n >= 1 && n <= 5)) return { reply: 'Kobo Kobo: send RATE then a number from 1 to 5, for example RATE 3.' };
        m.merchant.rateBps = n * 100; save();
        return { reply: `Kobo Kobo: rate set to ${n}%. Applies from tonight.` };
      }
      case 'STOP':
        m.merchant.status = 'CANCELLED'; save();
        return { reply: 'Kobo Kobo: sweeps stopped. Your pension balance stays safe in your pension.' };
      case 'HELP':
        return { reply: SMS_HELP };
      default:
        return { reply: SMS_HELP };
    }
  },

  receipt: (s: SweepRecord, lang: Lang) => (s.pensionReference ? receiptSms(lang, s.sweepKobo, s.pensionReference) : ''),
};
