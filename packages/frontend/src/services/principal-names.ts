import {
  DirectoryLookup, InventoryError, MAX_DIRECTORY_BATCH, delay, isDirectoryPrincipal,
  type ApiFailure, type ConnectionRow, type DirectoryLookupResult, type PrincipalLookup, type PrincipalReference,
} from '@rayfin-app/shared';
import { AdminAuthError, getDirectoryAccessToken } from '@/services/admin-auth';

/** Throttled lookups are retried at most this many times in a row, waiting at most this long each time. */
const MAX_THROTTLED_ATTEMPTS = 3;
const MAX_THROTTLE_WAIT_MS = 2 * 60_000;
const DEFAULT_THROTTLE_WAIT_MS = 10_000;

export interface PrincipalNamesState {
  /** Lookup results keyed by lower-case principal ID. */
  results: ReadonlyMap<string, DirectoryLookupResult>;
  /** Lookups are queued or in flight. */
  loading: boolean;
  /** Why lookups are paused: no Microsoft Graph token is available. They continue after a retry. */
  unavailable?: ApiFailure;
}

/** Owners whose names Fabric did not return and that Microsoft Graph can look up, once each. */
export function principalsNeedingNames(rows: readonly ConnectionRow[]): PrincipalReference[] {
  const principals = new Map<string, PrincipalReference>();
  for (const row of rows) {
    for (const owner of row.owners) {
      const key = owner.id.toLowerCase();
      if (!owner.displayName && !principals.has(key) && isDirectoryPrincipal(owner)) {
        principals.set(key, { id: owner.id, type: owner.type });
      }
    }
  }
  return [...principals.values()];
}

function isTransient(error: ApiFailure): boolean {
  return error.status === 429 || error.status === 503;
}

/** Looks up each owner's name once, in batches, as new owners appear. */
export class NameResolver {
  private readonly principals = new Map<string, PrincipalReference>();
  private readonly controller = new AbortController();
  private queue: PrincipalReference[] = [];
  private results: ReadonlyMap<string, DirectoryLookupResult> = new Map();
  private running = false;
  private unavailable: ApiFailure | undefined;
  private forceRefresh = false;
  private client: DirectoryLookup | undefined;

  constructor(private readonly onChange: (state: PrincipalNamesState) => void) {}

  /** Queues principals that have not been looked up yet. */
  add(principals: readonly PrincipalReference[]): void {
    let added = false;
    for (const principal of principals) {
      const key = principal.id.toLowerCase();
      if (this.principals.has(key)) continue;
      this.principals.set(key, principal);
      this.queue.push(principal);
      added = true;
    }
    if (added) void this.run();
  }

  /** Looks up denied and failed principals again with a fresh token, so newly granted permissions apply. */
  retry(): void {
    const again = [...this.results].filter(([, result]) => result.status === 'denied' || result.status === 'failed');
    if (again.length > 0) {
      const results = new Map(this.results);
      for (const [key] of again) {
        results.delete(key);
        this.queue.push(this.principals.get(key)!);
      }
      this.results = results;
    }
    this.unavailable = undefined;
    this.forceRefresh = true;
    this.emit();
    void this.run();
  }

  dispose(): void {
    this.controller.abort();
  }

  private emit(): void {
    if (this.controller.signal.aborted) return;
    this.onChange({
      results: this.results,
      loading: this.running || (this.queue.length > 0 && !this.unavailable),
      ...(this.unavailable ? { unavailable: this.unavailable } : {}),
    });
  }

  private record(entries: [string, DirectoryLookupResult][]): void {
    const results = new Map(this.results);
    for (const [key, result] of entries) results.set(key, result);
    this.results = results;
    this.emit();
  }

  private async run(): Promise<void> {
    if (this.running || this.unavailable || this.queue.length === 0) return;
    const signal = this.controller.signal;
    this.running = true;
    this.emit();
    let throttledAttempts = 0;
    try {
      while (this.queue.length > 0 && !this.unavailable) {
        const batch = this.queue.splice(0, MAX_DIRECTORY_BATCH);
        let token: string;
        try {
          token = await getDirectoryAccessToken(this.forceRefresh);
          this.forceRefresh = false;
        } catch (error) {
          signal.throwIfAborted();
          // Without a token nothing can be looked up; keep the queue until the user retries.
          this.queue.unshift(...batch);
          this.unavailable = error instanceof AdminAuthError ? { code: error.code, message: error.message } : {
            code: 'DirectoryAccessUnavailable', message: 'Owner names can\'t be looked up because Microsoft Graph access is unavailable.',
          };
          break;
        }
        signal.throwIfAborted();
        this.client = this.client ? this.client.nextBatch(token) : new DirectoryLookup(token, fetch, Date.now, undefined, signal);
        let lookups: PrincipalLookup[];
        try {
          lookups = await this.client.lookupPrincipals(batch);
        } catch (error) {
          signal.throwIfAborted();
          const failure: ApiFailure = error instanceof InventoryError ? error.failure : {
            code: 'NameLookupFailed', message: 'Owner names could not be looked up. Retry the name lookup.',
          };
          lookups = batch.map((principal) => ({ id: principal.id, result: { status: 'failed', error: failure } }));
        }
        signal.throwIfAborted();
        const finished: [string, DirectoryLookupResult][] = [];
        const throttled: PrincipalReference[] = [];
        let retryAt = 0;
        lookups.forEach(({ id, result }, index) => {
          if (result.status === 'failed' && isTransient(result.error) && throttledAttempts < MAX_THROTTLED_ATTEMPTS) {
            throttled.push(batch[index]);
            retryAt = Math.max(retryAt, result.error.retryAt ?? Date.now() + DEFAULT_THROTTLE_WAIT_MS);
          } else {
            finished.push([id.toLowerCase(), result]);
          }
        });
        if (finished.length > 0) this.record(finished);
        if (throttled.length > 0) {
          throttledAttempts++;
          this.queue.unshift(...throttled);
          await delay(Math.min(Math.max(retryAt - Date.now(), 0), MAX_THROTTLE_WAIT_MS), signal);
        } else {
          throttledAttempts = 0;
        }
      }
    } catch {
      if (!signal.aborted) {
        this.unavailable = { code: 'UnexpectedNameLookupError', message: 'Owner names could not be looked up. Retry the name lookup.' };
      }
    } finally {
      this.running = false;
      this.emit();
    }
  }
}
