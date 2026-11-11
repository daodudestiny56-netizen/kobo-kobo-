'use client';

import { useState } from 'react';
import Link from 'next/link';
import { CircleAlert, CircleCheck, Play } from 'lucide-react';
import { api } from '@/lib/api';
import type { ForceOutcome } from '@/lib/api/types';
import { naira } from '@/lib/money';
import { useOps } from '@/lib/ops';
import { SweepTable } from '@/components/SweepTable';

const FORCE: { v: ForceOutcome; label: string }[] = [
  { v: 'none', label: 'Normal run' },
  { v: 'timeout', label: 'Bank times out' },
  { v: 'reversed', label: 'Bank reverses the transfer' },
  { v: 'failed', label: 'Transfer fails' },
];

export default function OpsOverviewPage() {
  const { data: o, error, run, gate } = useOps();
  const [force, setForce] = useState<ForceOutcome>('none');

  if (gate) return gate;
  if (!o) return <div className="page" aria-busy="true"><div className="skeleton" style={{ height: 200 }} />{error && <p className="error-text mt4" role="alert">{error}</p>}</div>;

  const r = o.reconciliation;
  const balanced = r.diffKobo === 0;
  const pending = o.alerts.filter((a) => a.status === 'PENDING_REVIEW').length;

  return (
    <div className="page">
      <div className="page-head"><h1 className="h1">Overview</h1></div>

      <div className="figures">
        <div className="figure"><p className="muted small">Traders enrolled</p><p className="amount-lg">{o.totals.merchants}</p></div>
        <div className="figure"><p className="muted small">Pension assets</p><p className="amount-lg num">{naira(o.totals.aumKobo)}</p></div>
        <div className="figure"><p className="muted small">Moved today</p><p className="amount-lg num">{naira(o.totals.sweptTodayKobo)}</p></div>
        <div className="figure"><p className="muted small">Alerts to review</p><p className="amount-lg">{pending}</p></div>
      </div>

      <section className="section" aria-labelledby="rec-h">
        <h2 id="rec-h" className="h2">Reconciliation</h2>
        <p className={`status-line mt3 ${balanced ? '' : 'bad'}`} role="status">
          {balanced ? <CircleCheck size={22} aria-hidden /> : <CircleAlert size={22} aria-hidden />}
          <span>
            <b>{balanced ? 'Everything moved is accounted for.' : `The books are off by ${naira(Math.abs(r.diffKobo))}.`}</b>
            <br />
            <span className="small">{naira(r.ledgerKobo)} moved out of trader accounts. {naira(r.armKobo)} held in pots plus paid back out in withdrawals.</span>
          </span>
        </p>
      </section>

      <section className="section" aria-labelledby="run-h">
        <h2 id="run-h" className="h2">Nightly saving</h2>
        <p className="muted mt2" style={{ maxWidth: '62ch' }}>In production this runs at 11:00 pm. Run it now for the demo. Running it again on the same day does not move money twice.</p>
        <div className="row wrap mt3">
          <label className="sr-only" htmlFor="force">Simulate a problem</label>
          <select id="force" className="select" style={{ width: 'auto', minWidth: 240 }} value={force} onChange={(e) => setForce(e.target.value as ForceOutcome)}>
            {FORCE.map((f) => <option key={f.v} value={f.v}>{f.label}</option>)}
          </select>
          <button className="btn btn-primary" onClick={() => run(api.opsRunSweep(force))}><Play size={18} aria-hidden /> Run nightly saving</button>
        </div>
        {error && <p className="error-text mt3" role="alert">{error}</p>}
      </section>

      <section className="section" aria-labelledby="latest-h">
        <div className="section-head">
          <h2 id="latest-h" className="h2">Latest sweeps</h2>
          <Link href="/ops/sweeps" className="btn btn-text">See all</Link>
        </div>
        {o.sweeps.length === 0 ? <p className="muted">No sweeps yet. Add a trader and a sale, then run the nightly saving.</p> : <SweepTable sweeps={o.sweeps.slice(0, 5)} onRequery={(id) => run(api.opsRequery(id))} />}
      </section>
    </div>
  );
}
