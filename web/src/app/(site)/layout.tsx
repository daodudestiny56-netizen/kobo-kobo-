import Link from 'next/link';
import { Brand } from '@/components/Brand';

const COLUMNS = [
  {
    title: 'Product',
    links: [
      { href: '/#how', label: 'How it works' },
      { href: '/#pots', label: 'Two pots' },
      { href: '/#phones', label: 'On any phone' },
      { href: '/#faq', label: 'Questions' },
    ],
  },
  {
    title: 'Account',
    links: [
      { href: '/sign-up', label: 'Start a pension' },
      { href: '/sign-in', label: 'Sign in' },
    ],
  },
  {
    title: 'Support',
    links: [
      { href: '/help', label: 'Help' },
      { href: '/help#phone', label: 'Text commands' },
    ],
  },
  {
    title: 'Legal',
    links: [
      { href: '/terms', label: 'Terms of use' },
      { href: '/privacy', label: 'Privacy' },
    ],
  },
];

function SiteHeader() {
  return (
    <header className="site-head">
      <Brand />
      <nav className="site-nav" aria-label="Site">
        <Link href="/#how">How it works</Link>
        <Link href="/#phones">On any phone</Link>
        <Link href="/help">Help</Link>
      </nav>
      <div className="row">
        <Link href="/sign-in" className="btn btn-text hide-sm">Sign in</Link>
        <Link href="/sign-up" className="btn btn-primary btn-sm">Start a pension</Link>
      </div>
    </header>
  );
}

function SiteFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className="site-foot">
      <div className="wide">
        <div className="foot-top">
          <div className="foot-brand">
            <Brand />
            <p>A pension that grows when your sales do. A small share of each day&apos;s sales goes into your own pension, automatically.</p>
            <div className="row">
              <Link href="/sign-up" className="btn btn-primary btn-sm">Start a pension</Link>
            </div>
          </div>
          <div className="foot-cols">
            {COLUMNS.map((c) => (
              <nav key={c.title} className="foot-col" aria-label={c.title}>
                <p className="foot-h">{c.title}</p>
                {c.links.map((l) => <Link key={l.href} href={l.href}>{l.label}</Link>)}
              </nav>
            ))}
          </div>
        </div>

        <div className="foot-note">
          <p className="small">
            Kobo Kobo does not hold your money. Your sales are paid into your own bank account, and your pension is held under PenCom rules. Pension returns are not guaranteed and can be lower than inflation.
          </p>
          <div className="foot-bottom small">
            <span>&copy; {year} Kobo Kobo. All rights reserved.</span>
            <span>Photography: DanteOlolo, Oludeleadewalephotography and Azzawaady, via Wikimedia Commons (CC BY-SA 4.0).</span>
          </div>
        </div>
      </div>
    </footer>
  );
}

export default function SiteLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SiteHeader />
      <main>{children}</main>
      <SiteFooter />
    </>
  );
}
