import { useCallback, useEffect, useRef, useState } from 'react';
import type { InventorySnapshot } from '@rayfin-app/shared';

import { loadInventory } from '@/services/inventory';

interface InventoryState {
  snapshot: InventorySnapshot;
  loading: boolean;
  cancelled: boolean;
}

function initialState(): InventoryState {
  return {
    snapshot: {
      connections: [],
      inventoryComplete: false,
      phase: 'connections',
      updatedAt: null,
    },
    loading: true,
    cancelled: false,
  };
}

export function useInventory() {
  const [state, setState] = useState(initialState);
  const [revision, setRevision] = useState(0);
  const activeRequest = useRef<AbortController | null>(null);
  const resumeFrom = useRef<InventorySnapshot | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    activeRequest.current = controller;
    const resumeSnapshot = resumeFrom.current ?? undefined;
    resumeFrom.current = null;

    async function run() {
      try {
        const snapshot = await loadInventory({
          signal: controller.signal,
          resumeFrom: resumeSnapshot,
          onProgress: (progress) => {
            if (!controller.signal.aborted) {
              setState({ snapshot: progress, loading: true, cancelled: false });
            }
          },
        });
        if (!controller.signal.aborted) {
          setState({ snapshot, loading: false, cancelled: false });
        }
      } catch {
        if (!controller.signal.aborted) {
          setState((previous) => ({
            ...previous,
            loading: false,
            snapshot: {
              ...previous.snapshot,
              phase: 'error',
              updatedAt: null,
              pausedUntil: undefined,
              error: {
                code: 'UnexpectedInventoryError',
                message: 'The inventory could not be loaded. Refresh to try again.',
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

  /** Continues owner lookups for a complete connection list, keeping the rows already shown. */
  const resume = useCallback(() => {
    if (!state.snapshot.inventoryComplete) return;
    activeRequest.current?.abort();
    resumeFrom.current = state.snapshot;
    setState((previous) => ({ ...previous, loading: true, cancelled: false }));
    setRevision((value) => value + 1);
  }, [state.snapshot]);

  const cancel = useCallback(() => {
    activeRequest.current?.abort();
    setState((previous) => ({
      ...previous,
      loading: false,
      cancelled: true,
    }));
  }, []);

  return { ...state, refresh, resume, cancel };
}
