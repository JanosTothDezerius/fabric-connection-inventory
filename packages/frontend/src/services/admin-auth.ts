import {
  AuthError, BrowserCacheLocation, InteractionRequiredAuthError, PublicClientApplication,
  type AccountInfo, type AuthenticationResult,
} from '@azure/msal-browser';
import {
  CONNECTION_OWNER_PERMISSION, DIRECTORY_READ_PERMISSIONS, InventoryError, directoryTokenScopes, requireDirectoryToken,
  requireTenantAdminToken, requireTenantWriteToken,
  type DirectoryKind, type TenantWriteAccess,
} from '@rayfin-app/shared';
import { AdminConfigError, readAdminConfig, type AdminConfig } from './admin-config';

export interface AdminSession {
  username: string;
  tenantId: string;
  /** Lower-case Microsoft Entra object ID of the signed-in account, when its ID token provides one. */
  principalId?: string;
}

export class AdminAuthError extends Error {
  /** `detail` is a safe diagnostic code, such as the Microsoft Entra error AADSTS65001. */
  constructor(readonly code: string, message: string, readonly detail?: string) {
    super(message);
    this.name = 'AdminAuthError';
  }
}

export const ADMIN_SCOPE = 'https://api.fabric.microsoft.com/Tenant.Read.All';
/** Lets a Fabric administrator add connection owners. Requested only when Take over is used, never at sign-in. */
export const ADMIN_WRITE_SCOPE = `https://api.fabric.microsoft.com/${CONNECTION_OWNER_PERMISSION}`;
/** The same consented Tenant.Read.All permission, with the audience of the Power BI admin scanner API. */
export const POWER_BI_ADMIN_SCOPE = 'https://analysis.windows.net/powerbi/api/Tenant.Read.All';
const GRAPH_RESOURCE = 'https://graph.microsoft.com';
/** Every delegated Microsoft Graph permission granted to this app; used when a kind's own permission isn't granted. */
export const DIRECTORY_SCOPE = `${GRAPH_RESOURCE}/.default`;

/** The least-privileged delegated Microsoft Graph permission that reads names of this kind of principal. */
export function directoryScope(kind: DirectoryKind): string {
  return `${GRAPH_RESOURCE}/${DIRECTORY_READ_PERMISSIONS[kind][0]}`;
}
let client: Promise<PublicClientApplication> | undefined;
let account: AccountInfo | null = null;
let generation = 0;

function getClient(config: AdminConfig): Promise<PublicClientApplication> {
  if (window.location.origin !== config.hostedOrigin) {
    throw new AdminAuthError('UnregisteredOrigin', 'Admin sign-in is available only at the configured origin. Open the configured inventory to connect.');
  }
  client ??= (async () => {
    const instance = new PublicClientApplication({
      auth: {
        clientId: config.clientId,
        authority: `https://login.microsoftonline.com/${config.tenantId}`,
        redirectUri: `${config.hostedOrigin}/admin-auth.html`,
        ...(window.top !== window.self ? { popupRelayUri: `${config.hostedOrigin}/admin-auth-relay.html` } : {}),
      },
      cache: { cacheLocation: BrowserCacheLocation.MemoryStorage },
      system: {
        popupBridgeTimeout: 300_000,
        loggerOptions: { piiLoggingEnabled: false, loggerCallback: () => undefined },
      },
    });
    await instance.initialize();
    return instance;
  })().catch((error: unknown) => {
    client = undefined;
    throw error;
  });
  return client;
}

function validateResult(result: AuthenticationResult, config: AdminConfig): AccountInfo {
  if (!result.account || result.account.tenantId.toLowerCase() !== config.tenantId) {
    throw new AdminAuthError('WrongTenant', 'Connect an administrator account in the configured tenant.');
  }
  requireTenantAdminToken(() => result.accessToken, config.tenantId);
  return result.account;
}

function authFailure(error: unknown): AdminAuthError {
  if (error instanceof AdminAuthError) return error;
  if (error instanceof AdminConfigError) return new AdminAuthError(error.code, error.message);
  if (error instanceof InventoryError) return new AdminAuthError(error.failure.code, error.failure.message);
  if (error instanceof InteractionRequiredAuthError) {
    return new AdminAuthError('AdminSignInRequired', 'Your admin session needs attention. Reconnect the admin account to continue.');
  }
  const code = error instanceof AuthError && /^[a-z0-9_]+$/i.test(error.errorCode) ? error.errorCode : 'SignInFailed';
  return new AdminAuthError(code, code === 'user_cancelled' ?
    'Admin sign-in was cancelled. No inventory request was made.' :
    `Microsoft admin sign-in failed (${code}). Allow popups, verify consent, and reconnect.`);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The account's object ID in the configured tenant, from its ID token. */
function accountObjectId(value: AccountInfo): string | undefined {
  const id = value.idTokenClaims?.oid ?? value.localAccountId;
  return typeof id === 'string' && UUID.test(id) ? id.toLowerCase() : undefined;
}

function session(value: AccountInfo): AdminSession {
  return { username: value.username, tenantId: value.tenantId, principalId: accountObjectId(value) };
}

export function getAdminSession(): AdminSession | null {
  try {
    const config = readAdminConfig();
    return account?.tenantId.toLowerCase() === config.tenantId ? session(account) : null;
  } catch {
    return null;
  }
}

export async function signInAdmin(): Promise<AdminSession> {
  const currentGeneration = generation;
  try {
    const config = readAdminConfig();
    const instance = await getClient(config);
    const result = await instance.loginPopup({
      scopes: [ADMIN_SCOPE], prompt: 'select_account',
    });
    if (generation !== currentGeneration) {
      await instance.clearCache();
      throw new AdminAuthError('SignInCancelled', 'This sign-in was superseded. Connect again when ready.');
    }
    account = validateResult(result, config);
    instance.setActiveAccount(account);
    return session(account);
  } catch (error) {
    throw authFailure(error);
  }
}

export async function getAdminAccessToken(): Promise<string> {
  try {
    const config = readAdminConfig();
    if (!account) throw new AdminAuthError('AdminSignInRequired', 'Connect an admin account in the configured tenant before loading the inventory.');
    const currentGeneration = generation;
    const instance = await getClient(config);
    const result = await instance.acquireTokenSilent({ account, scopes: [ADMIN_SCOPE] });
    if (generation !== currentGeneration) throw new AdminAuthError('AdminSignInRequired', 'The admin account was disconnected.');
    validateResult(result, config);
    return result.accessToken;
  } catch (error) {
    throw authFailure(error);
  }
}

async function acquireSilently(scope: string, forceRefresh: boolean): Promise<{ result: AuthenticationResult; config: AdminConfig }> {
  const config = readAdminConfig();
  if (!account) throw new AdminAuthError('AdminSignInRequired', 'Connect an admin account in the configured tenant before loading the inventory.');
  const currentGeneration = generation;
  const instance = await getClient(config);
  const result = await instance.acquireTokenSilent({ account, scopes: [scope], ...(forceRefresh ? { forceRefresh } : {}) });
  if (generation !== currentGeneration) throw new AdminAuthError('AdminSignInRequired', 'The admin account was disconnected.');
  return { result, config };
}

/** A token for the Power BI admin scanner API, which uses the same consented Tenant.Read.All permission. */
export async function getPowerBiAdminAccessToken(): Promise<string> {
  try {
    const { result, config } = await acquireSilently(POWER_BI_ADMIN_SCOPE, false);
    validateResult(result, config);
    return result.accessToken;
  } catch (error) {
    throw authFailure(error);
  }
}

const KIND_NAMES: Record<DirectoryKind, string> = { user: 'user', group: 'group', servicePrincipal: 'service principal' };
/** Microsoft Entra errors meaning a permission has no consent: not consented, consent declined, admin consent required. */
const CONSENT_ERRORS = new Set(['65001', '65004', '90094']);

/** The Microsoft Entra error number, such as 65001 for AADSTS65001, when the server returned one. */
function entraErrorNumber(error: AuthError): string | undefined {
  const errorNo: unknown = (error as AuthError & { errorNo?: unknown }).errorNo;
  if ((typeof errorNo === 'string' && /^\d+$/.test(errorNo)) || (typeof errorNo === 'number' && Number.isInteger(errorNo))) {
    return String(errorNo);
  }
  return /AADSTS(\d+)/.exec(error.errorMessage ?? '')?.[1];
}

function consentMissing(error: unknown): boolean {
  if (!(error instanceof AuthError)) return false;
  const number = entraErrorNumber(error);
  return (number !== undefined && CONSENT_ERRORS.has(number)) ||
    error.subError === 'consent_required' || error.errorCode === 'consent_required';
}

/** A diagnostic code that is safe to show: the AADSTS error, else the MSAL error code. */
function errorCodeOf(error: unknown): string {
  if (!(error instanceof AuthError)) return 'unknown_error';
  const number = entraErrorNumber(error);
  if (number) return `AADSTS${number}`;
  return /^[a-z0-9_]+$/i.test(error.errorCode) ? error.errorCode : 'unknown_error';
}

function directoryFailure(error: unknown, kind: DirectoryKind): AdminAuthError {
  if (error instanceof AdminAuthError || error instanceof AdminConfigError || error instanceof InventoryError) {
    return authFailure(error);
  }
  const code = errorCodeOf(error);
  return new AdminAuthError('DirectoryAccessUnavailable',
    `Microsoft Graph did not issue a token for ${KIND_NAMES[kind]} names (${code}).`, code);
}

async function directoryToken(scope: string, forceRefresh: boolean): Promise<string> {
  const { result, config } = await acquireSilently(scope, forceRefresh);
  if (!result.account || result.account.tenantId.toLowerCase() !== config.tenantId) {
    throw new AdminAuthError('WrongTenant', 'Connect an administrator account in the configured tenant.');
  }
  return requireDirectoryToken(result.accessToken, config.tenantId);
}

/**
 * A Microsoft Graph token that can read the names of one kind of principal, so users, groups and
 * service principals are looked up independently. It asks for the kind's least-privileged permission
 * and, when that has no consent, accepts a broader permission an administrator granted instead.
 * It never opens a sign-in window; `forceRefresh` bypasses cached tokens so newly granted permissions apply.
 * Throws AdminAuthError `DirectoryPermissionNotGranted` when no permission that reads this kind has consent.
 */
export async function getDirectoryAccessToken(kind: DirectoryKind, forceRefresh = false): Promise<string> {
  const permissions = DIRECTORY_READ_PERMISSIONS[kind];
  let consentError: unknown;
  try {
    return await directoryToken(directoryScope(kind), forceRefresh);
  } catch (error) {
    if (!consentMissing(error)) throw directoryFailure(error, kind);
    consentError = error;
  }
  try {
    const token = await directoryToken(DIRECTORY_SCOPE, forceRefresh);
    const granted = new Set(directoryTokenScopes(token).map((scope) => scope.toLowerCase()));
    if (permissions.some((permission) => granted.has(permission.toLowerCase()))) return token;
  } catch (error) {
    if (!consentMissing(error)) throw directoryFailure(error, kind);
  }
  const code = errorCodeOf(consentError);
  throw new AdminAuthError('DirectoryPermissionNotGranted',
    `The delegated Microsoft Graph permission ${permissions[0]} has not been granted to this app with consent (${code}).`, code);
}

/**
 * A token that lets the signed-in Fabric administrator add themselves as a connection owner, with the
 * account's object ID. It is requested only when a take over starts, silently, and never opens a sign-in
 * window. Throws AdminAuthError `TakeOverPermissionNotGranted` when Tenant.ReadWrite.All has no consent.
 */
export async function getConnectionWriteAccess(): Promise<TenantWriteAccess> {
  try {
    const { result, config } = await acquireSilently(ADMIN_WRITE_SCOPE, false);
    if (!result.account || result.account.tenantId.toLowerCase() !== config.tenantId) {
      throw new AdminAuthError('WrongTenant', 'Connect an administrator account in the configured tenant.');
    }
    const access = requireTenantWriteToken(result.accessToken, config.tenantId);
    // Only the account signed in to this app may become an owner.
    const signedIn = account ? accountObjectId(account) : undefined;
    if (signedIn && signedIn !== access.principalId) {
      throw new AdminAuthError('WrongAccount', 'The access token belongs to a different account than the one signed in. Choose Connect again.');
    }
    return access;
  } catch (error) {
    if (error instanceof AdminAuthError || error instanceof AdminConfigError || error instanceof InventoryError) {
      throw authFailure(error);
    }
    const code = errorCodeOf(error);
    if (consentMissing(error)) {
      throw new AdminAuthError('TakeOverPermissionNotGranted',
        `The delegated Power BI Service permission ${CONNECTION_OWNER_PERMISSION} has not been granted to this app with admin consent (${code}).`, code);
    }
    throw new AdminAuthError('TakeOverTokenUnavailable',
      `Microsoft Entra ID did not issue a token for Take over (${code}). Retry; if this continues, choose Connect again.`, code);
  }
}

export async function disconnectAdmin(): Promise<void> {
  generation++;
  account = null;
  if (client) {
    const instance = await client;
    instance.setActiveAccount(null);
    await instance.clearCache();
  }
}
