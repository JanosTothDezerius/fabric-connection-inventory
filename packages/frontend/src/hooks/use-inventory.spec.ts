import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionRow, InventorySnapshot, LoadInventoryOptions } from '@rayfin-app/shared';

import { loadInventory } from '@/services/inventory';
import { syntheticConnection, syntheticSnapshot } from '@/test/inventory-fixtures';
import { useInventory } from './use-inventory';

vi.mock('@/services/inventory', () => ({ loadInventory: vi.fn() }));
const mockLoad = vi.mocked(loadInventory);

function deferred() {
  let resolve!: (value: InventorySnapshot) => void;
  const promise = new Promise<InventorySnapshot>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);

describe('useInventory request lifecycle', () => {
  it('exposes progress and only uses the service-provided completion timestamp', async () => {
    const request = deferred();
    let options!: LoadInventoryOptions;
    mockLoad.mockImplementation((value) => { options = value; return request.promise; });
    const { result } = renderHook(useInventory);
    const partial = syntheticSnapshot([syntheticConnection({ ownerStatus: 'pending' })], {
      phase: 'owners', updatedAt: null,
    });
    act(() => options.onProgress(partial));
    expect(result.current.snapshot).toEqual(partial);
    expect(result.current.loading).toBe(true);

    const done = syntheticSnapshot();
    await act(async () => request.resolve(done));
    expect(result.current.loading).toBe(false);
    expect(result.current.snapshot.updatedAt).toBe(done.updatedAt);
  });

  it('clears rows on refresh, aborts the old request and ignores its late progress or completion', async () => {
    const first = deferred();
    const second = deferred();
    const options: LoadInventoryOptions[] = [];
    mockLoad
      .mockImplementationOnce((value) => { options.push(value); return first.promise; })
      .mockImplementationOnce((value) => { options.push(value); return second.promise; });
    const { result } = renderHook(useInventory);
    act(() => options[0].onProgress(syntheticSnapshot([syntheticConnection({ id: 'old' })], {
      phase: 'owners', updatedAt: null,
    })));
    act(() => result.current.refresh());
    expect(options[0].signal.aborted).toBe(true);
    expect(result.current.snapshot.connections).toEqual([]);
    expect(result.current.snapshot.updatedAt).toBeNull();
    const fresh = syntheticSnapshot([syntheticConnection({ id: 'fresh' })]);
    await act(async () => second.resolve(fresh));
    await act(async () => {
      options[0].onProgress(syntheticSnapshot([syntheticConnection({ id: 'stale-progress' })]));
      first.resolve(syntheticSnapshot([syntheticConnection({ id: 'stale-final' })]));
    });
    expect(result.current.snapshot).toEqual(fresh);
  });

  it('cancels without discarding partial rows or accepting a late result', async () => {
    const request = deferred();
    let options!: LoadInventoryOptions;
    mockLoad.mockImplementation((value) => { options = value; return request.promise; });
    const { result } = renderHook(useInventory);
    const partial = syntheticSnapshot([syntheticConnection({ ownerStatus: 'pending' })], {
      phase: 'connections', inventoryComplete: false, updatedAt: null,
    });
    act(() => options.onProgress(partial));
    act(() => result.current.cancel());
    await act(async () => request.resolve(syntheticSnapshot()));
    expect(options.signal.aborted).toBe(true);
    expect(result.current.cancelled).toBe(true);
    expect(result.current.loading).toBe(false);
    expect(result.current.snapshot).toEqual(partial);
  });

  it('aborts on unmount and tolerates late callbacks', async () => {
    const request = deferred();
    let options!: LoadInventoryOptions;
    mockLoad.mockImplementation((value) => { options = value; return request.promise; });
    const { unmount } = renderHook(useInventory);
    unmount();
    expect(options.signal.aborted).toBe(true);
    await act(async () => {
      options.onProgress(syntheticSnapshot());
      request.resolve(syntheticSnapshot());
    });
  });

  it('shows an explicit sanitized error for an unexpected rejection', async () => {
    mockLoad.mockRejectedValue(new Error('Synthetic internal provider diagnostic'));
    const { result } = renderHook(useInventory);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.snapshot.phase).toBe('error');
    expect(result.current.snapshot.inventoryComplete).toBe(false);
    expect(result.current.snapshot.updatedAt).toBeNull();
    expect(result.current.snapshot.error?.message).toContain('Refresh to try again');
    expect(result.current.snapshot.error?.message).not.toContain('internal provider');
  });

  it('resumes from the current snapshot and keeps its rows while owner lookups continue', async () => {
    const first = deferred();
    const second = deferred();
    const options: LoadInventoryOptions[] = [];
    mockLoad
      .mockImplementationOnce((value) => { options.push(value); return first.promise; })
      .mockImplementationOnce((value) => { options.push(value); return second.promise; });
    const { result } = renderHook(useInventory);
    expect(options[0].resumeFrom).toBeUndefined();
    const stopped = syntheticSnapshot([
      syntheticConnection({ id: 'kept' }),
      syntheticConnection({ id: 'unfinished', ownerStatus: 'pending' }),
    ], { phase: 'error', updatedAt: null, error: { code: 'FabricHttp429', message: 'Synthetic throttling', status: 429 } });
    await act(async () => first.resolve(stopped));

    act(() => result.current.resume());
    expect(options).toHaveLength(2);
    expect(options[1].resumeFrom).toBe(stopped);
    expect(result.current.loading).toBe(true);
    expect(result.current.snapshot.connections).toEqual(stopped.connections);
    const finished = syntheticSnapshot([syntheticConnection({ id: 'kept' }), syntheticConnection({ id: 'unfinished' })]);
    await act(async () => second.resolve(finished));
    expect(result.current.loading).toBe(false);
    expect(result.current.snapshot).toEqual(finished);
  });

  it('does not resume an incomplete connection list', async () => {
    mockLoad.mockResolvedValueOnce(syntheticSnapshot([syntheticConnection({ ownerStatus: 'pending' })], {
      phase: 'error', inventoryComplete: false, updatedAt: null,
    }));
    const { result } = renderHook(useInventory);
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.resume());
    expect(mockLoad).toHaveBeenCalledTimes(1);
    expect(result.current.loading).toBe(false);
  });
});

describe('useInventory ownership changes', () => {
  const existing = { id: 'synthetic-group', type: 'Group', role: 'Owner' as const };
  const admin = { id: 'synthetic-admin', type: 'User', role: 'PendingOwner' as const };

  it('shows one connection’s new owners at once and keeps the added owner until a lookup lists it', async () => {
    const request = deferred();
    let options!: LoadInventoryOptions;
    mockLoad.mockImplementation((value) => { options = value; return request.promise; });
    const { result } = renderHook(useInventory);
    const publish = (...connections: ConnectionRow[]) =>
      act(() => options.onProgress(syntheticSnapshot(connections, { phase: 'owners', updatedAt: null })));
    const other = syntheticConnection({ id: 'other', ownerStatus: 'pending' });
    publish(syntheticConnection({ id: 'owned', ownerStatus: 'pending' }), other);

    act(() => result.current.updateOwners('owned', { owners: [existing, admin], added: admin }));
    expect(result.current.snapshot.connections[0]).toMatchObject({ ownerStatus: 'loaded', owners: [existing, admin] });
    expect(result.current.snapshot.connections[1]).toBe(other);

    // A lookup requested before the change, published after it, doesn't list the new owner yet.
    const otherLoaded = syntheticConnection({ id: 'other' });
    publish(syntheticConnection({ id: 'owned', owners: [existing] }), otherLoaded);
    expect(result.current.snapshot.connections.map((row) => row.owners)).toEqual([[existing, admin], []]);
    publish(syntheticConnection({
      id: 'owned', ownerStatus: 'error', ownerError: { code: 'Synthetic', message: 'Synthetic' },
    }), otherLoaded);
    expect(result.current.snapshot.connections[0]).toMatchObject({ ownerStatus: 'loaded', owners: [existing, admin] });

    const listed = syntheticConnection({ id: 'owned', owners: [existing, { ...admin, role: 'Owner' }] });
    await act(async () => request.resolve(syntheticSnapshot([listed, otherLoaded])));
    expect(result.current.snapshot.connections[0]).toBe(listed);
  });

  it('lists an added owner the lookup misses, keeps unrefreshed lookup states, and resumes from the rows shown', async () => {
    const options: LoadInventoryOptions[] = [];
    mockLoad
      .mockImplementationOnce(async (value) => {
        options.push(value);
        return syntheticSnapshot([
          syntheticConnection({ id: 'failed', ownerStatus: 'error', ownerError: { code: 'Synthetic', message: 'Synthetic' } }),
          syntheticConnection({ id: 'pending', ownerStatus: 'pending', owners: [existing] }),
        ], { phase: 'error', updatedAt: null, error: { code: 'FabricHttp429', message: 'Synthetic throttling', status: 429 } });
      })
      .mockImplementationOnce((value) => { options.push(value); return new Promise(() => {}); });
    const { result } = renderHook(useInventory);
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.updateOwners('failed', { owners: [existing], added: admin });
      result.current.updateOwners('pending', { added: admin });
      result.current.updateOwners('not-loaded', { added: admin });
    });
    const [failed, pending] = result.current.snapshot.connections;
    expect(failed).toMatchObject({ ownerStatus: 'loaded', ownerError: undefined, owners: [existing, admin] });
    expect(pending).toMatchObject({ ownerStatus: 'pending', owners: [existing, admin] });
    expect(result.current.snapshot.connections).toHaveLength(2);

    act(() => result.current.resume());
    expect(options[1].resumeFrom?.connections).toEqual([failed, pending]);
  });
});
