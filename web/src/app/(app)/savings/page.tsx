'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Clock, Download, Lock } from 'lucide-react';
import { api } from '@/lib/api';
import type { SweepRecord } from '@/lib/api/types';
import { fmtDate, fmtShortDay, naira } from '@/lib/money';
import { useSession, useSummary } from '@/lib/session';
import { LineChart } from '@/components/LineChart';

const DAY = 86_400_000;

function monthName(key: string) {
  return new Date(`${key}-01T12:00:00`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

export default function SavingsPage() {
  const { data: s } = useSummary();
  const { merchantId, version, hideBalance } = useSession();
  const [sweeps, setSweeps] = useState<SweepRecord[] | null>(null);

  useEffect(() => {
    if (!merchantId) return;
    api.activity(merchantId).then(setSweeps).catch(() => setSweeps([]));
  }, [merchantId, version]);

  const months = useMemo(() => {
    const map = new Map<string, { sales: number; saved: number; saved_nights: number; skipped: number }>();
    for (const x of sweeps ?? []) {
      const k = x.sweepDate.slice(0, 7);
      const row = map.get(k) ?? { sales: 0, saved: 0, saved_nights: 0, skipped: 0 };
      row.sales += x.takingsKobo;
      if (x.status === 'SETTLED') {
        row.saved += x.sweepKobo;
        row.saved_nights += 1;
      } else if (x.status === 'SKIPPED_ZERO_SALES' || x.status === 'SKIPPED_PAUSED') row.skipped += 1;
      map.set(k, row);
    }
    return [...map.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [sweeps]);

  if (!s) return <div className="page" aria-busy="true"><div className="skeleton" style={{ height: 260 }} /></div>;

  const hide = hideBalance;
  const show = (k: number) => (hide ? '₦•••••' : naira(k));
  const fmt = (v: number) => (hide ? '₦•••' : naira(v));
  const now = Date.now() + s.clockOffsetDays * DAY;
  const w = s.withdrawal;
  const progress = w.eligible ? 100 : w.availableFrom ? Math.max(0, Math.min(100, Math.round((1 - (w.availableFrom - now) / (91 * DAY)) * 100))) : 0;
  const total = s.emergencyKobo + s.retirementKobo;

  function statement() {
    const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const rows = (sweeps ?? []).slice().reverse().map((x) =>
      [x.sweepDate, (x.takingsKobo / 100).toFixed(2), `${x.rateBps / 100}%`, (x.sweepKobo / 100).toFixed(2), (x.emergencyKobo / 100).toFixed(2), (x.retirementKobo / 100).toFixed(2), x.pensionReference ?? '', x.status].map(String).map(esc).join(','),
    );
    const csv = ['Date,Sales (NGN),Share,Saved (NGN),To emergency pot (NGN),To retirement pot (NGN),Receipt,Status', ...rows].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'kobo-kobo-savings-statement.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="page page-narrow" style={{ maxWidth: 900 }}>
      <div className="page-head">
        <div>
          <h1 className="h1">Savings</h1>
          <p className="muted mt2">Total saved</p>
          <p className="amount-xl num">{show(total)}</p>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={statement} disabled={!sweeps || sweeps.length === 0}><Download size={16} aria-hidden /> Download statement</button>
      </div>

      {total > 0 && (
        <section aria-labelledby="growth-h">
          <h2 id="growth-h" className="h2">Growth over 90 days</h2>
          <div className="mt3"><LineChart points={s.balanceSeries.map((p) => ({ label: fmtShortDay(p.date), value: p.totalKobo }))} format={fmt} ariaLabel="Pension balance over the last 90 days" /></div>
        </section>
      )}

      <section className="section pots" aria-label="Your pots">
        <div className="pot pot-emergency">
          <p className="pot-label"><Clock size={18} aria-hidden /> Emergency pot</p>
          <p className="amount-lg">{show(s.emergencyKobo)}</p>
          <div className="meter" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} aria-label="Time until the emergency pot opens"><span style={{ width: `${progress}%` }} /></div>
          <p className="small" style={{ color: 'var(--ink-2)' }}>
            {w.eligible ? 'Open. Take money out whenever you need it, once every 2 months.' : w.availableFrom ? `Opens on ${fmtDate(w.availableFrom)}, 3 months after your first saving.` : 'Opens 3 months after your first saving.'}
          </p>
          <div className="row"><Link href="/savings/withdraw" className="btn btn-primary btn-sm">Withdraw</Link></div>
        </div>
        <div className="pot pot-retirement">
          <p className="pot-label"><Lock size={18} aria-hidden /> Retirement pot</p>
          <p className="amount-lg">{show(s.retirementKobo)}</p>
          <p className="small" style={{ color: 'var(--ink-2)' }}>Locked until you are 50. Keeping it locked is what protects your old age.</p>
        </div>
      </section>

      <section className="section" aria-labelledby="months-h">
        <h2 id="months-h" className="h2">Month by month</h2>
        {!sweeps ? <div className="skeleton mt3" style={{ height: 160 }} aria-busy="true" /> : months.length === 0 ? (
          <p className="empty">Your monthly summary appears after your first saving.</p>
        ) : (
          <div className="table-wrap mt3">
            <table className="table" style={{ minWidth: 520 }}>
              <thead>
                <tr><th scope="col">Month</th><th scope="col" className="r">Sales</th><th scope="col" className="r">Saved</th><th scope="col" className="r">Nights saved</th><th scope="col" className="r">Nights skipped</th></tr>
              </thead>
              <tbody>
                {months.map(([k, r]) => (
                  <tr key={k}>
                    <td>{monthName(k)}</td>
                    <td className="r num">{show(r.sales)}</td>
                    <td className="r num"><b>{show(r.saved)}</b></td>
                    <td className="r">{r.saved_nights}</td>
                    <td className="r">{r.skipped}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="split mt7">
        <section aria-labelledby="rules-h">
          <h2 id="rules-h" className="h2">How your savings are split</h2>
          <ul className="facts mt2">
            <li><span className="k">Each saving</span><span className="v">Half emergency, half retirement</span></li>
            <li><span className="k">Emergency pot</span><span className="v">Opens after 3 months, then once every 2 months</span></li>
            <li><span className="k">Withdrawals go to</span><span className="v">{s.merchant.bankAccount}</span></li>
            <li><span className="k">Retirement pot</span><span className="v">Paid out from age 50</span></li>
          </ul>
        </section>
        <section aria-labelledby="pen-h">
          <h2 id="pen-h" className="h2">Your pension</h2>
          <ul className="facts mt2">
            <li><span className="k">Fund manager</span><span className="v">Access ARM Pensions</span></li>
            <li><span className="k">Pension number (RSA PIN)</span><span className="v mono">{s.merchant.rsaPin}</span></li>
            <li><span className="k">Fund</span><span className="v">Fund 5A, the cautious default</span></li>
          </ul>
          <p className="small muted mt3">Pension returns are not guaranteed and can be lower than inflation. Ask Access ARM for your fund&apos;s latest returns.</p>
        </section>
      </div>
    </div>
  );
}
