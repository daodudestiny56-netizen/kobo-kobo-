'use client';

import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';

type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };

// Offers the browser's install prompt where there is one; on iPhone it explains Add to Home Screen.
export function InstallApp() {
  const [prompt, setPrompt] = useState<InstallPrompt | null>(null);
  const [installed, setInstalled] = useState(false);
  const [ios, setIos] = useState(false);

  useEffect(() => {
    const standalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
    setInstalled(standalone);
    setIos(/iphone|ipad|ipod/i.test(navigator.userAgent) && !standalone);
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setPrompt(e as InstallPrompt);
    };
    const onInstalled = () => {
      setInstalled(true);
      setPrompt(null);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (installed) return <p className="hint mt2">Kobo Kobo is installed on this device.</p>;
  if (prompt) {
    return (
      <button
        className="btn btn-secondary mt3"
        onClick={async () => {
          await prompt.prompt();
          await prompt.userChoice;
          setPrompt(null);
        }}
      >
        <Download size={18} aria-hidden /> Install Kobo Kobo
      </button>
    );
  }
  if (ios) return <p className="hint mt2">On iPhone: tap Share, then Add to Home Screen.</p>;
  return <p className="hint mt2">Open this page in Chrome or Safari on your phone to add Kobo Kobo to your home screen.</p>;
}
