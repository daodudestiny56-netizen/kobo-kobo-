'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from './api';
import type { FeedItem, Summary } from './api/types';

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
  const setHideBalance = useCallback((v: boolean) => {
    write(HIDE_KEY, v ? '1' : null);
    setHide(v);
  }, []);

  const setDemoMode = useCallback((v: boolean) => {
    write(DEMO_KEY, v ? '1' : '0');
    setDemo(v);
  }, []);

  const value = useMemo(
    () => ({ ready, merchantId, signIn, signOut, version, bump, hideBalance, setHideBalance, demoMode, setDemoMode }),
    [ready, merchantId, signIn, signOut, version, bump, hideBalance, setHideBalance, demoMode, setDemoMode],
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

/** Loads the signed-in trader's summary and reloads when `version` changes. */
export function useSummary(): Loaded<Summary> {
  const { merchantId, version, signOut } = useSession();
  const [state, setState] = useState<Loaded<Summary>>({ data: null, error: '', loading: true });

  useEffect(() => {
    if (!merchantId) return;
    let live = true;
    api
      .summary(merchantId)
      .then((s) => live && setState({ data: s, error: '', loading: false }))
      .catch((e: Error) => {
        if (!live) return;
        // A reset demo or a removed account leaves a stale id: send the user back to sign in.
        if (/unknown merchant/i.test(e.message)) signOut();
        setState((p) => ({ data: p.data, error: e.message, loading: false }));
      });
    return () => {
      live = false;
    };
  }, [merchantId, version, signOut]);

  return state;
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
      .catch((e: Error) => live && setState((p) => ({ data: p.data, error: e.message, loading: false })));
    return () => {
      live = false;
    };
  }, [merchantId, version]);

  return state;
}
