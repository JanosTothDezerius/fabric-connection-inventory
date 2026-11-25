import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ConnectionOwner, ConnectionRow, InventorySnapshot } from '@rayfin-app/shared';

import { loadInventory } from '@/services/inventory';

/** New ownership information for one connection, such as after a take over. */
export interface OwnerChange {
  /** All owners, looked up again after the change; the connection's owner lookup then counts as succeeded. */
  owners?: ConnectionOwner[];
  /** The owner that was added. It stays listed until a lookup includes it, or the inventory is loaded again. */
  added?: ConnectionOwner;
}

interface OwnerUpdate {
  /** The connection's row when the change was made; the change's owner list applies while the row is unchanged. */
  base: ConnectionRow;
  change: OwnerChange;
}

interface InventoryState {
  snapshot: InventorySnapshot;
  loading: boolean;
  cancelled: boolean;
  /** Ownership changes made in this view, by connection ID, applied on top of the loaded rows. */
  updates: ReadonlyMap<string, OwnerUpdate>;
}

const NO_UPDATES: ReadonlyMap<string, OwnerUpdate> = new Map();

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
    updates: NO_UPDATES,
  };
}

function isListed(owners: readonly ConnectionOwner[], owner: ConnectionOwner): boolean {
  return owners.some((candidate) => candidate.id.toLowerCase() === owner.id.toLowerCase());
}

function applyChange(row: ConnectionRow, change: OwnerChange): ConnectionRow {
  const owners = change.owners ?? row.owners;
  const { added } = change;
  return {
    ...row,
    owners: !added || isListed(owners, added) ? owners : [...owners, added],
    ...(change.owners ? { ownerStatus: 'loaded' as const, ownerError: undefined } : {}),
  };
}

/**
 * A row with its ownership change shown. A lookup published after the change may have been requested before
 * it, so the added owner stays listed until a lookup includes it, and a failed lookup doesn't hide the change.
 */
function showChange(row: ConnectionRow, { base, change }: OwnerUpdate): ConnectionRow {
  if (row === base || row.ownerStatus === 'error') return applyChange(row, change);
  const { added } = change;
  return !added || isListed(row.owners, added) ? row : { ...row, owners: [...row.owners, added] };
}

/** The loaded snapshot with ownership changes shown; the same snapshot when none apply. */
function withUpdates(snapshot: InventorySnapshot, updates: ReadonlyMap<string, OwnerUpdate>): InventorySnapshot {
  if (updates.size === 0) return snapshot;
  let changed = false;
  const connections = snapshot.connections.map((row) => {
    const update = updates.get(row.id);
    const shown = update ? showChange(row, update) : row;
    if (shown !== row) changed = true;
    return shown;
  });
  return changed ? { ...snapshot, connections } : snapshot;
}

export function useInventory() {
  const [state, setState] = useState(initialState);
  const [revision, setRevision] = useState(0);
  const activeRequest = useRef<AbortController | null>(null);
  const resumeFrom = useRef<InventorySnapshot | null>(null);
  const snapshot = useMemo(() => withUpdates(state.snapshot, state.updates), [state.snapshot, state.updates]);

  useEffect(() => {
    const controller = new AbortController();
    activeRequest.current = controller;
    const resumeSnapshot = resumeFrom.current ?? undefined;
    resumeFrom.current = null;

    async function run() {
      try {
        const loaded = await loadInventory({
          signal: controller.signal,
          resumeFrom: resumeSnapshot,
          onProgress: (progress) => {
            if (!controller.signal.aborted) {
              setState((previous) => ({ ...previous, snapshot: progress, loading: true, cancelled: false }));
            }
          },
        });
        if (!controller.signal.aborted) {
          setState((previous) => ({ ...previous, snapshot: loaded, loading: false, cancelled: false }));
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
    if (!snapshot.inventoryComplete) return;
    activeRequest.current?.abort();
    // The resumed run starts from the rows shown, so ownership changes are kept as loaded owners.
    resumeFrom.current = snapshot;
    setState((previous) => ({ ...previous, snapshot, updates: NO_UPDATES, loading: true, cancelled: false }));
    setRevision((value) => value + 1);
  }, [snapshot]);

  const cancel = useCallback(() => {
    activeRequest.current?.abort();
    setState((previous) => ({
      ...previous,
      loading: false,
      cancelled: true,
    }));
  }, []);

  /** Shows new ownership information for one connection immediately, without reloading other connections. */
  const updateOwners = useCallback((connectionId: string, change: OwnerChange) => {
    setState((previous) => {
      const base = previous.snapshot.connections.find((row) => row.id === connectionId);
      return base ? { ...previous, updates: new Map(previous.updates).set(connectionId, { base, change }) } : previous;
    });
  }, []);

  return { snapshot, loading: state.loading, cancelled: state.cancelled, refresh, resume, cancel, updateOwners };
}
