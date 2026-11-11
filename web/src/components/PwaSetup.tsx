'use client';

import { useEffect } from 'react';

// Registers the service worker in production builds only, so development never serves cached files.
export function PwaSetup() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }, []);
  return null;
}
