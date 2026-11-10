import Link from 'next/link';
import { Lock, PiggyBank, ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { Brand } from './Brand';

const POINTS = [
  { icon: Lock, text: 'Your sales land in your own account first. We never take money on its way to you.' },
  { icon: PiggyBank, text: 'A small share moves to your pension each night. No sales, nothing taken.' },
  { icon: ShieldCheck, text: 'Stop or pause any time. What you have saved stays yours.' },
];

export function AuthFrame({ children, aside }: { children: ReactNode; aside?: { text: string; href: string; label: string } }) {
  return (
    <div className="auth-split">
      <aside className="auth-art" aria-label="About Kobo Kobo">
        <Brand />
        <img src="/images/market-woman.jpg" width={960} height={640} alt="A trader at her stall in a Lagos market" />
        <div className="stack gap4">
          <p className="h1" style={{ color: 'var(--white)' }}>Your pension grows when your sales do.</p>
          <ul>
            {POINTS.map(({ icon: Icon, text }) => (
              <li key={text}><Icon size={20} aria-hidden /><span>{text}</span></li>
            ))}
          </ul>
        </div>
      </aside>
      <div className="auth-main">
        <header className="auth-top">
          <Brand />
          {aside && (
            <p className="small">
              <span className="muted">{aside.text} </span>
              <Link href={aside.href} style={{ fontWeight: 700, color: 'var(--brand)' }}>{aside.label}</Link>
            </p>
          )}
        </header>
        <main className="auth-body">
          <div className="auth-panel">{children}</div>
        </main>
      </div>
    </div>
  );
}
