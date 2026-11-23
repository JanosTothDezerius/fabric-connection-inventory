import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DirectoryLookup, type InventorySnapshot, type LoadInventoryOptions } from '@rayfin-app/shared';

import App from '@/App';
import { ThemeContext } from '@/hooks/theme.context';
import { useAppTheme } from '@/hooks/use-theme';
import { getAdminSession, getDirectoryAccessToken } from '@/services/admin-auth';
import { emptyUsage, loadConnectionUsage, type LoadUsageOptions } from '@/services/connection-usage';
import { loadInventory } from '@/services/inventory';
import { syntheticConnection, syntheticSnapshot } from '@/test/inventory-fixtures';
import { configureSyntheticAdminEnvironment, syntheticTenantId } from '@/test/admin-config-fixtures';

vi.mock('@/services/inventory', () => ({ loadInventory: vi.fn() }));
vi.mock('@/services/connection-usage', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/connection-usage')>(),
  loadConnectionUsage: vi.fn(),
}));
vi.mock('@/services/admin-auth', () => ({
  getAdminSession: vi.fn(),
  signInAdmin: vi.fn(),
  disconnectAdmin: vi.fn(),
  getDirectoryAccessToken: vi.fn(),
}));
const mockLoad = vi.mocked(loadInventory);
const mockUsage = vi.mocked(loadConnectionUsage);

beforeEach(() => {
  vi.resetAllMocks();
  configureSyntheticAdminEnvironment();
  vi.mocked(getAdminSession).mockReturnValue({
    username: 'synthetic-admin@example.test', tenantId: syntheticTenantId,
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
    expect(screen.getByText(/Requests use your signed-in account; Fabric enforces tenant-admin permissions/)).toBeVisible();
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
    fireEvent.change(screen.getByRole('combobox', { name: 'Connector type' }), { target: { value: 'SyntheticWeb' } });
    expect(screen.getByText('Page 1 of 1')).toBeVisible();
    expect(screen.getByText('Synthetic connection 28')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    fireEvent.click(screen.getByRole('button', { name: /^Connection$/ }));
    expect(screen.getByRole('columnheader', { name: /^Connection$/ })).toHaveAttribute('aria-sort', 'descending');
    expect(within(screen.getByRole('table')).getAllByRole('row')[1]).toHaveTextContent('Synthetic connection 28');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search inventory' }), { target: { value: 'nothing matches' } });
    expect(screen.getByText('No matching connections')).toBeVisible();
  });

  it('excludes pending and failed lookups from the no-owner filter', async () => {
    mockLoad.mockResolvedValue(syntheticSnapshot([
      syntheticConnection({ id: 'pending', displayName: 'Synthetic pending', ownerStatus: 'pending' }),
      syntheticConnection({ id: 'failure', displayName: 'Synthetic failure', ownerStatus: 'error' }),
      syntheticConnection({ id: 'empty', displayName: 'Synthetic confirmed empty' }),
    ]));
    render(<App />);
    await screen.findByText('Synthetic confirmed empty');
    fireEvent.change(screen.getByRole('combobox', { name: 'Owner resolution' }), { target: { value: 'none' } });
    expect(screen.getByText('Synthetic confirmed empty')).toBeVisible();
    expect(screen.queryByText('Synthetic failure')).not.toBeInTheDocument();
    expect(screen.queryByText('Synthetic pending')).not.toBeInTheDocument();
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

  it('filters by authentication type and shows each connection’s type', async () => {
    mockLoad.mockResolvedValue(syntheticSnapshot([
      syntheticConnection({ id: 'principal', displayName: 'Synthetic principal', credentialType: 'ServicePrincipal' }),
      syntheticConnection({ id: 'oauth', displayName: 'Synthetic oauth', credentialType: 'OAuth2' }),
    ]));
    render(<App />);
    await screen.findByText('Synthetic principal');
    const select = screen.getByRole('combobox', { name: 'Authentication type' });
    expect(within(select).getAllByRole('option').map((option) => option.textContent))
      .toEqual(['All authentication types', 'OAuth2', 'Service Principal']);

    fireEvent.change(select, { target: { value: 'ServicePrincipal' } });
    expect(screen.getByText('Synthetic principal')).toBeVisible();
    expect(screen.queryByText('Synthetic oauth')).not.toBeInTheDocument();
    expect(within(screen.getByRole('table')).getByText('Auth: Service Principal')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByText('Synthetic oauth')).toBeVisible();
  });

  it('shows directory names next to owner IDs and explains how to enable names that cannot be read', async () => {
    const user = '11111111-1111-4111-8111-111111111111';
    const group = '22222222-2222-4222-8222-222222222222';
    mockLoad.mockResolvedValue(syntheticSnapshot([syntheticConnection({
      owners: [{ id: user, type: 'User', role: 'Owner' }, { id: group, type: 'Group', role: 'Owner' }],
    })]));
    vi.mocked(getDirectoryAccessToken).mockResolvedValue('synthetic-graph-token');
    const lookup = vi.spyOn(DirectoryLookup.prototype, 'lookupPrincipals').mockResolvedValueOnce([
      { id: user, result: { status: 'resolved', displayName: 'Synthetic Owner', userPrincipalName: 'owner@example.test' } },
      { id: group, result: { status: 'denied' } },
    ]);
    render(<App />);
    const table = within(await screen.findByRole('table'));

    expect(await table.findByText('Synthetic Owner')).toBeVisible();
    expect(table.getByText(user)).toBeVisible();
    expect(table.getByText('owner@example.test')).toBeVisible();
    expect(table.getByText(group)).toBeVisible();
    expect(screen.getByText('Some owner names can’t be read')).toBeVisible();
    expect(screen.getByText('GroupMember.Read.All')).toBeVisible();

    lookup.mockResolvedValueOnce([{ id: group, result: { status: 'resolved', displayName: 'Synthetic Group' } }]);
    fireEvent.click(screen.getByRole('button', { name: 'Retry name lookups' }));
    expect(await table.findByText('Synthetic Group')).toBeVisible();
    expect(getDirectoryAccessToken).toHaveBeenLastCalledWith(true);
    expect(lookup).toHaveBeenLastCalledWith([{ id: group, type: 'Group' }]);
    expect(screen.queryByText('Some owner names can’t be read')).not.toBeInTheDocument();
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
