'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { naira } from '@/lib/money';
import { plainError } from '@/lib/text';
import { useSession, useSummary } from '@/lib/session';
import { Sheet } from '@/components/Sheet';
import { SettingsFrame } from '@/components/SettingsFrame';

export default function SecurityPage() {
  const { data: s } = useSummary();
  const { merchantId, applySummary, signOut } = useSession();
  const router = useRouter();
  const [stopOpen, setStopOpen] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (!s) return <SettingsFrame title="Security and privacy"><div className="skeleton" style={{ height: 260 }} aria-busy="true" /></SettingsFrame>;
  const stopped = s.merchant.status === 'CANCELLED';

  async function stop() {
    if (!merchantId) return;
    setBusy(true);
    try {
      applySummary(await api.updateSettings(merchantId, { cancel: true }));
      setStopOpen(false);
    } catch (e) {
      setError(plainError(e));
    } finally {
      setBusy(false);
    }
  }

  async function restart() {
    if (!merchantId) return;
    applySummary(await api.updateSettings(merchantId, { reactivate: true }));
  }

  return (
    <SettingsFrame title="Security and privacy">
      <h2 className="h2">Signing in</h2>
      <ul className="facts">
        <li><span className="k">Method</span><span className="v">Phone number and a text code</span></li>
        <li><span className="k">Phone</span><span className="v">{s.merchant.phone}</span></li>
      </ul>
      <button className="btn btn-secondary mt3" onClick={() => { signOut(); router.push('/sign-in'); }}>Sign out on this device</button>

      <h2 className="h2 mt7">How we protect your money</h2>
      <ul className="facts">
        <li><span className="k">Where your sales go</span><span className="v">Straight into your own account</span></li>
        <li><span className="k">What we move</span><span className="v">Only your chosen share, after sales are in</span></li>
        <li><span className="k">If a transfer is unclear</span><span className="v">We check, never take it twice</span></li>
        <li><span className="k">Unusual large payments</span><span className="v">Held back until checked</span></li>
        <li><span className="k">Your BVN</span><span className="v">Stored scrambled, not as a number</span></li>
        <li><span className="k">Always left in your account</span><span className="v">{naira(100_000)}</span></li>
      </ul>

      <h2 className="h2 mt7">Stop saving</h2>
      {stopped ? (
        <>
          <p className="notice notice-attn mt3"><span>Saving is stopped. Your pension balance stays safe in your pension.</span></p>
          <button className="btn btn-primary mt3" onClick={restart}>Start saving again</button>
        </>
      ) : (
        <>
          <p className="hint mt2">You can stop at any time. Your pension balance stays in your pension and keeps its rules.</p>
          <button className="btn btn-secondary btn-danger-text mt3" onClick={() => setStopOpen(true)}>Stop saving</button>
        </>
      )}

      <Sheet open={stopOpen} onClose={() => setStopOpen(false)} title="Stop saving?">
        <p>We will stop taking your share from tonight. Money already in your pension stays there, and you can start again whenever you want.</p>
        {error && <p className="error-text" role="alert">{error}</p>}
        <button className="btn btn-primary btn-block" onClick={stop} disabled={busy}>{busy ? 'Stopping...' : 'Yes, stop saving'}</button>
        <button className="btn btn-secondary btn-block" onClick={() => setStopOpen(false)}>Keep saving</button>
      </Sheet>
    </SettingsFrame>
  );
}
