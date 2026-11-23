import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_THROTTLE_WAIT_MS, FabricInventory, InventoryError, connection, delay, requireTenantAdminToken, safeResult,
} from '../dist/fabric-api.js';

const first = '11111111-1111-4111-8111-111111111111';
const second = '22222222-2222-4222-8222-222222222222';
const third = '44444444-4444-4444-8444-444444444444';
const tenant = '33333333-3333-4333-8333-333333333333';
const json = (body) => Response.json(body);
const throttled = (body, headers = {}) => new Response(body === undefined ? null : JSON.stringify(body), {
  status: 429, headers: { 'content-type': 'application/json', ...headers },
});
const assignment = (id, role = 'Owner') => ({ role, principal: { id, type: 'User', displayName: 'Synthetic owner', userDetails: { userPrincipalName: 'owner@example.test' } } });

test('only returns requested metadata, never credential payloads', () => {
  const row = connection({ id: first, displayName: 'Synthetic SQL', connectionDetails: { type: 'SQL', path: 'example.test;db' }, credentialDetails: { credentialType: 'Basic', credentials: { password: 'synthetic-secret' } } });
  assert.equal(row.endpoint, 'example.test;db');
  assert.equal(row.connectorType, 'SQL');
  assert.equal(row.credentialType, 'Basic');
  assert.ok(!JSON.stringify(row).includes('synthetic-secret'));
});

test('uses the admin path, encodes pagination once, and ignores continuation URI destinations', async () => {
  const api = new FabricInventory('synthetic', async (url, options) => {
    assert.equal(new URL(url).pathname, '/v1/admin/connections');
    assert.equal(new URL(url).searchParams.get('continuationToken'), 'a%3D&b');
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    return json({ value: [{ id: first }], continuationToken: 'next', continuationUri: 'https://attacker.invalid' });
  });
  assert.equal((await api.listConnections('a%3D&b')).nextToken, 'next');
});

test('all owners across all role pages, with PendingOwner separate and User excluded', async () => {
  let calls = 0;
  const api = new FabricInventory('synthetic', async (url) => {
    calls++;
    assert.equal(new URL(url).pathname, `/v1/admin/connections/${first}/roleAssignments`);
    return calls === 1 ? json({ value: [assignment(first), assignment(second, 'User')], continuationToken: 'next' }) :
      json({ value: [assignment(second, 'PendingOwner')] });
  });
  const result = await api.listConnectionOwners([first]);
  assert.equal(calls, 2);
  assert.equal(result.results[0].result.ok, true);
  assert.deepEqual(result.results[0].result.data.map((item) => item.role), ['Owner', 'PendingOwner']);
  assert.equal(result.results[0].result.data[0].userPrincipalName, 'owner@example.test');
});

test('a failed ownership lookup is not represented as an empty owner list', async () => {
  const api = new FabricInventory('synthetic', async (url) => url.includes(first) ?
    new Response(null, { status: 403, headers: { 'request-id': 'synthetic-request' } }) : json({ value: [] }));
  const result = await api.listConnectionOwners([first, second]);
  assert.equal(result.results[0].result.ok, false);
  assert.equal(result.results[0].result.error.requestId, 'synthetic-request');
  assert.deepEqual(result.results[1].result, { ok: true, data: [] });
});

test('malformed response fails rather than looking like an empty tenant', async () => {
  const result = await safeResult(() => new FabricInventory('synthetic', async () => json({ unexpected: [] })).listConnections(''));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'InvalidApiResponse');
});

test('does not bind native browser fetch to the inventory class instance', async () => {
  const api = new FabricInventory('synthetic', async function () {
    assert.equal(this, undefined);
    return json({ value: [] });
  });
  assert.deepEqual(await api.listConnections(''), { connections: [], nextToken: null });
});

test('repeated ownership continuation token returns explicit incomplete failure', async () => {
  const api = new FabricInventory('synthetic', async () => json({ value: [], continuationToken: 'loop' }));
  const result = await api.listConnectionOwners([first]);
  assert.equal(result.results[0].result.error.code, 'PaginationLoop');
});

test('reports Retry-After as a retry time instead of waiting inside the request', async () => {
  let count = 0;
  const delays = [];
  const api = new FabricInventory('synthetic', async () => {
    count++;
    return throttled(undefined, { 'retry-after': '7' });
  }, () => 1_000, async (ms) => { delays.push(ms); });
  await assert.rejects(() => api.listConnections(''), (error) =>
    error.failure.code === 'FabricHttp429' && error.failure.status === 429 && error.failure.retryAt === 8_000);
  assert.equal(count, 1);
  assert.deepEqual(delays, []);
});

test('does not call Fabric during a throttling window, then continues with the next batch token', async () => {
  let clock = 0;
  const tokens = [];
  const api = new FabricInventory('first-token', async (url, options) => {
    tokens.push(options.headers.Authorization);
    return tokens.length === 1 ? throttled(undefined, { 'retry-after': '30' }) : json({ value: [] });
  }, () => clock, async (ms) => { clock += ms; });
  await assert.rejects(() => api.listConnections(''), (error) => error.failure.retryAt === 30_000);
  clock = 29_000;
  await assert.rejects(() => api.listConnections(''), (error) =>
    error.failure.code === 'FabricHttp429' && error.failure.retryAt === 30_000);
  assert.equal(tokens.length, 1);
  clock = 30_000;
  assert.deepEqual(await api.nextBatch('second-token').listConnections(''), { connections: [], nextToken: null });
  assert.deepEqual(tokens, ['Bearer first-token', 'Bearer second-token']);
});

test('reads the blocked-until time from the throttling body when CORS hides Retry-After', async () => {
  const now = Date.UTC(2026, 1, 18, 22, 44, 0);
  let count = 0;
  const result = await safeResult(() => new FabricInventory('synthetic', async () => {
    count++;
    return throttled({
      errorCode: 'RequestBlocked',
      message: 'Request is blocked by the upstream service until: 2/18/2026 10:45:04 PM (UTC)',
    });
  }, () => now).listConnections(''));
  assert.equal(count, 1);
  assert.equal(result.error.code, 'FabricHttp429');
  assert.equal(result.error.status, 429);
  // One second of margin after the time Fabric reported.
  assert.equal(result.error.retryAt, Date.UTC(2026, 1, 18, 22, 45, 5));
});

test('falls back to one quota window when no plausible retry time is readable', async () => {
  const now = Date.UTC(2026, 1, 18, 22, 44, 0);
  const blocked = (until) => ({ errorCode: 'RequestBlocked', message: `Request is blocked by the upstream service until: ${until} (UTC)` });
  const capacity = {
    errorCode: 'CapacityLimitExceeded',
    message: "Your organization's Fabric compute capacity has exceeded its limits. Try again later.",
  };
  for (const body of [undefined, capacity, blocked('2/31/2026 10:45:04 PM'), blocked('2/20/2026 10:45:04 PM'), blocked('2/18/2026 9:00:00 PM')]) {
    const api = new FabricInventory('synthetic', async () => throttled(body), () => now);
    await assert.rejects(() => api.listConnections(''), (error) => error.failure.retryAt === now + DEFAULT_THROTTLE_WAIT_MS);
  }
  const api = new FabricInventory('synthetic', async () => throttled(capacity), () => now);
  await assert.rejects(() => api.listConnections(''), (error) => /capacity is overloaded/.test(error.failure.message));
});

test('reserves separate request slots for concurrent owner lookups', async () => {
  const delays = [];
  const api = new FabricInventory('synthetic', async () => json({ value: [] }), () => 0, async (ms) => { delays.push(ms); });
  const result = await api.listConnectionOwners([first, second, third]);
  assert.ok(result.results.every((lookup) => lookup.result.ok));
  assert.deepEqual(delays, [200, 400]);
});

test('doubles the gap between requests after throttling', async () => {
  let clock = 0;
  let status = 200;
  const delays = [];
  const api = new FabricInventory('synthetic', async () => status === 429 ?
    throttled(undefined, { 'retry-after': '1' }) : json({ value: [] }),
  () => clock, async (ms) => { delays.push(ms); clock += ms; });
  await api.listConnections('');
  await api.listConnections('');
  status = 429;
  await assert.rejects(() => api.listConnections(''), (error) => error.failure.retryAt === 1_400);
  status = 200;
  clock = 1_400;
  await api.listConnections('');
  await api.listConnections('');
  assert.deepEqual(delays, [200, 200, 400]);
});

test('reports a 503 that persists after bounded retries with its status', async () => {
  let count = 0;
  let clock = 0;
  const result = await safeResult(() => new FabricInventory('synthetic', async () => {
    count++;
    return new Response(null, { status: 503, headers: { 'retry-after': '1' } });
  }, () => clock, async (ms) => { clock += ms; }).listConnections(''));
  assert.equal(count, 3);
  assert.equal(result.error.code, 'FabricHttp503');
  assert.equal(result.error.status, 503);
});

test('reports a long 503 Retry-After with its retry time instead of sleeping through it', async () => {
  let count = 0;
  const delays = [];
  const api = new FabricInventory('synthetic', async () => {
    count++;
    return new Response(null, { status: 503, headers: { 'retry-after': '300' } });
  }, () => 0, async (ms) => { delays.push(ms); });
  await assert.rejects(() => api.listConnections(''), (error) =>
    error.failure.code === 'FabricHttp503' && error.failure.retryAt === 300_000);
  assert.equal(count, 1);
  assert.deepEqual(delays, []);
});

test('a user cancellation propagates as an abort, not a timeout or per-row failure', async () => {
  const controller = new AbortController();
  const api = new FabricInventory('synthetic', async () => {
    controller.abort();
    throw new DOMException('Cancelled', 'AbortError');
  }, Date.now, undefined, controller.signal);
  await assert.rejects(() => safeResult(() => api.listConnections('')), (error) => error.name === 'AbortError');
});

test('a cancellable delay rejects as soon as the run is cancelled', async () => {
  const controller = new AbortController();
  const started = Date.now();
  const waiting = delay(60_000, controller.signal);
  controller.abort();
  await assert.rejects(waiting, (error) => error.name === 'AbortError');
  assert.ok(Date.now() - started < 1_000);
});

test('403 is surfaced immediately, without user-scoped fallback or retry', async () => {
  let count = 0;
  const result = await safeResult(() => new FabricInventory('synthetic', async () => {
    count++;
    return new Response(null, { status: 403 });
  }).listConnections(''));
  assert.equal(result.error.status, 403);
  assert.equal(count, 1);
});

test('rejects invalid IDs, oversized batches, and URI-only pagination', async () => {
  const api = new FabricInventory('synthetic', async () => json({ value: [], continuationUri: 'https://example.test' }));
  await assert.rejects(() => api.listConnectionOwners(['../anything']), InventoryError);
  await assert.rejects(() => api.listConnectionOwners(Array(7).fill(first)), InventoryError);
  await assert.rejects(() => api.listConnections(''), (error) => error.failure.code === 'MissingContinuationToken');
});

test('tenant guard fails closed without leaking resource tokens', () => {
  const token = (tid) => `header.${Buffer.from(JSON.stringify({ tid, scp: 'Tenant.Read.All' })).toString('base64url')}.signature`;
  const valid = token(tenant);
  assert.equal(requireTenantAdminToken(() => valid, tenant), valid);
  assert.throws(() => requireTenantAdminToken(() => token(second), tenant), (error) => error.failure.code === 'WrongTenant');
  assert.throws(() => requireTenantAdminToken(() => { throw new Error('do not expose'); }, tenant), (error) => {
    assert.ok(!error.message.includes('do not expose'));
    return error.failure.code === 'FabricTokenUnavailable';
  });

});

test('valid tenant and user scopes do not substitute for the tenant-admin scope', () => {
  const token = `header.${Buffer.from(JSON.stringify({
    tid: tenant, scp: 'Workspace.ReadWrite.All Connection.ReadWrite.All',
  })).toString('base64url')}.signature`;
  assert.throws(() => requireTenantAdminToken(() => token, tenant), (error) => {
    assert.ok(!error.message.includes(token));
    return error.failure.code === 'AdminScopeMissing';
  });
});

test('requires a valid explicit expected tenant before reading a token', () => {
  for (const expected of [undefined, '', 'common', 'organizations', 'invalid', '00000000-0000-0000-0000-000000000000']) {
    let tokenReads = 0;
    assert.throws(() => requireTenantAdminToken(() => { tokenReads++; return 'unused'; }, expected),
      (error) => error.failure.code === 'InvalidTenantConfiguration');
    assert.equal(tokenReads, 0);
  }
});

test('requires delegated Tenant.Read.All instead of application roles or write-only consent', () => {
  const encode = (claims) => `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
  assert.throws(() => requireTenantAdminToken(() => encode({ tid: tenant, roles: ['Tenant.Read.All'] }), tenant),
    (error) => error.failure.code === 'DelegatedTokenRequired');
  assert.throws(() => requireTenantAdminToken(() => encode({ tid: tenant, scp: 'Tenant.ReadWrite.All' }), tenant),
    (error) => error.failure.code === 'AdminScopeMissing');
});
