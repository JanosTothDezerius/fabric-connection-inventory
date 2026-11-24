import {
  ConnectionOwnership, FabricInventory, InventoryError,
  type ApiFailure, type ConnectionOwner, type TenantWriteAccess,
} from '@rayfin-app/shared';
import { AdminAuthError, getAdminAccessToken, getConnectionWriteAccess } from '@/services/admin-auth';

export interface TakeOverResult {
  /** Lower-case object ID of the signed-in account that was added as an owner. */
  principalId: string;
  /** The account's new role assignment, when Fabric's response described it. */
  added?: ConnectionOwner;
  /** The connection's owners, looked up again after the change; undefined when that lookup failed. */
  owners?: ConnectionOwner[];
  /** Why the owners couldn't be looked up again. */
  refreshError?: ApiFailure;
}

/** A take over that did not add the owner, or whose outcome is unknown, with a message to show. */
export class TakeOverError extends Error {
  constructor(readonly failure: ApiFailure) {
    super(failure.message);
    this.name = 'TakeOverError';
  }
}

function accessFailure(error: unknown): ApiFailure {
  if (!(error instanceof AdminAuthError)) {
    return { code: 'TakeOverTokenUnavailable', message: 'No access token for Take over could be obtained. Retry; if this continues, choose Connect again.' };
  }
  return error.code === 'TakeOverPermissionNotGranted' ? {
    code: error.detail ?? error.code,
    message: 'This app registration doesn’t have the delegated Power BI Service permission Tenant.ReadWrite.All with admin consent. Add it under API permissions and have an administrator grant admin consent, then try again.',
  } : { code: error.code, message: error.message };
}

function requestFailure(failure: ApiFailure): ApiFailure {
  if (failure.status === 429) {
    return {
      ...failure,
      message: failure.retryAt ? `Fabric is throttling requests. Try again after ${new Date(failure.retryAt).toLocaleTimeString()}.` :
        'Fabric is throttling requests. Try again in a minute.',
    };
  }
  if (failure.code === 'RequestTimeout' || failure.code === 'NetworkError') {
    return {
      ...failure,
      message: 'The request to Fabric didn’t complete, so it isn’t known whether you were added. Refresh the inventory to check before trying again.',
    };
  }
  return failure;
}

/**
 * Adds the signed-in administrator as an owner of one connection, keeping every existing owner, then looks
 * up only that connection's owners again so the change can be shown immediately.
 * Throws TakeOverError when the owner was not added or the outcome is unknown.
 */
export async function takeOverConnection(connectionId: string): Promise<TakeOverResult> {
  let access: TenantWriteAccess;
  try {
    access = await getConnectionWriteAccess();
  } catch (error) {
    throw new TakeOverError(accessFailure(error));
  }
  let added: ConnectionOwner | undefined;
  try {
    added = await new ConnectionOwnership(access.token).addUserOwner(connectionId, access.principalId);
  } catch (error) {
    throw new TakeOverError(error instanceof InventoryError ? requestFailure(error.failure) : {
      code: 'TakeOverFailed',
      message: 'The take over failed unexpectedly. Refresh the inventory to check whether you were added before trying again.',
    });
  }
  const result: TakeOverResult = { principalId: access.principalId, ...(added ? { added } : {}) };
  try {
    const batch = await new FabricInventory(await getAdminAccessToken()).listConnectionOwners([connectionId]);
    const lookup = batch.results[0]?.result;
    if (lookup?.ok) return { ...result, owners: lookup.data };
    return { ...result, refreshError: lookup?.error ?? { code: 'MissingOwnerResult', message: 'Fabric returned no owner result.' } };
  } catch (error) {
    return {
      ...result,
      refreshError: error instanceof AdminAuthError ? { code: error.code, message: error.message } :
        error instanceof InventoryError ? error.failure : { code: 'OwnerRefreshFailed', message: 'The owners could not be looked up again.' },
    };
  }
}
