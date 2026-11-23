import { AlertCircle, CheckCircle2, Hourglass, LoaderCircle, TriangleAlert } from 'lucide-react';
import type { ApiFailure } from '@rayfin-app/shared';

import type { UsageView } from './connection-table';

/** The least-privileged delegated Microsoft Graph permission that reads each owner type's name. */
const GRAPH_PERMISSIONS: Record<string, string> = {
  user: 'User.ReadBasic.All',
  group: 'GroupMember.Read.All',
  serviceprincipal: 'Application.Read.All',
};

export function UsageStatus({ usage, onRetry }: { usage: UsageView; onRetry: () => void }) {
  const { snapshot, loading, cancelled } = usage;
  const total = snapshot.workspaceCount.toLocaleString();
  const scanned = snapshot.scannedWorkspaces.toLocaleString();
  let title: string;
  let description: string;
  let tone: 'progress' | 'paused' | 'warning' | 'error' | 'done';
  if (loading && snapshot.pausedUntil !== undefined) {
    tone = 'paused';
    title = 'Workspace scan paused while Power BI throttles requests';
    description = `${scanned} of ${total} workspaces scanned. The scan continues automatically at ${new Date(snapshot.pausedUntil).toLocaleTimeString()}.`;
  } else if (loading) {
    tone = 'progress';
    title = 'Scanning workspaces for dependent workloads';
    description = snapshot.phase === 'workspaces' ? 'Listing the workspaces to scan…' :
      `${scanned} of ${total} workspaces scanned. Expand a connection to see the workloads found so far.`;
  } else if (cancelled) {
    tone = 'warning';
    title = 'Workspace scan cancelled';
    description = `${scanned} of ${total} workspaces were scanned. Dependent workloads may be incomplete.`;
  } else if (snapshot.phase === 'error') {
    tone = 'error';
    title = 'Dependent workloads could not be determined';
    description = snapshot.error?.message ?? 'The workspace scan did not complete.';
  } else if (snapshot.failedWorkspaces > 0) {
    tone = 'warning';
    title = 'Workspace scan partially complete';
    description = `${snapshot.failedWorkspaces.toLocaleString()} of ${total} workspaces could not be scanned, so dependent workloads may be incomplete. ${snapshot.error?.message ?? ''}`.trim();
  } else {
    tone = 'done';
    title = 'Dependent workloads scanned';
    description = `${total} workspaces scanned. Expand a connection to see the workloads that use it.`;
  }
  const Icon = tone === 'error' ? AlertCircle : tone === 'warning' ? TriangleAlert : tone === 'paused' ? Hourglass :
    tone === 'progress' ? LoaderCircle : CheckCircle2;

  return (
    <div
      className={`inventory-notice${tone === 'warning' ? ' inventory-warning' : ''}`}
      data-error={tone === 'error' || undefined}
      role="status"
      aria-atomic="true"
    >
      <Icon aria-hidden="true" className={`icon-size-300 shrink-0 ${tone === 'progress' ? 'motion-safe:animate-spin' : ''}`} />
      <div className="min-w-0 flex-1 space-y-100">
        <p className="font-semibold">{title}</p>
        <p className="text-muted-foreground">{description}</p>
        {tone === 'error' && snapshot.error?.code && <p className="text-200">Error code: {snapshot.error.code}</p>}
      </div>
      {(tone === 'error' || tone === 'warning') && (
        <button className="inventory-button" onClick={onRetry}>Retry workspace scan</button>
      )}
    </div>
  );
}

/** Explains owner names that could not be looked up, and which permissions an administrator can grant. */
export function OwnerNameStatus({ unavailable, types, onRetry }: {
  /** Set when lookups are paused because no Microsoft Graph token is available. */
  unavailable?: ApiFailure;
  /** Principal types whose names are missing because of the problem being reported. */
  types: readonly string[];
  onRetry: () => void;
}) {
  if (!unavailable && types.length === 0) return null;
  const kinds = [...new Set(types.map((type) => type.toLowerCase()))].filter((type) => Object.hasOwn(GRAPH_PERMISSIONS, type));
  const permissions = (kinds.length > 0 ? kinds : ['user', 'group']).map((type) => GRAPH_PERMISSIONS[type]);
  const nouns = kinds.map((type) => type === 'serviceprincipal' ? 'service principal' : type).join(', ');
  return (
    <div className="inventory-notice inventory-warning" role="status">
      <TriangleAlert className="icon-size-300 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-100">
        <p className="font-semibold">{unavailable ? 'Owner names unavailable' : 'Some owner names can’t be read'}</p>
        <p className="text-muted-foreground">
          {unavailable ? unavailable.message : `This app’s Microsoft Graph permissions don’t allow reading ${nouns} names.`}
          {' '}Owner IDs are still shown. To show names, an administrator can grant the app registration the delegated
          Microsoft Graph {permissions.length > 1 ? 'permissions' : 'permission'}{' '}
          <span className="font-monospace">{permissions.join(', ')}</span> with admin consent, then retry.
        </p>
        {unavailable?.code && <p className="text-200">Error code: {unavailable.code}</p>}
      </div>
      <button className="inventory-button" onClick={onRetry}>Retry name lookups</button>
    </div>
  );
}
