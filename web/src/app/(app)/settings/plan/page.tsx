'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { fmtDate, naira } from '@/lib/money';
import { plainError } from '@/lib/text';
import { useSession, useSummary } from '@/lib/session';
import { PauseSheet } from '@/components/PauseSheet';
import { SettingsFrame } from '@/components/SettingsFrame';

export default function PlanPage() {
  const { data: s } = useSummary();
  const { merchantId, applySummary } = useSession();
  const [rate, setRate] = useState<number | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pauseOpen, setPauseOpen] = useState(false);

  useEffect(() => {
    if (s && rate === null) setRate(s.merchant.rateBps);
  }, [s, rate]);

  if (!s || rate === null) return <SettingsFrame title="Saving plan"><div className="skeleton" style={{ height: 260 }} aria-busy="true" /></SettingsFrame>;

  const m = s.merchant;
  const paused = m.pausedUntil !== null && m.pausedUntil > Date.now() + s.clockOffsetDays * 86_400_000;
  const changed = rate !== m.rateBps;

  async function save() {
    if (!merchantId || rate === null) return;
    setBusy(true);
    setError('');
    try {
      applySummary(await api.updateSettings(merchantId, { rateBps: rate }));
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setError(plainError(e));
    } finally {
      setBusy(false);
    }
  }

  async function resume() {
    if (!merchantId) return;
    applySummary(await api.updateSettings(merchantId, { pauseHours: 0 }));
  }

  return (
    <SettingsFrame title="Saving plan">
      <h2 className="h2">Your share of daily sales</h2>
      <p className="hint mt2">The change starts tonight. No sales means nothing is taken.</p>
      <div className="choices mt4" role="radiogroup" aria-label="Your share of daily sales">
        {[100, 200, 300, 400, 500].map((b) => (
          <label key={b} className="choice">
            <input type="radio" name="rate" checked={rate === b} onChange={() => { setRate(b); setSaved(false); }} />
            <span>
              <span className="choice-title">{b / 100}%{b === m.rateBps ? ' (current)' : ''}</span>
              <br />
              <span className="hint">On a {naira(3_000_000)} day, that is {naira(Math.floor((3_000_000 * b) / 10_000))}.</span>
            </span>
          </label>
        ))}
      </div>
      {error && <p className="error-text mt4" role="alert">{error}</p>}
      <div className="row mt4">
        <button className="btn btn-primary" onClick={save} disabled={!changed || busy}>{busy ? 'Saving...' : 'Save change'}</button>
        <span aria-live="polite" className="small is-brand">{saved ? 'Saved. It starts tonight.' : ''}</span>
      </div>

      <h2 className="h2 mt7">Restock mode</h2>
      {paused ? (
        <>
          <p className="notice notice-attn mt3"><span>Saving is paused until {fmtDate(m.pausedUntil!)}.</span></p>
          <button className="btn btn-secondary mt3" onClick={resume}>Start saving again</button>
        </>
      ) : (
        <>
          <p className="hint mt2">Buying stock? Skip the nightly saving for a day or two. It costs nothing.</p>
          <button className="btn btn-secondary mt3" onClick={() => setPauseOpen(true)}>Pause saving</button>
        </>
      )}

      <h2 className="h2 mt7">Safety limits</h2>
      <ul className="facts">
        <li><span className="k">Most we take in one night</span><span className="v">{naira(500_000)}</span></li>
        <li><span className="k">Always left in your account</span><span className="v">{naira(100_000)}</span></li>
      </ul>
      <p className="hint mt2">These keep you from ever being short of cash. They are set by Kobo Kobo for now.</p>

      <PauseSheet open={pauseOpen} onClose={() => setPauseOpen(false)} />
    </SettingsFrame>
  );
}
