import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { DirectoryLookup, type PrincipalLookup, type PrincipalReference } from '@rayfin-app/shared';

import { AdminAuthError, getDirectoryAccessToken } from '@/services/admin-auth';
import { syntheticConnection } from '@/test/inventory-fixtures';
import { NameResolver, principalsNeedingNames, type PrincipalNamesState } from './principal-names';

vi.mock('@/services/admin-auth', () => ({
  getDirectoryAccessToken: vi.fn(),
  AdminAuthError: class extends Error {
    constructor(readonly code: string, message: string) { super(message); }
  },
}));

const mockToken = vi.mocked(getDirectoryAccessToken);
let lookup: MockInstance<DirectoryLookup['lookupPrincipals']>;
const guid = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const users = (count: number, offset = 0): PrincipalReference[] =>
  Array.from({ length: count }, (_, index) => ({ id: guid(index + offset), type: 'User' }));
const resolved = (principals: PrincipalReference[]): PrincipalLookup[] =>
  principals.map(({ id }) => ({ id, result: { status: 'resolved', displayName: `Name ${id}` } }));

function observe() {
  const states: PrincipalNamesState[] = [];
  const resolver = new NameResolver((state) => states.push(state));
  return { resolver, latest: () => states.at(-1)! };
}

beforeEach(() => {
  mockToken.mockReset().mockResolvedValue('synthetic-graph-token');
  lookup = vi.spyOn(DirectoryLookup.prototype, 'lookupPrincipals')
    .mockImplementation(async (principals) => resolved(principals));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('owner name lookups', () => {
  it('selects each unnamed user, group or service principal once', () => {
    const rows = [
      syntheticConnection({
        owners: [
          { id: guid(1), type: 'User', role: 'Owner' },
          { id: guid(2), type: 'Group', role: 'PendingOwner' },
          { id: guid(3), type: 'User', displayName: 'Fabric name', role: 'Owner' },
          { id: guid(4), type: 'ServicePrincipalProfile', role: 'Owner' },
        ],
      }),
      syntheticConnection({ id: 'second', owners: [{ id: guid(1).toUpperCase(), type: 'User', role: 'Owner' }] }),
    ];
    expect(principalsNeedingNames(rows)).toEqual([{ id: guid(1), type: 'User' }, { id: guid(2), type: 'Group' }]);
  });

  it('looks up names 20 at a time and each principal only once, as owners arrive', async () => {
    const { resolver, latest } = observe();
    resolver.add(users(25));
    await vi.waitFor(() => expect(latest()).toMatchObject({ loading: false }));
    expect(lookup.mock.calls.map(([batch]) => batch.length)).toEqual([20, 5]);

    resolver.add([...users(25), ...users(1, 25)]);
    await vi.waitFor(() => expect(latest().results.size).toBe(26));
    expect(lookup).toHaveBeenCalledTimes(3);
    expect(lookup).toHaveBeenLastCalledWith([{ id: guid(25), type: 'User' }]);
    expect(latest().results.get(guid(0))).toEqual({ status: 'resolved', displayName: `Name ${guid(0)}` });
  });

  it('pauses without a Graph token until a retry, which requests a fresh token', async () => {
    mockToken.mockRejectedValueOnce(new AdminAuthError('DirectoryAccessUnavailable', 'Synthetic Graph access unavailable'));
    const { resolver, latest } = observe();
    resolver.add(users(2));
    await vi.waitFor(() => expect(latest().unavailable).toEqual({
      code: 'DirectoryAccessUnavailable', message: 'Synthetic Graph access unavailable',
    }));
    expect(latest().loading).toBe(false);

    resolver.add(users(1, 2));
    expect(mockToken).toHaveBeenCalledTimes(1);
    expect(lookup).not.toHaveBeenCalled();
    resolver.retry();
    await vi.waitFor(() => expect(latest().results.size).toBe(3));
    expect(mockToken).toHaveBeenLastCalledWith(true);
    expect(latest().unavailable).toBeUndefined();
  });

  it('records denials, retries throttled lookups after Retry-After, and retries denials on request', async () => {
    vi.useFakeTimers();
    const [first, second] = users(2);
    lookup.mockResolvedValueOnce([
      { id: first.id, result: { status: 'denied' } },
      {
        id: second.id,
        result: { status: 'failed', error: { code: 'GraphHttp429', message: 'Synthetic throttling', status: 429, retryAt: Date.now() + 5_000 } },
      },
    ]);
    const { resolver, latest } = observe();
    resolver.add([first, second]);
    await vi.advanceTimersByTimeAsync(0);

    expect(latest().results.get(first.id)).toEqual({ status: 'denied' });
    expect(latest().results.has(second.id)).toBe(false);
    expect(lookup).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(lookup).toHaveBeenLastCalledWith([second]);
    expect(latest().results.get(second.id)).toMatchObject({ status: 'resolved' });

    resolver.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(lookup).toHaveBeenLastCalledWith([first]);
    expect(mockToken).toHaveBeenLastCalledWith(true);
    expect(latest().results.get(first.id)).toMatchObject({ status: 'resolved' });
  });
});
