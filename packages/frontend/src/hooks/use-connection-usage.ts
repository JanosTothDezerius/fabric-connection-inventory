import { useCallback, useEffect, useRef, useState } from 'react';

import { emptyUsage, loadConnectionUsage, type UsageSnapshot } from '@/services/connection-usage';

interface UsageState {
  snapshot: UsageSnapshot;
  loading: boolean;
  cancelled: boolean;
}

function initialState(): UsageState {
  return { snapshot: emptyUsage(), loading: true, cancelled: false };
}

/** Scans workspaces for the items that depend on each connection, independently of the inventory load. */
export function useConnectionUsage() {
  const [state, setState] = useState(initialState);
  const [revision, setRevision] = useState(0);
  const activeRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    activeRequest.current = controller;

    async function run() {
      try {
        const snapshot = await loadConnectionUsage({
          signal: controller.signal,
          onProgress: (progress) => {
            if (!controller.signal.aborted) setState({ snapshot: progress, loading: true, cancelled: false });
          },
        });
        if (!controller.signal.aborted) setState({ snapshot, loading: false, cancelled: false });
      } catch {
        if (!controller.signal.aborted) {
          setState((previous) => ({
            ...previous,
            loading: false,
            snapshot: {
              ...previous.snapshot,
              phase: 'error',
              pausedUntil: undefined,
              error: {
                code: 'UnexpectedUsageError',
                message: 'Dependent workloads could not be loaded. Retry the workspace scan.',
              },
            },
          }));
        }
      }
    }

    void run();
    return () => controller.abort();
  }, [revision]);

  const refresh = useCallback(() => {
    activeRequest.current?.abort();
    setState(initialState());
    setRevision((value) => value + 1);
  }, []);

  const cancel = useCallback(() => {
    activeRequest.current?.abort();
    setState((previous) => previous.loading ? {
      ...previous, loading: false, cancelled: true, snapshot: { ...previous.snapshot, pausedUntil: undefined },
    } : previous);
  }, []);

  return { ...state, refresh, cancel };
}
