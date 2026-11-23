import type {
  ApiFailure, ApiResult, ConnectionOwner, ConnectionPage, ConnectionRecord, OwnerBatch,
} from './index.js';

const API_ROOT = 'https://api.fabric.microsoft.com/v1/admin/connections';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 25_000;
/** Minimum gap between request starts, so a large tenant does not burst through the caller's quota. */
const REQUEST_INTERVAL_MS = 200;
/** Throttling doubles the gap for the rest of the run, up to this limit. */
const MAX_REQUEST_INTERVAL_MS = 3_000;
/** Many Fabric rate limits use fixed one-minute windows; wait one window when no retry time is readable. */
export const DEFAULT_THROTTLE_WAIT_MS = 60_000;
/** A 503 is retried in place only for short waits; longer waits are reported with their retry time. */
const MAX_IN_PLACE_RETRY_MS = 30_000;
/** A retry time read from a throttling message is trusted only within these bounds. */
const MAX_MESSAGE_HINT_MS = 24 * 60 * 60_000;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;
// Fabric's RequestBlocked message, for example:
// "Request is blocked by the upstream service until: 2/18/2026 10:45:04 PM (UTC)"
const BLOCKED_UNTIL = /\buntil:?\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s*([AP]M)?\s*\(UTC\)/i;

/** Resolves after `ms`, or rejects with the abort reason as soon as `signal` aborts. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancelled = () => signal?.reason ?? new DOMException('Cancelled', 'AbortError');
    if (signal?.aborted) {
      reject(cancelled());
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(cancelled());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, Math.max(0, ms));
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function retryAfterMs(value: string | null, now: number): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed) * 1_000;
  const date = Date.parse(trimmed);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

function blockedUntil(message: unknown): number | undefined {
  if (typeof message !== 'string') return undefined;
  const match = BLOCKED_UNTIL.exec(message);
  if (!match) return undefined;
  const [month, day, year, hour, minute, second] = match.slice(1, 7).map(Number);
  const meridiem = match[7]?.toUpperCase();
  if (meridiem ? hour < 1 || hour > 12 : hour > 23) return undefined;
  const time = Date.UTC(year, month - 1, day, meridiem ? hour % 12 + (meridiem === 'PM' ? 12 : 0) : hour, minute, second);
  const parsed = new Date(time);
  // Date.UTC silently rolls over impossible values such as 2/31; reject them instead.
  return parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day && minute < 60 && second < 60 ?
    time : undefined;
}

function throttleRetryAt(header: string | null, message: unknown, now: number): number | undefined {
  const wait = retryAfterMs(header, now);
  if (wait !== undefined) return now + wait;
  // Browsers cannot read Retry-After unless Fabric exposes it to CORS, but the response body is readable.
  const until = blockedUntil(message);
  if (until === undefined || until - now > MAX_MESSAGE_HINT_MS || now - until > MAX_CLOCK_SKEW_MS) return undefined;
  return Math.max(until + 1_000, now + 1_000);
}

/** Reads a body up to `maxBytes`; returns null when it is larger. */
async function readText(response: Response, maxBytes: number): Promise<string | null> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(result.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return text + decoder.decode();
}

async function readErrorBody(response: Response): Promise<Record<string, unknown>> {
  try {
    const text = await readText(response, MAX_ERROR_BODY_BYTES);
    const body: unknown = text ? JSON.parse(text) : undefined;
    return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export class InventoryError extends Error {
  constructor(readonly failure: ApiFailure) {
    super(failure.message);
  }
}

function invalidResponse(): never {
  throw new InventoryError({
    code: 'InvalidApiResponse',
    message: 'Fabric returned an unexpected response. No incomplete page has been treated as complete.',
  });
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidResponse();
  return value as Record<string, unknown>;
}

function text(value: unknown, required = false): string | undefined {
  if (value === undefined || value === null) {
    if (required) invalidResponse();
    return undefined;
  }
  if (typeof value !== 'string' || value.length > 32_768) invalidResponse();
  return value;
}

function child(value: unknown): Record<string, unknown> {
  return value === undefined || value === null ? {} : object(value);
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) invalidResponse();
  return value;
}

function page(value: unknown): { values: unknown[]; nextToken: string | null } {
  const body = object(value);
  if (!Array.isArray(body.value) || body.value.length > 10_000) invalidResponse();
  const nextToken = text(body.continuationToken) || null;
  if (body.continuationUri && !nextToken) {
    throw new InventoryError({
      code: 'MissingContinuationToken',
      message: 'Fabric returned a continuation URI without a token. Enumeration stopped to avoid missing records.',
    });
  }
  return { values: body.value, nextToken };
}

export function connection(value: unknown): ConnectionRecord {
  const row = object(value);
  const details = child(row.connectionDetails);
  const credentials = child(row.credentialDetails);
  const recency = child(row.connectionRecency);
  return {
    id: identifier(row.id),
    displayName: text(row.displayName) || '(unnamed connection)',
    connectorType: text(details.type) || 'Not returned',
    connectivityType: text(row.connectivityType) || 'Not returned',
    endpoint: text(details.path) || 'Not returned',
    privacyLevel: text(row.privacyLevel),
    gatewayId: text(row.gatewayId),
    credentialType: text(credentials.credentialType),
    createdDateTime: text(recency.createdDateTime),
    lastCredentialUsedDateTime: text(recency.lastCredentialUsedDateTime),
  };
}

function owner(value: unknown): ConnectionOwner | null {
  const assignment = object(value);
  const role = text(assignment.role, true);
  if (role !== 'Owner' && role !== 'PendingOwner') return null;
  const principal = object(assignment.principal);
  return {
    id: identifier(principal.id),
    type: text(principal.type, true)!,
    displayName: text(principal.displayName),
    userPrincipalName: text(child(principal.userDetails).userPrincipalName),
    role,
  };
}

export async function safeResult<T>(operation: () => Promise<T>): Promise<ApiResult<T>> {
  try {
    const data = await operation();
    if (new TextEncoder().encode(JSON.stringify(data)).byteLength > MAX_OUTPUT_BYTES) {
      throw new InventoryError({
        code: 'OutputTooLarge',
        message: 'This API result exceeds the app response limit. No truncated result was returned.',
      });
    }
    return { ok: true, data };
  } catch (error) {
    // Cancellation ends the whole operation; it is not a per-request failure.
    if (error instanceof Error && error.name === 'AbortError') throw error;
    const failure: ApiFailure = error instanceof InventoryError ? error.failure : {
      code: 'UnexpectedFailure',
      message: 'The inventory request failed unexpectedly. Retry or check the Fabric API permissions.',
    };
    console.error('Connection inventory failure', failure.code, failure.status ?? '');
    return { ok: false, error: failure };
  }
}

export function requireTenantAdminToken(getToken: () => string, expectedTenantId: string): string {
  if (typeof expectedTenantId !== 'string' || !UUID.test(expectedTenantId) ||
    expectedTenantId === '00000000-0000-0000-0000-000000000000') {
    throw new InventoryError({
      code: 'InvalidTenantConfiguration',
      message: 'A valid, non-zero expected tenant GUID is required before requesting a Fabric resource token.',
    });
  }
  let token: string;
  try {
    token = getToken();
  } catch {
    throw new InventoryError({
      code: 'FabricTokenUnavailable',
      message: 'The Fabric access token is unavailable. Connect the dedicated admin account again.',
    });
  }
  let claims: unknown;
  try {
    const encoded = (token.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/');
    const decoded = atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '='));
    claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(decoded, (value) => value.charCodeAt(0))));
  } catch {
    throw new InventoryError({ code: 'InvalidResourceToken', message: 'The Fabric resource token could not be inspected for the configured tenant guard.' });
  }
  // Fabric validates the token; these checks only prevent wrong-tenant or wrong-scope requests.
  const metadata = object(claims);
  if (typeof metadata.tid !== 'string' || metadata.tid.toLowerCase() !== expectedTenantId.toLowerCase()) {
    throw new InventoryError({ code: 'WrongTenant', message: 'This app is restricted to its configured tenant. Connect a tenant administrator account in that directory.' });
  }
  if (typeof metadata.scp === 'string') {
    const scopes = metadata.scp.split(/\s+/);
    if (!scopes.includes('Tenant.Read.All')) {
      throw new InventoryError({
        code: 'AdminScopeMissing',
        message: 'Admin sign-in did not grant Tenant.Read.All. Reconnect using the dedicated app and confirm its delegated tenant-read consent. Changing connection ownership will not fix this.',
      });
    }
  } else {
    throw new InventoryError({ code: 'DelegatedTokenRequired', message: 'This app requires a delegated administrator sign-in, not an application-only token.' });
  }
  return token;
}

export class FabricInventory {
  private readonly sleep: (ms: number) => Promise<void>;
  private nextRequestAt = 0;
  private throttledUntil = 0;

  constructor(
    private token: string,
    private readonly request: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    sleep?: (ms: number) => Promise<void>,
    private readonly abortSignal?: AbortSignal,
    private requestIntervalMs = REQUEST_INTERVAL_MS,
  ) {
    this.sleep = sleep ?? ((ms) => delay(ms, abortSignal));
  }

  /** Uses a fresh token for the next request batch. Pacing and any throttling window carry over. */
  nextBatch(token: string): this {
    this.token = token;
    return this;
  }

  private assertNotThrottled(): void {
    if (this.throttledUntil > this.now()) {
      throw new InventoryError({
        code: 'FabricHttp429',
        message: 'Fabric is throttling requests.',
        status: 429,
        retryAt: this.throttledUntil,
      });
    }
  }

  /** Spaces request starts, including concurrent ones, and never calls Fabric during a throttling window. */
  private async waitForTurn(): Promise<void> {
    this.abortSignal?.throwIfAborted();
    this.assertNotThrottled();
    const now = this.now();
    const start = Math.max(now, this.nextRequestAt);
    this.nextRequestAt = start + this.requestIntervalMs;
    if (start > now) {
      await this.sleep(start - now);
      this.abortSignal?.throwIfAborted();
      this.assertNotThrottled();
    }
  }

  private async throttled(response: Response, requestId: string | undefined): Promise<InventoryError> {
    const body = await readErrorBody(response);
    const now = this.now();
    const retryAt = throttleRetryAt(response.headers.get('retry-after'), body.message, now) ??
      now + DEFAULT_THROTTLE_WAIT_MS;
    if (this.throttledUntil <= now) {
      // Fabric recommends reducing request volume after throttling; keep the slower pace for this run.
      this.requestIntervalMs = Math.min(Math.max(this.requestIntervalMs * 2, REQUEST_INTERVAL_MS), MAX_REQUEST_INTERVAL_MS);
    }
    this.throttledUntil = Math.max(this.throttledUntil, retryAt);
    return new InventoryError({
      code: 'FabricHttp429',
      message: body.errorCode === 'CapacityLimitExceeded' ?
        'The Fabric capacity is overloaded, so Fabric is throttling requests.' :
        'Fabric is throttling requests.',
      status: 429,
      requestId,
      retryAt: this.throttledUntil,
    });
  }

  private async get(path: string, continuationToken: string): Promise<unknown> {
    if (typeof continuationToken !== 'string' || continuationToken.length > 32_768) {
      throw new InventoryError({ code: 'InvalidInput', message: 'The continuation token is invalid.' });
    }
    const url = new URL(API_ROOT + path);
    if (continuationToken) url.searchParams.set('continuationToken', continuationToken);
    for (let attempt = 0; ; attempt++) {
      await this.waitForTurn();
      let response: Response;
      try {
        const request = this.request;
        response = await request(url.href, {
          method: 'GET',
          headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' },
          redirect: 'error',
          credentials: 'omit',
          signal: this.abortSignal ?
            AbortSignal.any([this.abortSignal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) :
            AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        // A user cancellation is not a timeout; let it propagate as an abort.
        this.abortSignal?.throwIfAborted();
        throw new InventoryError({
          code: error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError') ? 'RequestTimeout' : 'NetworkError',
          message: 'The Fabric API could not be reached within the request deadline. Retry the inventory.',
        });
      }
      const requestId = response.headers.get('request-id') ?? response.headers.get('requestid') ??
        response.headers.get('x-ms-request-id') ?? undefined;
      // Throttling is reported with its retry time; the caller decides whether to wait.
      if (response.status === 429) throw await this.throttled(response, requestId);
      if (response.status === 503 && attempt < 2) {
        const wait = retryAfterMs(response.headers.get('retry-after'), this.now()) ?? 1_000 * 2 ** attempt;
        await response.body?.cancel();
        if (wait > MAX_IN_PLACE_RETRY_MS) {
          throw new InventoryError({
            code: 'FabricHttp503',
            message: 'Fabric is temporarily unavailable.',
            status: 503,
            requestId,
            retryAt: this.now() + wait,
          });
        }
        await this.sleep(wait);
        this.abortSignal?.throwIfAborted();
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        const message = response.status === 403 ?
          'Access denied. Your signed-in account must be a Fabric administrator and have delegated Tenant.Read.All consent for this app.' :
          response.status === 401 ? 'Fabric rejected the resource token. Check its audience, expiry, consent, and the admin API identity requirements.' :
          response.status === 404 ? 'This connection or admin API was not found. The connection may have been deleted, or the preview API may be unavailable.' :
          response.status === 503 ? 'Fabric remained unavailable after bounded retries.' :
          `Fabric returned HTTP ${response.status}. Retry or use the request ID to investigate.`;
        throw new InventoryError({ code: `FabricHttp${response.status}`, message, status: response.status, requestId });
      }
      if (!response.body) invalidResponse();
      const responseText = await readText(response, MAX_RESPONSE_BYTES);
      if (responseText === null) {
        throw new InventoryError({ code: 'ResponseTooLarge', message: 'The Fabric API response exceeded the safe read limit. No partial page was accepted.' });
      }
      try {
        return JSON.parse(responseText) as unknown;
      } catch {
        invalidResponse();
      }
    }
  }

  async listConnections(continuationToken: string): Promise<ConnectionPage> {
    const result = page(await this.get('', continuationToken));
    return { connections: result.values.map(connection), nextToken: result.nextToken };
  }

  private async listOwners(connectionId: string): Promise<ConnectionOwner[]> {
    const owners = new Map<string, ConnectionOwner>();
    const tokens = new Set<string>();
    let token = '';
    for (let index = 0; index < 100; index++) {
      const result = page(await this.get(`/${connectionId}/roleAssignments`, token));
      for (const value of result.values) {
        const principal = owner(value);
        if (principal) owners.set(`${principal.type}:${principal.id}:${principal.role}`, principal);
      }
      if (!result.nextToken) return [...owners.values()];
      if (tokens.has(result.nextToken)) {
        throw new InventoryError({ code: 'PaginationLoop', message: 'Fabric repeated an ownership continuation token. Owner results are incomplete.' });
      }
      tokens.add(result.nextToken);
      token = result.nextToken;
    }
    throw new InventoryError({ code: 'PageLimitExceeded', message: 'Owner enumeration reached the 100-page safety limit. Owner results are incomplete.' });
  }

  async listConnectionOwners(connectionIds: string[]): Promise<OwnerBatch> {
    if (!Array.isArray(connectionIds) || connectionIds.length < 1 || connectionIds.length > 6 ||
        connectionIds.some((id) => typeof id !== 'string' || !UUID.test(id)) ||
        new Set(connectionIds).size !== connectionIds.length) {
      throw new InventoryError({ code: 'InvalidInput', message: 'Supply between one and six unique connection UUIDs.' });
    }
    const results: OwnerBatch['results'] = [];
    for (let start = 0; start < connectionIds.length; start += 3) {
      results.push(...await Promise.all(connectionIds.slice(start, start + 3).map(async (connectionId) => ({
        connectionId,
        result: await safeResult(() => this.listOwners(connectionId)),
      }))));
    }
    return { results };
  }
}
