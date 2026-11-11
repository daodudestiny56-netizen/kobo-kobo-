'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from './api';
import type { FeedItem, Summary } from './api/types';
import { ApiError } from './api/errors';
import { plainError } from './text';

const ID_KEY = 'kobokobo.merchantId';
const HIDE_KEY = 'kobokobo.hideBalance';
const DEMO_KEY = 'kobokobo.demo';

interface SessionValue {
  ready: boolean;
  merchantId: string | null;
  signIn: (id: string) => void;
  signOut: () => void;
  /** Bumped after anything that changes server state, so screens reload. */
  version: number;
  bump: () => void;
  /** The signed-in trader's summary, fetched once for the whole app (every summary call costs the server a bank call). */
  summary: Loaded<Summary>;
  /** Use a summary the server just returned (settings calls return one), instead of asking for it again. */
  applySummary: (s: Summary) => void;
  hideBalance: boolean;
  setHideBalance: (v: boolean) => void;
  /** Shows the demo controls (simulate a customer payment, skip time). On by default only on the mock API. */
  demoMode: boolean;
  setDemoMode: (v: boolean) => void;
}

const Ctx = createContext<SessionValue | null>(null);

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: session lasts until reload */
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [merchantId, setMerchantId] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [hideBalance, setHide] = useState(false);
  const [demoMode, setDemo] = useState(false);
  const [summary, setSummary] = useState<Loaded<Summary>>({ data: null, error: '', loading: true });

  useEffect(() => {
    setMerchantId(read(ID_KEY));
    setHide(read(HIDE_KEY) === '1');
    const stored = read(DEMO_KEY);
    const fromUrl = new URLSearchParams(window.location.search).get('demo');
    if (fromUrl === '1') write(DEMO_KEY, '1');
    if (fromUrl === '0') write(DEMO_KEY, '0');
    const v = read(DEMO_KEY) ?? stored;
    setDemo(v === null ? process.env.NEXT_PUBLIC_API_MODE !== 'live' : v === '1');
    setReady(true);
  }, []);

  const signIn = useCallback((id: string) => {
    write(ID_KEY, id);
    setMerchantId(id);
  }, []);
  const signOut = useCallback(() => {
    write(ID_KEY, null);
    setMerchantId(null);
  }, []);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const applySummary = useCallback((s: Summary) => setSummary({ data: s, error: '', loading: false }), []);

  // One request for the whole app. It reloads after any action (bump) and when the tab comes back into view.
  useEffect(() => {
    if (!merchantId) {
      setSummary({ data: null, error: '', loading: false });
      return;
    }
    let live = true;
    setSummary((p) => (p.data && p.data.merchant.id === merchantId ? p : { data: null, error: '', loading: true }));
    api
      .summary(merchantId)
      .then((s) => live && setSummary({ data: s, error: '', loading: false }))
      .catch((e: Error) => {
        if (!live) return;
        // The demo was reset, or the account is gone. A missing endpoint (HTTP_404) is not the same thing.
        const gone = (e instanceof ApiError && e.status === 404 && !e.code.startsWith('HTTP_')) || /unknown merchant/i.test(e.message);
        if (gone) signOut();
        setSummary((p) => ({ data: p.data, error: plainError(e), loading: false }));
      });
    return () => {
      live = false;
    };
  }, [merchantId, version, signOut]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') setVersion((v) => v + 1);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);
  const setHideBalance = useCallback((v: boolean) => {
    write(HIDE_KEY, v ? '1' : null);
    setHide(v);
  }, []);

  const setDemoMode = useCallback((v: boolean) => {
    write(DEMO_KEY, v ? '1' : '0');
    setDemo(v);
  }, []);

  const value = useMemo(
    () => ({ ready, merchantId, signIn, signOut, version, bump, summary, applySummary, hideBalance, setHideBalance, demoMode, setDemoMode }),
    [ready, merchantId, signIn, signOut, version, bump, summary, applySummary, hideBalance, setHideBalance, demoMode, setDemoMode],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession must be used inside SessionProvider');
  return v;
}

export interface Loaded<T> {
  data: T | null;
  error: string;
  loading: boolean;
}

/** The signed-in trader's summary. It is loaded once by the provider and shared by every screen. */
export function useSummary(): Loaded<Summary> {
  return useSession().summary;
}

/** Loads the account feed (customer payments, savings, withdrawals) and reloads when `version` changes. */
export function useFeed(): Loaded<FeedItem[]> {
  const { merchantId, version } = useSession();
  const [state, setState] = useState<Loaded<FeedItem[]>>({ data: null, error: '', loading: true });

  useEffect(() => {
    if (!merchantId) return;
    let live = true;
    api
      .feed(merchantId)
      .then((f) => live && setState({ data: f, error: '', loading: false }))
      .catch((e: Error) => live && setState((p) => ({ data: p.data, error: plainError(e), loading: false })));
    return () => {
      live = false;
    };
  }, [merchantId, version]);

  return state;
}
