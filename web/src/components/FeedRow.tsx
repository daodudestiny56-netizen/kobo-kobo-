import Link from 'next/link';
import { ArrowDownLeft, ArrowUpRight, ChevronRight, Landmark, Minus, PiggyBank, TriangleAlert } from 'lucide-react';
import type { FeedItem } from '@/lib/api/types';
import { fmtTime, naira } from '@/lib/money';

const ICON = { sale: ArrowDownLeft, saving: PiggyBank, withdrawal: Landmark, skipped: Minus, attention: TriangleAlert } as const;
const TONE = { sale: 'brand', saving: '', withdrawal: 'brand', skipped: '', attention: 'strong' } as const;

export function FeedRow({ item, hidden, onOpen }: { item: FeedItem; hidden?: boolean; onOpen?: (i: FeedItem) => void }) {
  const Icon = ICON[item.kind];
  const income = item.amountKobo > 0;
  const amount = item.amountKobo === 0 ? '' : `${income ? '+' : '-'}${naira(Math.abs(item.amountKobo))}`;

  const body = (
    <>
      <span className={`item-icon ${TONE[item.kind]}`}><Icon size={20} aria-hidden /></span>
      <span className="grow">
        <span className="item-title">{item.title}</span>
        <br />
        <span className="item-sub">{fmtTime(item.at)} · {hidden ? 'Details hidden' : item.subtitle}</span>
      </span>
      <span className="item-end num">
        {item.status !== 'completed' && <span className="tag tag-attn" style={{ marginBottom: 2 }}>{item.status === 'pending' ? 'Pending' : item.status === 'reversed' ? 'Reversed' : 'Failed'}</span>}
        {item.status !== 'completed' && <br />}
        <span className={income ? 'txt-in' : ''} style={{ fontWeight: 700 }}>{hidden && amount ? '₦•••' : amount}</span>
      </span>
      <ChevronRight className="item-chevron" size={18} aria-hidden />
    </>
  );

  // Savings have a full receipt page. Everything else opens a short detail sheet.
  if (item.kind === 'saving' || item.kind === 'attention' || item.kind === 'skipped') {
    return <li><Link className="item" href={`/transactions/${item.sweepId}`}>{body}</Link></li>;
  }
  return <li><button className="item" onClick={() => onOpen?.(item)}>{body}</button></li>;
}
