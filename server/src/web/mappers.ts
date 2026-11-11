import type { Deps } from '../deps';
import { listAlerts } from '../sweeps/alerts';
import { mapSweep, type Sweep } from '../sweeps/engine';
import { getOffsetDays } from '../demo/clock';
import { tierOf } from '../demo/traders';
import { NEVER, addDays, sweepWindow, toWatDate } from '../time';
import { getMerchant, type Merchant } from '../merchants/service';
import { merchantSummary } from '../merchants/summary';
import { withdrawalRefusal } from '../messages/templates';
import { reconciliationReport } from '../reconciliation/report';
import { getOpenSuggestion } from '../smart-rate/service';
import { toKobo } from '../money';

/**
 * Shapes the web app (web/src/lib/api/types.ts) reads. Money is integer kobo as a plain number; every time is
 * epoch milliseconds. Keep these in step with that file.
 */
const BANK_NAME = 'Access Bank';
const ms = (d: Date | string | null | undefined): number | null => (d ? new Date(d).getTime() : null);
const n = (v: unknown): number => Number(toKobo(v as number | bigint));

export function webMerchant(deps: Deps, m: Merchant) {
  const pin = deps.db.prepare('SELECT rsa_pin FROM pension_accounts WHERE merchant_id = ?').get(m.id) as { rsa_pin: string } | undefined;
  return {
    id: m.id,
    fullName: m.fullName,
    phone: m.phone,
    bankAccount: m.bankAccount,
    virtualAccount: m.virtualAccount ?? '',
    rsaPin: pin?.rsa_pin ?? '',
    language: m.language,
    rateBps: m.rateBps,
    pausedUntil: m.pausedUntil && m.pausedUntil.toISOString() !== NEVER && m.pausedUntil > deps.clock() ? m.pausedUntil.getTime() : m.pausedUntil?.toISOString() === NEVER ? Date.parse(NEVER) : null,
    status: m.status,
  };
}

const SWEEP_STATUS: Record<string, string> = { PLANNED: 'UNKNOWN', SUBMITTED: 'UNKNOWN' };

export function webSweep(s: Sweep, merchantName: string) {
  return {
    id: s.id,
    merchantId: s.merchantId,
    merchantName,
    sweepDate: s.sweepDate,
    takingsKobo: n(s.takings),
    rateBps: s.rateBps,
    sweepKobo: n(s.sweep),
    emergencyKobo: n(s.emergency),
    retirementKobo: n(s.retirement),
    status: SWEEP_STATUS[s.status] ?? s.status,
    pensionReference: s.pensionReference,
    bankReference: s.bankReference,
    ...(s.settledAt ? { executedAt: Date.parse(s.settledAt) } : {}),
    ...(s.failureReason || s.lastError ? { note: s.failureReason ?? s.lastError ?? undefined } : {}),
  };
}

function sweepsOf(deps: Deps, merchantId: string, limit = 400): Sweep[] {
  return (deps.db.prepare('SELECT * FROM sweeps WHERE merchant_id = ? ORDER BY sweep_date DESC LIMIT ?').all(merchantId, limit) as any[]).map(mapSweep);
}

export function webActivity(deps: Deps, merchantId: string) {
  const m = getMerchant(deps.db, merchantId);
  return sweepsOf(deps, merchantId, 120).map((s) => webSweep(s, m.fullName));
}

const dateRange = (today: string, days: number) => Array.from({ length: days }, (_, i) => addDays(today, -(days - 1 - i)));

export async function webSummary(deps: Deps, merchantId: string) {
  const s = merchantSummary(deps, merchantId);
  const m = s.merchant;
  const today = s.nextSweepDate;
  const { from, to } = sweepWindow(today);
  const held = (deps.db
    .prepare(`SELECT COALESCE(SUM(amount_kobo),0) v FROM inflows WHERE merchant_id = ? AND counted = 1 AND hold_status = 'HELD' AND settled_at >= ? AND settled_at < ?`)
    .get(m.id, from.toISOString(), to.toISOString()) as { v: number }).v;
  const expected = s.paused ? 0 : n(s.estimatedSweep);

  const mine = sweepsOf(deps, m.id);
  const byDate = new Map(mine.map((x) => [x.sweepDate, x]));
  const settled = mine.filter((x) => x.status === 'SETTLED');
  const withdrawn = (deps.db.prepare(`SELECT amount_kobo a, effective_at e FROM withdrawals WHERE merchant_id = ? AND status IN ('REQUESTED','UNKNOWN','DISBURSED')`).all(m.id) as { a: number; e: string }[]).map((w) => ({
    kobo: w.a,
    date: toWatDate(new Date(w.e)),
  }));

  const last30 = dateRange(today, 30);
  const series = last30.map((d) => {
    const sw = byDate.get(d);
    if (sw) return { date: d, takingsKobo: n(sw.takings), savedKobo: sw.status === 'SETTLED' ? n(sw.sweep) : 0 };
    if (d === today) return { date: d, takingsKobo: n(s.takingsToday), savedKobo: expected };
    return { date: d, takingsKobo: 0, savedKobo: 0 };
  });
  const balanceSeries = dateRange(today, 90).map((d) => {
    const saved = settled.filter((x) => x.sweepDate <= d).reduce((a, x) => a + n(x.sweep), 0);
    const out = withdrawn.filter((w) => w.date <= d).reduce((a, w) => a + w.kobo, 0);
    return { date: d, totalKobo: Math.max(saved - out, 0) };
  });

  const in30 = new Set(last30);
  const in90 = new Set(dateRange(today, 90));
  const past30 = series.filter((p) => p.date !== today).map((p) => p.takingsKobo);
  const best = mine.filter((x) => in90.has(x.sweepDate)).sort((a, b) => Number(b.takings - a.takings))[0];
  const stats = {
    savedThisMonthKobo: settled.filter((x) => x.sweepDate.startsWith(today.slice(0, 7))).reduce((a, x) => a + n(x.sweep), 0),
    savedAllTimeKobo: settled.reduce((a, x) => a + n(x.sweep), 0),
    nightsSaved30: settled.filter((x) => in30.has(x.sweepDate)).length,
    avgSales30Kobo: past30.length ? Math.round(past30.reduce((a, b) => a + b, 0) / past30.length) : 0,
    bestDay: best && best.takings > 0n ? { date: best.sweepDate, takingsKobo: n(best.takings) } : null,
    memberSince: ms(s.firstContributionAt),
  };

  let balance = 0;
  try {
    balance = Number(await deps.bank.getBalance(m.bankAccount));
  } catch {
    // the bank being unreachable must not break the home screen
  }
  const open = getOpenSuggestion(deps, m.id);
  const e = s.eligibility;
  return {
    merchant: webMerchant(deps, m),
    bankBalanceKobo: balance,
    todayTakingsKobo: n(s.takingsToday),
    heldKobo: held,
    expectedSweepKobo: expected,
    emergencyKobo: n(s.pots.emergency),
    retirementKobo: n(s.pots.retirement),
    withdrawal: {
      eligible: e.eligible,
      maxKobo: e.eligible ? n(s.pots.emergency) : 0,
      ...(e.eligible ? {} : { reason: withdrawalRefusal(m.language, e) }),
      ...(e.eligibleOn ? { availableFrom: e.eligibleOn.getTime() } : {}),
    },
    smartRate: open ? { suggestedBps: open.suggestedBps, reason: open.reason ?? '' } : null,
    recent: mine.slice(0, 8).map((x) => webSweep(x, m.fullName)),
    clockOffsetDays: s.demoClockOffsetDays,
    account: { bankName: BANK_NAME, number: m.bankAccount, balanceKobo: balance, tier: tierOf(m.bankAccount) },
    stats,
    series,
    balanceSeries,
  };
}

type FeedItem = { id: string; kind: 'sale' | 'saving' | 'withdrawal' | 'skipped' | 'attention'; at: number; title: string; subtitle: string; amountKobo: number; reference: string; status: 'completed' | 'pending' | 'failed' | 'reversed'; sweepId?: string };

const CHANNEL: Record<string, string> = { POS: 'POS card payment', QR: 'QR payment', NIP_TRANSFER: 'Bank transfer' };

/** Customer payments, nightly savings and withdrawals in one newest-first list. Money in is positive. */
export function webFeed(deps: Deps, merchantId: string): FeedItem[] {
  const items: FeedItem[] = [];
  const inflows = deps.db.prepare('SELECT id, bank_reference, amount_kobo, channel, counted, hold_status, settled_at FROM inflows WHERE merchant_id = ? ORDER BY settled_at DESC LIMIT 150').all(merchantId) as any[];
  for (const i of inflows) {
    if (!i.counted) continue;
    const held = i.hold_status === 'HELD';
    items.push({
      id: `in-${i.id}`, kind: held ? 'attention' : 'sale', at: Date.parse(i.settled_at), amountKobo: i.amount_kobo, reference: i.bank_reference,
      title: held ? 'Payment held for review' : 'Payment received', subtitle: held ? 'Left out of tonight\'s savings until we check it' : CHANNEL[i.channel] ?? 'Payment',
      status: 'completed',
    });
  }
  for (const s of sweepsOf(deps, merchantId, 120)) {
    const at = Date.parse(s.settledAt ?? s.windowEnd);
    const base = { at, reference: s.pensionReference ?? s.bankReference, sweepId: s.id };
    if (s.status === 'SETTLED') items.push({ ...base, id: `sw-${s.id}`, kind: 'saving', title: 'Saved to your pension', subtitle: `${s.sweepDate} · ${s.rateBps / 100}% of takings`, amountKobo: -n(s.sweep), status: 'completed' });
    else if (s.status === 'REVERSED') items.push({ ...base, id: `sw-${s.id}`, kind: 'saving', title: 'Saving reversed', subtitle: 'The bank sent this money back', amountKobo: 0, status: 'reversed' });
    else if (s.status === 'FAILED') items.push({ ...base, id: `sw-${s.id}`, kind: 'attention', title: 'Saving did not go through', subtitle: 'Nothing was taken. We will try again tonight', amountKobo: 0, status: 'failed' });
    else if (s.status === 'HELD_GUARD') items.push({ ...base, id: `sw-${s.id}`, kind: 'attention', title: 'Savings held for review', subtitle: 'A payment looked unusual, so nothing was taken', amountKobo: 0, status: 'pending' });
    else if (s.status === 'SUBMITTED' || s.status === 'UNKNOWN' || s.status === 'PLANNED') items.push({ ...base, id: `sw-${s.id}`, kind: 'saving', title: 'Saving in progress', subtitle: 'Waiting for the bank to confirm', amountKobo: -n(s.sweep), status: 'pending' });
    else items.push({ ...base, id: `sw-${s.id}`, kind: 'skipped', title: 'Skipped tonight', subtitle: ({ SKIPPED_ZERO_SALES: 'No sales today', SKIPPED_PAUSED: 'Your savings were paused', SKIPPED_LOW_BALANCE: 'Your balance was below the minimum' } as Record<string, string>)[s.status] ?? s.status, amountKobo: 0, status: 'completed' });
  }
  const wds = deps.db.prepare('SELECT id, amount_kobo, status, bank_reference, effective_at, created_at FROM withdrawals WHERE merchant_id = ? ORDER BY created_at DESC LIMIT 50').all(merchantId) as any[];
  for (const w of wds) {
    if (w.status === 'REJECTED') continue;
    items.push({
      id: `wd-${w.id}`, kind: 'withdrawal', at: Date.parse(w.created_at), amountKobo: w.amount_kobo, reference: w.bank_reference ?? w.id,
      title: w.status === 'FAILED' ? 'Withdrawal failed' : 'Emergency withdrawal', subtitle: w.status === 'FAILED' ? 'Your money is back in the Emergency Pot' : 'From your Emergency Pot to your bank account',
      status: w.status === 'DISBURSED' ? 'completed' : w.status === 'FAILED' ? 'failed' : 'pending',
    });
  }
  return items.sort((a, b) => b.at - a.at).slice(0, 200);
}

function alertDetail(details: unknown): string {
  if (!details || typeof details !== 'object') return '';
  return Object.entries(details as Record<string, unknown>).map(([k, v]) => `${k}: ${typeof v === 'bigint' ? v.toString() : String(v)}`).join(', ').slice(0, 200);
}

export async function webOverview(deps: Deps) {
  const names = new Map((deps.db.prepare('SELECT id, full_name FROM merchants').all() as { id: string; full_name: string }[]).map((r) => [r.id, r.full_name]));
  const sweeps = (deps.db.prepare('SELECT * FROM sweeps ORDER BY sweep_date DESC, updated_at DESC LIMIT 80').all() as any[]).map(mapSweep).map((s) => webSweep(s, names.get(s.merchantId) ?? ''));
  const amounts = new Map((deps.db.prepare('SELECT id, amount_kobo FROM inflows').all() as { id: string; amount_kobo: number }[]).map((r) => [r.id, r.amount_kobo]));
  const alerts = listAlerts(deps.db).slice(0, 60).map((a) => ({
    id: a.id, merchantId: a.merchantId, merchantName: names.get(a.merchantId) ?? '', amountKobo: a.inflowId ? amounts.get(a.inflowId) ?? 0 : 0,
    type: a.type, status: a.status, detail: alertDetail(a.details),
  }));
  const rec = await reconciliationReport(deps);
  const today = toWatDate(deps.clock());
  const swept = (deps.db.prepare(`SELECT COALESCE(SUM(sweep_kobo),0) v FROM sweeps WHERE status = 'SETTLED' AND sweep_date = ?`).get(today) as { v: number }).v;
  const merchants = (deps.db.prepare(`SELECT COUNT(*) c FROM merchants WHERE status = 'ACTIVE'`).get() as { c: number }).c;
  const ledger = n(rec.ledger.potsTotal);
  const arm = n(rec.ledger.sweptTotal - rec.ledger.withdrawnTotal);
  return {
    sweeps,
    alerts,
    totals: { merchants, aumKobo: ledger, sweptTodayKobo: swept },
    reconciliation: { ledgerKobo: ledger, armKobo: arm, diffKobo: ledger - arm },
    clockOffsetDays: deps.config.demoMode ? getOffsetDays(deps.db) : 0,
  };
}
