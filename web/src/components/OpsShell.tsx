'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ArrowLeft, Banknote, LayoutDashboard, ShieldAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { Brand } from './Brand';

const LINKS = [
  { href: '/ops', label: 'Overview', icon: LayoutDashboard, exact: true },
  { href: '/ops/sweeps', label: 'Sweeps', icon: Banknote, exact: false },
  { href: '/ops/alerts', label: 'Alerts', icon: ShieldAlert, exact: false },
];

export function OpsShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const cur = (href: string, exact: boolean) => ((exact ? path === href : path === href || path.startsWith(`${href}/`)) ? 'page' : undefined);

  return (
    <>
      
      <div className="app">
        <aside className="sidebar" aria-label="Operations">
          <Brand href="/ops" />
          <p className="nav-label">Operations</p>
          <nav className="nav" style={{ marginTop: 0 }} aria-label="Operations pages">
            {LINKS.map(({ href, label, icon: Icon, exact }) => (
              <Link key={href} href={href} aria-current={cur(href, exact)}><Icon size={20} aria-hidden /> {label}</Link>
            ))}
          </nav>
          <div className="sidebar-foot">
            <nav className="nav" style={{ marginTop: 0 }} aria-label="Back">
              <Link href="/home"><ArrowLeft size={20} aria-hidden /> Trader app</Link>
            </nav>
          </div>
        </aside>
        <div className="main">
          <header className="topbar"><Brand href="/ops" /><div className="topbar-actions"><Link href="/home" className="btn btn-text">Trader app</Link></div></header>
          <nav className="ops-tabs" aria-label="Operations pages">
            {LINKS.map(({ href, label, exact }) => <Link key={href} href={href} aria-current={cur(href, exact)}>{label}</Link>)}
          </nav>
          {children}
        </div>
      </div>
    </>
  );
}
