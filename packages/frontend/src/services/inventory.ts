import {
  DEFAULT_THROTTLE_WAIT_MS, FabricInventory, delay, safeResult,
  type ApiFailure, type InventorySnapshot, type LoadInventoryOptions, type OwnerLookup,
} from '@rayfin-app/shared';
import { AdminAuthError, getAdminAccessToken } from '@/services/admin-auth';

const OWNER_BATCH_SIZE = 6;
/** Throttling pauses in a row without a completed request before the run stops; owner lookups can then be resumed. */
const MAX_PAUSES_WITHOUT_PROGRESS = 3;
/** Fabric may ask for longer waits; the run then stops and reports when to resume instead of waiting unattended. */
const MAX_AUTOMATIC_PAUSE_MS = 10 * 60_000;
const MAX_BACKOFF_MS = 4 * 60_000;

function requestFailure(): ApiFailure {
  return {
    code: 'InventoryRequestFailed',
    message: 'The app could not complete its inventory request. Check admin sign-in, the app’s admin consent, and network access, then retry.',
  };
}

function isTransient(error: ApiFailure): boolean {
  return error.status === 429 || error.status === 503;
}

function formatTime(value: number): string {
  return new Date(value).toLocaleTimeString();
}

function waitForRequest<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('Cancelled', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    operation.then(
      (value) => { signal.removeEventListener('abort', abort); resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', abort); reject(error); },
    );
  });
}

export async function loadInventory({ signal, onProgress, resumeFrom }: LoadInventoryOptions): Promise<InventorySnapshot> {
  let snapshot: InventorySnapshot = resumeFrom?.inventoryComplete ? {
    ...resumeFrom, phase: 'owners', updatedAt: null, error: undefined, pausedUntil: undefined,
  } : {
    connections: [], inventoryComplete: false, phase: 'connections', updatedAt: null,
  };
  const publish = () => {
    signal.throwIfAborted();
    onProgress(snapshot);
  };
  publish();
  let pausesWithoutProgress = 0;

  /** Waits until Fabric accepts requests again. Returns false, with the run stopped, if it should not wait. */
  async function pause(failure: ApiFailure): Promise<boolean> {
    pausesWithoutProgress++;
    const now = Date.now();
    // Throttling that persists without progress backs off exponentially, as Fabric recommends.
    const backoff = pausesWithoutProgress > 1 ?
      Math.min(DEFAULT_THROTTLE_WAIT_MS * 2 ** (pausesWithoutProgress - 1), MAX_BACKOFF_MS) : 0;
    const resumeAt = Math.max(failure.retryAt ?? now + DEFAULT_THROTTLE_WAIT_MS, now + backoff);
    const tooLong = resumeAt - now > MAX_AUTOMATIC_PAUSE_MS;
    if (tooLong || pausesWithoutProgress > MAX_PAUSES_WITHOUT_PROGRESS) {
      const reason = tooLong ?
        `Fabric asked the app to wait until ${formatTime(resumeAt)}, longer than it waits automatically.` :
        `Fabric still did not accept requests after ${MAX_PAUSES_WITHOUT_PROGRESS} automatic pauses.`;
      const next = snapshot.inventoryComplete ?
        `Completed owner results are kept; resume owner lookups after ${formatTime(resumeAt)}.` :
        `The connection list is incomplete; refresh the inventory after ${formatTime(resumeAt)}.`;
      snapshot = {
        ...snapshot,
        phase: 'error',
        pausedUntil: undefined,
        error: { ...failure, retryAt: resumeAt, message: `${failure.message} ${reason} ${next}` },
      };
      publish();
      return false;
    }
    snapshot = { ...snapshot, pausedUntil: resumeAt };
    publish();
    await delay(resumeAt - now, signal);
    snapshot = { ...snapshot, pausedUntil: undefined };
    publish();
    return true;
  }

  try {
    // One client per run, so request pacing and Fabric's throttling window apply across batches.
    let client: FabricInventory | undefined;
    const api = async () => {
      const token = await getAdminAccessToken();
      client = client ? client.nextBatch(token) : new FabricInventory(token, fetch, Date.now, undefined, signal);
      return client;
    };
    if (!snapshot.inventoryComplete) {
      const seenTokens = new Set<string>();
      const seenIds = new Set<string>();
      let continuationToken = '';
      let pages = 0;
      for (;;) {
        signal.throwIfAborted();
        if (pages >= 10_000) {
          snapshot = { ...snapshot, phase: 'error', error: { code: 'PageLimitExceeded', message: 'Connection enumeration reached the safety page limit; this inventory is incomplete.' } };
          publish();
          return snapshot;
        }
        const currentApi = await api();
        signal.throwIfAborted();
        const result = await waitForRequest(safeResult(() => currentApi.listConnections(continuationToken)), signal);
        signal.throwIfAborted();
        if (!result.ok) {
          // A throttled page is requested again with the same continuation token after the pause.
          if (isTransient(result.error)) {
            if (await pause(result.error)) continue;
            return snapshot;
          }
          snapshot = { ...snapshot, phase: 'error', error: result.error };
          publish();
          return snapshot;
        }
        pages++;
        pausesWithoutProgress = 0;
        const newRows = result.data.connections.filter((row) => {
          if (seenIds.has(row.id)) return false;
          seenIds.add(row.id);
          return true;
        }).map((row) => ({ ...row, owners: [], ownerStatus: 'pending' as const }));
        snapshot = { ...snapshot, connections: [...snapshot.connections, ...newRows] };
        publish();
        if (!result.data.nextToken) break;
        if (seenTokens.has(result.data.nextToken)) {
          snapshot = { ...snapshot, phase: 'error', error: { code: 'PaginationLoop', message: 'Fabric repeated a continuation token. The displayed connection inventory is incomplete.' } };
          publish();
          return snapshot;
        }
        seenTokens.add(result.data.nextToken);
        continuationToken = result.data.nextToken;
      }
      snapshot = { ...snapshot, inventoryComplete: true, phase: 'owners' };
      publish();
    }
    const rowIndex = new Map(snapshot.connections.map((row, index) => [row.id, index]));
    // A resumed run keeps successful owner results and looks up every other row again.
    const queue = snapshot.connections.filter((row) => row.ownerStatus !== 'loaded').map((row) => row.id);
    while (queue.length > 0) {
      signal.throwIfAborted();
      const connectionIds = queue.splice(0, OWNER_BATCH_SIZE);
      let lookups: OwnerLookup[];
      try {
        const currentApi = await api();
        signal.throwIfAborted();
        const batch = await waitForRequest(
          safeResult(() => currentApi.listConnectionOwners(connectionIds)), signal,
        );
        lookups = batch.ok ? batch.data.results : connectionIds.map((connectionId) => ({
          connectionId, result: { ok: false as const, error: batch.error },
        }));
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof AdminAuthError) throw error;
        lookups = connectionIds.map((connectionId) => ({
          connectionId, result: { ok: false as const, error: requestFailure() },
        }));
      }
      signal.throwIfAborted();
      const results = new Map(lookups.map((lookup) => [lookup.connectionId, lookup.result]));
      const connections = snapshot.connections.slice();
      const throttledIds: string[] = [];
      let throttle: ApiFailure | undefined;
      for (const connectionId of connectionIds) {
        const index = rowIndex.get(connectionId)!;
        const row = connections[index];
        const result = results.get(connectionId);
        if (result && !result.ok && isTransient(result.error)) {
          // Throttled rows keep their state and are looked up first after the pause.
          throttledIds.push(connectionId);
          // Keep the latest retry time; on ties, the earliest row is the response Fabric actually sent.
          if (!throttle || (result.error.retryAt ?? 0) > (throttle.retryAt ?? 0)) throttle = result.error;
          continue;
        }
        pausesWithoutProgress = 0;
        connections[index] = !result ?
          { ...row, ownerStatus: 'error', ownerError: { code: 'MissingOwnerResult', message: 'The function did not return this connection owner result.' } } :
          result.ok ? { ...row, owners: result.data, ownerStatus: 'loaded', ownerError: undefined } :
            { ...row, ownerStatus: 'error', ownerError: result.error };
      }
      snapshot = { ...snapshot, connections };
      publish();
      if (throttle) {
        queue.unshift(...throttledIds);
        if (!(await pause(throttle))) return snapshot;
      }
    }
    snapshot = { ...snapshot, phase: 'done', updatedAt: new Date().toISOString() };
  } catch (error) {
    signal.throwIfAborted();
    snapshot = { ...snapshot, phase: 'error', pausedUntil: undefined, error: error instanceof AdminAuthError ?
      { code: error.code, message: error.message } : requestFailure() };
  }
  publish();
  return snapshot;
}
