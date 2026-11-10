'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { OpsOverview } from './api/types';
import { plainError } from './text';
import { useSession } from './session';

// Loads the operations overview and gives pages a `run` helper that applies an action's result and reports errors.
export function useOps() {
  const { version, bump } = useSession();
  const [data, setData] = useState<OpsOverview | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    api.opsOverview().then((o) => live && setData(o)).catch((e) => live && setError(plainError(e)));
    return () => {
      live = false;
    };
  }, [version]);

  const run = useCallback(
    async (p: Promise<OpsOverview>) => {
      try {
        setData(await p);
        setError('');
        bump();
      } catch (e) {
        setError(plainError(e));
      }
    },
    [bump],
  );

  return { data, error, run };
}
