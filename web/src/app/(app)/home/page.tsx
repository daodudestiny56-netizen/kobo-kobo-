'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, Clock, Copy, Check, Eye, EyeOff, Landmark, Lock, Pause, Play, Sparkles, Wallet } from 'lucide-react';
import { api } from '@/lib/api';
import type { FeedItem } from '@/lib/api/types';
import { greeting } from '@/lib/activity';
import { fmtDate, fmtDay, fmtShortDay, naira, nairaShort, pct } from '@/lib/money';
import { useFeed, useSession, useSummary } from '@/lib/session';
import { BarChart } from '@/components/BarChart';
import { FeedDetail } from '@/components/FeedDetail';
import { FeedRow } from '@/components/FeedRow';
import { LineChart } from '@/components/LineChart';
import { PauseSheet } from '@/components/PauseSheet';

const DAY = 86_400_000;

export default function HomePage() {
  const { data: s, error } = useSummary();
  const { data: feed } = useFeed();
  const { merchantId, hideBalance, setHideBalance, bump } = useSession();
  const [pauseOpen, setPauseOpen] = useState(false);
  const [range, setRange] = useState<30 | 90>(90);
  const [detail, setDetail] = useState<FeedItem | null>(null);
  const [copied, setCopied] = useState(false);

  const recent = useMemo(() => (feed ?? []).filter((f) => f.kind !== 'skipped').slice(0, 6), [feed]);

  if (!s) {
    return (
      <div className="page" aria-busy="true">
        <div className="skeleton" style={{ height: 36, width: 240 }} />
        <div className="skeleton mt5" style={{ height: 64, width: 320 }} />
        <div className="skeleton mt5" style={{ height: 240 }} />
        {error && <p className="error-text mt4" role="alert">{error}</p>}
      </div>
    );
  }

  const m = s.merchant;
  const now = Date.now() + s.clockOffsetDays * DAY;
  const paused = m.pausedUntil !== null && m.pausedUntil > now;
  const total = s.emergencyKobo + s.retirementKobo;
  const hide = hideBalance;
  const show = (kobo: number) => (hide ? '₦•••••' : naira(kobo));
  const fmt = (v: number) => (hide ? '₦•••' : naira(v));

  const eligible = s.withdrawal.eligible;
  const opens = s.withdrawal.availableFrom;
  const progress = eligible ? 100 : opens ? Math.max(0, Math.min(100, Math.round((1 - (opens - now) / (91 * DAY)) * 100))) : 0;

  const balancePoints = s.balanceSeries.slice(-range).map((p) => ({ label: fmtShortDay(p.date), value: p.totalKobo }));
  const bars = s.series.slice(-14).map((p, i, all) => ({
    label: fmtShortDay(p.date),
    value: p.takingsKobo,
    detail: hide ? 'Hidden' : `Sales ${naira(p.takingsKobo)} · Saved ${naira(p.savedKobo)}`,
    highlight: i === all.length - 1,
  }));

  async function resume() {
    if (!merchantId) return;
    await api.updateSettings(merchantId, { pauseHours: 0 });
    bump();
  }
  async function acceptSuggestion() {
    if (!merchantId || !s?.smartRate) return;
    await api.updateSettings(merchantId, { rateBps: s.smartRate.suggestedBps });
    bump();
  }
  async function copyAccount() {
    try {
      await navigator.clipboard.writeText(s!.account.number);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="page">
      <div className="dash-head">
        <div>
          <p className="muted">{greeting()},</p>
          <h1 className="h1">{m.fullName.split(' ')[0]}</h1>
        </div>
        <div className="row wrap">
          <Link href="/savings/withdraw" className="btn btn-primary"><Wallet size={20} aria-hidden /> Withdraw</Link>
          {paused ? (
            <button className="btn btn-secondary" onClick={resume}><Play size={18} aria-hidden /> Resume saving</button>
          ) : (
            <button className="btn btn-secondary" onClick={() => setPauseOpen(true)}><Pause size={18} aria-hidden /> Pause saving</button>
          )}
        </div>
      </div>

      {m.status === 'CANCELLED' && (
        <p className="notice notice-attn mt4" role="status">
          <span><span className="notice-title">Saving is stopped.</span> Your pension balance stays safe. <Link href="/settings/security" style={{ fontWeight: 700 }}>Start saving again</Link></span>
        </p>
      )}

      <div className="cols mt5">
        <div className="col-main">
          <section aria-labelledby="bal-h">
            <div className="row between">
              <p id="bal-h" className="muted">Pension balance</p>
              <button className="icon-btn" onClick={() => setHideBalance(!hide)} aria-pressed={hide} aria-label={hide ? 'Show balances' : 'Hide balances'}>
                {hide ? <EyeOff size={22} aria-hidden /> : <Eye size={22} aria-hidden />}
              </button>
            </div>
            <p className="amount-xl" aria-live="polite">{show(total)}</p>
            <div className="balance-line">
              {s.stats.savedThisMonthKobo > 0 && <span className="delta"><ArrowUpRight size={14} aria-hidden /> {hide ? '₦•••' : naira(s.stats.savedThisMonthKobo)} this month</span>}
              {s.stats.memberSince && <span className="small muted">Saving since {fmtDate(s.stats.memberSince)}</span>}
            </div>
            <div className="row between wrap mt5">
              <p className="small muted">Last {range} days</p>
              <div className="segmented" role="group" aria-label="Chart range">
                <button aria-pressed={range === 30} onClick={() => setRange(30)}>30 days</button>
                <button aria-pressed={range === 90} onClick={() => setRange(90)}>90 days</button>
              </div>
            </div>
            <div className="mt3">
              {total > 0 ? (
                <LineChart points={balancePoints} format={fmt} ariaLabel={`Pension balance over the last ${range} days`} />
              ) : (
                <p className="empty">Your balance chart appears after your first saving. Savings happen on any night you have sales.</p>
              )}
            </div>
          </section>

          <section className="section" aria-labelledby="pots-h">
            <div className="section-head">
              <h2 id="pots-h" className="h2">Your two pots</h2>
              <Link href="/savings" className="btn btn-text">Details</Link>
            </div>
            <div className="pots">
              <div className="pot pot-emergency">
                <p className="pot-label"><Clock size={18} aria-hidden /> Emergency pot</p>
                <p className="amount-lg">{show(s.emergencyKobo)}</p>
                <div className="meter" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} aria-label="Time until the emergency pot opens">
                  <span style={{ width: `${progress}%` }} />
                </div>
                <p className="small" style={{ color: 'var(--ink-2)' }}>
                  {eligible ? 'Open. You can withdraw now.' : opens ? `Opens on ${fmtDate(opens)}` : 'Opens 3 months after your first saving.'}
                </p>
              </div>
              <div className="pot pot-retirement">
                <p className="pot-label"><Lock size={18} aria-hidden /> Retirement pot</p>
                <p className="amount-lg">{show(s.retirementKobo)}</p>
                <p className="small" style={{ color: 'var(--ink-2)' }}>Locked until you are 50.</p>
              </div>
            </div>
          </section>

          <section className="section" aria-labelledby="sales-h">
            <h2 id="sales-h" className="h2">Sales and savings, last 14 days</h2>
            <p className="small muted mt1">Each bar is a day&apos;s sales. Tap or hover a bar to see what was saved.</p>
            <div className="mt3">
              <BarChart bars={bars} format={(v) => (hide ? '₦•••' : nairaShort(v))} ariaLabel="Daily sales for the last 14 days" />
            </div>
          </section>

          <section className="section" aria-labelledby="recent-h">
            <div className="section-head">
              <h2 id="recent-h" className="h2">Recent transactions</h2>
              <Link href="/transactions" className="btn btn-text">See all</Link>
            </div>
            {recent.length === 0 ? (
              <p className="empty">No transactions yet. Payments from your customers and your nightly savings will show here.</p>
            ) : (
              <ul className="list">{recent.map((f) => <FeedRow key={f.id} item={f} hidden={hide} onOpen={setDetail} />)}</ul>
            )}
          </section>
        </div>

        <aside className="col-aside" aria-label="Account and plan">
          <section className="panel" aria-labelledby="acct-h">
            <div className="row between">
              <p id="acct-h" className="eyebrow">Linked account</p>
              <Link href="/settings/account" className="btn btn-text btn-sm">Manage</Link>
            </div>
            <div className="account-line">
              <span className="item-icon"><Landmark size={20} aria-hidden /></span>
              <span className="grow">
                <b>{s.account.bankName}</b>
                <br />
                <span className="small muted mono">{hide ? '••••••' + s.account.number.slice(-4) : s.account.number}</span>
              </span>
              <button className="icon-btn" onClick={copyAccount} aria-label="Copy account number">{copied ? <Check size={18} aria-hidden /> : <Copy size={18} aria-hidden />}</button>
            </div>
            <p className="amount-lg num">{show(s.account.balanceKobo)}</p>
            <p className="small muted">Available balance. Your sales land here first.</p>
          </section>

          <section className="panel" aria-labelledby="tonight-h">
            <p id="tonight-h" className="eyebrow">Tonight at 11:00 pm</p>
            <ul className="facts">
              <li><span className="k">Sales today</span><span className="v num">{show(s.todayTakingsKobo)}</span></li>
              <li><span className="k">Your share</span><span className="v">{pct(m.rateBps)}</span></li>
              <li><span className="k">Will be saved</span><span className="v num">{paused ? 'Paused' : show(s.expectedSweepKobo)}</span></li>
            </ul>
            {s.heldKobo > 0 && <p className="notice notice-attn"><span className="small">{show(s.heldKobo)} is held for a safety check and is not counted.</span></p>}
            <p className="small muted">
              {paused ? `Saving is paused until ${fmtDate(m.pausedUntil!)}.` : s.todayTakingsKobo === 0 ? 'No sales yet today, so nothing will be taken.' : 'Sales since your last saving count towards tonight.'}
            </p>
            <Link href="/settings/plan" className="btn btn-secondary btn-sm">Change plan</Link>
          </section>

          <section className="panel" aria-labelledby="ins-h">
            <p id="ins-h" className="eyebrow">Your last 30 days</p>
            <ul className="facts">
              <li><span className="k">Average daily sales</span><span className="v num">{show(s.stats.avgSales30Kobo)}</span></li>
              <li><span className="k">Nights saved</span><span className="v">{s.stats.nightsSaved30} of 30</span></li>
              <li><span className="k">Saved this month</span><span className="v num">{show(s.stats.savedThisMonthKobo)}</span></li>
              {s.stats.bestDay && <li><span className="k">Best day</span><span className="v">{hide ? '₦•••' : naira(s.stats.bestDay.takingsKobo)} · {fmtDay(s.stats.bestDay.date)}</span></li>}
            </ul>
          </section>

          {s.smartRate && (
            <section className="panel" aria-labelledby="sug-h">
              <p id="sug-h" className="eyebrow"><Sparkles size={14} aria-hidden style={{ verticalAlign: '-2px' }} /> Suggestion</p>
              <p><b>Change your share to {pct(s.smartRate.suggestedBps)}?</b></p>
              <p className="small muted">{s.smartRate.reason} We only change it if you say yes.</p>
              <div className="row wrap">
                <button className="btn btn-primary btn-sm" onClick={acceptSuggestion}>Yes, change it</button>
                <Link href="/settings/plan" className="btn btn-text">Choose myself</Link>
              </div>
            </section>
          )}
        </aside>
      </div>

      <PauseSheet open={pauseOpen} onClose={() => setPauseOpen(false)} />
      <FeedDetail item={detail} onClose={() => setDetail(null)} />
    </div>
  );
}
