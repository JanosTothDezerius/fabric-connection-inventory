import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  configureSyntheticAdminEnvironment, syntheticClientId, syntheticHostedOrigin, syntheticTenantId,
} from '@/test/admin-config-fixtures';

const msal = vi.hoisted(() => ({
  configure: vi.fn(),
  initialize: vi.fn(),
  loginPopup: vi.fn(),
  acquireTokenSilent: vi.fn(),
  setActiveAccount: vi.fn(),
  clearCache: vi.fn(),
}));

vi.mock('@azure/msal-browser', () => {
  // Mirrors the MSAL 5 constructor parameters used by the app.
  class AuthError extends Error {
    constructor(readonly errorCode: string, readonly correlationId = '', readonly errorMessage = '', readonly subError = '') {
      super(errorCode);
    }
  }
  class InteractionRequiredAuthError extends AuthError {
    readonly errorNo?: string;
    // MSAL 5 passes timestamp, trace ID and claims before the server error number.
    constructor(errorCode: string, correlationId = '', errorMessage = '', subError = '', ...details: string[]) {
      super(errorCode, correlationId, errorMessage, subError);
      this.errorNo = details[3];
    }
  }
  return {
    AuthError,
    InteractionRequiredAuthError,
    BrowserCacheLocation: { MemoryStorage: 'memoryStorage' },
    PublicClientApplication: class {
      constructor(config: unknown) { msal.configure(config); }
      initialize = msal.initialize;
      loginPopup = msal.loginPopup;
      acquireTokenSilent = msal.acquireTokenSilent;
      setActiveAccount = msal.setActiveAccount;
      clearCache = msal.clearCache;
    },
  };
});

const tenant = syntheticTenantId;
const origin = syntheticHostedOrigin;
const identity = { username: 'admin@example.test', tenantId: tenant, homeAccountId: 'synthetic-home' };
const token = (tid = tenant, scp = 'Tenant.Read.All') =>
  `header.${btoa(JSON.stringify({ tid, scp }))}.synthetic-signature`;
const success = () => ({ account: identity, accessToken: token() });

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  configureSyntheticAdminEnvironment();
  const top = {};
  vi.stubGlobal('window', { location: { origin }, top, self: top });
  msal.initialize.mockResolvedValue(undefined);
  msal.clearCache.mockResolvedValue(undefined);
  msal.loginPopup.mockResolvedValue(success());
  msal.acquireTokenSilent.mockResolvedValue(success());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('configured single-tenant delegated authentication', () => {
  it('does not silently sign in or request a token before an explicit connection', async () => {
    const auth = await import('./admin-auth');
    expect(auth.getAdminSession()).toBeNull();
    await expect(auth.getAdminAccessToken()).rejects.toMatchObject({ code: 'AdminSignInRequired' });
    expect(msal.loginPopup).not.toHaveBeenCalled();
    expect(msal.acquireTokenSilent).not.toHaveBeenCalled();
  });

  it('uses single-tenant PKCE browser auth, memory cache, and only the tenant read scope', async () => {
    const auth = await import('./admin-auth');
    expect(await auth.signInAdmin()).toEqual({ username: identity.username, tenantId: tenant });
    expect(msal.configure).toHaveBeenCalledWith(expect.objectContaining({
      auth: {
        clientId: syntheticClientId,
        authority: `https://login.microsoftonline.com/${tenant}`,
        redirectUri: `${origin}/admin-auth.html`,
      },
      cache: { cacheLocation: 'memoryStorage' },
    }));
    expect(msal.loginPopup).toHaveBeenCalledWith({ scopes: [auth.ADMIN_SCOPE], prompt: 'select_account' });
    expect(await auth.getAdminAccessToken()).toBe(token());
    expect(msal.acquireTokenSilent).toHaveBeenCalledWith({ account: identity, scopes: [auth.ADMIN_SCOPE] });
  });

  it('rejects a wrong-tenant account before showing a connected session', async () => {
    const otherTenant = '44444444-4444-4444-8444-444444444444';
    msal.loginPopup.mockResolvedValue({ account: { ...identity, tenantId: otherTenant }, accessToken: token(otherTenant) });
    const auth = await import('./admin-auth');
    await expect(auth.signInAdmin()).rejects.toMatchObject({ code: 'WrongTenant' });
    expect(auth.getAdminSession()).toBeNull();
  });

  it('rejects a valid tenant token without tenant-read consent', async () => {
    msal.loginPopup.mockResolvedValue({ account: identity, accessToken: token(tenant, 'Connection.ReadWrite.All') });
    const auth = await import('./admin-auth');
    await expect(auth.signInAdmin()).rejects.toMatchObject({ code: 'AdminScopeMissing' });
    expect(auth.getAdminSession()).toBeNull();
  });

  it('uses the same-origin MSAL popup relay for embedded sign-in without changing scope or tenant', async () => {
    vi.stubGlobal('window', { location: { origin }, top: {}, self: {} });
    const auth = await import('./admin-auth');
    expect(await auth.signInAdmin()).toEqual({ username: identity.username, tenantId: tenant });
    expect(msal.configure).toHaveBeenCalledWith(expect.objectContaining({
      auth: {
        clientId: syntheticClientId,
        authority: `https://login.microsoftonline.com/${tenant}`,
        redirectUri: `${origin}/admin-auth.html`,
        popupRelayUri: `${origin}/admin-auth-relay.html`,
      },
      cache: { cacheLocation: 'memoryStorage' },
    }));
    expect(msal.loginPopup).toHaveBeenCalledWith({ scopes: [auth.ADMIN_SCOPE], prompt: 'select_account' });
  });

  it('rejects an unregistered origin before opening sign-in', async () => {
    const top = {};
    vi.stubGlobal('window', { location: { origin: 'https://unregistered.example.test' }, top, self: top });
    const auth = await import('./admin-auth');
    await expect(auth.signInAdmin()).rejects.toMatchObject({ code: 'UnregisteredOrigin' });
    expect(msal.loginPopup).not.toHaveBeenCalled();
  });

  it('clears only this app cache and removes the active admin immediately', async () => {
    const auth = await import('./admin-auth');
    await auth.signInAdmin();
    const disconnect = auth.disconnectAdmin();
    expect(auth.getAdminSession()).toBeNull();
    await disconnect;
    expect(msal.clearCache).toHaveBeenCalledOnce();
    expect(msal.setActiveAccount).toHaveBeenLastCalledWith(null);
    await expect(auth.getAdminAccessToken()).rejects.toMatchObject({ code: 'AdminSignInRequired' });
  });

  it('does not reconnect from a late popup response after disconnect', async () => {
    let finish!: (value: ReturnType<typeof success>) => void;
    msal.loginPopup.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const auth = await import('./admin-auth');
    const connecting = auth.signInAdmin();
    await vi.waitFor(() => expect(msal.loginPopup).toHaveBeenCalledOnce());
    await auth.disconnectAdmin();
    finish(success());
    await expect(connecting).rejects.toMatchObject({ code: 'SignInCancelled' });
    expect(auth.getAdminSession()).toBeNull();
  });

  it('does not expose raw authentication error details or retry with a popup silently', async () => {
    const auth = await import('./admin-auth');
    await auth.signInAdmin();
    msal.acquireTokenSilent.mockRejectedValue(new Error('synthetic-sensitive-error-payload'));
    await expect(auth.getAdminAccessToken()).rejects.not.toThrow('synthetic-sensitive-error-payload');
    expect(msal.loginPopup).toHaveBeenCalledOnce();
  });

  it('acquires scanner and per-kind Graph tokens silently for the connected admin, never with a popup', async () => {
    const auth = await import('./admin-auth');
    await expect(auth.getDirectoryAccessToken('user')).rejects.toMatchObject({ code: 'AdminSignInRequired' });
    await auth.signInAdmin();
    expect(await auth.getPowerBiAdminAccessToken()).toBe(token());
    expect(msal.acquireTokenSilent).toHaveBeenLastCalledWith({ account: identity, scopes: [auth.POWER_BI_ADMIN_SCOPE] });

    const graphToken = token(tenant, 'User.ReadBasic.All GroupMember.Read.All Application.Read.All');
    msal.acquireTokenSilent.mockResolvedValue({ account: identity, accessToken: graphToken });
    expect(await auth.getDirectoryAccessToken('user', true)).toBe(graphToken);
    expect(msal.acquireTokenSilent).toHaveBeenLastCalledWith({
      account: identity, scopes: ['https://graph.microsoft.com/User.ReadBasic.All'], forceRefresh: true,
    });
    await auth.getDirectoryAccessToken('group');
    expect(msal.acquireTokenSilent).toHaveBeenLastCalledWith({
      account: identity, scopes: ['https://graph.microsoft.com/GroupMember.Read.All'],
    });
    await auth.getDirectoryAccessToken('servicePrincipal');
    expect(msal.acquireTokenSilent).toHaveBeenLastCalledWith({
      account: identity, scopes: ['https://graph.microsoft.com/Application.Read.All'],
    });
    expect(msal.loginPopup).toHaveBeenCalledOnce();
  });

  it('accepts a broader granted permission and reports a missing one with its Entra error code', async () => {
    const { InteractionRequiredAuthError } = await import('@azure/msal-browser');
    const consentRequired = () => new InteractionRequiredAuthError('invalid_grant', 'synthetic-correlation',
      'AADSTS65001: The user or administrator has not consented. Trace ID: synthetic-trace', 'consent_required', '', '', '', '65001');
    const auth = await import('./admin-auth');
    await auth.signInAdmin();
    const broader = token(tenant, 'User.ReadBasic.All Directory.Read.All');
    msal.acquireTokenSilent.mockRejectedValueOnce(consentRequired()).mockResolvedValueOnce({ account: identity, accessToken: broader });
    expect(await auth.getDirectoryAccessToken('group')).toBe(broader);
    expect(msal.acquireTokenSilent.mock.calls.map(([request]) => request.scopes)).toEqual([
      ['https://graph.microsoft.com/GroupMember.Read.All'], [auth.DIRECTORY_SCOPE],
    ]);

    msal.acquireTokenSilent.mockRejectedValueOnce(consentRequired())
      .mockResolvedValueOnce({ account: identity, accessToken: token(tenant, 'User.ReadBasic.All') });
    const missing = await auth.getDirectoryAccessToken('servicePrincipal').catch((error: unknown) => error);
    expect(missing).toMatchObject({ code: 'DirectoryPermissionNotGranted', detail: 'AADSTS65001' });
    expect((missing as Error).message).toContain('Application.Read.All');
    expect((missing as Error).message).not.toContain('synthetic-trace');

    msal.acquireTokenSilent.mockRejectedValueOnce(consentRequired()).mockRejectedValueOnce(consentRequired());
    await expect(auth.getDirectoryAccessToken('user')).rejects.toMatchObject({
      code: 'DirectoryPermissionNotGranted', detail: 'AADSTS65001',
    });
    expect(msal.loginPopup).toHaveBeenCalledOnce();
  });

  it('reports other Graph token failures by code without raw details, and pins the Graph token tenant', async () => {
    const { InteractionRequiredAuthError } = await import('@azure/msal-browser');
    const auth = await import('./admin-auth');
    await auth.signInAdmin();
    msal.acquireTokenSilent.mockRejectedValueOnce(new InteractionRequiredAuthError('interaction_required', 'synthetic-correlation',
      'AADSTS50076: synthetic-sensitive-error-payload', '', '', '', '', '50076'));
    const failure = auth.getDirectoryAccessToken('user');
    await expect(failure).rejects.toMatchObject({
      code: 'DirectoryAccessUnavailable', detail: 'AADSTS50076', message: expect.stringContaining('(AADSTS50076)'),
    });
    await expect(failure).rejects.not.toThrow('synthetic-sensitive-error-payload');
    expect(msal.acquireTokenSilent).toHaveBeenCalledOnce();
    msal.acquireTokenSilent.mockRejectedValueOnce(new Error('synthetic-sensitive-error-payload'));
    await expect(auth.getDirectoryAccessToken('group')).rejects.not.toThrow('synthetic-sensitive-error-payload');
    msal.acquireTokenSilent.mockResolvedValueOnce({
      account: identity, accessToken: token('44444444-4444-4444-8444-444444444444', 'User.ReadBasic.All'),
    });
    await expect(auth.getDirectoryAccessToken('user')).rejects.toMatchObject({ code: 'WrongTenant' });
    expect(msal.loginPopup).toHaveBeenCalledOnce();
  });

  it('requests Tenant.ReadWrite.All silently only for Take over, for the signed-in account only', async () => {
    const { InteractionRequiredAuthError } = await import('@azure/msal-browser');
    const oid = '55555555-5555-4555-8555-555555555555';
    const signedIn = { ...identity, localAccountId: oid.toUpperCase() };
    const writeToken = (id: string) =>
      `header.${btoa(JSON.stringify({ tid: tenant, scp: 'Tenant.Read.All Tenant.ReadWrite.All', oid: id }))}.synthetic-signature`;
    msal.loginPopup.mockResolvedValue({ account: signedIn, accessToken: token() });
    const auth = await import('./admin-auth');
    await expect(auth.getConnectionWriteAccess()).rejects.toMatchObject({ code: 'AdminSignInRequired' });
    expect(await auth.signInAdmin()).toEqual({ username: identity.username, tenantId: tenant, principalId: oid });
    expect(msal.loginPopup).toHaveBeenCalledWith({ scopes: [auth.ADMIN_SCOPE], prompt: 'select_account' });

    msal.acquireTokenSilent.mockResolvedValueOnce({ account: signedIn, accessToken: writeToken(oid) });
    expect(await auth.getConnectionWriteAccess()).toEqual({ token: writeToken(oid), principalId: oid });
    expect(msal.acquireTokenSilent).toHaveBeenLastCalledWith({
      account: signedIn, scopes: ['https://api.fabric.microsoft.com/Tenant.ReadWrite.All'],
    });

    msal.acquireTokenSilent.mockResolvedValueOnce({
      account: signedIn, accessToken: writeToken('66666666-6666-4666-8666-666666666666'),
    });
    await expect(auth.getConnectionWriteAccess()).rejects.toMatchObject({ code: 'WrongAccount' });
    msal.acquireTokenSilent.mockResolvedValueOnce({ account: signedIn, accessToken: token() });
    await expect(auth.getConnectionWriteAccess()).rejects.toMatchObject({ code: 'WriteScopeMissing' });

    msal.acquireTokenSilent.mockRejectedValueOnce(new InteractionRequiredAuthError('invalid_grant', 'synthetic-correlation',
      'AADSTS65001: synthetic-sensitive-error-payload', 'consent_required', '', '', '', '65001'));
    const missing = auth.getConnectionWriteAccess();
    await expect(missing).rejects.toMatchObject({
      code: 'TakeOverPermissionNotGranted', detail: 'AADSTS65001', message: expect.stringContaining('Tenant.ReadWrite.All'),
    });
    await expect(missing).rejects.not.toThrow('synthetic-sensitive-error-payload');
    expect(msal.loginPopup).toHaveBeenCalledOnce();
  });

  it.each([
    ['VITE_ADMIN_TENANT_ID', undefined, 'AdminConfigurationRequired'],
    ['VITE_ADMIN_CLIENT_ID', 'invalid-client', 'InvalidAdminConfiguration'],
    ['VITE_ADMIN_HOSTED_ORIGIN', 'https://inventory.example.test/path', 'InvalidAdminConfiguration'],
  ] as const)('fails closed before authentication or API calls for invalid %s', async (field, value, code) => {
    vi.stubEnv(field, value);
    const request = vi.spyOn(globalThis, 'fetch');
    const auth = await import('./admin-auth');

    expect(auth.getAdminSession()).toBeNull();
    await expect(auth.signInAdmin()).rejects.toMatchObject({ code });
    await expect(auth.getAdminAccessToken()).rejects.toMatchObject({ code });
    expect(msal.configure).not.toHaveBeenCalled();
    expect(msal.loginPopup).not.toHaveBeenCalled();
    expect(msal.acquireTokenSilent).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    request.mockRestore();
  });

  it('pins the token tenant independently of the account metadata', async () => {
    msal.loginPopup.mockResolvedValue({
      account: identity,
      accessToken: token('44444444-4444-4444-8444-444444444444'),
    });
    const auth = await import('./admin-auth');
    await expect(auth.signInAdmin()).rejects.toMatchObject({ code: 'WrongTenant' });
    expect(auth.getAdminSession()).toBeNull();
  });

  it('supports an explicitly configured localhost SPA origin without changing the tenant guard', async () => {
    const localOrigin = 'http://127.0.0.1:5173';
    vi.stubEnv('VITE_ADMIN_HOSTED_ORIGIN', localOrigin);
    const top = {};
    vi.stubGlobal('window', { location: { origin: localOrigin }, top, self: top });
    const auth = await import('./admin-auth');

    await auth.signInAdmin();
    expect(msal.configure).toHaveBeenCalledWith(expect.objectContaining({
      auth: {
        clientId: syntheticClientId,
        authority: `https://login.microsoftonline.com/${tenant}`,
        redirectUri: `${localOrigin}/admin-auth.html`,
      },
    }));
    expect(await auth.getAdminAccessToken()).toBe(token());
  });
});
