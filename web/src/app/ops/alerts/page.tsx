'use client';

import { api } from '@/lib/api';
import { naira } from '@/lib/money';
import { useOps } from '@/lib/ops';

const STATUS = { PENDING_REVIEW: 'Needs review', DISMISSED: 'Dismissed, counted next night', CONFIRMED: 'Confirmed, excluded' } as const;

export default function OpsAlertsPage() {
  const { data: o, error, run } = useOps();

  return (
    <div className="page page-narrow" style={{ marginLeft: 0 }}>
      <div className="page-head"><h1 className="h1">Alerts</h1></div>
      <p className="muted" style={{ maxWidth: '60ch' }}>SweepGuard holds any single payment far above a trader&apos;s normal day. Only that payment is held. The rest of the day still counts.</p>
      {error && <p className="error-text mt4" role="alert">{error}</p>}
      {!o ? <div className="skeleton mt5" style={{ height: 160 }} aria-busy="true" /> : o.alerts.length === 0 ? (
        <p className="muted mt5">No alerts. In the demo tools, add the ₦3,000,000 payment and run the nightly saving to see one.</p>
      ) : (
        <ul className="list mt5">
          {o.alerts.map((a) => (
            <li key={a.id} className="stack gap2" style={{ padding: 'var(--s4) 0' }}>
              <div className="row between wrap">
                <p><b>{a.merchantName}</b> · <span className="num">{naira(a.amountKobo)}</span></p>
                <span className={`tag ${a.status === 'PENDING_REVIEW' ? 'tag-attn' : 'tag-brand'}`}>{STATUS[a.status]}</span>
              </div>
              <p className="muted">{a.detail}</p>
              {a.status === 'PENDING_REVIEW' && (
                <div className="row wrap mt2">
                  <button className="btn btn-secondary btn-sm" onClick={() => run(api.opsResolveAlert(a.id, 'DISMISSED'))}>It is genuine, count it next night</button>
                  <button className="btn btn-dark btn-sm" onClick={() => run(api.opsResolveAlert(a.id, 'CONFIRMED'))}>It is a mistake, exclude it</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
