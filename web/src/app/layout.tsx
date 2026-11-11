import type { Metadata, Viewport } from 'next';
import { Bricolage_Grotesque } from 'next/font/google';
import { SessionProvider } from '@/lib/session';
import { PwaSetup } from '@/components/PwaSetup';
import './globals.css';

const font = Bricolage_Grotesque({ subsets: ['latin'], variable: '--font-sans', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'Kobo Kobo: pension that grows when your sales do', template: '%s | Kobo Kobo' },
  description: 'A small share of every naira you receive goes into your own pension automatically. No sales, nothing taken.',
  manifest: '/manifest.webmanifest',
  icons: { icon: [{ url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }], apple: '/icons/apple-touch-icon.png' },
  appleWebApp: { capable: true, title: 'Kobo Kobo', statusBarStyle: 'default' },
};

export const viewport: Viewport = {
  themeColor: '#ffffff',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={font.variable}>
      <body>
        <PwaSetup />
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}
