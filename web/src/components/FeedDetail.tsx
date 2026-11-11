'use client';

import type { FeedItem } from '@/lib/api/types';
import { naira } from '@/lib/money';
import { Sheet } from './Sheet';

const KIND = { sale: 'Money received', saving: 'Saved to pension', withdrawal: 'Emergency withdrawal', skipped: 'Nightly saving', attention: 'Nightly saving' } as const;

export function FeedDetail({ item, onClose }: { item: FeedItem | null; onClose: () => void }) {
  const when = item ? new Date(item.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  return (
    <Sheet open={!!item} onClose={onClose} title={item ? KIND[item.kind] : 'Transaction'}>
      {item && (
        <>
          <p className="amount-lg">{item.amountKobo > 0 ? '+' : item.amountKobo < 0 ? '-' : ''}{naira(Math.abs(item.amountKobo))}</p>
          <ul className="facts">
            <li><span className="k">{item.kind === 'sale' ? 'From' : 'Description'}</span><span className="v">{item.title.replace('Payment from ', '')}</span></li>
            <li><span className="k">Date</span><span className="v">{when}</span></li>
            <li><span className="k">Status</span><span className="v" style={{ textTransform: 'capitalize' }}>{item.status}</span></li>
            <li><span className="k">Details</span><span className="v">{item.subtitle}</span></li>
            <li><span className="k">Reference</span><span className="v mono">{item.reference}</span></li>
          </ul>
        </>
      )}
    </Sheet>
  );
}
