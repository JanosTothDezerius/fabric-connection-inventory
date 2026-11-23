import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { DirectoryLookup, type PrincipalLookup, type PrincipalReference } from '@rayfin-app/shared';

import { AdminAuthError, getDirectoryAccessToken } from '@/services/admin-auth';
import { syntheticConnection } from '@/test/inventory-fixtures';
import {
  NameResolver, ownersShowingOnlyIds, principalsNeedingNames, type PrincipalNamesState,
} from './principal-names';

vi.mock('@/services/admin-auth', () => ({
  getDirectoryAccessToken: vi.fn(),
  AdminAuthError: class extends Error {
    constructor(readonly code: string, message: string, readonly detail?: string) { super(message); }
  },
}));

const mockToken = vi.mocked(getDirectoryAccessToken);
let lookup: MockInstance<DirectoryLookup['lookupPrincipals']>;
const guid = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const principals = (type: string, count: number, offset: number): PrincipalReference[] =>
  Array.from({ length: count }, (_, index) => ({ id: guid(index + offset), type }));
const users = (count: number, offset = 0) => principals('User', count, offset);
const groups = (count: number, offset = 0) => principals('Group', count, 100 + offset);
const servicePrincipals = (count: number, offset = 0) => principals('ServicePrincipal', count, 200 + offset);
const resolved = (batch: PrincipalReference[]): PrincipalLookup[] =>
  batch.map(({ id }) => ({ id, result: { status: 'resolved', displayName: `Name ${id}` } }));
const notGranted = () => new AdminAuthError('DirectoryPermissionNotGranted', 'Synthetic permission not granted', 'AADSTS65001');

function observe() {
  const states: PrincipalNamesState[] = [];
  const resolver = new NameResolver((state) => states.push(state));
  return { resolver, latest: () => states.at(-1)! };
}

beforeEach(() => {
  mockToken.mockReset().mockResolvedValue('synthetic-graph-token');
  lookup = vi.spyOn(DirectoryLookup.prototype, 'lookupPrincipals')
    .mockImplementation(async (batch) => resolved(batch));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('owner name lookups', () => {
  it('selects each unnamed user, group or service principal once, and counts owners that show only an ID', () => {
    const rows = [
      syntheticConnection({
        owners: [
          { id: guid(1), type: 'User', role: 'Owner' },
          { id: guid(2), type: 'Group', role: 'PendingOwner' },
          { id: guid(3), type: 'User', displayName: 'Fabric name', role: 'Owner' },
          { id: guid(4), type: 'ServicePrincipalProfile', role: 'Owner' },
          { id: guid(5), type: 'User', userPrincipalName: 'owner@example.test', role: 'Owner' },
          { id: guid(6), type: 'ServicePrincipal', role: 'Owner', directoryStatus: 'notFound' },
        ],
      }),
      syntheticConnection({ id: 'second', owners: [{ id: guid(1).toUpperCase(), type: 'User', role: 'Owner' }] }),
    ];
    expect(principalsNeedingNames(rows)).toEqual([
      { id: guid(1), type: 'User' }, { id: guid(2), type: 'Group' },
      { id: guid(5), type: 'User' }, { id: guid(6), type: 'ServicePrincipal' },
    ]);
    expect(ownersShowingOnlyIds(rows)).toEqual({ user: 1, group: 1, servicePrincipal: 0 });
  });

  it('looks up names 20 at a time per kind, with a token for that kind, and each principal once', async () => {
    const { resolver, latest } = observe();
    resolver.add([...users(25), ...groups(1)]);
    await vi.waitFor(() => expect(latest().loading).toBe(false));
    expect(lookup.mock.calls.map(([batch]) => batch)).toEqual([users(20), users(5, 20), groups(1)]);
    expect(mockToken.mock.calls).toEqual([['user', false], ['user', false], ['group', false]]);
    expect(latest().access).toEqual({ user: { status: 'granted' }, group: { status: 'granted' } });

    resolver.add([...users(25), ...users(1, 25)]);
    await vi.waitFor(() => expect(latest().results.size).toBe(27));
    expect(lookup).toHaveBeenCalledTimes(4);
    expect(lookup).toHaveBeenLastCalledWith(users(1, 25));
    expect(latest().results.get(guid(0))).toEqual({ status: 'resolved', displayName: `Name ${guid(0)}` });
  });

  it('keeps looking up granted kinds when other kinds lack a permission or a token', async () => {
    mockToken.mockImplementation(async (kind) => {
      if (kind === 'group') throw notGranted();
      if (kind === 'servicePrincipal') {
        throw new AdminAuthError('DirectoryAccessUnavailable', 'Synthetic token failure (AADSTS50076).', 'AADSTS50076');
      }
      return 'synthetic-user-token';
    });
    const { resolver, latest } = observe();
    resolver.add([...servicePrincipals(1), ...groups(2), ...users(2)]);
    await vi.waitFor(() => expect(latest().loading).toBe(false));

    expect(lookup).toHaveBeenCalledExactlyOnceWith(users(2));
    expect([...latest().results.keys()]).toEqual(users(2).map(({ id }) => id));
    expect(latest().access).toEqual({
      user: { status: 'granted' },
      group: { status: 'notGranted', code: 'AADSTS65001' },
      servicePrincipal: {
        status: 'failed', error: { code: 'DirectoryAccessUnavailable', message: 'Synthetic token failure (AADSTS50076).' },
      },
    });
  });

  it('waits while a kind is blocked, then checks it again with a fresh token on retry', async () => {
    mockToken.mockRejectedValueOnce(notGranted());
    const { resolver, latest } = observe();
    resolver.add(users(2));
    await vi.waitFor(() => expect(latest().access.user).toEqual({ status: 'notGranted', code: 'AADSTS65001' }));
    expect(latest().loading).toBe(false);

    resolver.add(users(1, 2));
    expect(mockToken).toHaveBeenCalledTimes(1);
    expect(lookup).not.toHaveBeenCalled();
    resolver.retry();
    expect(latest().access.user).toEqual({ status: 'checking' });
    await vi.waitFor(() => expect(latest().results.size).toBe(3));
    expect(mockToken).toHaveBeenLastCalledWith('user', true);
    expect(latest().access.user).toEqual({ status: 'granted' });

    resolver.add(users(1, 3));
    await vi.waitFor(() => expect(latest().results.size).toBe(4));
    expect(mockToken).toHaveBeenLastCalledWith('user', false);
  });

  it('reports a kind Graph denies for a whole batch as a missing permission, and single denials per owner', async () => {
    lookup.mockImplementationOnce(async (batch) => batch.map(({ id }) => ({ id, result: { status: 'denied' } })));
    const { resolver, latest } = observe();
    resolver.add(groups(2));
    await vi.waitFor(() => expect(latest().access.group).toEqual({ status: 'notGranted', code: 'GraphHttp403' }));
    expect(latest().results.size).toBe(0);

    const [first, second] = groups(2);
    lookup.mockResolvedValueOnce([
      { id: first.id, result: { status: 'resolved', displayName: 'Synthetic Group' } },
      { id: second.id, result: { status: 'denied' } },
    ]);
    resolver.retry();
    await vi.waitFor(() => expect(latest().results.size).toBe(2));
    expect(latest().results.get(second.id)).toEqual({ status: 'denied' });
    expect(latest().access.group).toEqual({ status: 'granted' });
  });

  it('retries throttled lookups after Retry-After, and owners denied individually on request', async () => {
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
    expect(mockToken).toHaveBeenLastCalledWith('user', true);
    expect(latest().results.get(first.id)).toMatchObject({ status: 'resolved' });
  });
});
