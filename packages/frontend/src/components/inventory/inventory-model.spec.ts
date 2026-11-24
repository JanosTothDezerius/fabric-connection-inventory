import { describe, expect, it } from 'vitest';
import type { DependentItem } from '@rayfin-app/shared';

import { syntheticConnection, syntheticSnapshot } from '@/test/inventory-fixtures';
import {
  CREDENTIAL_TYPE_NOT_PROVIDED, connectorTypeOptions, credentialTypeLabel, credentialTypeOptions, formatTimestamp,
  selectConnections, summarizeInventory, withDirectoryNames, workspaceOptions, type InventoryFilters,
} from './inventory-model';

const filters: InventoryFilters = { search: '', connectorTypes: [], credentialTypes: [], workspaceIds: [] };
const sort = { column: 'displayName' as const, direction: 'asc' as const };

function item(workspaceId: string, workspaceName?: string, workspaceState?: string): DependentItem {
  return { id: `item-in-${workspaceId}`, name: 'Synthetic item', type: 'Semantic model', workspaceId, workspaceName, workspaceState };
}

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

  it('matches any value selected in one filter and requires every filter, without mutating input', () => {
    const rows = [
      syntheticConnection({ id: 'web-oauth', connectorType: 'SyntheticWeb', credentialType: 'OAuth2' }),
      syntheticConnection({ id: 'sql-oauth', credentialType: 'OAuth2' }),
      syntheticConnection({ id: 'sql-key', credentialType: 'Key' }),
      syntheticConnection({ id: 'file-oauth', connectorType: 'SyntheticFile', credentialType: 'OAuth2' }),
    ];
    const select = (update: Partial<InventoryFilters>) =>
      selectConnections(rows, { ...filters, ...update }, sort).map((row) => row.id);

    expect(select({ connectorTypes: ['SyntheticSQL', 'SyntheticWeb'] }).sort()).toEqual(['sql-key', 'sql-oauth', 'web-oauth']);
    expect(select({ connectorTypes: ['SyntheticSQL', 'SyntheticWeb'], credentialTypes: ['OAuth2'] }).sort())
      .toEqual(['sql-oauth', 'web-oauth']);
    expect(rows.map((row) => row.id)).toEqual(['web-oauth', 'sql-oauth', 'sql-key', 'file-oauth']);
  });

  it('filters by workspace using dependent workloads, showing a connection for each of its workspaces', () => {
    const rows = [
      syntheticConnection({ id: 'Shared', displayName: 'Synthetic shared' }),
      syntheticConnection({ id: 'finance-only', displayName: 'Synthetic finance' }),
      syntheticConnection({ id: 'unused', displayName: 'Synthetic unused' }),
    ];
    const items = new Map([
      ['shared', [item('finance'), item('sales')]],
      ['finance-only', [item('finance')]],
    ]);
    const select = (workspaceIds: string[]) =>
      selectConnections(rows, { ...filters, workspaceIds }, sort, items).map((row) => row.id);

    expect(select(['finance'])).toEqual(['finance-only', 'Shared']);
    expect(select(['sales'])).toEqual(['Shared']);
    expect(select(['finance', 'sales'])).toEqual(['finance-only', 'Shared']);
    expect(select([])).toHaveLength(3);
    expect(selectConnections(rows, { ...filters, workspaceIds: ['finance'] }, sort)).toEqual([]);
  });

  it('builds filter options with connection counts and keeps selected values that no longer match', () => {
    const rows = [
      syntheticConnection({ id: 'a', credentialType: 'ServicePrincipal' }),
      syntheticConnection({ id: 'b', connectorType: 'SyntheticWeb', credentialType: 'OAuth2' }),
      syntheticConnection({ id: 'c' }),
    ];
    expect(connectorTypeOptions(rows, ['Gone'])).toEqual([
      { value: 'Gone', label: 'Gone', count: 0 },
      { value: 'SyntheticSQL', label: 'SyntheticSQL', count: 2 },
      { value: 'SyntheticWeb', label: 'SyntheticWeb', count: 1 },
    ]);
    expect(credentialTypeOptions(rows, [])).toEqual([
      { value: 'OAuth2', label: 'OAuth2', count: 1 },
      { value: 'ServicePrincipal', label: 'Service Principal', count: 1 },
      { value: CREDENTIAL_TYPE_NOT_PROVIDED, label: 'Not provided', count: 1 },
    ]);
  });

  it('lists workspaces with dependent workloads, telling apart workspaces that share a name', () => {
    const rows = [syntheticConnection({ id: 'a' }), syntheticConnection({ id: 'b' })];
    const items = new Map([
      ['a', [item('11111111-aaaa', 'Sales'), item('22222222-bbbb', 'Sales'), item('33333333-cccc', 'Archive', 'Deleted')]],
      ['b', [item('11111111-aaaa', 'Sales'), item('11111111-aaaa', 'Sales')]],
      ['not-loaded', [item('44444444-dddd', 'Elsewhere')]],
    ]);
    expect(workspaceOptions(rows, items, ['55555555-eeee'])).toEqual([
      { value: '55555555-eeee', label: '55555555-eeee', count: 0 },
      { value: '33333333-cccc', label: 'Archive (Deleted)', count: 1 },
      { value: '11111111-aaaa', label: 'Sales (11111111)', count: 2 },
      { value: '22222222-bbbb', label: 'Sales (22222222)', count: 1 },
    ]);
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

    expect(select({ credentialTypes: ['ServicePrincipal'] })).toEqual(['principal']);
    expect(select({ credentialTypes: [CREDENTIAL_TYPE_NOT_PROVIDED] })).toEqual(['missing']);
    expect(select({ credentialTypes: ['ServicePrincipal', CREDENTIAL_TYPE_NOT_PROVIDED] })).toEqual(['missing', 'principal']);
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
