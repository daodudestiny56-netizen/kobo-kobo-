'use client';

import { useSummary } from '@/lib/session';
import { SettingsFrame } from '@/components/SettingsFrame';

export default function ProfilePage() {
  const { data: s } = useSummary();
  if (!s) return <SettingsFrame title="Profile"><div className="skeleton" style={{ height: 240 }} aria-busy="true" /></SettingsFrame>;
  const m = s.merchant;

  return (
    <SettingsFrame title="Profile">
      <ul className="facts">
        <li><span className="k">Name</span><span className="v">{m.fullName}</span></li>
        <li><span className="k">Phone</span><span className="v">{m.phone}</span></li>
        <li><span className="k">Bank account</span><span className="v">{m.bankAccount}</span></li>
        <li><span className="k">Bank</span><span className="v">Xtradot Bank</span></li>
        <li><span className="k">Pension fund manager</span><span className="v">Access ARM Pensions</span></li>
        <li><span className="k">Pension number (RSA PIN)</span><span className="v">{m.rsaPin}</span></li>
      </ul>
      <p className="notice mt5"><span className="small">Your name and account come from your BVN and your bank, so they cannot be changed here. If something is wrong, fix it with your bank first.</span></p>
    </SettingsFrame>
  );
}
