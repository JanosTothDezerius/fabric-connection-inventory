import { Fragment, useId, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronDown, ChevronRight } from 'lucide-react';
import type { ConnectionRow, DependentItem } from '@rayfin-app/shared';

import type { UsageSnapshot } from '@/services/connection-usage';
import { credentialTypeLabel, formatTimestamp, type InventorySort, type SortColumn } from './inventory-model';

export interface UsageView {
  snapshot: UsageSnapshot;
  loading: boolean;
  cancelled: boolean;
}

interface ConnectionTableProps {
  rows: ConnectionRow[];
  sort: InventorySort;
  onSort: (column: SortColumn) => void;
  loading: boolean;
  usage: UsageView;
  emptyTitle: string;
  emptyDescription: string;
}

function Owners({ row }: { row: ConnectionRow }) {
  return (
    <div className="space-y-300">
      {row.ownerStatus === 'pending' && (
        <p className="inline-flex items-center gap-200 text-muted-foreground">
          <span className="inventory-status-dot" aria-hidden="true" />
          Not yet resolved
        </p>
      )}
      {row.ownerStatus === 'error' && (
        <p className="font-medium text-destructive">Owner lookup failed</p>
      )}
      {row.ownerStatus === 'loaded' && row.owners.length === 0 && (
        <p className="text-muted-foreground">No owners returned</p>
      )}
      {row.owners.length > 0 && (
        <ul className="space-y-300" aria-label="Connection owners">
          {row.owners.map((owner) => (
            <li key={`${owner.type}:${owner.id}:${owner.role}`} className="space-y-100">
              <div className="flex flex-wrap items-center gap-200">
                <span className={owner.displayName || owner.userPrincipalName ? 'font-medium' : 'font-monospace text-200'}>
                  {owner.displayName || owner.userPrincipalName || owner.id}
                </span>
                {owner.role === 'PendingOwner' && (
                  <span className="inventory-badge inventory-badge-accent">Pending owner</span>
                )}
              </div>
              <div className="text-200 text-muted-foreground">
                {owner.type || 'Principal type not provided'}
                {(owner.displayName || owner.userPrincipalName) && (
                  <span className="block font-monospace">{owner.id}</span>
                )}
                {owner.displayName && owner.userPrincipalName && (
                  <span className="block">{owner.userPrincipalName}</span>
                )}
                {owner.displayName && !owner.userPrincipalName && owner.mail && (
                  <span className="block">{owner.mail}</span>
                )}
                {owner.directoryStatus === 'notFound' && (
                  <span className="block">Not found in Microsoft Entra ID</span>
                )}
                {owner.directoryStatus === 'denied' && (
                  <span className="block">Name not readable with this app’s permissions</span>
                )}
                {owner.directoryStatus === 'failed' && <span className="block">Name lookup failed</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const itemCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function DependentWorkloads({ row, usage }: { row: ConnectionRow; usage: UsageView }) {
  const { snapshot } = usage;
  const items = [...(snapshot.itemsByConnection.get(row.id.toLowerCase()) ?? [])].sort((a: DependentItem, b: DependentItem) =>
    itemCollator.compare(a.type, b.type) || itemCollator.compare(a.name, b.name));
  const finished = !usage.loading && !usage.cancelled && snapshot.phase === 'done';
  const scanned = snapshot.scannedWorkspaces.toLocaleString();
  let status: string | undefined;
  if (usage.loading) {
    status = snapshot.phase === 'workspaces' ? 'Listing workspaces to scan…' :
      `Scanning workspaces: ${scanned} of ${snapshot.workspaceCount.toLocaleString()} scanned. More dependent workloads may appear.`;
  } else if (usage.cancelled) {
    status = 'The workspace scan was cancelled, so this list may be incomplete.';
  } else if (snapshot.phase === 'error') {
    status = `Dependent workloads could not be determined. ${snapshot.error?.message ?? 'The workspace scan did not complete.'}`;
  } else if (snapshot.failedWorkspaces > 0) {
    status = `${snapshot.failedWorkspaces.toLocaleString()} of ${snapshot.workspaceCount.toLocaleString()} workspaces could not be scanned, so this list may be incomplete.`;
  }

  return (
    <div className="space-y-300 border-t pt-400">
      <h4 className="font-semibold">
        Dependent workloads{items.length > 0 && <span className="font-regular text-muted-foreground"> ({items.length.toLocaleString()})</span>}
      </h4>
      {items.length > 0 ? (
        <ul className="space-y-200" aria-label="Dependent workloads">
          {items.map((item) => (
            <li key={`${item.workspaceId}:${item.type}:${item.id || item.name}`} className="flex flex-wrap items-center gap-200">
              <span className="inventory-badge">{item.type}</span>
              <span className="font-medium">{item.name}</span>
              <span className="text-200 text-muted-foreground">
                in {item.workspaceName ?? item.workspaceId}{item.workspaceState && ` (workspace ${item.workspaceState})`}
              </span>
              {item.misconfigured && <span className="inventory-badge inventory-badge-accent">Misconfigured binding</span>}
            </li>
          ))}
        </ul>
      ) : finished && (
        <p>
          {snapshot.failedWorkspaces > 0 ?
            `Not used by any workload in the ${scanned} workspaces that were scanned.` :
            `Not used by any workload. No item in the ${scanned} scanned workspaces is bound to this connection.`}
        </p>
      )}
      {status && <p className="text-200 text-muted-foreground">{status}</p>}
      <p className="text-200 text-muted-foreground">
        Based on the Fabric admin workspace scanner, which reports the connections that items such as semantic models,
        dataflows, data pipelines, Copy jobs and lakehouses are bound to. Connections referenced only from code, such as
        in notebooks, are not detected.
      </p>
    </div>
  );
}

function ConnectionDetails({ row, usage }: { row: ConnectionRow; usage: UsageView }) {
  const details = [
    ['Connectivity', row.connectivityType],
    ['Gateway ID', row.gatewayId],
    ['Privacy level', row.privacyLevel],
    ['Authentication type', row.credentialType && credentialTypeLabel(row.credentialType)],
    ['Created', formatTimestamp(row.createdDateTime)],
    ['Credentials last used', formatTimestamp(row.lastCredentialUsedDateTime)],
  ];

  return (
    <div className="space-y-400 p-500">
      <h3 className="font-semibold">Connection details</h3>
      <dl className="grid gap-400 sm:grid-cols-2 xl:grid-cols-3">
        {details.map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="text-200 text-muted-foreground">{label}</dt>
            <dd className="mt-100 break-words">{value || 'Not provided'}</dd>
          </div>
        ))}
      </dl>
      {row.ownerStatus === 'error' && (
        <div className="space-y-100 border-t pt-400">
          <p className="font-medium text-destructive">
            {row.ownerError?.message || 'Owners could not be retrieved for this connection.'}
          </p>
          {row.ownerError?.code && <p className="text-200">Error code: {row.ownerError.code}</p>}
          {row.ownerError?.status && <p className="text-200">HTTP status: {row.ownerError.status}</p>}
          {row.ownerError?.requestId && (
            <p className="break-all font-monospace text-200">
              Request ID: {row.ownerError.requestId}
            </p>
          )}
          <p className="text-200 text-muted-foreground">
            Retry owner lookups from the status panel above; connections do not need to be reloaded.
          </p>
        </div>
      )}
      <DependentWorkloads row={row} usage={usage} />
    </div>
  );
}

export function ConnectionTable({
  rows, sort, onSort, loading, usage, emptyTitle, emptyDescription,
}: ConnectionTableProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const tableId = useId();
  const columns: { key: SortColumn; label: string }[] = [
    { key: 'displayName', label: 'Connection' },
    { key: 'owners', label: 'Owners' },
    { key: 'connectorType', label: 'Connector type' },
    { key: 'endpoint', label: 'Endpoint / path' },
  ];

  function toggleDetails(id: string) {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="inventory-table-scroll" role="region" aria-label="Connections table" tabIndex={0}>
      <table className="inventory-table" aria-busy={loading}>
        <caption className="sr-only">
          Tenant connections and owner lookup results. Sort using the column headings; expand a connection for details.
        </caption>
        <thead>
          <tr>
            <th scope="col" className="inventory-expand-column"><span className="sr-only">Details</span></th>
            {columns.map(({ key, label }) => (
              <th
                scope="col"
                key={key}
                aria-sort={sort.column === key ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
              >
                <button className="inventory-sort" onClick={() => onSort(key)}>
                  {label}
                  {sort.column !== key ? <ArrowUpDown aria-hidden="true" className="icon-size-100" /> :
                    sort.direction === 'asc' ? <ArrowUp aria-hidden="true" className="icon-size-100" /> :
                      <ArrowDown aria-hidden="true" className="icon-size-100" />}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const isExpanded = expanded.has(row.id);
            const detailId = `${tableId}-${row.id}`;
            return (
              <Fragment key={row.id}>
                <tr className="inventory-data-row">
                  <td className="inventory-expand-column">
                    <button
                      className="inventory-icon-button"
                      aria-label={`${isExpanded ? 'Hide' : 'Show'} details for ${row.displayName || row.id}`}
                      aria-expanded={isExpanded}
                      aria-controls={isExpanded ? detailId : undefined}
                      onClick={() => toggleDetails(row.id)}
                    >
                      {isExpanded ? <ChevronDown aria-hidden="true" className="icon-size-200" /> :
                        <ChevronRight aria-hidden="true" className="icon-size-200" />}
                    </button>
                  </td>
                  <th scope="row">
                    <p className="font-semibold">{row.displayName || '(unnamed connection)'}</p>
                    <p className="mt-100 font-monospace text-200 font-regular text-muted-foreground">{row.id}</p>
                  </th>
                  <td><Owners row={row} /></td>
                  <td>
                    <span className="inventory-badge">{row.connectorType || 'Not returned'}</span>
                    <p className="mt-200 text-200 text-muted-foreground">Auth: {credentialTypeLabel(row.credentialType)}</p>
                  </td>
                  <td className="font-monospace text-200">{row.endpoint || 'Not returned'}</td>
                </tr>
                {isExpanded && (
                  <tr id={detailId} className="inventory-detail-row">
                    <td colSpan={5}><ConnectionDetails row={row} usage={usage} /></td>
                  </tr>
                )}
              </Fragment>
            );
          })}
          {rows.length === 0 && (
            <tr>
              <td colSpan={5}>
                <div className="inventory-empty">
                  <p className="text-400 font-semibold">{emptyTitle}</p>
                  <p className="mt-200 text-muted-foreground">{emptyDescription}</p>
                </div>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
