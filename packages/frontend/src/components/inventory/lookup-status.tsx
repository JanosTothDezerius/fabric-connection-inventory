import { AlertCircle, CheckCircle2, Hourglass, LoaderCircle, TriangleAlert } from 'lucide-react';
import { DIRECTORY_KINDS, DIRECTORY_READ_PERMISSIONS, type DirectoryKind } from '@rayfin-app/shared';

import type { DirectoryAccess } from '@/services/principal-names';
import type { UsageView } from './connection-table';

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
const KIND_DETAILS: Record<DirectoryKind, { one: string; many: string; purpose: string }> = {
  user: {
    one: 'user',
    many: 'users',
    purpose: 'Reads the display name, user principal name and email address of users that own connections.',
  },
  group: {
    one: 'security group',
    many: 'security groups',
    purpose: 'Reads the display name and email address of security groups that own connections.',
  },
  servicePrincipal: {
    one: 'service principal',
    many: 'service principals',
    purpose: 'Reads the display name and application ID of service principals, such as app registrations, managed identities and workspace identities, that own connections.',
  },
};

function joined(items: string[]): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

function owners(kind: DirectoryKind, count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? KIND_DETAILS[kind].one : KIND_DETAILS[kind].many}`;
}

/**
 * Lists, for each kind of owner that shows only IDs, the missing Microsoft Graph permission and its
 * purpose, or why the name lookup failed. Kinds with access keep showing their names.
 */
export function OwnerNameStatus({ access, unnamed, onRetry }: {
  access: Readonly<Partial<Record<DirectoryKind, DirectoryAccess>>>;
  /** Distinct owners of each kind that show only their ID. */
  unnamed: Readonly<Record<DirectoryKind, number>>;
  onRetry: () => void;
}) {
  const missing = DIRECTORY_KINDS.filter((kind) => access[kind]?.status === 'notGranted' && unnamed[kind] > 0);
  const failed = DIRECTORY_KINDS.filter((kind) => access[kind]?.status === 'failed' && unnamed[kind] > 0);
  if (missing.length === 0 && failed.length === 0) return null;
  const shown = DIRECTORY_KINDS.filter((kind) => access[kind]?.status === 'granted');
  const total = [...missing, ...failed].reduce((sum, kind) => sum + unnamed[kind], 0);
  return (
    <div className="inventory-notice inventory-warning" role="status">
      <TriangleAlert className="icon-size-300 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-300">
        <div className="space-y-100">
          <p className="font-semibold">{shown.length > 0 ? 'Some owner names can’t be shown' : 'Owner names unavailable'}</p>
          <p className="text-muted-foreground">
            {total.toLocaleString()} {total === 1 ? 'owner shows' : 'owners show'} only an ID.
            {shown.length > 0 && ` Names are shown for ${joined(shown.map((kind) => KIND_DETAILS[kind].many))}.`}
          </p>
        </div>
        {missing.length > 0 && (
          <div className="space-y-200">
            <p>
              {missing.length === 1 ?
                'This delegated Microsoft Graph permission is missing from the app registration or has no admin consent yet:' :
                'These delegated Microsoft Graph permissions are missing from the app registration or have no admin consent yet:'}
            </p>
            <ul className="space-y-200" aria-label="Missing Microsoft Graph permissions">
              {missing.map((kind) => {
                const state = access[kind] as Extract<DirectoryAccess, { status: 'notGranted' }>;
                return (
                  <li key={kind} className="inventory-permission">
                    <p className="font-monospace font-semibold">{DIRECTORY_READ_PERMISSIONS[kind][0]}</p>
                    <p className="text-muted-foreground">{KIND_DETAILS[kind].purpose}</p>
                    <p className="text-200 text-muted-foreground">
                      {owners(kind, unnamed[kind])} without a name · Error code: {state.code}
                    </p>
                  </li>
                );
              })}
            </ul>
            <p className="text-200 text-muted-foreground">
              In Microsoft Entra ID, open App registrations, select this app, then API permissions. Add any missing
              permission and have an administrator select Grant admin consent; each permission’s Status must show
              Granted. Then select Retry name lookups.
            </p>
          </div>
        )}
        {failed.length > 0 && (
          <ul className="space-y-200" aria-label="Failed name lookups">
            {failed.map((kind) => {
              const state = access[kind] as Extract<DirectoryAccess, { status: 'failed' }>;
              return (
                <li key={kind} className="inventory-permission">
                  <p className="font-semibold">Names of {owners(kind, unnamed[kind])} couldn’t be looked up</p>
                  <p className="text-muted-foreground">
                    {state.error.message} Select Retry name lookups; if this continues, choose Connect again.
                  </p>
                  <p className="text-200 text-muted-foreground">Error code: {state.error.code}</p>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <button className="inventory-button" onClick={onRetry}>Retry name lookups</button>
    </div>
  );
}
