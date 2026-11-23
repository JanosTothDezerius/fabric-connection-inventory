import type { ConnectionRow, DirectoryLookupResult, InventorySnapshot } from '@rayfin-app/shared';

export type OwnerFilter = 'all' | 'pending' | 'loaded' | 'error' | 'none';
export type SortColumn = 'displayName' | 'owners' | 'connectorType' | 'endpoint';
export interface InventoryFilters {
  search: string;
  connectorType: string;
  /** A credential type, CREDENTIAL_TYPE_NOT_PROVIDED, or empty for all. */
  credentialType: string;
  ownerStatus: OwnerFilter;
}
export interface InventorySort {
  column: SortColumn;
  direction: 'asc' | 'desc';
}

export const PAGE_SIZE = 25;
/** Filter value for connections whose authentication type Fabric did not return; never a Fabric credential type. */
export const CREDENTIAL_TYPE_NOT_PROVIDED = '(not provided)';

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Readable authentication type, such as "Service Principal" for ServicePrincipal. */
export function credentialTypeLabel(value?: string): string {
  return value ? value.replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/([A-Z]{2,})([A-Z][a-z])/g, '$1 $2') : 'Not provided';
}

// Rows are immutable snapshots, so their derived text can be cached per row object.
const ownerTextCache = new WeakMap<ConnectionRow, string>();
const searchTextCache = new WeakMap<ConnectionRow, string>();

function ownerSearchText(row: ConnectionRow): string {
  let text = ownerTextCache.get(row);
  if (text === undefined) {
    text = row.owners
      .map((owner) =>
        [owner.id, owner.type, owner.displayName, owner.userPrincipalName, owner.mail, owner.role]
          .filter(Boolean)
          .join(' ')
      )
      .join(' ');
    ownerTextCache.set(row, text);
  }
  return text;
}

function searchText(row: ConnectionRow): string {
  let text = searchTextCache.get(row);
  if (text === undefined) {
    text = [
      row.displayName,
      row.id,
      row.connectorType,
      row.connectivityType,
      row.credentialType,
      row.endpoint,
      ownerSearchText(row),
    ].join(' ').toLocaleLowerCase();
    searchTextCache.set(row, text);
  }
  return text;
}

export function selectConnections(
  rows: ConnectionRow[],
  filters: InventoryFilters,
  sort: InventorySort
): ConnectionRow[] {
  const query = filters.search.trim().toLocaleLowerCase();
  return rows
    .filter((row) => {
      if (filters.connectorType && row.connectorType !== filters.connectorType) return false;
      if (filters.credentialType && (row.credentialType || CREDENTIAL_TYPE_NOT_PROVIDED) !== filters.credentialType) {
        return false;
      }
      if (filters.ownerStatus === 'none') {
        if (row.ownerStatus !== 'loaded' || row.owners.length !== 0) return false;
      } else if (filters.ownerStatus !== 'all' && row.ownerStatus !== filters.ownerStatus) {
        return false;
      }
      return !query || searchText(row).includes(query);
    })
    .sort((a, b) => {
      const left = sort.column === 'owners' ? `${a.ownerStatus} ${ownerSearchText(a)}` : a[sort.column];
      const right = sort.column === 'owners' ? `${b.ownerStatus} ${ownerSearchText(b)}` : b[sort.column];
      const comparison = collator.compare(left, right) || collator.compare(a.id, b.id);
      return sort.direction === 'asc' ? comparison : -comparison;
    });
}

/**
 * Adds Microsoft Entra ID names to owners that Fabric returned without one. Names from Fabric are kept,
 * and rows without new information keep their identity, so cached search text stays valid.
 */
export function withDirectoryNames(
  rows: ConnectionRow[],
  results: ReadonlyMap<string, DirectoryLookupResult>
): ConnectionRow[] {
  if (results.size === 0) return rows;
  return rows.map((row) => {
    let changed = false;
    const owners = row.owners.map((owner) => {
      if (owner.displayName) return owner;
      const result = results.get(owner.id.toLowerCase());
      if (!result) return owner;
      changed = true;
      return result.status === 'resolved' ? {
        ...owner,
        displayName: result.displayName,
        userPrincipalName: owner.userPrincipalName ?? result.userPrincipalName,
        mail: result.mail,
        directoryStatus: result.status,
      } : { ...owner, directoryStatus: result.status };
    });
    return changed ? { ...row, owners } : row;
  });
}

export function summarizeInventory(snapshot: InventorySnapshot) {
  const rows = snapshot.connections;
  return {
    total: rows.length,
    connectorTypes: new Set(rows.map((row) => row.connectorType).filter(Boolean)).size,
    resolved: rows.filter((row) => row.ownerStatus === 'loaded').length,
    pending: rows.filter((row) => row.ownerStatus === 'pending').length,
    failed: rows.filter((row) => row.ownerStatus === 'error').length,
    noOwners: rows.filter((row) => row.ownerStatus === 'loaded' && row.owners.length === 0).length,
  };
}

export function formatTimestamp(value?: string | null): string {
  if (!value) return 'Not provided';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Not provided' : date.toLocaleString();
}
