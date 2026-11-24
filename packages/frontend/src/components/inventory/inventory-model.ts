import type { ConnectionRow, DependentItem, DirectoryLookupResult, InventorySnapshot } from '@rayfin-app/shared';

export type SortColumn = 'displayName' | 'owners' | 'connectorType' | 'endpoint';
/** Each list holds the selected values of a multi-select filter; an empty list doesn't filter. */
export interface InventoryFilters {
  search: string;
  connectorTypes: string[];
  /** Credential types, including CREDENTIAL_TYPE_NOT_PROVIDED. */
  credentialTypes: string[];
  /** Lower-case workspace IDs. A connection matches when it has a dependent workload in any of them. */
  workspaceIds: string[];
}
export interface InventorySort {
  column: SortColumn;
  direction: 'asc' | 'desc';
}
export interface FilterOption {
  value: string;
  label: string;
  /** Loaded connections that the option matches. */
  count: number;
}
export type DependentItems = ReadonlyMap<string, readonly DependentItem[]>;

export const PAGE_SIZE = 25;
/** Filter value for connections whose authentication type Fabric did not return; never a Fabric credential type. */
export const CREDENTIAL_TYPE_NOT_PROVIDED = '(not provided)';

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const NO_ITEMS: DependentItems = new Map();

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

function workspacesOf(row: ConnectionRow, itemsByConnection: DependentItems): Set<string> {
  return new Set((itemsByConnection.get(row.id.toLowerCase()) ?? []).map((item) => item.workspaceId).filter(Boolean));
}

/**
 * Filters and sorts connections. Values selected in one filter match any of them; different filters
 * must all match. The workspace filter uses the dependent workloads found so far.
 */
export function selectConnections(
  rows: ConnectionRow[],
  filters: InventoryFilters,
  sort: InventorySort,
  itemsByConnection: DependentItems = NO_ITEMS
): ConnectionRow[] {
  const query = filters.search.trim().toLocaleLowerCase();
  const connectorTypes = new Set(filters.connectorTypes);
  const credentialTypes = new Set(filters.credentialTypes);
  const workspaceIds = new Set(filters.workspaceIds);
  return rows
    .filter((row) => {
      if (connectorTypes.size > 0 && !connectorTypes.has(row.connectorType)) return false;
      if (credentialTypes.size > 0 && !credentialTypes.has(row.credentialType || CREDENTIAL_TYPE_NOT_PROVIDED)) return false;
      if (workspaceIds.size > 0 && ![...workspacesOf(row, itemsByConnection)].some((id) => workspaceIds.has(id))) return false;
      return !query || searchText(row).includes(query);
    })
    .sort((a, b) => {
      const left = sort.column === 'owners' ? `${a.ownerStatus} ${ownerSearchText(a)}` : a[sort.column];
      const right = sort.column === 'owners' ? `${b.ownerStatus} ${ownerSearchText(b)}` : b[sort.column];
      const comparison = collator.compare(left, right) || collator.compare(a.id, b.id);
      return sort.direction === 'asc' ? comparison : -comparison;
    });
}

/** Counts the rows that have each value; selected values stay listed even when no row has them. */
function tally(rows: readonly ConnectionRow[], valuesOf: (row: ConnectionRow) => Iterable<string>, selected: readonly string[]) {
  const counts = new Map<string, number>(selected.map((value) => [value, 0]));
  for (const row of rows) {
    for (const value of new Set(valuesOf(row))) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

export function connectorTypeOptions(rows: readonly ConnectionRow[], selected: readonly string[]): FilterOption[] {
  return [...tally(rows, (row) => [row.connectorType], selected)]
    .map(([value, count]) => ({ value, label: value, count }))
    .sort((a, b) => collator.compare(a.label, b.label));
}

export function credentialTypeOptions(rows: readonly ConnectionRow[], selected: readonly string[]): FilterOption[] {
  return [...tally(rows, (row) => [row.credentialType || CREDENTIAL_TYPE_NOT_PROVIDED], selected)]
    .map(([value, count]) => ({
      value, count, label: value === CREDENTIAL_TYPE_NOT_PROVIDED ? 'Not provided' : credentialTypeLabel(value),
    }))
    .sort((a, b) => a.value === CREDENTIAL_TYPE_NOT_PROVIDED ? 1 : b.value === CREDENTIAL_TYPE_NOT_PROVIDED ? -1 :
      collator.compare(a.label, b.label));
}

/**
 * Workspaces that contain a dependent workload of at least one loaded connection. Workspaces that share
 * a name are told apart by their ID, and workspaces that aren't active show their state.
 */
export function workspaceOptions(
  rows: readonly ConnectionRow[],
  itemsByConnection: DependentItems,
  selected: readonly string[]
): FilterOption[] {
  const details = new Map<string, { name?: string; state?: string }>();
  for (const items of itemsByConnection.values()) {
    for (const item of items) {
      if (item.workspaceId && !details.has(item.workspaceId)) {
        details.set(item.workspaceId, { name: item.workspaceName, state: item.workspaceState });
      }
    }
  }
  const counts = tally(rows, (row) => workspacesOf(row, itemsByConnection), selected);
  const names = new Map<string, number>();
  for (const id of counts.keys()) {
    const name = details.get(id)?.name?.toLocaleLowerCase();
    if (name) names.set(name, (names.get(name) ?? 0) + 1);
  }
  return [...counts]
    .map(([value, count]) => {
      const { name, state } = details.get(value) ?? {};
      const notes = [name && names.get(name.toLocaleLowerCase())! > 1 ? value.slice(0, 8) : '', state ?? ''].filter(Boolean);
      return { value, count, label: `${name ?? value}${notes.length > 0 ? ` (${notes.join(', ')})` : ''}` };
    })
    .sort((a, b) => collator.compare(a.label, b.label) || collator.compare(a.value, b.value));
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
