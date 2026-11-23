import { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Hourglass, LoaderCircle, TriangleAlert } from 'lucide-react';
import type { InventorySnapshot } from '@rayfin-app/shared';

import { summarizeInventory } from './inventory-model';

/** Whole seconds until `until`, refreshed every second; undefined before the first tick. */
function useSecondsUntil(until: number | undefined): number | undefined {
  const [now, setNow] = useState<number>();
  useEffect(() => {
    if (until === undefined) return undefined;
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, 1_000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [until]);
  return until === undefined || now === undefined ? undefined : Math.max(0, Math.ceil((until - now) / 1_000));
}

export function InventoryStatus({
  snapshot, loading, cancelled, onRetry, onResume,
}: {
  snapshot: InventorySnapshot;
  loading: boolean;
  cancelled: boolean;
  onRetry: () => void;
  onResume: () => void;
}) {
  const counts = summarizeInventory(snapshot);
  const failed = snapshot.phase === 'error';
  const completed = !loading && snapshot.phase === 'done' && snapshot.inventoryComplete;
  const pausedUntil = loading ? snapshot.pausedUntil : undefined;
  const secondsLeft = useSecondsUntil(pausedUntil);
  // With a complete connection list, unfinished owner lookups continue without reloading connections.
  const canResume = !loading && snapshot.inventoryComplete && counts.pending + counts.failed > 0 &&
    (failed || cancelled || completed);
  let title = 'Discovering connections';
  let description = `${counts.total.toLocaleString()} connections loaded so far. The inventory and counts are partial until all pages have loaded.`;

  if (pausedUntil !== undefined) {
    const resumeTime = `${new Date(pausedUntil).toLocaleTimeString()}${secondsLeft === undefined ? '' : ` (in ${secondsLeft.toLocaleString()} s)`}`;
    title = 'Paused while Fabric throttles requests';
    description = snapshot.inventoryComplete ?
      `${(counts.resolved + counts.failed).toLocaleString()} of ${counts.total.toLocaleString()} owner lookups finished. Owner lookups continue automatically at ${resumeTime}. Completed results are kept.` :
      `${counts.total.toLocaleString()} connections loaded so far. Loading continues automatically at ${resumeTime}.`;
  } else if (loading && snapshot.phase === 'owners') {
    title = 'Resolving connection owners';
    description = `${(counts.resolved + counts.failed).toLocaleString()} of ${counts.total.toLocaleString()} owner lookups finished. Connections are available while remaining owners load.`;
  } else if (cancelled) {
    title = 'Refresh cancelled';
    description = `${snapshot.inventoryComplete ? 'All connection pages were loaded.' : 'The connection inventory is incomplete.'} Any results below are partial; pending owner lookups have not completed in this view. An in-flight server request may still finish. ${canResume ? 'Resume to continue the remaining owner lookups, or refresh to start over.' : 'Refresh to try again.'}`;
  } else if (failed) {
    title = 'Inventory could not be fully loaded';
    description = snapshot.error?.message || 'The request failed. Check access and refresh to try again.';
  } else if (completed) {
    title = counts.failed > 0 || counts.pending > 0 ? 'Connections loaded · owner results incomplete' : 'Inventory refreshed';
    description = `${counts.total.toLocaleString()} connections loaded. ${counts.resolved.toLocaleString()} owner lookups succeeded${counts.noOwners > 0 ? `, including ${counts.noOwners.toLocaleString()} with no owners returned` : ''}.${counts.pending > 0 ? ` ${counts.pending.toLocaleString()} owner lookups have not yet resolved.` : ''}`;
  }

  const StatusIcon = failed ? AlertCircle : cancelled ? TriangleAlert : pausedUntil !== undefined ? Hourglass :
    loading ? LoaderCircle : CheckCircle2;
  const spinning = loading && pausedUntil === undefined;

  return (
    <div className="space-y-300">
      <div className="inventory-notice" data-error={failed || undefined} role={failed ? 'alert' : 'status'} aria-atomic="true">
        <StatusIcon
          aria-hidden="true"
          className={`icon-size-300 shrink-0 ${spinning ? 'motion-safe:animate-spin' : ''}`}
        />
        <div className="min-w-0 flex-1 space-y-100">
          <p className="font-semibold">{title}</p>
          <p className="text-muted-foreground">{description}</p>
          {failed && (
            <>
              <p className="text-200 text-muted-foreground">
                {snapshot.inventoryComplete ? 'Connection pages are complete; owner results may be incomplete. Resuming keeps completed owner results.' :
                  'The connection list is incomplete. Any visible counts and rows cover only the pages that loaded.'}
              </p>
              {snapshot.error?.code && <p className="text-200">Error code: {snapshot.error.code}</p>}
              {snapshot.error?.requestId && (
                <p className="break-all font-monospace text-200">Request ID: {snapshot.error.requestId}</p>
              )}
            </>
          )}
        </div>
        {canResume ? (
          <button className="inventory-button" onClick={onResume}>
            {counts.pending > 0 ? 'Resume owner lookups' : 'Retry failed owner lookups'}
          </button>
        ) : (failed || cancelled) && <button className="inventory-button" onClick={onRetry}>Retry</button>}
      </div>
      {counts.failed > 0 && (
        <div className="inventory-notice inventory-warning" role="status">
          <TriangleAlert className="icon-size-300 shrink-0" aria-hidden="true" />
          <p>
            <strong>Partial owner results.</strong> Owners could not be retrieved for {counts.failed.toLocaleString()}{' '}
            {counts.failed === 1 ? 'connection' : 'connections'}. A failed lookup does not mean there are no owners.
            Expand an affected row for error details; failed lookups can be retried without reloading connections.
          </p>
        </div>
      )}
    </div>
  );
}
