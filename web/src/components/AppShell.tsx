'use client';

import { useEffect, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ArrowLeftRight, Bell, CircleHelp, Home, PiggyBank, Settings, Smartphone, Wrench } from 'lucide-react';
import { initials } from '@/lib/money';
import { useSession, useSummary } from '@/lib/session';
import { Brand } from './Brand';
import { DemoTools } from './DemoTools';

const MAIN = [
  { href: '/home', label: 'Home', icon: Home },
  { href: '/savings', label: 'Savings', icon: PiggyBank },
  { href: '/transactions', label: 'Transactions', icon: ArrowLeftRight },
  { href: '/settings', label: 'Settings', icon: Settings },
];

function current(path: string, href: string) {
  return path === href || path.startsWith(`${href}/`) ? 'page' : undefined;
}

export function AppShell({ children }: { children: ReactNode }) {
  const { ready, merchantId, demoMode } = useSession();
  const { data: s } = useSummary();
  const path = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (ready && !merchantId) router.replace('/sign-in');
  }, [ready, merchantId, router]);

  if (!ready || !merchantId) {
    return <div className="page page-center" aria-busy="true"><div className="skeleton" style={{ height: 160 }} /></div>;
  }

  const needsAttention = !!s && s.recent.slice(0, 3).some((r) => ['FAILED', 'REVERSED', 'UNKNOWN', 'HELD_GUARD', 'SKIPPED_LOW_BALANCE'].includes(r.status));

  return (
    <>
      <div className="app">
        <aside className="sidebar" aria-label="Main">
          <Brand href="/home" />
          <nav className="nav" aria-label="Primary">
            {MAIN.map(({ href, label, icon: Icon }) => (
              <Link key={href} href={href} aria-current={current(path, href)}>
                <Icon size={20} aria-hidden /> {label}
              </Link>
            ))}
          </nav>
          {demoMode && (
            <>
              <p className="nav-label">Demo</p>
              <nav className="nav" style={{ marginTop: 0 }} aria-label="Demo">
                <Link href="/demo/phone" aria-current={current(path, '/demo/phone')}><Smartphone size={20} aria-hidden /> Button phone</Link>
                <Link href="/ops" aria-current={current(path, '/ops')}><Wrench size={20} aria-hidden /> Operations</Link>
                <DemoTools variant="nav" />
              </nav>
            </>
          )}
          <div className="sidebar-foot">
            <nav className="nav" style={{ marginTop: 0 }} aria-label="Support">
              <Link href="/help" aria-current={current(path, '/help')}><CircleHelp size={20} aria-hidden /> Help</Link>
            </nav>
          </div>
        </aside>

        <div className="main">
          <header className="topbar">
            <Brand href="/home" />
            <div className="topbar-actions">
              {demoMode && <span className="hide-lg"><DemoTools variant="icon" /></span>}
              <Link href="/notifications" className="icon-btn" aria-label={needsAttention ? 'Notifications, something needs your attention' : 'Notifications'}>
                <Bell size={22} aria-hidden />
                {needsAttention && <span className="dot-badge" aria-hidden />}
              </Link>
              <Link href="/settings/profile" className="avatar" aria-label="Your profile">{s ? initials(s.merchant.fullName) : ''}</Link>
            </div>
          </header>
          {children}
        </div>
      </div>

      <nav className="tabbar" aria-label="Primary">
        {MAIN.map(({ href, label, icon: Icon }) => (
          <Link key={href} href={href} aria-current={current(path, href)}>
            <Icon size={22} aria-hidden /> {label}
          </Link>
        ))}
      </nav>
    </>
  );
}
