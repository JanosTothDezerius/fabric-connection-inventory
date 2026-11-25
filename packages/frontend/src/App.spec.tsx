import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DirectoryLookup, type InventorySnapshot, type LoadInventoryOptions } from '@rayfin-app/shared';

import App from '@/App';
import { ThemeContext } from '@/hooks/theme.context';
import { useAppTheme } from '@/hooks/use-theme';
import { AdminAuthError, getAdminSession, getDirectoryAccessToken } from '@/services/admin-auth';
import { emptyUsage, loadConnectionUsage, type LoadUsageOptions } from '@/services/connection-usage';
import { TakeOverError, takeOverConnection, type TakeOverResult } from '@/services/connection-takeover';
import { loadInventory } from '@/services/inventory';
import { syntheticConnection, syntheticSnapshot } from '@/test/inventory-fixtures';
import { configureSyntheticAdminEnvironment, syntheticTenantId } from '@/test/admin-config-fixtures';

vi.mock('@/services/inventory', () => ({ loadInventory: vi.fn() }));
vi.mock('@/services/connection-usage', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/connection-usage')>(),
  loadConnectionUsage: vi.fn(),
}));
vi.mock('@/services/connection-takeover', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/connection-takeover')>(),
  takeOverConnection: vi.fn(),
}));
vi.mock('@/services/admin-auth', () => ({
  getAdminSession: vi.fn(),
  signInAdmin: vi.fn(),
  disconnectAdmin: vi.fn(),
  getDirectoryAccessToken: vi.fn(),
  AdminAuthError: class extends Error {
    constructor(readonly code: string, message: string, readonly detail?: string) { super(message); }
  },
}));
const mockLoad = vi.mocked(loadInventory);
const mockUsage = vi.mocked(loadConnectionUsage);

beforeEach(() => {
  vi.resetAllMocks();
  configureSyntheticAdminEnvironment();
  vi.mocked(getAdminSession).mockReturnValue({
    username: 'synthetic-admin@example.test', tenantId: syntheticTenantId, permissions: ['Tenant.ReadWrite.All'],
  });
  mockUsage.mockReturnValue(new Promise(() => {}));
});
afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.classList.remove('dark');
  vi.unstubAllEnvs();
});

describe('Connection inventory', () => {
  it('renders honest pending, failed, empty and pending-owner states, with plain-text endpoints', async () => {
    mockLoad.mockResolvedValue(syntheticSnapshot([
      syntheticConnection({ id: 'pending', displayName: 'Synthetic pending', ownerStatus: 'pending' }),
      syntheticConnection({
        id: 'failure', displayName: 'Synthetic failure', ownerStatus: 'error',
        ownerError: { code: 'SyntheticFailure', message: 'Synthetic lookup failed', requestId: 'synthetic-request-id' },
      }),
      syntheticConnection({ id: 'empty', displayName: 'Synthetic empty' }),
      syntheticConnection({
        id: 'owned', displayName: 'Synthetic owned', endpoint: 'https://synthetic.example.invalid/path',
        owners: [
          { id: 'synthetic-group-principal', type: 'Group', role: 'Owner' },
          { id: 'synthetic-pending-principal', type: 'User', role: 'PendingOwner' },
        ],
      }),
    ]));
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Connection inventory' })).toBeVisible();
    await screen.findByText('Synthetic owned');
    const table = within(screen.getByRole('table'));
    expect(table.getByText('Not yet resolved')).toBeVisible();
    expect(table.getByText('Owner lookup failed')).toBeVisible();
    expect(table.getAllByText('No owners returned')).toHaveLength(1);
    expect(table.getByText('synthetic-group-principal')).toBeVisible();
    expect(table.getByText('Pending owner')).toBeVisible();
    expect(screen.getByText('Partial owner results.')).toBeVisible();
    expect(screen.getByText('Requests use your signed-in account, and Fabric allows them only for Fabric administrators.')).toBeVisible();
    expect(screen.getByText('synthetic-admin@example.test')).toBeVisible();
    expect(screen.queryByText(/Backend requests run as the app owner/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Authorized admin:/)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /synthetic.example.invalid/ })).not.toBeInTheDocument();
    expect(table.getByText('https://synthetic.example.invalid/path').closest('a')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show details for Synthetic failure' }));
    expect(screen.getByText('Request ID: synthetic-request-id')).toBeVisible();
    expect(screen.getAllByText('Not provided').length).toBeGreaterThan(0);
  });

  it('paginates at 25, resets the page when filtering and sorts accessible column headers', async () => {
    const connections = Array.from({ length: 28 }, (_, index) => syntheticConnection({
      id: `synthetic-${index + 1}`,
      displayName: `Synthetic connection ${index + 1}`,
      connectorType: index === 27 ? 'SyntheticWeb' : 'SyntheticSQL',
    }));
    mockLoad.mockResolvedValue(syntheticSnapshot(connections));
    render(<App />);
    await screen.findByText('Synthetic connection 25');
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(26);
    expect(screen.queryByText('Synthetic connection 26')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByText('Synthetic connection 28')).toBeVisible();
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(4);
    fireEvent.click(screen.getByRole('button', { name: 'Connector type All connector types' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'SyntheticWeb' }));
    expect(screen.getByText('Page 1 of 1')).toBeVisible();
    expect(screen.getByText('Synthetic connection 28')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    fireEvent.click(screen.getByRole('button', { name: /^Connection$/ }));
    expect(screen.getByRole('columnheader', { name: /^Connection$/ })).toHaveAttribute('aria-sort', 'descending');
    expect(within(screen.getByRole('table')).getAllByRole('row')[1]).toHaveTextContent('Synthetic connection 28');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search inventory' }), { target: { value: 'nothing matches' } });
    expect(screen.getByText('No matching connections')).toBeVisible();
  });

  it('shows partial-list failure and retry without labeling the inventory complete', async () => {
    mockLoad.mockResolvedValueOnce(syntheticSnapshot(
      [syntheticConnection({ ownerStatus: 'pending' })],
      { phase: 'error', inventoryComplete: false, updatedAt: null, error: {
        code: 'SyntheticForbidden', message: 'Synthetic permission failure', requestId: 'synthetic-list-request',
      } }
    )).mockResolvedValueOnce(syntheticSnapshot([]));
    render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic permission failure');
    expect(screen.getByText(/The connection list is incomplete/)).toBeVisible();
    expect(screen.getByText('No completed refresh in this session')).toBeVisible();
    expect(screen.queryByText('Last refreshed')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No connections returned')).toBeVisible();
    expect(mockLoad).toHaveBeenCalledTimes(2);
  });

  it('resumes unfinished owner lookups without clearing the loaded connections', async () => {
    const stopped = syntheticSnapshot([
      syntheticConnection({ id: 'kept', displayName: 'Synthetic kept' }),
      syntheticConnection({ id: 'unfinished', displayName: 'Synthetic unfinished', ownerStatus: 'pending' }),
    ], { phase: 'error', updatedAt: null, error: { code: 'FabricHttp429', message: 'Synthetic throttling stopped the run.', status: 429 } });
    let resumed!: LoadInventoryOptions;
    mockLoad.mockResolvedValueOnce(stopped).mockImplementationOnce((options) => {
      resumed = options;
      return new Promise(() => {});
    });
    render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic throttling stopped the run.');
    expect(screen.getByText(/Resuming keeps completed owner results/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Resume owner lookups' }));
    expect(resumed.resumeFrom).toBe(stopped);
    expect(screen.getByText('Synthetic kept')).toBeVisible();
    expect(screen.getByText('Synthetic unfinished')).toBeVisible();
  });

  it('offers to retry only failed owner lookups after a completed refresh', async () => {
    const finished = syntheticSnapshot([
      syntheticConnection({ id: 'ok' }),
      syntheticConnection({ id: 'failed', ownerStatus: 'error', ownerError: { code: 'SyntheticFailure', message: 'Synthetic failure' } }),
    ]);
    mockLoad.mockResolvedValueOnce(finished).mockReturnValueOnce(new Promise(() => {}));
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry failed owner lookups' }));
    expect(mockLoad).toHaveBeenCalledTimes(2);
    expect(mockLoad).toHaveBeenLastCalledWith(expect.objectContaining({ resumeFrom: finished }));
  });

  it('shows when throttled requests continue automatically', async () => {
    let options!: LoadInventoryOptions;
    mockLoad.mockImplementation((value) => {
      options = value;
      return new Promise(() => {});
    });
    render(<App />);
    const resumeAt = Date.now() + 42_000;
    act(() => options.onProgress(syntheticSnapshot([syntheticConnection({ ownerStatus: 'pending' })], {
      phase: 'owners', updatedAt: null, pausedUntil: resumeAt,
    })));

    expect(screen.getByText('Paused while Fabric throttles requests')).toBeVisible();
    expect(screen.getByText(/continue automatically at/)).toHaveTextContent(new Date(resumeAt).toLocaleTimeString());
    expect(await screen.findByText(/\(in 4[12] s\)/)).toBeVisible();
    expect(screen.getByRole('button', { name: /^Cancel$/ })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Resume owner lookups' })).not.toBeInTheDocument();
  });

  it('keeps loading and cancellation explicit and clears previous data on refresh', async () => {
    let options!: LoadInventoryOptions;
    let finish!: (value: InventorySnapshot) => void;
    mockLoad.mockImplementation((value) => {
      options = value;
      return new Promise((resolve) => { finish = resolve; });
    });
    render(<App />);
    expect(screen.getByText('Loading connections…')).toBeVisible();
    act(() => options.onProgress(syntheticSnapshot(
      [syntheticConnection({ ownerStatus: 'pending' })],
      { phase: 'connections', inventoryComplete: false, updatedAt: null }
    )));
    expect(screen.getByText('Synthetic warehouse')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/ }));
    expect(screen.getByText('Refresh cancelled')).toBeVisible();
    expect(screen.getByText(/An in-flight server request may still finish/)).toBeVisible();
    await act(async () => finish(syntheticSnapshot()));
    expect(screen.getByText('Refresh cancelled')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh inventory' }));
    expect(screen.queryByText('Synthetic warehouse')).not.toBeInTheDocument();
    expect(screen.getByText('Loading connections…')).toBeVisible();
  });

  it('shows unexpected loader failures rather than an endless loading state', async () => {
    mockLoad.mockRejectedValue(new Error('Synthetic unexpected failure'));
    render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Refresh to try again');
    expect(screen.queryByText('Loading connections…')).not.toBeInTheDocument();
  });

  it('filters by several authentication types at once and shows each connection’s type', async () => {
    mockLoad.mockResolvedValue(syntheticSnapshot([
      syntheticConnection({ id: 'principal', displayName: 'Synthetic principal', credentialType: 'ServicePrincipal' }),
      syntheticConnection({ id: 'oauth', displayName: 'Synthetic oauth', credentialType: 'OAuth2' }),
      syntheticConnection({ id: 'key', displayName: 'Synthetic key', credentialType: 'Key' }),
    ]));
    render(<App />);
    await screen.findByText('Synthetic principal');
    fireEvent.click(screen.getByRole('button', { name: 'Authentication type All authentication types' }));
    const options = within(screen.getByRole('group', { name: 'Authentication type' }));
    fireEvent.click(options.getByRole('checkbox', { name: 'Service Principal', description: '1 connection' }));
    fireEvent.click(options.getByRole('checkbox', { name: 'OAuth2' }));

    expect(screen.getByRole('button', { name: 'Authentication type 2 selected' })).toBeVisible();
    expect(screen.getByText('Synthetic principal')).toBeVisible();
    expect(screen.getByText('Synthetic oauth')).toBeVisible();
    expect(screen.queryByText('Synthetic key')).not.toBeInTheDocument();
    expect(within(screen.getByRole('table')).getByText('Auth: Service Principal')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByText('Synthetic key')).toBeVisible();
  });

  it('filters by workspaces, showing connections with a dependent workload in any selected workspace', async () => {
    const item = (workspaceId: string, workspaceName: string) => ({
      id: `item-${workspaceId}`, name: 'Synthetic model', type: 'Semantic model', workspaceId, workspaceName,
    });
    mockLoad.mockResolvedValue(syntheticSnapshot([
      syntheticConnection({ id: 'shared', displayName: 'Synthetic shared' }),
      syntheticConnection({ id: 'finance', displayName: 'Synthetic finance' }),
      syntheticConnection({ id: 'unused', displayName: 'Synthetic unused' }),
    ]));
    mockUsage.mockResolvedValue({
      ...emptyUsage(), phase: 'done', workspaceCount: 2, scannedWorkspaces: 2, updatedAt: '2026-01-02T03:04:05Z',
      itemsByConnection: new Map([
        ['shared', [item('workspace-finance', 'Finance'), item('workspace-sales', 'Sales')]],
        ['finance', [item('workspace-finance', 'Finance')]],
      ]),
    });
    render(<App />);
    expect(await screen.findByText('Dependent workloads scanned')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Workspace All workspaces' }));
    const workspaces = within(screen.getByRole('group', { name: 'Workspace' }));
    fireEvent.click(workspaces.getByRole('checkbox', { name: 'Sales', description: '1 connection' }));
    expect(screen.getByText('Synthetic shared')).toBeVisible();
    expect(screen.queryByText('Synthetic finance')).not.toBeInTheDocument();

    fireEvent.click(workspaces.getByRole('checkbox', { name: 'Finance', description: '2 connections' }));
    expect(screen.getByText('Synthetic shared')).toBeVisible();
    expect(screen.getByText('Synthetic finance')).toBeVisible();
    expect(screen.queryByText('Synthetic unused')).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Workspace 2 selected' }), { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'Workspace' })).not.toBeInTheDocument();
  });

  it('looks up user, group and service principal names separately and lists each missing permission', async () => {
    const user = '11111111-1111-4111-8111-111111111111';
    const group = '22222222-2222-4222-8222-222222222222';
    const app = '33333333-3333-4333-8333-333333333333';
    const names: Record<string, string> = { [user]: 'Synthetic Owner', [group]: 'Synthetic Group', [app]: 'Synthetic App' };
    mockLoad.mockResolvedValue(syntheticSnapshot([syntheticConnection({
      owners: [
        { id: user, type: 'User', role: 'Owner' },
        { id: group, type: 'Group', role: 'Owner' },
        { id: app, type: 'ServicePrincipal', role: 'Owner' },
      ],
    })]));
    const granted = new Set<string>();
    vi.mocked(getDirectoryAccessToken).mockImplementation(async (kind) => {
      if (granted.has(kind)) return `synthetic-${kind}-token`;
      throw new AdminAuthError('DirectoryPermissionNotGranted', 'Synthetic permission not granted', 'AADSTS65001');
    });
    const lookup = vi.spyOn(DirectoryLookup.prototype, 'lookupPrincipals').mockImplementation(async (batch) =>
      batch.map(({ id }) => ({ id, result: { status: 'resolved' as const, displayName: names[id] } })));
    const permissions = () => within(screen.getByRole('list', { name: 'Missing Microsoft Graph permissions' })).getAllByRole('listitem');
    render(<App />);
    const table = within(await screen.findByRole('table'));

    expect(await screen.findByText('3 owners show only an ID.')).toBeVisible();
    expect(screen.getByText('Owner names unavailable')).toBeVisible();
    expect(permissions()).toHaveLength(3);
    expect(permissions()[0]).toHaveTextContent('User.ReadBasic.All');
    expect(permissions()[0]).toHaveTextContent('Reads the display name, user principal name and email address of users that own connections.');
    expect(permissions()[0]).toHaveTextContent('1 user without a name · Error code: AADSTS65001');
    expect(permissions()[1]).toHaveTextContent('GroupMember.Read.All');
    expect(permissions()[1]).toHaveTextContent('security groups that own connections');
    expect(permissions()[2]).toHaveTextContent('Application.Read.All');
    expect(permissions()[2]).toHaveTextContent('service principals, such as app registrations');
    expect(table.getByText(user)).toBeVisible();
    expect(lookup).not.toHaveBeenCalled();

    granted.add('user');
    fireEvent.click(screen.getByRole('button', { name: 'Retry name lookups' }));
    expect(await table.findByText('Synthetic Owner')).toBeVisible();
    expect(await screen.findByText('2 owners show only an ID. Names are shown for users.')).toBeVisible();
    expect(screen.getByText('Some owner names can’t be shown')).toBeVisible();
    expect(permissions()).toHaveLength(2);
    expect(permissions()[0]).toHaveTextContent('GroupMember.Read.All');
    expect(getDirectoryAccessToken).toHaveBeenCalledWith('user', true);

    granted.add('group').add('servicePrincipal');
    fireEvent.click(screen.getByRole('button', { name: 'Retry name lookups' }));
    expect(await table.findByText('Synthetic Group')).toBeVisible();
    expect(await table.findByText('Synthetic App')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Retry name lookups' })).not.toBeInTheDocument();
    expect(lookup.mock.calls.map(([batch]) => batch)).toEqual([
      [{ id: user, type: 'User' }], [{ id: group, type: 'Group' }], [{ id: app, type: 'ServicePrincipal' }],
    ]);
    lookup.mockRestore();
  });

  it('lists the dependent workloads of an expanded connection, or says it is not used', async () => {
    mockLoad.mockResolvedValue(syntheticSnapshot([
      syntheticConnection({ id: 'used', displayName: 'Synthetic used' }),
      syntheticConnection({ id: 'unused', displayName: 'Synthetic unused' }),
    ]));
    mockUsage.mockResolvedValue({
      ...emptyUsage(), phase: 'done', workspaceCount: 2, scannedWorkspaces: 2, updatedAt: '2026-01-02T03:04:05Z',
      itemsByConnection: new Map([['used', [
        { id: 'model', name: 'Synthetic sales model', type: 'Semantic model', workspaceId: 'workspace', workspaceName: 'Synthetic workspace' },
        { id: 'flow', name: 'Synthetic flow', type: 'Dataflow', workspaceId: 'workspace', workspaceName: 'Synthetic workspace', misconfigured: true },
      ]]]),
    });
    render(<App />);
    expect(await screen.findByText('Dependent workloads scanned')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Show details for Synthetic used' }));
    const workloads = within(screen.getByRole('list', { name: 'Dependent workloads' }));
    expect(workloads.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'DataflowSynthetic flowin Synthetic workspaceMisconfigured binding',
      'Semantic modelSynthetic sales modelin Synthetic workspace',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Show details for Synthetic unused' }));
    expect(screen.getByText('Not used by any workload. No item in the 2 scanned workspaces is bound to this connection.')).toBeVisible();
  });

  it('offers Take over only in expanded details and shows that connection’s new owners at once', async () => {
    // Not a GUID, so no Microsoft Graph name lookup starts for the new owner.
    const admin = 'synthetic-admin-principal';
    const group = { id: 'synthetic-group-principal', type: 'Group', role: 'Owner' as const };
    vi.mocked(getAdminSession).mockReturnValue({
      username: 'synthetic-admin@example.test', tenantId: syntheticTenantId, principalId: admin, permissions: ['Tenant.ReadWrite.All'],
    });
    mockLoad.mockResolvedValue(syntheticSnapshot([
      syntheticConnection({ id: 'target', displayName: 'Synthetic target', owners: [group] }),
      syntheticConnection({ id: 'other', displayName: 'Synthetic other' }),
    ]));
    let finish!: (result: TakeOverResult) => void;
    vi.mocked(takeOverConnection).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    render(<App />);
    await screen.findByText('Synthetic target');
    expect(screen.queryByRole('button', { name: 'Take over' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show details for Synthetic target' }));
    const takeOver = screen.getByRole('button', { name: 'Take over' });
    expect(takeOver).toHaveAccessibleDescription('Adds your signed-in account as an owner. Existing owners are kept.');
    fireEvent.click(takeOver);
    expect(takeOverConnection).not.toHaveBeenCalled();
    const confirmation = screen.getByRole('alertdialog', { name: 'Take over Synthetic target?' });
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Take over' }));
    expect(confirmation).not.toBeInTheDocument();
    fireEvent.click(takeOver);
    expect(takeOverConnection).toHaveBeenCalledOnce();
    expect(takeOverConnection).toHaveBeenCalledWith('target');
    expect(takeOver).toBeDisabled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

    const added = { id: admin, type: 'User', role: 'PendingOwner' as const };
    await act(async () => finish({ principalId: admin, added, owners: [group, added] }));
    const notifications = within(screen.getByRole('region', { name: 'Notifications' }));
    expect(notifications.getByText('Connection taken over')).toBeVisible();
    expect(notifications.getByText(/^You were added as a pending owner of Synthetic target\. Existing owners were kept\./)).toBeVisible();
    const owners = within(screen.getByRole('list', { name: 'Connection owners' }));
    expect(owners.getByText('synthetic-group-principal')).toBeVisible();
    expect(owners.getByText(admin)).toBeVisible();
    expect(owners.getByText('Pending owner')).toBeVisible();
    expect(owners.getByText('You')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Take over' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Take over' })).toHaveAccessibleDescription(/^You’re a pending owner\./);
    expect(mockLoad).toHaveBeenCalledOnce();

    fireEvent.click(notifications.getByRole('button', { name: 'Dismiss: Connection taken over' }));
    expect(notifications.queryByText('Connection taken over')).not.toBeInTheDocument();
  });

  it('notifies when a take over fails and leaves the owners unchanged', async () => {
    mockLoad.mockResolvedValue(syntheticSnapshot([syntheticConnection({ id: 'target', displayName: 'Synthetic target' })]));
    vi.mocked(takeOverConnection).mockRejectedValue(new TakeOverError({
      code: 'FabricHttp403', message: 'Synthetic denial.', status: 403, requestId: 'synthetic-request-id',
    }));
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Show details for Synthetic target' }));
    fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
    fireEvent.click(within(screen.getByRole('alertdialog', { name: 'Take over Synthetic target?' })).getByRole('button', { name: 'Take over' }));

    const alert = await within(screen.getByRole('region', { name: 'Notifications' })).findByRole('alert');
    expect(alert).toHaveTextContent('Take over failed');
    expect(alert).toHaveTextContent('Synthetic target: Synthetic denial.');
    expect(alert).toHaveTextContent('Error code: FabricHttp403');
    expect(alert).toHaveTextContent('HTTP status: 403');
    expect(alert).toHaveTextContent('Request ID: synthetic-request-id');
    expect(within(screen.getByRole('table')).getByText('No owners returned')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Take over' })).toBeEnabled();
  });

  it('asks for confirmation, listing the steps after a take over and the endpoint, and changes nothing when cancelled', async () => {
    mockLoad.mockResolvedValue(syntheticSnapshot([
      syntheticConnection({ id: 'target', displayName: 'Synthetic target', credentialType: 'OAuth2' }),
    ]));
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Show details for Synthetic target' }));
    const takeOver = screen.getByRole('button', { name: 'Take over' });
    fireEvent.click(takeOver);

    const dialog = screen.getByRole('alertdialog', { name: 'Take over Synthetic target?' });
    expect(dialog).toHaveAccessibleDescription(/^You’ll be added as a pending owner, and existing owners are kept\./);
    expect(dialog).toHaveTextContent('open Settings > Manage connections and gateways, and open this connection’s settings on the Connections tab.');
    expect(dialog).toHaveTextContent('Enter credentials that can access the endpoint below, and save. For OAuth2, select Edit credentials and sign in. This makes you an owner.');
    expect(dialog).toHaveTextContent('Make sure those credentials work for every item under Dependent workloads');
    expect(within(dialog).getByText('synthetic.example.invalid;database=test')).toBeVisible();
    expect(within(dialog).getByText('SyntheticSQL')).toBeVisible();
    expect(within(dialog).getByText('OAuth2')).toBeVisible();
    expect(within(dialog).getByText('Continue only if these steps are clear to you and you’ve confirmed that you have the access or credentials this endpoint needs.')).toBeVisible();

    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    const confirm = within(dialog).getByRole('button', { name: 'Take over' });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true });
    expect(confirm).toHaveFocus();
    fireEvent.keyDown(confirm, { key: 'Tab' });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(cancel, { key: 'Escape' });
    expect(dialog).not.toBeInTheDocument();
    expect(takeOver).toHaveFocus();

    fireEvent.click(takeOver);
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(takeOver).toHaveFocus();
    expect(takeOverConnection).not.toHaveBeenCalled();
  });

  it('closes the confirmation when owner lookups show the signed-in account already has a role', () => {
    const admin = 'synthetic-admin-principal';
    vi.mocked(getAdminSession).mockReturnValue({
      username: 'synthetic-admin@example.test', tenantId: syntheticTenantId, principalId: admin, permissions: ['Tenant.ReadWrite.All'],
    });
    let options!: LoadInventoryOptions;
    mockLoad.mockImplementation((value) => {
      options = value;
      return new Promise(() => {});
    });
    render(<App />);
    const target = syntheticConnection({ id: 'target', displayName: 'Synthetic target', ownerStatus: 'pending' });
    act(() => options.onProgress(syntheticSnapshot([target], { phase: 'owners', updatedAt: null })));
    fireEvent.click(screen.getByRole('button', { name: 'Show details for Synthetic target' }));
    fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
    expect(screen.getByRole('alertdialog', { name: 'Take over Synthetic target?' })).toBeVisible();

    act(() => options.onProgress(syntheticSnapshot(
      [{ ...target, ownerStatus: 'loaded', owners: [{ id: admin, type: 'User', role: 'Owner' }] }],
      { phase: 'owners', updatedAt: null },
    )));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Take over' })).toHaveAccessibleDescription('You already own this connection.');
    expect(takeOverConnection).not.toHaveBeenCalled();

    act(() => options.onProgress(syntheticSnapshot([{ ...target, ownerStatus: 'loaded' }], { phase: 'owners', updatedAt: null })));
    expect(screen.getByRole('button', { name: 'Take over' })).toBeEnabled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it.each([
    [['Tenant.ReadWrite.All'], 'Power BI Service permission: Tenant.ReadWrite.All, for the inventory and Take over.', true],
    [['Tenant.Read.All'], 'Power BI Service permission: Tenant.Read.All, for the inventory only. Take over needs Tenant.ReadWrite.All in its place.', false],
    [['Tenant.ReadWrite.All', 'Tenant.Read.All'],
      'Power BI Service permissions: Tenant.ReadWrite.All and Tenant.Read.All. Tenant.ReadWrite.All already allows everything Tenant.Read.All does, so an administrator can revoke Tenant.Read.All.', true],
  ] as const)('with the Fabric admin permissions %j, shows them and whether Take over is available', async (permissions, note, available) => {
    vi.mocked(getAdminSession).mockReturnValue({
      username: 'synthetic-admin@example.test', tenantId: syntheticTenantId, permissions,
    });
    mockLoad.mockResolvedValue(syntheticSnapshot([syntheticConnection({ id: 'target', displayName: 'Synthetic target' })]));
    render(<App />);
    expect(screen.getByRole('region', { name: 'Access and deployment context' })).toHaveTextContent(note);
    fireEvent.click(await screen.findByRole('button', { name: 'Show details for Synthetic target' }));
    const takeOver = screen.getByRole('button', { name: 'Take over' });
    if (available) {
      expect(takeOver).toBeEnabled();
    } else {
      expect(takeOver).toBeDisabled();
      expect(takeOver).toHaveAccessibleDescription('Take over needs the Power BI Service permission Tenant.ReadWrite.All, which this app doesn’t have.');
      fireEvent.click(takeOver);
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(takeOverConnection).not.toHaveBeenCalled();
    }
  });

  it('cancels a running workspace scan without marking a finished inventory as cancelled', async () => {
    let usageOptions!: LoadUsageOptions;
    mockLoad.mockResolvedValue(syntheticSnapshot());
    mockUsage.mockImplementation((options) => {
      usageOptions = options;
      return new Promise(() => {});
    });
    render(<App />);
    expect(await screen.findByText('Inventory refreshed')).toBeVisible();
    expect(screen.getByText('Scanning workspaces for dependent workloads')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/ }));
    expect(usageOptions.signal.aborted).toBe(true);
    expect(screen.getByText('Workspace scan cancelled')).toBeVisible();
    expect(screen.getByText('Inventory refreshed')).toBeVisible();
    expect(screen.queryByText('Refresh cancelled')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Cancel$/ })).not.toBeInTheDocument();
  });

  it('uses the existing theme toggle and keeps data-theme and dark class coherent', async () => {
    mockLoad.mockResolvedValue(syntheticSnapshot([]));
    function ThemedApp() {
      const theme = useAppTheme();
      return <ThemeContext.Provider value={theme}><App /></ThemeContext.Provider>;
    }
    render(<ThemedApp />);
    await screen.findByText('No connections returned');
    fireEvent.click(screen.getByRole('button', { name: 'Switch to dark theme' }));
    await waitFor(() => expect(document.documentElement).toHaveClass('dark'));
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    fireEvent.click(screen.getByRole('button', { name: 'Switch to light theme' }));
    await waitFor(() => expect(document.documentElement).not.toHaveClass('dark'));
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
  });
});
