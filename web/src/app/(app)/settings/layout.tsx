'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Bell, ChevronRight, Info, Landmark, LogOut, PiggyBank, ShieldCheck, UserRound } from 'lucide-react';
import type { ReactNode } from 'react';
import { useSession, useSummary } from '@/lib/session';

const ITEMS = [
  { href: '/settings/profile', label: 'Profile', sub: 'Your name and phone number', icon: UserRound },
  { href: '/settings/account', label: 'Linked account', sub: 'Where your sales land', icon: Landmark },
  { href: '/settings/plan', label: 'Saving plan', sub: 'Your share, restock mode', icon: PiggyBank },
  { href: '/settings/messages', label: 'Language and messages', sub: 'How we talk to you', icon: Bell },
  { href: '/settings/security', label: 'Security and privacy', sub: 'Sign-in, your data, stop saving', icon: ShieldCheck },
  { href: '/settings/about', label: 'About Kobo Kobo', sub: 'Terms, privacy, this prototype', icon: Info },
];

export default function SettingsLayout({ children }: { children: ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const { signOut } = useSession();
  const { data: s } = useSummary();
  const onIndex = path === '/settings';

  const plan = s ? `${s.merchant.rateBps / 100}% of daily sales` : '';

  return (
    <div className="page">
      <h1 className="h1">Settings</h1>
      <div className={`settings mt5 ${onIndex ? 'on-index' : ''}`}>
        <nav className="settings-nav snav" aria-label="Settings">
          <ul className="list">
            {ITEMS.map(({ href, label, sub, icon: Icon }) => (
              <li key={href}>
                <Link href={href} aria-current={path === href ? 'page' : undefined}>
                  <Icon size={20} aria-hidden />
                  <span className="grow">{label}<span className="sub">{href === '/settings/plan' && plan ? plan : sub}</span></span>
                  <ChevronRight className="chev" size={18} aria-hidden />
                </Link>
              </li>
            ))}
            <li>
              <button className="item" style={{ padding: '10px var(--s3)' }} onClick={() => { signOut(); router.push('/sign-in'); }}>
                <LogOut size={20} aria-hidden style={{ color: 'var(--brand)' }} />
                <span className="grow item-title">Sign out</span>
              </button>
            </li>
          </ul>
        </nav>
        <div className="settings-content">{children}</div>
      </div>
    </div>
  );
}
