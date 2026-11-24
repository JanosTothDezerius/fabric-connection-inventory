import {
  DEFAULT_THROTTLE_WAIT_MS, InventoryError, MAX_SCAN_WORKSPACES, WorkspaceScanner, delay,
  type ApiFailure, type DependentItem, type WorkspaceUsage,
} from '@rayfin-app/shared';
import { AdminAuthError, getPowerBiAdminAccessToken } from '@/services/admin-auth';

export interface UsageSnapshot {
  phase: 'workspaces' | 'scanning' | 'done' | 'error';
  /** Workspaces to scan; zero until the workspace list has loaded. */
  workspaceCount: number;
  scannedWorkspaces: number;
  /** Workspaces in scans that failed; their items are missing from the results. */
  failedWorkspaces: number;
  /** Dependent items keyed by lower-case connection ID. */
  itemsByConnection: ReadonlyMap<string, readonly DependentItem[]>;
  updatedAt: string | null;
  /** What stopped the scan or, when some workspaces could not be scanned, the latest scan failure. */
  error?: ApiFailure;
  /** Set while requests are paused for throttling: epoch milliseconds when they resume. */
  pausedUntil?: number;
}

export interface LoadUsageOptions {
  signal: AbortSignal;
  onProgress: (snapshot: UsageSnapshot) => void;
}

/** Well below the scanner's 16 simultaneous scans, leaving room for other admin tools in the tenant. */
const CONCURRENT_SCANS = 3;
const POLL_DELAYS_MS = [1_000, 2_000, 3_000, 5_000];
const MAX_SCAN_WAIT_MS = 10 * 60_000;
const MAX_PAUSES_WITHOUT_PROGRESS = 3;
const MAX_AUTOMATIC_PAUSE_MS = 10 * 60_000;
const MAX_BACKOFF_MS = 4 * 60_000;

export function emptyUsage(): UsageSnapshot {
  return {
    phase: 'workspaces', workspaceCount: 0, scannedWorkspaces: 0, failedWorkspaces: 0,
    itemsByConnection: new Map(), updatedAt: null,
  };
}

/** The whole scan cannot continue: no token, no access, or persistent throttling. */
class ScanStopped extends Error {
  constructor(readonly failure: ApiFailure) {
    super(failure.message);
  }
}

function isTransient(error: ApiFailure): boolean {
  return error.status === 429 || error.status === 503;
}

function failureOf(error: unknown): ApiFailure {
  if (error instanceof ScanStopped || error instanceof InventoryError) return error.failure;
  if (error instanceof AdminAuthError) return { code: error.code, message: error.message };
  return { code: 'UsageScanFailed', message: 'The workspace scan failed unexpectedly. Retry the scan.' };
}

/**
 * Scans every workspace with the admin scanner API and maps the items bound to each connection.
 * Results are published as each batch of up to 100 workspaces completes.
 */
export async function loadConnectionUsage({ signal, onProgress }: LoadUsageOptions): Promise<UsageSnapshot> {
  let snapshot = emptyUsage();
  const publish = () => {
    signal.throwIfAborted();
    onProgress(snapshot);
  };
  publish();
  let scanner: WorkspaceScanner | undefined;
  let pausesWithoutProgress = 0;
  let pausing: Promise<void> | undefined;

  async function pause(failure: ApiFailure): Promise<void> {
    pausesWithoutProgress++;
    const now = Date.now();
    const backoff = pausesWithoutProgress > 1 ?
      Math.min(DEFAULT_THROTTLE_WAIT_MS * 2 ** (pausesWithoutProgress - 1), MAX_BACKOFF_MS) : 0;
    const resumeAt = Math.max(failure.retryAt ?? now + DEFAULT_THROTTLE_WAIT_MS, now + backoff);
    if (resumeAt - now > MAX_AUTOMATIC_PAUSE_MS || pausesWithoutProgress > MAX_PAUSES_WITHOUT_PROGRESS) {
      throw new ScanStopped({
        ...failure, retryAt: resumeAt,
        message: `${failure.message} Retry the workspace scan after ${new Date(resumeAt).toLocaleTimeString()}.`,
      });
    }
    snapshot = { ...snapshot, pausedUntil: resumeAt };
    publish();
    await delay(resumeAt - now, signal);
    snapshot = { ...snapshot, pausedUntil: undefined };
    publish();
  }

  /** Sends one scanner request with a current token, waiting out throttling. */
  async function call<T>(operation: (client: WorkspaceScanner) => Promise<T>): Promise<T> {
    for (;;) {
      signal.throwIfAborted();
      let token: string;
      try {
        token = await getPowerBiAdminAccessToken();
      } catch (error) {
        throw new ScanStopped(failureOf(error));
      }
      signal.throwIfAborted();
      scanner = scanner ? scanner.nextBatch(token) : new WorkspaceScanner(token, fetch, Date.now, undefined, signal);
      try {
        const value = await operation(scanner);
        pausesWithoutProgress = 0;
        return value;
      } catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof InventoryError)) throw error;
        // Access problems affect every scan, so the run stops instead of failing each batch.
        if (error.failure.status === 401 || error.failure.status === 403) throw new ScanStopped(error.failure);
        if (!isTransient(error.failure)) throw error;
        // Concurrent scans wait out one shared pause instead of each counting towards the limit.
        pausing ??= pause(error.failure).finally(() => { pausing = undefined; });
        await pausing;
      }
    }
  }

  async function scanBatch(workspaceIds: string[]): Promise<WorkspaceUsage> {
    const started = await call((client) => client.startScan(workspaceIds));
    const deadline = Date.now() + MAX_SCAN_WAIT_MS;
    let status = started.status;
    for (let attempt = 0; status !== 'Succeeded'; attempt++) {
      if (status === 'Failed') {
        throw new InventoryError({ code: 'ScanFailed', message: 'Power BI reported that a workspace scan failed.' });
      }
      if (Date.now() > deadline) {
        throw new InventoryError({ code: 'ScanTimeout', message: 'A workspace scan did not finish within 10 minutes.' });
      }
      await delay(POLL_DELAYS_MS[Math.min(attempt, POLL_DELAYS_MS.length - 1)], signal);
      status = (await call((client) => client.scanStatus(started.id))).status;
    }
    return call((client) => client.scanResult(started.id));
  }

  function record(usage: WorkspaceUsage, workspaces: number) {
    let itemsByConnection = snapshot.itemsByConnection;
    if (usage.itemsByConnection.size > 0) {
      const next = new Map(itemsByConnection);
      for (const [connectionId, items] of usage.itemsByConnection) {
        next.set(connectionId, [...(next.get(connectionId) ?? []), ...items]);
      }
      itemsByConnection = next;
    }
    snapshot = { ...snapshot, itemsByConnection, scannedWorkspaces: snapshot.scannedWorkspaces + workspaces };
    publish();
  }

  try {
    const workspaceIds = await call((client) => client.listWorkspaceIds());
    snapshot = { ...snapshot, phase: 'scanning', workspaceCount: workspaceIds.length };
    publish();
    const batches: string[][] = [];
    for (let start = 0; start < workspaceIds.length; start += MAX_SCAN_WORKSPACES) {
      batches.push(workspaceIds.slice(start, start + MAX_SCAN_WORKSPACES));
    }
    let stopped: ScanStopped | undefined;
    const worker = async () => {
      while (!stopped && batches.length > 0) {
        const batch = batches.shift()!;
        try {
          record(await scanBatch(batch), batch.length);
        } catch (error) {
          signal.throwIfAborted();
          if (error instanceof ScanStopped) {
            stopped = error;
            return;
          }
          if (error instanceof InventoryError && error.failure.code === 'ResponseTooLarge' && batch.length > 1) {
            // Fewer workspaces per scan produce smaller results.
            const half = Math.ceil(batch.length / 2);
            batches.unshift(batch.slice(0, half), batch.slice(half));
            continue;
          }
          snapshot = { ...snapshot, failedWorkspaces: snapshot.failedWorkspaces + batch.length, error: failureOf(error) };
          publish();
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENT_SCANS, batches.length) }, worker));
    if (stopped) throw stopped;
    snapshot = { ...snapshot, phase: 'done', pausedUntil: undefined, updatedAt: new Date().toISOString() };
  } catch (error) {
    signal.throwIfAborted();
    snapshot = { ...snapshot, phase: 'error', pausedUntil: undefined, error: failureOf(error) };
  }
  publish();
  return snapshot;
}
