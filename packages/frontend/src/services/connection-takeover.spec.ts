import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { ConnectionOwnership, FabricInventory, InventoryError, type OwnerBatch } from '@rayfin-app/shared';

import { AdminAuthError, getAdminAccessToken, getConnectionWriteAccess } from '@/services/admin-auth';
import { TakeOverError, takeOverConnection } from './connection-takeover';

vi.mock('@/services/admin-auth', () => ({
  getAdminAccessToken: vi.fn(),
  getConnectionWriteAccess: vi.fn(),
  AdminAuthError: class extends Error {
    constructor(readonly code: string, message: string, readonly detail?: string) { super(message); }
  },
}));

const connectionId = '11111111-1111-4111-8111-111111111111';
const principalId = '55555555-5555-4555-8555-555555555555';
const existing = { id: '22222222-2222-4222-8222-222222222222', type: 'Group', role: 'Owner' as const };
const added = { id: principalId, type: 'User', role: 'PendingOwner' as const };
let addOwner: MockInstance<ConnectionOwnership['addUserOwner']>;
let listOwners: MockInstance<FabricInventory['listConnectionOwners']>;

function failureOf(promise: Promise<unknown>) {
  return promise.then(() => undefined, (error: unknown) => error instanceof TakeOverError ? error.failure : error);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getConnectionWriteAccess).mockResolvedValue({ token: 'synthetic-write-token', principalId });
  vi.mocked(getAdminAccessToken).mockResolvedValue('synthetic-read-token');
  addOwner = vi.spyOn(ConnectionOwnership.prototype, 'addUserOwner').mockResolvedValue(added);
  listOwners = vi.spyOn(FabricInventory.prototype, 'listConnectionOwners').mockResolvedValue({
    results: [{ connectionId, result: { ok: true, data: [existing, added] } }],
  });
});
afterEach(() => vi.restoreAllMocks());

describe('takeOverConnection', () => {
  it('adds only the signed-in account, then looks up only that connection’s owners again', async () => {
    await expect(takeOverConnection(connectionId)).resolves.toEqual({ principalId, added, owners: [existing, added] });
    expect(addOwner).toHaveBeenCalledOnce();
    expect(addOwner).toHaveBeenCalledWith(connectionId, principalId);
    expect(listOwners).toHaveBeenCalledOnce();
    expect(listOwners).toHaveBeenCalledWith([connectionId]);
    expect(addOwner.mock.invocationCallOrder[0]).toBeLessThan(listOwners.mock.invocationCallOrder[0]);
  });

  it('still reports the change when the owners can’t be looked up again', async () => {
    const throttled = { code: 'FabricHttp429', message: 'Fabric is throttling requests.', status: 429 };
    listOwners.mockResolvedValue({ results: [{ connectionId, result: { ok: false, error: throttled } }] } satisfies OwnerBatch);
    await expect(takeOverConnection(connectionId)).resolves.toEqual({ principalId, added, refreshError: throttled });
  });

  it('explains that Take over needs Tenant.ReadWrite.All without calling Fabric', async () => {
    vi.mocked(getConnectionWriteAccess).mockRejectedValue(
      new AdminAuthError('TakeOverPermissionNotGranted', 'Synthetic missing permission', 'WriteScopeMissing'));
    expect(await failureOf(takeOverConnection(connectionId))).toEqual({
      code: 'WriteScopeMissing', message: expect.stringContaining('Tenant.ReadWrite.All, which this app doesn’t have'),
    });
    expect(addOwner).not.toHaveBeenCalled();
  });

  it('reports a throttled or unconfirmed change without looking owners up again', async () => {
    const retryAt = Date.now() + 30_000;
    addOwner.mockRejectedValueOnce(new InventoryError({ code: 'FabricHttp429', message: 'Fabric is throttling requests.', status: 429, retryAt }));
    expect(await failureOf(takeOverConnection(connectionId))).toMatchObject({
      code: 'FabricHttp429', status: 429, message: `Fabric is throttling requests. Try again after ${new Date(retryAt).toLocaleTimeString()}.`,
    });
    addOwner.mockRejectedValueOnce(new InventoryError({ code: 'RequestTimeout', message: 'Synthetic timeout' }));
    expect(await failureOf(takeOverConnection(connectionId))).toMatchObject({
      code: 'RequestTimeout', message: expect.stringContaining('it isn’t known whether you were added'),
    });
    expect(listOwners).not.toHaveBeenCalled();
  });
});
