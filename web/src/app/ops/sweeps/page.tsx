'use client';

import { api } from '@/lib/api';
import { useOps } from '@/lib/ops';
import { SweepTable } from '@/components/SweepTable';

export default function OpsSweepsPage() {
  const { data: o, error, run } = useOps();

  return (
    <div className="page">
      <div className="page-head"><h1 className="h1">Sweeps</h1></div>
      {error && <p className="error-text" role="alert">{error}</p>}
      {!o ? <div className="skeleton" style={{ height: 200 }} aria-busy="true" /> : o.sweeps.length === 0 ? <p className="muted">No sweeps yet.</p> : <SweepTable sweeps={o.sweeps} onRequery={(id) => run(api.opsRequery(id))} />}
    </div>
  );
}
