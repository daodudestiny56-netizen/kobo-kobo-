'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Sheet } from './Sheet';

// Restock mode: skip the nightly saving for a while. Pausing costs nothing and can be undone at any time.
export function PauseSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { merchantId, bump } = useSession();
  const [hours, setHours] = useState(24);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save() {
    if (!merchantId) return;
    setBusy(true);
    setError('');
    try {
      await api.updateSettings(merchantId, { pauseHours: hours });
      bump();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not pause. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title="Pause saving">
      <p className="hint">Buying stock? Skip the nightly saving. You can start again whenever you like, and nothing is charged for pausing.</p>
      <div className="choices" role="radiogroup" aria-label="How long to pause">
        {[
          { h: 24, t: 'For 1 day', d: 'Tonight is skipped. Saving restarts tomorrow night.' },
          { h: 48, t: 'For 2 days', d: 'Tonight and tomorrow night are skipped.' },
        ].map((o) => (
          <label key={o.h} className="choice">
            <input type="radio" name="pause" checked={hours === o.h} onChange={() => setHours(o.h)} />
            <span>
              <span className="choice-title">{o.t}</span>
              <br />
              <span className="hint">{o.d}</span>
            </span>
          </label>
        ))}
      </div>
      {error && <p className="error-text" role="alert">{error}</p>}
      <button className="btn btn-primary btn-block" onClick={save} disabled={busy}>{busy ? 'Pausing...' : 'Pause saving'}</button>
    </Sheet>
  );
}
