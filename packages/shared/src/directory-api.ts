import type { ApiFailure } from './index.js';
import {
  InventoryError, PacedApiClient, UUID, child, invalidResponse, object, retryAfterMs,
} from './fabric-api.js';

const GRAPH_BATCH_URL = 'https://graph.microsoft.com/v1.0/$batch';
/** Microsoft Graph accepts at most 20 requests in one JSON batch. */
export const MAX_DIRECTORY_BATCH = 20;
/** Graph normally sends Retry-After with throttling; this is the wait when it does not. */
const DEFAULT_GRAPH_RETRY_MS = 10_000;
const EMPTY_GUID = '00000000-0000-0000-0000-000000000000';

/** The kinds of directory object that can own connections and that Microsoft Graph can look up. */
export type DirectoryKind = 'user' | 'group' | 'servicePrincipal';
export const DIRECTORY_KINDS: readonly DirectoryKind[] = ['user', 'group', 'servicePrincipal'];

/**
 * Delegated Microsoft Graph permissions that can read each kind's basic properties. The first is the
 * least-privileged one the app asks for; the others are broader permissions that also work when an
 * administrator granted one of them instead.
 */
export const DIRECTORY_READ_PERMISSIONS: Readonly<Record<DirectoryKind, readonly string[]>> = {
  user: ['User.ReadBasic.All', 'User.Read.All', 'User.ReadWrite.All', 'Directory.Read.All', 'Directory.ReadWrite.All', 'Directory.AccessAsUser.All'],
  group: [
    'GroupMember.Read.All', 'Group.ReadBasic.All', 'Group.Read.All', 'Group.ReadWrite.All',
    'Directory.Read.All', 'Directory.ReadWrite.All', 'Directory.AccessAsUser.All',
  ],
  servicePrincipal: ['Application.Read.All', 'Application.ReadWrite.All', 'Directory.Read.All', 'Directory.ReadWrite.All', 'Directory.AccessAsUser.All'],
};

// Only basic profile properties are requested, so the least-privileged permission for each kind suffices.
const PRINCIPAL_PATHS: Record<DirectoryKind, string> = {
  user: '/users/{id}?$select=id,displayName,userPrincipalName,mail',
  group: '/groups/{id}?$select=id,displayName,mail',
  servicePrincipal: '/servicePrincipals/{id}?$select=id,displayName,appId',
};

export interface PrincipalReference {
  id: string;
  /** The Fabric principal type, such as User, Group or ServicePrincipal. */
  type: string;
}

export type DirectoryLookupResult =
  | { status: 'resolved'; displayName?: string; userPrincipalName?: string; mail?: string; appId?: string }
  /** The directory has no such object; it may have been deleted. */
  | { status: 'notFound' }
  /** The app's Microsoft Graph permissions do not allow reading this principal. */
  | { status: 'denied' }
  | { status: 'failed'; error: ApiFailure };

export interface PrincipalLookup {
  id: string;
  result: DirectoryLookupResult;
}

/** The directory kind of a Fabric principal type, or undefined when Microsoft Graph can't look it up. */
export function directoryKind(type: unknown): DirectoryKind | undefined {
  if (typeof type !== 'string') return undefined;
  switch (type.toLowerCase()) {
    case 'user': return 'user';
    case 'group': return 'group';
    case 'serviceprincipal': return 'servicePrincipal';
    default: return undefined;
  }
}

/** Whether Microsoft Graph can look up a principal of this type; other types are not directory objects. */
export function isDirectoryPrincipal(principal: PrincipalReference): boolean {
  return typeof principal.id === 'string' && UUID.test(principal.id) && directoryKind(principal.type) !== undefined;
}

function claims(token: string): Record<string, unknown> {
  let value: unknown;
  try {
    const encoded = (token.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/');
    const decoded = atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '='));
    value = JSON.parse(new TextDecoder().decode(Uint8Array.from(decoded, (character) => character.charCodeAt(0))));
  } catch {
    throw new InventoryError({ code: 'InvalidResourceToken', message: 'The Microsoft Graph token could not be inspected for the configured tenant guard.' });
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * Requires a delegated Microsoft Graph token issued by the expected tenant. Graph validates the token
 * and its permissions; this only prevents wrong-tenant or application-only requests.
 */
export function requireDirectoryToken(token: string, expectedTenantId: string): string {
  if (typeof expectedTenantId !== 'string' || !UUID.test(expectedTenantId) || expectedTenantId === EMPTY_GUID) {
    throw new InventoryError({
      code: 'InvalidTenantConfiguration',
      message: 'A valid, non-zero expected tenant GUID is required before requesting a Microsoft Graph token.',
    });
  }
  const metadata = claims(token);
  if (typeof metadata.tid !== 'string' || metadata.tid.toLowerCase() !== expectedTenantId.toLowerCase()) {
    throw new InventoryError({ code: 'WrongTenant', message: 'This app is restricted to its configured tenant. Connect a tenant administrator account in that directory.' });
  }
  if (typeof metadata.scp !== 'string') {
    throw new InventoryError({ code: 'DelegatedTokenRequired', message: 'This app requires a delegated administrator sign-in, not an application-only token.' });
  }
  return token;
}

/** The delegated permissions a Microsoft Graph token grants (its scp claim), such as User.ReadBasic.All. */
export function directoryTokenScopes(token: string): string[] {
  const scopes = claims(token).scp;
  return typeof scopes === 'string' ? scopes.split(/\s+/).filter(Boolean) : [];
}

function optional(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.slice(0, 1_024) : undefined;
}

function header(headers: Record<string, unknown>, name: string): string | undefined {
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  const value = key === undefined ? undefined : headers[key];
  return typeof value === 'string' ? value : undefined;
}

/** Read-only Microsoft Graph lookups of the users, groups and service principals that own connections. */
export class DirectoryLookup extends PacedApiClient {
  protected override readonly serviceName = 'Microsoft Graph';
  protected override readonly errorPrefix = 'GraphHttp';

  protected override failureMessage(status: number): string {
    return status === 401 ? 'Microsoft Graph rejected the access token. Reconnect the admin account and retry.' :
      status === 403 ? 'Microsoft Graph denied the directory lookup. Grant the app delegated Microsoft Graph permissions to read users, groups and service principals.' :
      status === 503 ? 'Microsoft Graph remained unavailable after bounded retries.' :
      `Microsoft Graph returned HTTP ${status}. Retry the name lookup.`;
  }

  /** Looks up to 20 principals in one batch. Results are per principal, in request order. */
  async lookupPrincipals(principals: PrincipalReference[]): Promise<PrincipalLookup[]> {
    if (!Array.isArray(principals) || principals.length < 1 || principals.length > MAX_DIRECTORY_BATCH ||
        !principals.every(isDirectoryPrincipal) ||
        new Set(principals.map((principal) => principal.id.toLowerCase())).size !== principals.length) {
      throw new InventoryError({
        code: 'InvalidInput',
        message: `Supply between one and ${MAX_DIRECTORY_BATCH} unique users, groups or service principals.`,
      });
    }
    const requests = principals.map((principal, index) => ({
      id: String(index),
      method: 'GET',
      url: PRINCIPAL_PATHS[directoryKind(principal.type)!].replace('{id}', principal.id),
    }));
    const body = object(await this.send(new URL(GRAPH_BATCH_URL), 'POST', { requests }));
    if (!Array.isArray(body.responses)) invalidResponse();
    const results = new Map<number, DirectoryLookupResult>();
    for (const value of body.responses) {
      const response = object(value);
      const index = Number(response.id);
      if (!Number.isInteger(index) || index < 0 || index >= principals.length) continue;
      const status = typeof response.status === 'number' ? response.status : 0;
      if (status === 200) {
        const data = child(response.body);
        results.set(index, {
          status: 'resolved',
          displayName: optional(data.displayName),
          userPrincipalName: optional(data.userPrincipalName),
          mail: optional(data.mail),
          appId: optional(data.appId),
        });
      } else if (status === 404) {
        results.set(index, { status: 'notFound' });
      } else if (status === 403) {
        results.set(index, { status: 'denied' });
      } else if (status === 429 || status === 503) {
        const now = this.now();
        const wait = retryAfterMs(header(child(response.headers), 'retry-after'), now) ?? DEFAULT_GRAPH_RETRY_MS;
        results.set(index, {
          status: 'failed',
          error: {
            code: `GraphHttp${status}`, message: 'Microsoft Graph is throttling requests.', status, retryAt: now + wait,
          },
        });
      } else {
        results.set(index, {
          status: 'failed',
          error: { code: `GraphHttp${status || 'Unknown'}`, message: this.failureMessage(status), ...(status ? { status } : {}) },
        });
      }
    }
    return principals.map((principal, index) => ({
      id: principal.id,
      result: results.get(index) ?? {
        status: 'failed',
        error: { code: 'MissingDirectoryResult', message: 'Microsoft Graph did not return a result for this principal.' },
      },
    }));
  }
}
