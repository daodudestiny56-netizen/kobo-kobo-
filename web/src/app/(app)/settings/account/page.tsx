'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { naira } from '@/lib/money';
import { useSession, useSummary } from '@/lib/session';
import { displayName } from '@/lib/text';
import { SettingsFrame } from '@/components/SettingsFrame';

// Transfer limits by account tier (Forge sandbox guide, section 5.2).
const LIMITS: Record<number, { single: number; daily: number }> = {
  1: { single: 5_000_000, daily: 30_000_000 },
  2: { single: 10_000_000, daily: 50_000_000 },
  3: { single: 500_000_000, daily: 2_500_000_000 },
};

export default function AccountPage() {
  const { data: s } = useSummary();
  const { hideBalance } = useSession();
  const [copied, setCopied] = useState('');

  if (!s) return <SettingsFrame title="Linked account"><div className="skeleton" style={{ height: 260 }} aria-busy="true" /></SettingsFrame>;

  const a = s.account;
  const lim = LIMITS[a.tier] ?? LIMITS[1];

  async function copy(v: string) {
    try {
      await navigator.clipboard.writeText(v);
      setCopied(v);
      setTimeout(() => setCopied(''), 1800);
    } catch {
      setCopied('');
    }
  }

  return (
    <SettingsFrame title="Linked account">
      <p className="muted" style={{ maxWidth: '56ch' }}>This is the bank account your customers pay into. Your sales land here first. Each night we move your chosen share from this account into your pension.</p>

      <ul className="facts mt5">
        <li><span className="k">Bank</span><span className="v">{a.bankName}</span></li>
        <li><span className="k">Account name</span><span className="v">{displayName(s.merchant.fullName)}</span></li>
        <li>
          <span className="k">Account number</span>
          <span className="v mono">
            <button className="btn btn-text" onClick={() => copy(a.number)} aria-label={`Copy account number ${a.number}`}>{a.number} {copied === a.number ? <Check size={16} aria-hidden /> : <Copy size={16} aria-hidden />}</button>
          </span>
        </li>
        <li><span className="k">Available balance</span><span className="v num">{hideBalance ? '₦•••••' : naira(a.balanceKobo)}</span></li>
        <li><span className="k">Account level</span><span className="v">Tier {a.tier}</span></li>
      </ul>

      <h3 className="h2 mt6">Get paid</h3>
      <p className="hint mt2">Share this collection number with customers who pay by bank transfer. Payments to it land in your account above.</p>
      <ul className="facts mt3">
        <li>
          <span className="k">Collection number</span>
          <span className="v mono">
            <button className="btn btn-text" onClick={() => copy(s.merchant.virtualAccount)} aria-label={`Copy collection number ${s.merchant.virtualAccount}`}>{s.merchant.virtualAccount} {copied === s.merchant.virtualAccount ? <Check size={16} aria-hidden /> : <Copy size={16} aria-hidden />}</button>
          </span>
        </li>
      </ul>

      <h3 className="h2 mt6">Transfer limits</h3>
      <ul className="facts mt2">
        <li><span className="k">Single transfer</span><span className="v num">{naira(lim.single)}</span></li>
        <li><span className="k">Per day</span><span className="v num">{naira(lim.daily)}</span></li>
        <li><span className="k">Always left in your account by us</span><span className="v num">{naira(100_000)}</span></li>
      </ul>
      <p className="hint mt2">Limits depend on your account level and are set by your bank.</p>
    </SettingsFrame>
  );
}
