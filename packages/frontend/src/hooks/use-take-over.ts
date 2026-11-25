import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiFailure, ConnectionOwner, ConnectionRow } from '@rayfin-app/shared';

import type { OwnerChange } from '@/hooks/use-inventory';
import type { NewNotification } from '@/hooks/use-notifications';
import { TakeOverError, takeOverConnection } from '@/services/connection-takeover';

function succeeded(name: string, own: ConnectionOwner | undefined, refreshError: ApiFailure | undefined): NewNotification {
  const message = own?.role === 'Owner' ? `You’re now an owner of ${name}. Existing owners were kept.` :
    own?.role === 'PendingOwner' ?
      `You were added as a pending owner of ${name}. Existing owners were kept. To make your ownership effective, update the connection’s credentials in Manage connections and gateways.` :
      `Fabric accepted adding you as an owner of ${name}. Existing owners were kept.`;
  return {
    tone: 'success',
    title: 'Connection taken over',
    message,
    ...(refreshError ? {
      details: [`The owner list couldn’t be refreshed (${refreshError.code}). Refresh the inventory to see every owner.`],
    } : {}),
  };
}

function failed(name: string, error: unknown): NewNotification {
  const failure: ApiFailure = error instanceof TakeOverError ? error.failure : {
    code: 'TakeOverFailed',
    message: 'The take over failed unexpectedly. Refresh the inventory to check whether you were added before trying again.',
  };
  return {
    tone: 'error',
    title: 'Take over failed',
    message: `${name}: ${failure.message}`,
    details: [
      `Error code: ${failure.code}`,
      ...(failure.status ? [`HTTP status: ${failure.status}`] : []),
      ...(failure.requestId ? [`Request ID: ${failure.requestId}`] : []),
    ],
  };
}

/**
 * Adds the signed-in account as an owner of a connection, shows the outcome as a notification, and
 * updates only that connection's owners.
 */
export function useTakeOver(
  updateOwners: (connectionId: string, change: OwnerChange) => void,
  notify: (notification: NewNotification) => void,
) {
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  // Tracked synchronously, so a repeated click can't send a second request for the same connection.
  const running = useRef(new Set<string>());
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const takeOver = useCallback(async (row: ConnectionRow) => {
    if (running.current.has(row.id)) return;
    running.current.add(row.id);
    setPending(new Set(running.current));
    const name = row.displayName || row.id;
    try {
      const result = await takeOverConnection(row.id);
      if (!mounted.current) return;
      // The signed-in account's role assignment as Fabric last reported it: the owner list read after the change, else the response.
      const own = result.owners?.find((owner) => owner.id.toLowerCase() === result.principalId) ?? result.added;
      if (result.owners || own) updateOwners(row.id, { owners: result.owners, added: own });
      notify(succeeded(name, own, result.refreshError));
    } catch (error) {
      if (mounted.current) notify(failed(name, error));
    } finally {
      running.current.delete(row.id);
      if (mounted.current) setPending(new Set(running.current));
    }
  }, [notify, updateOwners]);

  return { pending, takeOver };
}
