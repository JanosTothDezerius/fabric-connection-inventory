import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  FabricInventory, InventoryError, type ApiFailure, type ConnectionPage, type ConnectionRecord,
  type InventorySnapshot, type OwnerBatch,
} from '@rayfin-app/shared';

import { AdminAuthError, getAdminAccessToken } from '@/services/admin-auth';
import { syntheticConnection, syntheticSnapshot } from '@/test/inventory-fixtures';
import { loadInventory } from './inventory';

vi.mock('@/services/admin-auth', () => ({
  getAdminAccessToken: vi.fn(),
  AdminAuthError: class extends Error {
    constructor(readonly code: string, message: string) { super(message); }
  },
}));

let listConnections: MockInstance<FabricInventory['listConnections']>;
let listOwners: MockInstance<FabricInventory['listConnectionOwners']>;
const mockAccessToken = vi.mocked(getAdminAccessToken);

function page(connections: ConnectionRecord[], nextToken: string | null = null): ConnectionPage {
  return { connections, nextToken };
}

function syntheticRows(count: number): ConnectionRecord[] {
  return Array.from({ length: count }, (_, index) =>
    syntheticConnection({ id: `synthetic-connection-${index + 1}` })
  );
}

function emptyOwners(connectionIds: string[]): OwnerBatch {
  return {
    results: connectionIds.map((connectionId) => ({
      connectionId, result: { ok: true, data: [] },
    })),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function observeLoad() {
  const controller = new AbortController();
  const onProgress = vi.fn<(snapshot: InventorySnapshot) => void>();
  const result = loadInventory({ signal: controller.signal, onProgress });
  return { controller, onProgress, result };
}

beforeEach(() => {
  mockAccessToken.mockReset().mockResolvedValue('synthetic-access-token');
  listConnections = vi.spyOn(FabricInventory.prototype, 'listConnections');
  listOwners = vi.spyOn(FabricInventory.prototype, 'listConnectionOwners')
    .mockImplementation(async (connectionIds) => emptyOwners(connectionIds));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe('loadInventory', () => {
  it('enumerates all pages, deduplicates ids and resolves owners only after enumeration', async () => {
    const [first, second, third] = syntheticRows(3);
    listConnections
      .mockResolvedValueOnce(page([first, first, second], 'synthetic-next-token'))
      .mockResolvedValueOnce(page([
        { ...first, displayName: 'Synthetic duplicate must not replace the first row' }, third,
      ]));
    const started = Date.now();
    const { result, onProgress } = observeLoad();
    const snapshot = await result;

    expect(listConnections.mock.calls.map(([token]) => token))
      .toEqual(['', 'synthetic-next-token']);
    expect(listOwners).toHaveBeenCalledExactlyOnceWith([first.id, second.id, third.id]);
    expect(mockAccessToken).toHaveBeenCalledTimes(3);
    expect(listOwners.mock.invocationCallOrder[0])
      .toBeGreaterThan(listConnections.mock.invocationCallOrder[1]);
    expect(snapshot.connections.map((row) => row.id)).toEqual([first.id, second.id, third.id]);
    expect(snapshot.connections[0].displayName).toBe(first.displayName);
    expect(snapshot).toMatchObject({ phase: 'done', inventoryComplete: true });
    expect(new Date(snapshot.updatedAt!).getTime()).toBeGreaterThanOrEqual(started);
    expect(new Date(snapshot.updatedAt!).getTime()).toBeLessThanOrEqual(Date.now());

    const snapshots = onProgress.mock.calls.map(([value]) => value);
    expect(snapshots[0]).toEqual({
      connections: [], inventoryComplete: false, phase: 'connections', updatedAt: null,
    });
    expect(snapshots.filter((value) => value.phase !== 'done').every((value) => value.updatedAt === null)).toBe(true);
    const enumerated = snapshots.find((value) => value.phase === 'owners');
    expect(enumerated?.inventoryComplete).toBe(true);
    expect(enumerated?.connections).toHaveLength(3);
    expect(enumerated?.connections.every((row) => row.ownerStatus === 'pending')).toBe(true);
    expect(snapshots.at(-1)).toBe(snapshot);
  });

  it('keeps successful empty owners distinct from a per-connection failure and preserves every owner', async () => {
    const rows = syntheticRows(3);
    const owners = [
      { id: 'synthetic-owner-1', type: 'Group', role: 'Owner' as const },
      { id: 'synthetic-owner-2', type: 'User', role: 'PendingOwner' as const },
    ];
    const error = {
      code: 'SyntheticForbidden', message: 'Synthetic owner access failure',
      status: 403, requestId: 'synthetic-owner-request',
    };
    listConnections.mockResolvedValue(page(rows));
    listOwners.mockResolvedValue({
      results: [
        { connectionId: rows[0].id, result: { ok: true, data: owners } },
        { connectionId: rows[1].id, result: { ok: true, data: [] } },
        { connectionId: rows[2].id, result: { ok: false, error } },
      ],
    });
    const snapshot = await observeLoad().result;

    expect(snapshot.connections[0]).toMatchObject({ ownerStatus: 'loaded', owners });
    expect(snapshot.connections[1]).toMatchObject({ ownerStatus: 'loaded', owners: [] });
    expect(snapshot.connections[1].ownerError).toBeUndefined();
    expect(snapshot.connections[2]).toMatchObject({ ownerStatus: 'error', ownerError: error });
    expect(snapshot).toMatchObject({ phase: 'done', inventoryComplete: true });
    expect(snapshot.updatedAt).not.toBeNull();
    expect(snapshot.error).toBeUndefined();
  });

  it('marks a missing owner result as an error rather than a successful empty result', async () => {
    const rows = syntheticRows(2);
    listConnections.mockResolvedValue(page(rows));
    listOwners.mockResolvedValue(emptyOwners([rows[0].id]));
    const snapshot = await observeLoad().result;

    expect(snapshot.connections[0].ownerStatus).toBe('loaded');
    expect(snapshot.connections[1]).toMatchObject({
      ownerStatus: 'error', ownerError: { code: 'MissingOwnerResult' },
    });
  });

  it('sends at most six ids in each owner batch and waits before starting the next batch', async () => {
    const rows = syntheticRows(13);
    const firstBatch = deferred<OwnerBatch>();
    listConnections.mockResolvedValue(page(rows));
    listOwners.mockImplementationOnce(() => firstBatch.promise);
    const { result, onProgress } = observeLoad();

    await vi.waitFor(() => expect(listOwners).toHaveBeenCalledTimes(1));
    expect(listOwners.mock.calls[0][0]).toEqual(rows.slice(0, 6).map((row) => row.id));
    expect(onProgress.mock.calls.at(-1)?.[0].connections.every((row) => row.ownerStatus === 'pending')).toBe(true);
    firstBatch.resolve(emptyOwners(rows.slice(0, 6).map((row) => row.id)));
    const snapshot = await result;

    expect(listOwners.mock.calls.map(([connectionIds]) => connectionIds.length)).toEqual([6, 6, 1]);
    expect(listOwners.mock.calls.flatMap(([connectionIds]) => connectionIds)).toEqual(rows.map((row) => row.id));
    expect(snapshot.connections.every((row) => row.ownerStatus === 'loaded')).toBe(true);
    const afterFirstBatch = onProgress.mock.calls.map(([value]) => value)
      .find((value) => value.connections.filter((row) => row.ownerStatus === 'loaded').length === 6);
    expect(afterFirstBatch?.connections.filter((row) => row.ownerStatus === 'pending')).toHaveLength(7);
    expect(afterFirstBatch?.updatedAt).toBeNull();
  });

  it.each(['InventoryError', 'unexpected rejection'])(
    'preserves failed owner statuses and continues later batches after an owner %s',
    async (failureKind) => {
      const rows = syntheticRows(7);
      listConnections.mockResolvedValue(page(rows));
      if (failureKind === 'InventoryError') {
        listOwners.mockRejectedValueOnce(new InventoryError({
          code: 'SyntheticBatchFailure', message: 'Synthetic owner batch failure',
        }));
      } else {
        listOwners.mockRejectedValueOnce(new Error('Synthetic raw internal diagnostic'));
      }

      const snapshot = await observeLoad().result;
      expect(listOwners).toHaveBeenCalledTimes(2);
      expect(snapshot.connections.slice(0, 6).every((row) => row.ownerStatus === 'error')).toBe(true);
      expect(snapshot.connections[0].ownerError?.code)
        .toBe(failureKind === 'InventoryError' ? 'SyntheticBatchFailure' : 'UnexpectedFailure');
      expect(snapshot.connections[0].ownerError?.message).not.toContain('raw internal diagnostic');
      expect(snapshot.connections[6].ownerStatus).toBe('loaded');
      expect(snapshot).toMatchObject({ phase: 'done', inventoryComplete: true });
    }
  );

  it.each(['InventoryError', 'unexpected rejection'])(
    'retains a partial inventory without owner lookups when a later list page has an %s',
    async (failureKind) => {
      const rows = syntheticRows(2);
      listConnections.mockResolvedValueOnce(page(rows, 'synthetic-next-token'));
      const error = {
        code: 'SyntheticListFailure', message: 'Synthetic list failure',
        status: 403, requestId: 'synthetic-list-request',
      };
      if (failureKind === 'InventoryError') {
        listConnections.mockRejectedValueOnce(new InventoryError(error));
      } else {
        listConnections.mockRejectedValueOnce(new Error('Synthetic raw list diagnostic'));
      }
      const { result, onProgress } = observeLoad();
      const snapshot = await result;

      expect(snapshot).toMatchObject({ phase: 'error', inventoryComplete: false, updatedAt: null });
      expect(snapshot.connections.map((row) => row.id)).toEqual(rows.map((row) => row.id));
      expect(snapshot.connections.every((row) => row.ownerStatus === 'pending')).toBe(true);
      if (failureKind === 'InventoryError') expect(snapshot.error).toEqual(error);
      else expect(snapshot.error?.code).toBe('UnexpectedFailure');
      expect(listOwners).not.toHaveBeenCalled();
      expect(onProgress.mock.calls.at(-1)?.[0]).toBe(snapshot);
    }
  );

  it.each([
    ['synthetic-a', 'synthetic-a'],
    ['synthetic-a', 'synthetic-b', 'synthetic-a'],
  ])('stops a pagination cycle with tokens %j', async (...tokens) => {
    const rows = syntheticRows(tokens.length);
    tokens.forEach((token, index) => listConnections.mockResolvedValueOnce(page([rows[index]], token)));
    const snapshot = await observeLoad().result;

    expect(listConnections).toHaveBeenCalledTimes(tokens.length);
    expect(snapshot).toMatchObject({
      phase: 'error', inventoryComplete: false, updatedAt: null,
      error: { code: 'PaginationLoop' },
    });
    expect(snapshot.connections).toHaveLength(tokens.length);
    expect(listOwners).not.toHaveBeenCalled();
  });

  it('completes an empty tenant inventory without inventing owners or invoking owner batches', async () => {
    listConnections.mockResolvedValue(page([]));
    const snapshot = await observeLoad().result;

    expect(snapshot).toMatchObject({ phase: 'done', inventoryComplete: true, connections: [] });
    expect(snapshot.updatedAt).not.toBeNull();
    expect(listOwners).not.toHaveBeenCalled();
  });

  it('surfaces silent token acquisition failure without making an inventory request', async () => {
    mockAccessToken.mockRejectedValue(new Error('Synthetic token diagnostic'));
    const snapshot = await observeLoad().result;

    expect(snapshot).toMatchObject({
      phase: 'error', inventoryComplete: false, updatedAt: null, connections: [],
    });
    expect(snapshot.error?.message).toBeTruthy();
    expect(snapshot.error?.message).not.toContain('Synthetic token diagnostic');
    expect(listConnections).not.toHaveBeenCalled();
    expect(listOwners).not.toHaveBeenCalled();
  });

  it('preserves AdminSignInRequired on initial token rejection without making HTTP requests', async () => {
    const request = vi.spyOn(globalThis, 'fetch');
    const error = new AdminAuthError('AdminSignInRequired', 'Synthetic admin session needs reconnection.');
    mockAccessToken.mockRejectedValueOnce(error);
    const { result, onProgress } = observeLoad();
    const snapshot = await result;

    expect(snapshot).toEqual({
      connections: [],
      inventoryComplete: false,
      phase: 'error',
      updatedAt: null,
      error: { code: error.code, message: error.message },
    });
    expect(mockAccessToken).toHaveBeenCalledTimes(1);
    expect(listConnections).not.toHaveBeenCalled();
    expect(listOwners).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(onProgress.mock.calls.at(-1)?.[0]).toBe(snapshot);
  });

  it('preserves an owner-phase auth error and completed connection enumeration while unread owners remain pending', async () => {
    const rows = syntheticRows(13);
    const error = new AdminAuthError('AdminSignInRequired', 'Synthetic admin session expired during owner lookup.');
    listConnections.mockResolvedValue(page(rows));
    mockAccessToken
      .mockResolvedValueOnce('synthetic-list-token')
      .mockResolvedValueOnce('synthetic-first-owner-token')
      .mockRejectedValueOnce(error);
    const { result, onProgress } = observeLoad();
    const snapshot = await result;

    expect(snapshot).toMatchObject({
      phase: 'error',
      inventoryComplete: true,
      updatedAt: null,
      error: { code: error.code, message: error.message },
    });
    expect(snapshot.connections).toHaveLength(13);
    expect(snapshot.connections.slice(0, 6).every((row) => row.ownerStatus === 'loaded')).toBe(true);
    expect(snapshot.connections.slice(6).every((row) =>
      row.ownerStatus === 'pending' && row.owners.length === 0 && row.ownerError === undefined
    )).toBe(true);
    expect(listConnections).toHaveBeenCalledTimes(1);
    expect(listOwners).toHaveBeenCalledExactlyOnceWith(rows.slice(0, 6).map((row) => row.id));
    expect(mockAccessToken).toHaveBeenCalledTimes(3);
    expect(onProgress.mock.calls.some(([value]) => value.phase === 'done')).toBe(false);
    expect(onProgress.mock.calls.at(-1)?.[0]).toBe(snapshot);
  });
});

describe('loadInventory throttling and resume', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function throttled(retryAt?: number, status = 429): ApiFailure {
    return {
      code: `FabricHttp${status}`, message: 'Synthetic throttling.', status,
      ...(retryAt === undefined ? {} : { retryAt }),
    };
  }

  it('recovers end to end from throttling using the blocked-until time in the response body', async () => {
    listConnections.mockRestore();
    listOwners.mockRestore();
    vi.setSystemTime(Date.UTC(2026, 1, 18, 22, 44, 0));
    const first = '11111111-1111-4111-8111-111111111111';
    const second = '22222222-2222-4222-8222-222222222222';
    const ownersPath = (id: string) => `/v1/admin/connections/${id}/roleAssignments`;
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      requests.push(path);
      if (path === '/v1/admin/connections') return Response.json({ value: [{ id: first }, { id: second }] });
      if (requests.filter((value) => value === ownersPath(first)).length === 1) {
        return Response.json({
          errorCode: 'RequestBlocked',
          message: 'Request is blocked by the upstream service until: 2/18/2026 10:44:30 PM (UTC)',
        }, { status: 429 });
      }
      return Response.json({
        value: path === ownersPath(first) ? [{ role: 'Owner', principal: { id: second, type: 'User' } }] : [],
      });
    }));
    const { result, onProgress } = observeLoad();
    await vi.advanceTimersByTimeAsync(1_000);

    // The second lookup is not sent while Fabric's blocking window is open.
    expect(requests).toEqual(['/v1/admin/connections', ownersPath(first)]);
    expect(onProgress.mock.calls.at(-1)![0].pausedUntil).toBe(Date.UTC(2026, 1, 18, 22, 44, 31));
    await vi.advanceTimersByTimeAsync(31_000);
    const snapshot = await result;

    expect(requests.slice(2)).toEqual([ownersPath(first), ownersPath(second)]);
    expect(snapshot).toMatchObject({ phase: 'done', inventoryComplete: true });
    expect(snapshot.connections.map((row) => row.ownerStatus)).toEqual(['loaded', 'loaded']);
    expect(snapshot.connections[0].owners).toEqual([expect.objectContaining({ id: second, role: 'Owner' })]);
  });

  it.each([
    { status: 429, wait: 45_000, hinted: true },
    { status: 503, wait: 60_000, hinted: false },
  ])('pauses for a $status owner lookup, then looks it up again before later rows', async ({ status, wait, hinted }) => {
    const rows = syntheticRows(8);
    const error = throttled(hinted ? Date.now() + wait : undefined, status);
    listConnections.mockResolvedValue(page(rows));
    listOwners.mockResolvedValueOnce({
      results: rows.slice(0, 6).map((row, index) => ({
        connectionId: row.id,
        result: index < 2 ? { ok: true as const, data: [] } : { ok: false as const, error },
      })),
    });
    const { result, onProgress } = observeLoad();
    await vi.advanceTimersByTimeAsync(0);

    const paused = onProgress.mock.calls.at(-1)![0];
    expect(paused).toMatchObject({ phase: 'owners', inventoryComplete: true, pausedUntil: Date.now() + wait });
    expect(paused.connections.map((row) => row.ownerStatus))
      .toEqual(['loaded', 'loaded', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending']);
    await vi.advanceTimersByTimeAsync(wait - 1);
    expect(listOwners).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const snapshot = await result;

    expect(listOwners.mock.calls.map(([connectionIds]) => connectionIds)).toEqual([
      rows.slice(0, 6).map((row) => row.id),
      rows.slice(2).map((row) => row.id),
    ]);
    expect(snapshot).toMatchObject({ phase: 'done', inventoryComplete: true });
    expect(snapshot.pausedUntil).toBeUndefined();
    expect(snapshot.error).toBeUndefined();
    expect(snapshot.connections.every((row) => row.ownerStatus === 'loaded')).toBe(true);
  });

  it('backs off while throttling continues without progress, then stops with resumable rows', async () => {
    const rows = syntheticRows(3);
    listConnections.mockResolvedValue(page(rows));
    listOwners.mockImplementation(async (connectionIds) => ({
      results: connectionIds.map((connectionId) => ({
        connectionId, result: { ok: false as const, error: throttled(Date.now() + 60_000) },
      })),
    }));
    const pauses: number[] = [];
    const result = loadInventory({
      signal: new AbortController().signal,
      onProgress: (snapshot) => {
        if (snapshot.pausedUntil !== undefined) pauses.push(snapshot.pausedUntil - Date.now());
      },
    });
    await vi.advanceTimersByTimeAsync(60_000 + 120_000 + 240_000);
    const snapshot = await result;

    expect(pauses).toEqual([60_000, 120_000, 240_000]);
    expect(listOwners).toHaveBeenCalledTimes(4);
    expect(snapshot).toMatchObject({
      phase: 'error', inventoryComplete: true, updatedAt: null,
      error: { code: 'FabricHttp429', status: 429, retryAt: Date.now() + 240_000 },
    });
    expect(snapshot.error?.message).toContain('after 3 automatic pauses');
    expect(snapshot.error?.message).toContain('Completed owner results are kept');
    expect(snapshot.pausedUntil).toBeUndefined();
    expect(snapshot.connections.every((row) => row.ownerStatus === 'pending')).toBe(true);
  });

  it('stops without waiting when Fabric asks for a longer pause than the app waits automatically', async () => {
    const rows = syntheticRows(2);
    const retryAt = Date.now() + 11 * 60_000;
    listConnections.mockResolvedValue(page(rows));
    listOwners.mockResolvedValueOnce({
      results: rows.map((row) => ({ connectionId: row.id, result: { ok: false as const, error: throttled(retryAt) } })),
    });
    const snapshot = await observeLoad().result;

    expect(snapshot).toMatchObject({ phase: 'error', inventoryComplete: true, error: { status: 429, retryAt } });
    expect(snapshot.error?.message).toContain('longer than it waits automatically');
    expect(listOwners).toHaveBeenCalledTimes(1);
    expect(snapshot.connections.every((row) => row.ownerStatus === 'pending')).toBe(true);
  });

  it('requests a throttled connection page again after the pause without restarting enumeration', async () => {
    const [first, second] = syntheticRows(2);
    const retryAt = Date.now() + 30_000;
    listConnections
      .mockResolvedValueOnce(page([first], 'synthetic-next-token'))
      .mockRejectedValueOnce(new InventoryError(throttled(retryAt)))
      .mockResolvedValueOnce(page([second]));
    const { result, onProgress } = observeLoad();
    await vi.advanceTimersByTimeAsync(0);

    expect(onProgress.mock.calls.at(-1)![0]).toMatchObject({
      phase: 'connections', inventoryComplete: false, pausedUntil: retryAt,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    const snapshot = await result;

    expect(listConnections.mock.calls.map(([token]) => token))
      .toEqual(['', 'synthetic-next-token', 'synthetic-next-token']);
    expect(snapshot).toMatchObject({ phase: 'done', inventoryComplete: true });
    expect(snapshot.connections.map((row) => row.id)).toEqual([first.id, second.id]);
  });

  it('cancels during a pause without sending further requests or progress', async () => {
    const rows = syntheticRows(7);
    listConnections.mockResolvedValue(page(rows));
    listOwners.mockResolvedValueOnce({
      results: rows.slice(0, 6).map((row) => ({
        connectionId: row.id, result: { ok: false as const, error: throttled(Date.now() + 60_000) },
      })),
    });
    const { controller, result, onProgress } = observeLoad();
    await vi.advanceTimersByTimeAsync(0);
    expect(onProgress.mock.calls.at(-1)![0].pausedUntil).toBeDefined();
    const progressCount = onProgress.mock.calls.length;
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejected;

    await vi.advanceTimersByTimeAsync(120_000);
    expect(listOwners).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledTimes(progressCount);
  });

  it('resumes only unfinished owner lookups from a complete connection list without listing again', async () => {
    const done = syntheticConnection({
      id: 'synthetic-done', owners: [{ id: 'synthetic-owner', type: 'User', role: 'Owner' }],
    });
    const pending = syntheticConnection({ id: 'synthetic-pending', ownerStatus: 'pending' });
    const failed = syntheticConnection({
      id: 'synthetic-failed', ownerStatus: 'error', ownerError: { code: 'SyntheticFailure', message: 'Synthetic failure' },
    });
    const resumeFrom = syntheticSnapshot([done, pending, failed], {
      phase: 'error', updatedAt: null, pausedUntil: Date.now(), error: throttled(),
    });
    const onProgress = vi.fn<(snapshot: InventorySnapshot) => void>();
    const snapshot = await loadInventory({ signal: new AbortController().signal, onProgress, resumeFrom });

    expect(listConnections).not.toHaveBeenCalled();
    expect(listOwners).toHaveBeenCalledExactlyOnceWith([pending.id, failed.id]);
    const first = onProgress.mock.calls[0][0];
    expect(first).toMatchObject({ phase: 'owners', inventoryComplete: true, updatedAt: null });
    expect(first.connections).toEqual(resumeFrom.connections);
    expect(first.error).toBeUndefined();
    expect(first.pausedUntil).toBeUndefined();
    expect(snapshot).toMatchObject({ phase: 'done', inventoryComplete: true });
    expect(snapshot.connections[0]).toBe(done);
    expect(snapshot.connections[2]).toMatchObject({ ownerStatus: 'loaded', owners: [] });
    expect(snapshot.connections[2].ownerError).toBeUndefined();
  });

  it('starts a full refresh when asked to resume an incomplete connection list', async () => {
    listConnections.mockResolvedValue(page(syntheticRows(1)));
    const resumeFrom = syntheticSnapshot([syntheticConnection({ ownerStatus: 'pending' })], {
      phase: 'error', inventoryComplete: false, updatedAt: null,
    });
    const snapshot = await loadInventory({ signal: new AbortController().signal, onProgress: vi.fn(), resumeFrom });

    expect(listConnections).toHaveBeenCalledOnce();
    expect(snapshot).toMatchObject({ phase: 'done', inventoryComplete: true });
  });
});

describe('loadInventory cancellation', () => {
  it('does not publish or invoke functions when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const onProgress = vi.fn();

    await expect(loadInventory({ signal: controller.signal, onProgress })).rejects.toMatchObject({ name: 'AbortError' });
    expect(onProgress).not.toHaveBeenCalled();
    expect(mockAccessToken).not.toHaveBeenCalled();
  });

  it('abandons a pending list wait and ignores its late result without requesting another page', async () => {
    const pendingPage = deferred<ConnectionPage>();
    listConnections.mockReturnValue(pendingPage.promise);
    const { controller, result, onProgress } = observeLoad();
    await vi.waitFor(() => expect(listConnections).toHaveBeenCalledTimes(1));
    const progressCount = onProgress.mock.calls.length;
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejected;

    pendingPage.resolve(page(syntheticRows(2), 'synthetic-unused-next-token'));
    await Promise.resolve();
    await Promise.resolve();
    expect(onProgress).toHaveBeenCalledTimes(progressCount);
    expect(listConnections).toHaveBeenCalledTimes(1);
    expect(listOwners).not.toHaveBeenCalled();
  });

  it('abandons a pending owner wait, suppresses late progress and never starts subsequent batches', async () => {
    const rows = syntheticRows(13);
    const pendingOwners = deferred<OwnerBatch>();
    listConnections.mockResolvedValue(page(rows));
    listOwners.mockReturnValueOnce(pendingOwners.promise);
    const { controller, result, onProgress } = observeLoad();
    await vi.waitFor(() => expect(listOwners).toHaveBeenCalledTimes(1));
    const progressCount = onProgress.mock.calls.length;
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejected;

    pendingOwners.resolve(emptyOwners(rows.slice(0, 6).map((row) => row.id)));
    await Promise.resolve();
    await Promise.resolve();
    expect(onProgress).toHaveBeenCalledTimes(progressCount);
    expect(listOwners).toHaveBeenCalledTimes(1);
    const finalProgress = onProgress.mock.calls.at(-1)?.[0];
    expect(finalProgress?.phase).toBe('owners');
    expect(finalProgress?.updatedAt).toBeNull();
    expect(finalProgress?.connections.every((row) => row.ownerStatus === 'pending')).toBe(true);
  });

  it('checks cancellation between completed owner batches before issuing another invocation', async () => {
    listConnections.mockResolvedValue(page(syntheticRows(13)));
    const controller = new AbortController();
    const onProgress = vi.fn((snapshot: InventorySnapshot) => {
      if (snapshot.connections.filter((row) => row.ownerStatus === 'loaded').length === 6) {
        controller.abort();
      }
    });

    await expect(loadInventory({ signal: controller.signal, onProgress })).rejects.toMatchObject({ name: 'AbortError' });
    expect(listOwners).toHaveBeenCalledTimes(1);
    expect(onProgress.mock.calls.at(-1)?.[0].phase).toBe('owners');
    expect(onProgress.mock.calls.at(-1)?.[0].updatedAt).toBeNull();
  });
});
