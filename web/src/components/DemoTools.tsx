'use client';

import { useState } from 'react';
import { FlaskConical } from 'lucide-react';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Sheet } from './Sheet';

// Sandbox-only controls for the demo (PRD 12 and 15). The live backend must put these behind a login.
export function DemoTools({ variant }: { variant: 'nav' | 'icon' }) {
  const { merchantId, bump } = useSession();
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState('');

  async function act(label: string, fn: () => Promise<unknown>) {
    try {
      await fn();
      setMsg(label);
      bump();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'That did not work.');
    }
  }

  const pay = (amount: number, label: string) => (
    <button
      key={amount}
      className="btn btn-secondary btn-sm"
      disabled={!merchantId}
      onClick={() => act(`${label} received from a customer.`, () => api.demoInflow(merchantId!, amount * 100))}
    >
      {label}
    </button>
  );

  return (
    <>
      {variant === 'nav' ? (
        <button className="nav-btn" onClick={() => setOpen(true)}>
          <FlaskConical size={20} aria-hidden /> Demo tools
        </button>
      ) : (
        <button className="icon-btn" onClick={() => setOpen(true)} aria-label="Demo tools">
          <FlaskConical size={22} aria-hidden />
        </button>
      )}
      <Sheet open={open} onClose={() => setOpen(false)} title="Demo tools">
        <p className="hint">Sandbox only. These simulate things that happen outside the app, such as a customer paying or the clock moving on.</p>

        <div>
          <p className="label">A customer pays you</p>
          <div className="row wrap mt2">
            {pay(2000, '₦2,000')}
            {pay(5000, '₦5,000')}
            {pay(28000, '₦28,000')}
            {pay(3000000, '₦3,000,000 (a mistake)')}
          </div>
        </div>

        <div>
          <p className="label">Run tonight</p>
          <div className="row wrap mt2">
            <button className="btn btn-primary btn-sm" onClick={() => act('The nightly saving ran.', () => api.opsRunSweep('none'))}>Run the nightly saving now</button>
            <button className="btn btn-secondary btn-sm" onClick={() => act('Moved forward one day.', () => api.demoClock(1))}>Skip 1 day</button>
            <button className="btn btn-secondary btn-sm" onClick={() => act('Moved forward three months.', () => api.demoClock(92))}>Skip 3 months</button>
          </div>
        </div>

        <div>
          <p className="label">Start over</p>
          <div className="row wrap mt2">
            <button className="btn btn-secondary btn-sm" onClick={() => act('Demo data reset.', () => api.demoReset())}>Reset all demo data</button>
          </div>
        </div>

        {msg && <p className="notice notice-brand" aria-live="polite">{msg}</p>}
      </Sheet>
    </>
  );
}
