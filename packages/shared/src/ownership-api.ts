import type { ConnectionOwner } from './index.js';
import { InventoryError, PacedApiClient, UUID, owner, readErrorBody } from './fabric-api.js';

const ADMIN_CONNECTIONS_ROOT = 'https://api.fabric.microsoft.com/v1/admin/connections';
const EMPTY_GUID = '00000000-0000-0000-0000-000000000000';
/** Fabric error codes are identifiers, such as UnsupportedPrincipalType; other values are not shown. */
const FABRIC_ERROR_CODE = /^[A-Za-z][A-Za-z0-9_.]{0,99}$/;

/** The delegated Power BI Service permission that lets a Fabric administrator use the admin APIs read-only. */
export const ADMIN_READ_PERMISSION = 'Tenant.Read.All';
/**
 * The delegated Power BI Service permission that lets a Fabric administrator add connection owners. Every admin
 * API the app reads also accepts it, so it replaces Tenant.Read.All rather than adding to it.
 */
export const CONNECTION_OWNER_PERMISSION = 'Tenant.ReadWrite.All';

export type TenantPermission = typeof ADMIN_READ_PERMISSION | typeof CONNECTION_OWNER_PERMISSION;
const TENANT_PERMISSIONS: readonly TenantPermission[] = [CONNECTION_OWNER_PERMISSION, ADMIN_READ_PERMISSION];

/** A delegated token that can add connection owners, and the account it was issued to. */
export interface TenantWriteAccess {
  token: string;
  /** Lower-case Microsoft Entra object ID of the signed-in account. */
  principalId: string;
}

function claims(token: string): Record<string, unknown> {
  let value: unknown;
  try {
    const encoded = (token.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/');
    const decoded = atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '='));
    value = JSON.parse(new TextDecoder().decode(Uint8Array.from(decoded, (character) => character.charCodeAt(0))));
  } catch {
    throw new InventoryError({ code: 'InvalidResourceToken', message: 'The Fabric resource token could not be inspected for the configured tenant guard.' });
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** The Fabric admin permissions in a token's scp claim, Tenant.ReadWrite.All first. The token isn't validated. */
export function tenantPermissions(token: string): TenantPermission[] {
  const { scp } = claims(token);
  const scopes = typeof scp === 'string' ? scp.split(/\s+/) : [];
  return TENANT_PERMISSIONS.filter((permission) => scopes.includes(permission));
}

/**
 * Requires a delegated Fabric token from the expected tenant that grants Tenant.ReadWrite.All, and
 * returns the object ID of the account it was issued to. Fabric validates the token; this only prevents
 * wrong-tenant, application-only or read-only requests, and identifies the account to add as owner.
 */
export function requireTenantWriteToken(token: string, expectedTenantId: string): TenantWriteAccess {
  if (typeof expectedTenantId !== 'string' || !UUID.test(expectedTenantId) || expectedTenantId === EMPTY_GUID) {
    throw new InventoryError({
      code: 'InvalidTenantConfiguration',
      message: 'A valid, non-zero expected tenant GUID is required before requesting a Fabric resource token.',
    });
  }
  const metadata = claims(token);
  if (typeof metadata.tid !== 'string' || metadata.tid.toLowerCase() !== expectedTenantId.toLowerCase()) {
    throw new InventoryError({ code: 'WrongTenant', message: 'This app is restricted to its configured tenant. Connect a tenant administrator account in that directory.' });
  }
  if (typeof metadata.scp !== 'string') {
    throw new InventoryError({ code: 'DelegatedTokenRequired', message: 'This app requires a delegated administrator sign-in, not an application-only token.' });
  }
  if (!metadata.scp.split(/\s+/).includes(CONNECTION_OWNER_PERMISSION)) {
    throw new InventoryError({
      code: 'WriteScopeMissing',
      message: `The Fabric access token does not grant ${CONNECTION_OWNER_PERMISSION}, which Take over needs.`,
    });
  }
  if (typeof metadata.oid !== 'string' || !UUID.test(metadata.oid)) {
    throw new InventoryError({
      code: 'AccountIdUnavailable',
      message: 'The Fabric access token does not identify the signed-in account, so it cannot be added as an owner.',
    });
  }
  return { token, principalId: metadata.oid.toLowerCase() };
}

/** Adds connection owners through the Fabric admin API. It only adds role assignments; it never changes or removes them. */
export class ConnectionOwnership extends PacedApiClient {
  protected override readonly serviceName = 'Fabric';
  protected override readonly errorPrefix = 'FabricHttp';

  protected override failureMessage(status: number): string {
    return status === 403 ?
      `Fabric denied the change. Your signed-in account must be a Fabric administrator, and this app needs delegated ${CONNECTION_OWNER_PERMISSION} consent.` :
      status === 401 ? 'Fabric rejected the access token. Connect the admin account again, then retry.' :
      status === 404 ? 'The connection was not found. It may have been deleted; refresh the inventory.' :
      status === 409 ? 'Fabric reported a conflict. Your account may already have a role on this connection.' :
      status === 400 ? 'Fabric did not accept the request.' :
      status === 503 ? 'Fabric remained unavailable after bounded retries.' :
      `Fabric returned HTTP ${status}. Retry or use the request ID to investigate.`;
  }

  /** Reports Fabric's error code, such as UnsupportedPrincipalType, when the error response has one. */
  protected override async failure(response: Response, requestId: string | undefined): Promise<InventoryError> {
    const body = await readErrorBody(response);
    const errorCode = typeof body.errorCode === 'string' && FABRIC_ERROR_CODE.test(body.errorCode) ? body.errorCode : undefined;
    // Browsers can't read Fabric's request ID header unless CORS exposes it, but the error body is readable.
    const bodyRequestId = typeof body.requestId === 'string' && UUID.test(body.requestId) ? body.requestId : undefined;
    return new InventoryError({
      code: errorCode ?? `${this.errorPrefix}${response.status}`,
      message: this.failureMessage(response.status),
      status: response.status,
      requestId: requestId ?? bodyRequestId,
    });
  }

  /**
   * Adds one user as an owner of a connection, keeping every existing role assignment. Fabric records
   * an owner added this way as PendingOwner until that user updates the connection's credentials.
   * Returns the new assignment, or undefined when Fabric confirmed it without readable details.
   */
  async addUserOwner(connectionId: string, userId: string): Promise<ConnectionOwner | undefined> {
    if (typeof connectionId !== 'string' || !UUID.test(connectionId) || typeof userId !== 'string' || !UUID.test(userId)) {
      throw new InventoryError({ code: 'InvalidInput', message: 'Supply a connection UUID and the object ID of a user.' });
    }
    const body = await this.send(new URL(`${ADMIN_CONNECTIONS_ROOT}/${connectionId}/roleAssignments`), 'POST', {
      principal: { id: userId, type: 'User' },
      role: 'Owner',
    });
    try {
      const created = body === undefined ? null : owner(body);
      return created?.id.toLowerCase() === userId.toLowerCase() ? created : undefined;
    } catch {
      // Fabric accepted the request; an unexpected body only means its details aren't known.
      return undefined;
    }
  }
}
