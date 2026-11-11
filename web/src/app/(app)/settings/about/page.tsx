'use client';

import Link from 'next/link';
import { useSession } from '@/lib/session';
import { SettingsFrame } from '@/components/SettingsFrame';
import { InstallApp } from '@/components/InstallApp';

export default function AboutPage() {
  const { demoMode, setDemoMode } = useSession();

  return (
    <SettingsFrame title="About Kobo Kobo">
      <p style={{ maxWidth: '58ch', color: 'var(--ink-2)' }}>Kobo Kobo moves a small share of each day&apos;s sales from your bank account into your own pension, automatically. It was built for Access Youth Tech Forge 2026.</p>

      <h3 className="h2 mt6">What is real in this prototype</h3>
      <ul className="facts mt2">
        <li><span className="k">Bank accounts, transfers, identity checks</span><span className="v">Forge sandbox, synthetic data</span></li>
        <li><span className="k">Pension account and RSA PIN</span><span className="v">Simulated</span></li>
        <li><span className="k">USSD, SMS and voice</span><span className="v">Simulated, no mobile network</span></li>
        <li><span className="k">Customer payments</span><span className="v">Simulated</span></li>
      </ul>

      <h3 className="h2 mt6">Install on your phone</h3>
      <p className="hint mt2">Add Kobo Kobo to your home screen so it opens like an app.</p>
      <InstallApp />

      <h3 className="h2 mt6">Demo controls</h3>
      <p className="hint mt2">Adds tools for presenting: simulate a customer payment, run tonight&apos;s saving, skip time, and open the button phone and operations console.</p>
      <label className="switch mt3">
        <input type="checkbox" checked={demoMode} onChange={(e) => setDemoMode(e.target.checked)} />
        <span className="label">Show demo controls</span>
      </label>

      <h3 className="h2 mt6">Legal</h3>
      <ul className="list mt2">
        <li><Link className="item" href="/terms"><span className="grow item-title">Terms of use</span></Link></li>
        <li><Link className="item" href="/privacy"><span className="grow item-title">Privacy</span></Link></li>
        <li><Link className="item" href="/help"><span className="grow item-title">Help</span></Link></li>
      </ul>
    </SettingsFrame>
  );
}
