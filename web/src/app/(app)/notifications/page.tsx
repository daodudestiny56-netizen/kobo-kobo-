'use client';

import { useEffect, useState } from 'react';
import { MessageSquareText, TriangleAlert } from 'lucide-react';
import { api } from '@/lib/api';
import type { SweepRecord } from '@/lib/api/types';
import { dayHeading, fmtTime, naira } from '@/lib/money';
import { receiptSms } from '@/lib/messages';
import { useSession, useSummary } from '@/lib/session';

interface Note { id: string; at: number; text: string; attention: boolean }

// Notifications are the text messages we send. Each saving gets a receipt, as pension rules require.
function toNotes(sweeps: SweepRecord[], lang: Parameters<typeof receiptSms>[0]): Note[] {
  const out: Note[] = [];
  for (const x of sweeps) {
    const at = x.executedAt ?? Date.parse(`${x.sweepDate}T22:00:00Z`);
    if (x.status === 'SETTLED' && x.pensionReference) out.push({ id: x.id, at, text: receiptSms(lang, x.sweepKobo, x.pensionReference), attention: false });
    else if (x.status === 'REVERSED') out.push({ id: x.id, at, text: `Kobo Kobo: the bank reversed tonight's saving of ${naira(x.sweepKobo)}. Your money is back in your account.`, attention: true });
    else if (x.status === 'FAILED') out.push({ id: x.id, at, text: 'Kobo Kobo: tonight’s saving did not go through. Nothing was taken from your account.', attention: true });
    else if (x.status === 'UNKNOWN') out.push({ id: x.id, at, text: 'Kobo Kobo: the bank has not confirmed tonight’s saving yet. We are checking and will not take it twice.', attention: true });
    else if (x.status === 'SKIPPED_LOW_BALANCE') out.push({ id: x.id, at, text: 'Kobo Kobo: we skipped tonight’s saving to keep a safety minimum in your account.', attention: true });
  }
  return out.sort((a, b) => b.at - a.at);
}

export default function NotificationsPage() {
  const { merchantId, version } = useSession();
  const { data: s } = useSummary();
  const [sweeps, setSweeps] = useState<SweepRecord[] | null>(null);

  useEffect(() => {
    if (!merchantId) return;
    api.activity(merchantId).then(setSweeps).catch(() => setSweeps([]));
  }, [merchantId, version]);

  const notes = sweeps && s ? toNotes(sweeps, s.merchant.language).slice(0, 40) : null;

  return (
    <div className="page page-narrow" style={{ maxWidth: 760 }}>
      <div className="page-head">
        <div>
          <h1 className="h1">Notifications</h1>
          <p className="muted mt2">The text messages we send to {s?.merchant.phone ?? 'your phone'}.</p>
        </div>
      </div>
      {!notes && <div className="skeleton" style={{ height: 200 }} aria-busy="true" />}
      {notes && notes.length === 0 && <p className="empty">No messages yet. You get a text with a receipt number after every saving.</p>}
      {notes && notes.length > 0 && (
        <ul className="list">
          {notes.map((n, i) => (
            <li key={n.id}>
              {(i === 0 || dayHeading(n.at) !== dayHeading(notes[i - 1].at)) && <p className="eyebrow" style={{ paddingTop: 'var(--s4)' }}>{dayHeading(n.at)}</p>}
              <div className="item" style={{ alignItems: 'flex-start' }}>
                <span className={`item-icon ${n.attention ? 'strong' : 'brand'}`}>{n.attention ? <TriangleAlert size={20} aria-hidden /> : <MessageSquareText size={20} aria-hidden />}</span>
                <span className="grow"><span>{n.text}</span><br /><span className="item-sub">{fmtTime(n.at)}</span></span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
