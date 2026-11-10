import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import type { ReactNode } from 'react';

// The page header sits inside the settings layout. On a phone the menu is its own screen, so each page gets a back link.
export function SettingsFrame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <Link href="/settings" className="back hide-lg"><ArrowLeft size={18} aria-hidden /> Settings</Link>
      <h2 className="h1 mt2">{title}</h2>
      <div className="mt5">{children}</div>
    </div>
  );
}
