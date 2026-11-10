'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Check, Copy } from 'lucide-react';
import { api } from '@/lib/api';
import type { SweepRecord } from '@/lib/api/types';
import { describeSweep } from '@/lib/activity';
import { fmtDay, naira, pct } from '@/lib/money';
import { useSession } from '@/lib/session';

const EXPLAIN: Record<string, string> = {
  SETTLED: 'This share of your day’s sales moved from your account into your pension.',
  SKIPPED_ZERO_SALES: 'You had no sales in this period, so nothing was taken. Saving only ever follows your sales.',
  SKIPPED_PAUSED: 'Restock mode was on, so nothing was taken.',
  SKIPPED_LOW_BALANCE: 'Taking the saving would have left less than the safety minimum in your account, so we left it for another night.',
  HELD_GUARD: 'A payment far larger than usual arrived. We hold it back until it is checked, in case it was sent by mistake. Your other sales are not affected.',
  FAILED: 'The transfer did not go through. Nothing was taken from your account.',
  UNKNOWN: 'The bank has not confirmed this yet. We are checking, and we will not try to take the money a second time.',
  REVERSED: 'The bank reversed this transfer. The money is back in your account and your pension pots are unchanged.',
};

export default function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { merchantId, version } = useSession();
  const [item, setItem] = useState<SweepRecord | null | undefined>(undefined);
  const [copied, setCopied] = useState('');

  useEffect(() => {
    if (!merchantId) return;
    api.activity(merchantId).then((all) => setItem(all.find((x) => x.id === id) ?? null)).catch(() => setItem(null));
  }, [merchantId, id, version]);

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(text);
      setTimeout(() => setCopied(''), 1800);
    } catch {
      setCopied('');
    }
  }

  if (item === undefined) return <div className="page page-narrow" aria-busy="true"><div className="skeleton" style={{ height: 220 }} /></div>;
  if (item === null) {
    return (
      <div className="page page-narrow">
        <Link href="/transactions" className="back"><ArrowLeft size={18} aria-hidden /> Transactions</Link>
        <h1 className="h1 mt2">We could not find that receipt</h1>
        <p className="muted mt2">It may belong to a different account, or the demo was reset.</p>
      </div>
    );
  }

  const v = describeSweep(item);

  return (
    <div className="page page-narrow">
      <Link href="/transactions" className="back"><ArrowLeft size={18} aria-hidden /> Transactions</Link>
      <p className="mt3"><span className={`tag ${v.tone === 'positive' ? 'tag-brand' : v.tone === 'attention' ? 'tag-attn' : ''}`}>{v.title}</span></p>
      <p className="amount-xl mt3">{naira(item.sweepKobo)}</p>
      <p className="muted mt2">{fmtDay(item.sweepDate)}</p>
      <p className="mt4" style={{ color: 'var(--ink-2)', maxWidth: '60ch' }}>{EXPLAIN[item.status]}</p>
      {item.note && <p className="notice mt4"><span className="small">{item.note}</span></p>}

      <h2 className="h2 mt6">The numbers</h2>
      <ul className="facts">
        <li><span className="k">Your sales counted</span><span className="v num">{naira(item.takingsKobo)}</span></li>
        <li><span className="k">Your share</span><span className="v">{pct(item.rateBps)}</span></li>
        <li><span className="k">To emergency pot</span><span className="v num">{naira(item.emergencyKobo)}</span></li>
        <li><span className="k">To retirement pot</span><span className="v num">{naira(item.retirementKobo)}</span></li>
        <li><span className="k">Fee</span><span className="v">{naira(0)}</span></li>
      </ul>

      <h2 className="h2 mt6">Reference numbers</h2>
      <ul className="facts">
        <li>
          <span className="k">Pension receipt</span>
          <span className="v">
            {item.pensionReference ? (
              <button className="btn btn-text" onClick={() => copy(item.pensionReference!)} aria-label={`Copy receipt number ${item.pensionReference}`}>
                {item.pensionReference} {copied === item.pensionReference ? <Check size={16} aria-hidden /> : <Copy size={16} aria-hidden />}
              </button>
            ) : (
              <span className="muted">None, nothing was saved</span>
            )}
          </span>
        </li>
        <li>
          <span className="k">Bank reference</span>
          <span className="v">
            <button className="btn btn-text" onClick={() => copy(item.bankReference)} aria-label={`Copy bank reference ${item.bankReference}`}>
              {item.bankReference} {copied === item.bankReference ? <Check size={16} aria-hidden /> : <Copy size={16} aria-hidden />}
            </button>
          </span>
        </li>
      </ul>
      <p aria-live="polite" className="small is-brand mt2">{copied ? 'Copied.' : ''}</p>
    </div>
  );
}
