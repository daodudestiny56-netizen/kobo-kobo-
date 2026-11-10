'use client';

import { useMemo, useState } from 'react';
import { Download, Search } from 'lucide-react';
import type { FeedItem, FeedKind } from '@/lib/api/types';
import { dayHeading, naira } from '@/lib/money';
import { useFeed, useSession } from '@/lib/session';
import { FeedDetail } from '@/components/FeedDetail';
import { FeedRow } from '@/components/FeedRow';

type Filter = 'all' | 'in' | 'savings' | 'withdrawals' | 'skipped' | 'issues';

const FILTERS: { v: Filter; label: string; kinds: FeedKind[] | null }[] = [
  { v: 'all', label: 'All', kinds: null },
  { v: 'in', label: 'Money in', kinds: ['sale'] },
  { v: 'savings', label: 'Savings', kinds: ['saving'] },
  { v: 'withdrawals', label: 'Withdrawals', kinds: ['withdrawal'] },
  { v: 'skipped', label: 'Skipped nights', kinds: ['skipped'] },
  { v: 'issues', label: 'Issues', kinds: ['attention'] },
];

const PAGE = 40;

function csv(items: FeedItem[]): string {
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const rows = items.map((i) => {
    const d = new Date(i.at);
    return [d.toISOString().slice(0, 10), d.toISOString().slice(11, 16), i.kind, i.title, i.reference, (i.amountKobo / 100).toFixed(2), i.status].map(String).map(esc).join(',');
  });
  return ['Date,Time (UTC),Type,Description,Reference,Amount (NGN),Status', ...rows].join('\n');
}

export default function TransactionsPage() {
  const { data: feed, error } = useFeed();
  const { hideBalance } = useSession();
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [detail, setDetail] = useState<FeedItem | null>(null);

  const filtered = useMemo(() => {
    const kinds = FILTERS.find((f) => f.v === filter)?.kinds;
    const q = query.trim().toLowerCase();
    return (feed ?? []).filter((i) => (!kinds || kinds.includes(i.kind)) && (!q || `${i.title} ${i.subtitle} ${i.reference}`.toLowerCase().includes(q)));
  }, [feed, filter, query]);

  const shown = filtered.slice(0, limit);
  const groups = useMemo(() => {
    const out: { heading: string; rows: FeedItem[] }[] = [];
    for (const i of shown) {
      const h = dayHeading(i.at);
      const last = out[out.length - 1];
      if (last && last.heading === h) last.rows.push(i);
      else out.push({ heading: h, rows: [i] });
    }
    return out;
  }, [shown]);

  const moneyIn = filtered.filter((i) => i.amountKobo > 0 && i.kind === 'sale').reduce((a, i) => a + i.amountKobo, 0);
  const saved = filtered.filter((i) => i.kind === 'saving').reduce((a, i) => a + Math.abs(i.amountKobo), 0);

  function download() {
    const blob = new Blob([csv(filtered)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'kobo-kobo-transactions.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="page page-narrow" style={{ maxWidth: 820 }}>
      <div className="page-head">
        <div>
          <h1 className="h1">Transactions</h1>
          <p className="muted mt2">Payments from your customers, your nightly savings and withdrawals.</p>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={download} disabled={filtered.length === 0}><Download size={16} aria-hidden /> Download CSV</button>
      </div>

      <div className="row wrap">
        <label className="search">
          <Search size={18} aria-hidden />
          <span className="sr-only">Search transactions</span>
          <input type="search" placeholder="Search by name or reference" value={query} onChange={(e) => { setQuery(e.target.value); setLimit(PAGE); }} />
        </label>
      </div>
      <div className="segmented mt3" role="group" aria-label="Filter transactions">
        {FILTERS.map((f) => (
          <button key={f.v} aria-pressed={filter === f.v} onClick={() => { setFilter(f.v); setLimit(PAGE); }}>{f.label}</button>
        ))}
      </div>

      {error && <p className="error-text mt4" role="alert">{error}</p>}
      {!feed && !error && <div className="skeleton mt5" style={{ height: 220 }} aria-busy="true" />}

      {feed && (
        <p className="small muted mt4" aria-live="polite">
          {filtered.length} {filtered.length === 1 ? 'result' : 'results'}
          {!hideBalance && moneyIn > 0 && <> · Money in <b style={{ color: 'var(--ink)' }}>{naira(moneyIn)}</b></>}
          {!hideBalance && saved > 0 && <> · Saved <b style={{ color: 'var(--ink)' }}>{naira(saved)}</b></>}
        </p>
      )}

      {feed && filtered.length === 0 && (
        <div className="empty">
          <p>{query ? `Nothing matches "${query}".` : 'Nothing here yet.'}</p>
          {(query || filter !== 'all') && <button className="btn btn-text mt2" onClick={() => { setQuery(''); setFilter('all'); }}>Clear search and filters</button>}
        </div>
      )}

      {groups.map((g) => (
        <section key={g.heading} className="section" style={{ marginTop: 'var(--s5)' }} aria-label={g.heading}>
          <h2 className="eyebrow">{g.heading}</h2>
          <ul className="list mt2">{g.rows.map((i) => <FeedRow key={i.id} item={i} hidden={hideBalance} onOpen={setDetail} />)}</ul>
        </section>
      ))}

      {filtered.length > limit && (
        <button className="btn btn-secondary btn-block mt5" onClick={() => setLimit((l) => l + PAGE)}>Show more ({filtered.length - limit} left)</button>
      )}

      <FeedDetail item={detail} onClose={() => setDetail(null)} />
    </div>
  );
}
