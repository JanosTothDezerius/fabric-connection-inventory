import { describe, expect, it } from 'vitest';

import { syntheticConnection, syntheticSnapshot } from '@/test/inventory-fixtures';
import {
  CREDENTIAL_TYPE_NOT_PROVIDED, credentialTypeLabel, formatTimestamp, selectConnections, summarizeInventory, withDirectoryNames,
} from './inventory-model';

const filters = { search: '', connectorType: '', credentialType: '', ownerStatus: 'all' as const };
const sort = { column: 'displayName' as const, direction: 'asc' as const };

describe('inventory filtering and summaries', () => {
  it('counts only successful empty owner results as having no owners', () => {
    const snapshot = syntheticSnapshot([
      syntheticConnection({ id: 'empty' }),
      syntheticConnection({ id: 'pending', ownerStatus: 'pending' }),
      syntheticConnection({ id: 'failed', ownerStatus: 'error' }),
      syntheticConnection({
        id: 'owned',
        owners: [{ id: 'synthetic-principal', type: 'Group', role: 'Owner' }],
      }),
    ]);

    expect(summarizeInventory(snapshot)).toEqual({
      total: 4, connectorTypes: 1, resolved: 2, pending: 1, failed: 1, noOwners: 1,
    });
    expect(selectConnections(snapshot.connections, { ...filters, ownerStatus: 'none' }, sort).map((row) => row.id))
      .toEqual(['empty']);
  });

  it.each([
    'WAREHOUSE', 'synthetic-connection-1', 'syntheticsql', 'SHAREABLECLOUD',
    'example.invalid', 'PRINCIPAL-ALPHA', 'Synthetic Owner', 'owner@example.invalid', 'ServicePrincipal',
  ])('searches names, ids, types, endpoints and owner metadata for %s', (search) => {
    const row = syntheticConnection({
      owners: [{
        id: 'principal-alpha',
        displayName: 'Synthetic Owner',
        userPrincipalName: 'owner@example.invalid',
        type: 'ServicePrincipal',
        role: 'Owner',
      }],
    });
    expect(selectConnections([row], { ...filters, search: ` ${search} ` }, sort)).toEqual([row]);
  });

  it('combines connector and owner filters without mutating input', () => {
    const rows = [
      syntheticConnection({ id: 'wrong-type', connectorType: 'SyntheticWeb', ownerStatus: 'error' }),
      syntheticConnection({ id: 'match', ownerStatus: 'error' }),
      syntheticConnection({ id: 'wrong-status' }),
    ];
    expect(selectConnections(rows, { ...filters, connectorType: 'SyntheticSQL', ownerStatus: 'error' }, sort).map((row) => row.id))
      .toEqual(['match']);
    expect(rows.map((row) => row.id)).toEqual(['wrong-type', 'match', 'wrong-status']);
  });

  it('sorts numerically with a stable id tie-breaker in either direction', () => {
    const rows = [
      syntheticConnection({ id: 'c', displayName: 'Synthetic 10' }),
      syntheticConnection({ id: 'b', displayName: 'Synthetic 2' }),
      syntheticConnection({ id: 'a', displayName: 'Synthetic 2' }),
    ];
    expect(selectConnections(rows, filters, sort).map((row) => row.id)).toEqual(['a', 'b', 'c']);
    expect(selectConnections(rows, filters, { ...sort, direction: 'desc' }).map((row) => row.id)).toEqual(['c', 'b', 'a']);
    expect(rows[0].id).toBe('c');
  });

  it('does not present absent or invalid dates as real timestamps', () => {
    expect(formatTimestamp()).toBe('Not provided');
    expect(formatTimestamp('invalid')).toBe('Not provided');
    expect(formatTimestamp('2026-01-02T03:04:05Z')).not.toBe('Not provided');
  });

  it('filters and searches by authentication type, keeping missing types selectable', () => {
    const rows = [
      syntheticConnection({ id: 'principal', credentialType: 'ServicePrincipal' }),
      syntheticConnection({ id: 'oauth', credentialType: 'OAuth2' }),
      syntheticConnection({ id: 'missing' }),
    ];
    const select = (update: Partial<typeof filters>) =>
      selectConnections(rows, { ...filters, ...update }, sort).map((row) => row.id);

    expect(select({ credentialType: 'ServicePrincipal' })).toEqual(['principal']);
    expect(select({ credentialType: CREDENTIAL_TYPE_NOT_PROVIDED })).toEqual(['missing']);
    expect(select({ search: 'oauth2' })).toEqual(['oauth']);
    expect(['ServicePrincipal', 'OAuth2', 'WindowsWithoutImpersonation', undefined].map(credentialTypeLabel))
      .toEqual(['Service Principal', 'OAuth2', 'Windows Without Impersonation', 'Not provided']);
  });

  it('adds directory names to unnamed owners only, and keeps unchanged rows for cached search text', () => {
    const named = syntheticConnection({
      id: 'named', owners: [{ id: 'AAAA', type: 'User', displayName: 'Fabric name', role: 'Owner' }],
    });
    const unnamed = syntheticConnection({
      id: 'unnamed',
      owners: [
        { id: 'BBBB', type: 'User', role: 'Owner' },
        { id: 'cccc', type: 'Group', role: 'PendingOwner' },
        { id: 'dddd', type: 'User', role: 'Owner' },
      ],
    });
    const rows = withDirectoryNames([named, unnamed], new Map([
      ['aaaa', { status: 'resolved' as const, displayName: 'Directory name' }],
      ['bbbb', { status: 'resolved' as const, displayName: 'Synthetic Owner', userPrincipalName: 'owner@example.test' }],
      ['cccc', { status: 'resolved' as const, displayName: 'Synthetic Group', mail: 'group@example.test' }],
      ['dddd', { status: 'notFound' as const }],
    ]));

    expect(rows[0]).toBe(named);
    expect(rows[1].owners).toEqual([
      { id: 'BBBB', type: 'User', role: 'Owner', displayName: 'Synthetic Owner', userPrincipalName: 'owner@example.test', mail: undefined, directoryStatus: 'resolved' },
      { id: 'cccc', type: 'Group', role: 'PendingOwner', displayName: 'Synthetic Group', userPrincipalName: undefined, mail: 'group@example.test', directoryStatus: 'resolved' },
      { id: 'dddd', type: 'User', role: 'Owner', directoryStatus: 'notFound' },
    ]);
    expect(selectConnections(rows, { ...filters, search: 'synthetic group' }, sort).map((row) => row.id)).toEqual(['unnamed']);
  });
});
