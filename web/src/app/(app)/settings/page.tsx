'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// On a phone this route is the settings menu, which the layout already shows. On a wide screen the menu sits beside the
// content, so land on the first page instead of an empty pane.
export default function SettingsIndex() {
  const router = useRouter();
  useEffect(() => {
    if (window.matchMedia('(min-width: 900px)').matches) router.replace('/settings/profile');
  }, [router]);
  return null;
}
