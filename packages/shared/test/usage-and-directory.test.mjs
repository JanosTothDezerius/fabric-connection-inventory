import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DirectoryLookup, InventoryError, WorkspaceScanner, connectionUsageFromScan, isDirectoryPrincipal, requireDirectoryToken,
} from '../dist/index.js';

const workspace = '11111111-1111-4111-8111-111111111111';
const otherWorkspace = '22222222-2222-4222-8222-222222222222';
const connection = '33333333-3333-4333-8333-333333333333';
const otherConnection = '44444444-4444-4444-8444-444444444444';
const scanId = '55555555-5555-4555-8555-555555555555';
const user = '66666666-6666-4666-8666-666666666666';
const group = '77777777-7777-4777-8777-777777777777';
const servicePrincipal = '88888888-8888-4888-8888-888888888888';
const deleted = '99999999-9999-4999-8999-999999999999';
const busy = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const tenant = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const json = (body) => Response.json(body);

test('lists every workspace once, including personal and inactive workspaces', async () => {
  const api = new WorkspaceScanner('synthetic', async (url, options) => {
    const target = new URL(url);
    assert.equal(target.origin + target.pathname, 'https://api.powerbi.com/v1.0/myorg/admin/workspaces/modified');
    assert.equal(target.searchParams.get('excludePersonalWorkspaces'), 'false');
    assert.equal(target.searchParams.get('excludeInActiveWorkspaces'), 'false');
    assert.equal(options.method, 'GET');
    return json([{ id: workspace }, { id: workspace.toUpperCase() }, { id: otherWorkspace }]);
  });
  assert.deepEqual(await api.listWorkspaceIds(), [workspace, otherWorkspace]);
});

test('scans only data source usage and lineage, polling by scan ID', async () => {
  const calls = [];
  const api = new WorkspaceScanner('synthetic', async (url, options) => {
    const target = new URL(url);
    calls.push(`${options.method} ${target.pathname}`);
    if (target.pathname.endsWith('/getInfo')) {
      assert.deepEqual([...target.searchParams.keys()].sort(), ['datasourceDetails', 'lineage']);
      assert.equal(target.searchParams.get('lineage'), 'True');
      assert.equal(target.searchParams.get('datasourceDetails'), 'True');
      assert.equal(options.headers['Content-Type'], 'application/json');
      assert.deepEqual(JSON.parse(options.body), { workspaces: [workspace, otherWorkspace] });
      return json({ id: scanId, status: 'NotStarted' });
    }
    if (target.pathname.endsWith(`/scanStatus/${scanId}`)) return json({ id: scanId, status: 'Succeeded' });
    return json({ workspaces: [] });
  }, () => 0, async () => {});
  assert.deepEqual(await api.startScan([workspace, otherWorkspace]), { id: scanId, status: 'NotStarted' });
  assert.equal((await api.scanStatus(scanId)).status, 'Succeeded');
  assert.equal((await api.scanResult(scanId)).workspaceCount, 0);
  assert.deepEqual(calls, [
    'POST /v1.0/myorg/admin/workspaces/getInfo',
    `GET /v1.0/myorg/admin/workspaces/scanStatus/${scanId}`,
    `GET /v1.0/myorg/admin/workspaces/scanResult/${scanId}`,
  ]);
});

test('rejects empty, oversized, duplicate or invalid workspace batches before calling the scanner', async () => {
  let calls = 0;
  const api = new WorkspaceScanner('synthetic', async () => { calls++; return json({}); });
  const many = Array.from({ length: 101 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`);
  for (const ids of [[], many, [workspace, workspace], ['../anything']]) {
    await assert.rejects(() => api.startScan(ids), (error) => error instanceof InventoryError && error.failure.code === 'InvalidInput');
  }
  assert.equal(calls, 0);
});

test('maps every item type that reports data source usage to its connection', () => {
  const usage = connectionUsageFromScan({
    workspaces: [
      {
        id: workspace, name: 'Synthetic finance', state: 'Active',
        reports: [{ id: 'report-1', name: 'Report without data sources' }],
        datasets: [{
          id: 'model-1', name: 'Synthetic model',
          datasourceUsages: [{ datasourceInstanceId: connection.toUpperCase() }],
          misconfiguredDatasourceUsages: [{ datasourceInstanceId: connection }],
        }],
        dataflows: [{
          objectId: 'dataflow-1', name: 'Synthetic dataflow',
          datasourceUsages: [{ datasourceInstanceId: connection }],
          misconfiguredDatasourceUsages: [{ datasourceInstanceId: otherConnection }],
        }],
        DataPipeline: [{ id: 'pipeline-1', displayName: 'Synthetic pipeline', DatasourceUsages: [{ DatasourceInstanceId: otherConnection }] }],
        KQLDatabase: [{ id: 'kql-1', name: 'Synthetic KQL', datasourceUsages: [{ datasourceInstanceId: otherConnection }] }],
      },
      {
        id: otherWorkspace, name: 'Synthetic archive', state: 'Deleted',
        datamarts: [{ id: 'datamart-1', name: 'Synthetic datamart', datasourceUsages: [{ datasourceInstanceId: connection }, { datasourceInstanceId: 'not-a-guid' }] }],
      },
    ],
  });

  assert.equal(usage.workspaceCount, 2);
  assert.deepEqual(usage.itemsByConnection.get(connection), [
    { id: 'model-1', name: 'Synthetic model', type: 'Semantic model', workspaceId: workspace, workspaceName: 'Synthetic finance' },
    { id: 'dataflow-1', name: 'Synthetic dataflow', type: 'Dataflow', workspaceId: workspace, workspaceName: 'Synthetic finance' },
    {
      id: 'datamart-1', name: 'Synthetic datamart', type: 'Datamart', workspaceId: otherWorkspace,
      workspaceName: 'Synthetic archive', workspaceState: 'Deleted',
    },
  ]);
  assert.deepEqual(usage.itemsByConnection.get(otherConnection), [
    { id: 'dataflow-1', name: 'Synthetic dataflow', type: 'Dataflow', workspaceId: workspace, workspaceName: 'Synthetic finance', misconfigured: true },
    { id: 'pipeline-1', name: 'Synthetic pipeline', type: 'Data pipeline', workspaceId: workspace, workspaceName: 'Synthetic finance' },
    { id: 'kql-1', name: 'Synthetic KQL', type: 'KQL database', workspaceId: workspace, workspaceName: 'Synthetic finance' },
  ]);
  assert.equal(usage.itemsByConnection.size, 2);
});

test('a scan result without a workspace list is rejected rather than read as unused connections', () => {
  assert.throws(() => connectionUsageFromScan({ value: [] }), (error) => error.failure.code === 'InvalidApiResponse');
});

test('looks up users, groups and service principals with basic-profile selects in one Graph batch', async () => {
  const principals = [
    { id: user, type: 'User' },
    { id: group, type: 'Group' },
    { id: servicePrincipal, type: 'ServicePrincipal' },
    { id: deleted, type: 'User' },
    { id: busy, type: 'Group' },
  ];
  const api = new DirectoryLookup('synthetic', async (url, options) => {
    assert.equal(url, 'https://graph.microsoft.com/v1.0/$batch');
    assert.equal(options.method, 'POST');
    assert.equal(options.credentials, 'omit');
    assert.deepEqual(JSON.parse(options.body).requests.map((request) => `${request.id} ${request.method} ${request.url}`), [
      `0 GET /users/${user}?$select=id,displayName,userPrincipalName,mail`,
      `1 GET /groups/${group}?$select=id,displayName,mail`,
      `2 GET /servicePrincipals/${servicePrincipal}?$select=id,displayName,appId`,
      `3 GET /users/${deleted}?$select=id,displayName,userPrincipalName,mail`,
      `4 GET /groups/${busy}?$select=id,displayName,mail`,
    ]);
    // Graph may answer batch requests in any order.
    return json({
      responses: [
        { id: '2', status: 200, body: { id: servicePrincipal, displayName: 'Synthetic automation', appId: tenant } },
        { id: '4', status: 429, headers: { 'Retry-After': '5' }, body: {} },
        { id: '0', status: 200, body: { id: user, displayName: 'Synthetic Owner', userPrincipalName: 'owner@example.test', mail: null } },
        { id: '3', status: 404, body: { error: { code: 'Request_ResourceNotFound' } } },
        { id: '1', status: 403, body: { error: { code: 'Authorization_RequestDenied' } } },
      ],
    });
  }, () => 1_000);

  assert.deepEqual(await api.lookupPrincipals(principals), [
    { id: user, result: { status: 'resolved', displayName: 'Synthetic Owner', userPrincipalName: 'owner@example.test', mail: undefined, appId: undefined } },
    { id: group, result: { status: 'denied' } },
    { id: servicePrincipal, result: { status: 'resolved', displayName: 'Synthetic automation', userPrincipalName: undefined, mail: undefined, appId: tenant } },
    { id: deleted, result: { status: 'notFound' } },
    { id: busy, result: { status: 'failed', error: { code: 'GraphHttp429', message: 'Microsoft Graph is throttling requests.', status: 429, retryAt: 6_000 } } },
  ]);
});

test('a missing Graph batch response is a failure, not an absent name', async () => {
  const api = new DirectoryLookup('synthetic', async () => json({ responses: [] }));
  const [lookup] = await api.lookupPrincipals([{ id: user, type: 'User' }]);
  assert.equal(lookup.result.status, 'failed');
  assert.equal(lookup.result.error.code, 'MissingDirectoryResult');
});

test('only users, groups and service principals with GUIDs are sent to Microsoft Graph', async () => {
  assert.equal(isDirectoryPrincipal({ id: user, type: 'user' }), true);
  for (const principal of [
    { id: user, type: 'ServicePrincipalProfile' }, { id: user, type: 'EntireTenant' }, { id: user, type: 'constructor' },
    { id: 'not-a-guid', type: 'User' },
  ]) assert.equal(isDirectoryPrincipal(principal), false);
  let calls = 0;
  const api = new DirectoryLookup('synthetic', async () => { calls++; return json({ responses: [] }); });
  const tooMany = Array.from({ length: 21 }, (_, index) => ({ id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, type: 'User' }));
  for (const principals of [[], tooMany, [{ id: user, type: 'User' }, { id: user.toUpperCase(), type: 'User' }], [{ id: user, type: 'EntireTenant' }]]) {
    await assert.rejects(() => api.lookupPrincipals(principals), (error) => error.failure.code === 'InvalidInput');
  }
  assert.equal(calls, 0);
});

test('the Graph token guard pins the tenant and requires a delegated token', () => {
  const encode = (claims) => `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
  const valid = encode({ tid: tenant, scp: 'User.ReadBasic.All GroupMember.Read.All' });
  assert.equal(requireDirectoryToken(valid, tenant), valid);
  assert.throws(() => requireDirectoryToken(encode({ tid: workspace, scp: 'User.ReadBasic.All' }), tenant), (error) => error.failure.code === 'WrongTenant');
  assert.throws(() => requireDirectoryToken(encode({ tid: tenant, roles: ['User.Read.All'] }), tenant), (error) => error.failure.code === 'DelegatedTokenRequired');
  assert.throws(() => requireDirectoryToken('not-a-token', tenant), (error) => {
    assert.ok(!error.message.includes('not-a-token'));
    return error.failure.code === 'InvalidResourceToken';
  });
  assert.throws(() => requireDirectoryToken(valid, '00000000-0000-0000-0000-000000000000'), (error) => error.failure.code === 'InvalidTenantConfiguration');
});
