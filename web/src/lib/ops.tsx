'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { DemoKeyForm } from '@/components/DemoKeyForm';
import { api } from './api';
import { ApiError } from './api/errors';
import type { OpsOverview } from './api/types';
import { plainError } from './text';
import { useSession } from './session';

// Loads the operations overview and gives pages a `run` helper that applies an action's result and reports errors.
// When the server wants a key, `gate` is a form to enter it; pages return it instead of their content.
export function useOps() {
  const { version, bump } = useSession();
  const [data, setData] = useState<OpsOverview | null>(null);
  const [error, setError] = useState('');
  const [denied, setDenied] = useState(false);

  const fail = useCallback((e: unknown) => {
    if (e instanceof ApiError && e.status === 401) setDenied(true);
    else setError(plainError(e));
  }, []);

  useEffect(() => {
    let live = true;
    api.opsOverview().then((o) => { if (live) { setData(o); setDenied(false); setError(''); } }).catch((e) => live && fail(e));
    return () => {
      live = false;
    };
  }, [version, fail]);

  const run = useCallback(
    async (p: Promise<OpsOverview>) => {
      try {
        setData(await p);
        setError('');
        bump();
      } catch (e) {
        fail(e);
      }
    },
    [bump, fail],
  );

  const gate: ReactNode = denied ? (
    <div className="page page-narrow">
      <h1 className="h1">Operations</h1>
      <p className="muted mt2">This area is protected. Enter the demo key to continue.</p>
      <div className="mt5"><DemoKeyForm onSaved={() => { setDenied(false); bump(); }} /></div>
    </div>
  ) : null;

  return { data, error, run, gate };
}
