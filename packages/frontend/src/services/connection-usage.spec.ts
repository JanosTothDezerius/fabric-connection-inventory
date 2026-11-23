import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { InventoryError, WorkspaceScanner, type DependentItem, type WorkspaceUsage } from '@rayfin-app/shared';

import { AdminAuthError, getPowerBiAdminAccessToken } from '@/services/admin-auth';
import { loadConnectionUsage, type UsageSnapshot } from './connection-usage';

vi.mock('@/services/admin-auth', () => ({
  getPowerBiAdminAccessToken: vi.fn(),
  AdminAuthError: class extends Error {
    constructor(readonly code: string, message: string) { super(message); }
  },
}));

let listWorkspaceIds: MockInstance<WorkspaceScanner['listWorkspaceIds']>;
let startScan: MockInstance<WorkspaceScanner['startScan']>;
let scanStatus: MockInstance<WorkspaceScanner['scanStatus']>;
let scanResult: MockInstance<WorkspaceScanner['scanResult']>;
const mockToken = vi.mocked(getPowerBiAdminAccessToken);

function item(name: string): DependentItem {
  return { id: name, name, type: 'Semantic model', workspaceId: 'synthetic-workspace' };
}

function usage(entries: [string, DependentItem[]][] = []): WorkspaceUsage {
  return { workspaceCount: 0, itemsByConnection: new Map(entries) };
}

function observe() {
  const onProgress = vi.fn<(snapshot: UsageSnapshot) => void>();
  const result = loadConnectionUsage({ signal: new AbortController().signal, onProgress });
  return { result, onProgress };
}

beforeEach(() => {
  vi.useFakeTimers();
  mockToken.mockReset().mockResolvedValue('synthetic-power-bi-token');
  listWorkspaceIds = vi.spyOn(WorkspaceScanner.prototype, 'listWorkspaceIds');
  startScan = vi.spyOn(WorkspaceScanner.prototype, 'startScan')
    .mockImplementation(async (ids) => ({ id: ids.join(','), status: 'Succeeded' }));
  scanStatus = vi.spyOn(WorkspaceScanner.prototype, 'scanStatus');
  scanResult = vi.spyOn(WorkspaceScanner.prototype, 'scanResult').mockResolvedValue(usage());
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('loadConnectionUsage', () => {
  it('scans workspaces in batches of 100, polls until each scan succeeds, and merges items per connection', async () => {
    const ids = Array.from({ length: 150 }, (_, index) => `workspace-${index}`);
    listWorkspaceIds.mockResolvedValue(ids);
    startScan.mockImplementation(async (batch) => ({ id: `scan-${batch.length}`, status: 'NotStarted' }));
    scanStatus.mockResolvedValueOnce({ id: 'scan-100', status: 'Running' })
      .mockImplementation(async (id) => ({ id, status: 'Succeeded' }));
    scanResult.mockImplementation(async (id) => usage([['connection', [item(id)]]]));
    const { result, onProgress } = observe();
    await vi.runAllTimersAsync();
    const snapshot = await result;

    expect(startScan.mock.calls.map(([batch]) => batch)).toEqual([ids.slice(0, 100), ids.slice(100)]);
    expect(scanStatus).toHaveBeenCalledTimes(3);
    expect(snapshot).toMatchObject({ phase: 'done', workspaceCount: 150, scannedWorkspaces: 150, failedWorkspaces: 0 });
    expect(snapshot.itemsByConnection.get('connection')?.map((entry) => entry.name).sort()).toEqual(['scan-100', 'scan-50']);
    expect(snapshot.updatedAt).not.toBeNull();
    expect(onProgress.mock.calls.some(([value]) => value.phase === 'scanning' && value.workspaceCount === 150)).toBe(true);
    expect(onProgress.mock.calls.at(-1)?.[0]).toBe(snapshot);
  });

  it('splits a batch whose result is too large and counts failed scans without stopping the run', async () => {
    listWorkspaceIds.mockResolvedValue(['w1', 'w2', 'w3', 'w4']);
    scanResult.mockImplementation(async (id) => {
      if (id === 'w1,w2,w3,w4') throw new InventoryError({ code: 'ResponseTooLarge', message: 'Synthetic large result' });
      if (id === 'w3,w4') throw new InventoryError({ code: 'PowerBiHttp500', message: 'Synthetic scan failure', status: 500 });
      return usage([['connection', [item(id)]]]);
    });
    const snapshot = await observe().result;

    expect(startScan.mock.calls.map(([batch]) => batch.join(','))).toEqual(['w1,w2,w3,w4', 'w1,w2', 'w3,w4']);
    expect(snapshot).toMatchObject({
      phase: 'done', workspaceCount: 4, scannedWorkspaces: 2, failedWorkspaces: 2, error: { code: 'PowerBiHttp500' },
    });
    expect(snapshot.itemsByConnection.get('connection')).toEqual([item('w1,w2')]);
  });

  it('reports a failed scan status as a failed batch', async () => {
    listWorkspaceIds.mockResolvedValue(['w1']);
    startScan.mockResolvedValue({ id: 'scan', status: 'Failed' });
    const snapshot = await observe().result;

    expect(snapshot).toMatchObject({ phase: 'done', scannedWorkspaces: 0, failedWorkspaces: 1, error: { code: 'ScanFailed' } });
    expect(scanResult).not.toHaveBeenCalled();
  });

  it('stops without listing workspaces when the scanner token is unavailable', async () => {
    mockToken.mockRejectedValue(new AdminAuthError('AdminSignInRequired', 'Synthetic sign-in required'));
    const snapshot = await observe().result;

    expect(snapshot).toMatchObject({ phase: 'error', error: { code: 'AdminSignInRequired', message: 'Synthetic sign-in required' } });
    expect(listWorkspaceIds).not.toHaveBeenCalled();
  });

  it('stops the whole run when scanner access is denied instead of failing every batch', async () => {
    listWorkspaceIds.mockResolvedValue(['w1']);
    startScan.mockRejectedValue(new InventoryError({ code: 'PowerBiHttp403', message: 'Synthetic denied', status: 403 }));
    const snapshot = await observe().result;

    expect(snapshot).toMatchObject({ phase: 'error', failedWorkspaces: 0, error: { code: 'PowerBiHttp403', status: 403 } });
  });

  it('pauses while Power BI throttles, then sends the same request again', async () => {
    listWorkspaceIds
      .mockRejectedValueOnce(new InventoryError({
        code: 'PowerBiHttp429', message: 'Synthetic throttling.', status: 429, retryAt: Date.now() + 30_000,
      }))
      .mockResolvedValueOnce(['w1']);
    const { result, onProgress } = observe();
    await vi.advanceTimersByTimeAsync(0);

    expect(onProgress.mock.calls.at(-1)![0].pausedUntil).toBe(Date.now() + 30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    const snapshot = await result;

    expect(listWorkspaceIds).toHaveBeenCalledTimes(2);
    expect(snapshot).toMatchObject({ phase: 'done', scannedWorkspaces: 1 });
    expect(snapshot.pausedUntil).toBeUndefined();
  });

  it('stops instead of waiting when Power BI asks for a longer pause than the scan waits automatically', async () => {
    const retryAt = Date.now() + 30 * 60_000;
    listWorkspaceIds.mockRejectedValue(new InventoryError({
      code: 'PowerBiHttp429', message: 'Synthetic throttling.', status: 429, retryAt,
    }));
    const snapshot = await observe().result;

    expect(listWorkspaceIds).toHaveBeenCalledTimes(1);
    expect(snapshot).toMatchObject({ phase: 'error', error: { code: 'PowerBiHttp429', retryAt } });
    expect(snapshot.error?.message).toContain('Retry the workspace scan after');
  });
});
