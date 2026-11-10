import type { SweepRecord } from '@/lib/api/types';
import { naira, pct } from '@/lib/money';

const TAG: Record<string, string> = {
  SETTLED: 'tag-brand',
  REVERSED: 'tag-attn',
  FAILED: 'tag-attn',
  HELD_GUARD: 'tag-attn',
  UNKNOWN: 'tag-attn',
  SKIPPED_LOW_BALANCE: 'tag-attn',
};

const LABEL: Record<string, string> = {
  SETTLED: 'Settled',
  SKIPPED_ZERO_SALES: 'Skipped: no sales',
  SKIPPED_PAUSED: 'Skipped: paused',
  SKIPPED_LOW_BALANCE: 'Skipped: low balance',
  HELD_GUARD: 'Held by guard',
  FAILED: 'Failed',
  UNKNOWN: 'Unknown, requery',
  REVERSED: 'Reversed',
};

export function SweepTable({ sweeps, onRequery }: { sweeps: SweepRecord[]; onRequery?: (id: string) => void }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Trader</th>
            <th scope="col" className="r">Sales</th>
            <th scope="col" className="r">Share</th>
            <th scope="col" className="r">Moved</th>
            <th scope="col" className="r">Emergency</th>
            <th scope="col" className="r">Retirement</th>
            <th scope="col">Status</th>
            <th scope="col">Reference</th>
          </tr>
        </thead>
        <tbody>
          {sweeps.map((s) => (
            <tr key={s.id}>
              <td className="num">{s.sweepDate}</td>
              <td>{s.merchantName.split(' ')[0]}</td>
              <td className="r num">{naira(s.takingsKobo)}</td>
              <td className="r">{pct(s.rateBps)}</td>
              <td className="r num"><b>{naira(s.sweepKobo)}</b></td>
              <td className="r num">{naira(s.emergencyKobo)}</td>
              <td className="r num">{naira(s.retirementKobo)}</td>
              <td>
                <span className={`tag ${TAG[s.status] ?? ''}`}>{LABEL[s.status] ?? s.status}</span>
                {s.note && <p className="small muted mt2" style={{ maxWidth: 280 }}>{s.note}</p>}
                {s.status === 'UNKNOWN' && onRequery && (
                  <button className="btn btn-primary btn-sm mt2" onClick={() => onRequery(s.id)}>Requery bank</button>
                )}
              </td>
              <td className="small">{s.pensionReference ?? <span className="muted">none</span>}<br /><span className="muted">{s.bankReference}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
