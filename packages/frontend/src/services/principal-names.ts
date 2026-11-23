import {
  DIRECTORY_KINDS, DirectoryLookup, InventoryError, MAX_DIRECTORY_BATCH, delay, directoryKind, isDirectoryPrincipal,
  type ApiFailure, type ConnectionRow, type DirectoryKind, type DirectoryLookupResult, type PrincipalLookup,
  type PrincipalReference,
} from '@rayfin-app/shared';
import { AdminAuthError, getDirectoryAccessToken } from '@/services/admin-auth';

/** Throttled lookups are retried at most this many times in a row, waiting at most this long each time. */
const MAX_THROTTLED_ATTEMPTS = 3;
const MAX_THROTTLE_WAIT_MS = 2 * 60_000;
const DEFAULT_THROTTLE_WAIT_MS = 10_000;

/** Microsoft Graph access for one kind of principal. Each kind is checked and looked up independently. */
export type DirectoryAccess =
  /** A token for this kind is being requested. */
  | { status: 'checking' }
  | { status: 'granted' }
  /** No delegated permission that reads this kind has consent. `code` is a diagnostic such as AADSTS65001. */
  | { status: 'notGranted'; code: string }
  /** Microsoft Graph didn't issue a usable token for another reason, such as an expired session. */
  | { status: 'failed'; error: ApiFailure };

export interface PrincipalNamesState {
  /** Lookup results keyed by lower-case principal ID. */
  results: ReadonlyMap<string, DirectoryLookupResult>;
  /** Lookups are queued or in flight for a kind that isn't blocked. */
  loading: boolean;
  /** Access for each kind of principal that has had owners to look up. */
  access: Readonly<Partial<Record<DirectoryKind, DirectoryAccess>>>;
}

interface QueuedPrincipal extends PrincipalReference {
  kind: DirectoryKind;
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

/** Distinct owners of each kind that show only their ID, excluding principals the directory no longer has. */
export function ownersShowingOnlyIds(rows: readonly ConnectionRow[]): Record<DirectoryKind, number> {
  const ids: Record<DirectoryKind, Set<string>> = { user: new Set(), group: new Set(), servicePrincipal: new Set() };
  for (const row of rows) {
    for (const owner of row.owners) {
      const kind = directoryKind(owner.type);
      if (kind && !owner.displayName && !owner.userPrincipalName && owner.directoryStatus !== 'notFound') {
        ids[kind].add(owner.id.toLowerCase());
      }
    }
  }
  return { user: ids.user.size, group: ids.group.size, servicePrincipal: ids.servicePrincipal.size };
}

function isTransient(error: ApiFailure): boolean {
  return error.status === 429 || error.status === 503;
}

/** Looks up each owner's name once, in batches per kind, as new owners appear. */
export class NameResolver {
  private readonly principals = new Map<string, QueuedPrincipal>();
  private readonly queues: Record<DirectoryKind, QueuedPrincipal[]> = { user: [], group: [], servicePrincipal: [] };
  private readonly controller = new AbortController();
  private readonly forceRefresh = new Set<DirectoryKind>();
  private readonly throttledAttempts = new Map<DirectoryKind, number>();
  private results: ReadonlyMap<string, DirectoryLookupResult> = new Map();
  private access: Partial<Record<DirectoryKind, DirectoryAccess>> = {};
  private running = false;
  /** Increases with every retry, so outcomes of requests started before it are not recorded. */
  private attempt = 0;
  private client: DirectoryLookup | undefined;

  constructor(private readonly onChange: (state: PrincipalNamesState) => void) {}

  /** Queues principals that have not been looked up yet. */
  add(principals: readonly PrincipalReference[]): void {
    let added = false;
    for (const principal of principals) {
      const key = principal.id.toLowerCase();
      const kind = directoryKind(principal.type);
      if (!kind || this.principals.has(key)) continue;
      const queued = { id: principal.id, type: principal.type, kind };
      this.principals.set(key, queued);
      this.queues[kind].push(queued);
      if (!this.access[kind]) this.setAccess(kind, { status: 'checking' });
      added = true;
    }
    if (!added) return;
    this.emit();
    void this.run();
  }

  /**
   * Checks every kind again with fresh tokens, so permissions granted since the last attempt apply,
   * and looks up principals that were waiting for access, denied, or failed.
   */
  retry(): void {
    this.attempt++;
    const results = new Map(this.results);
    for (const [key, result] of this.results) {
      if (result.status !== 'denied' && result.status !== 'failed') continue;
      results.delete(key);
      const principal = this.principals.get(key)!;
      this.queues[principal.kind].push(principal);
    }
    this.results = results;
    const access: Partial<Record<DirectoryKind, DirectoryAccess>> = {};
    for (const kind of DIRECTORY_KINDS) {
      this.forceRefresh.add(kind);
      this.throttledAttempts.delete(kind);
      if (this.queues[kind].length > 0) access[kind] = { status: 'checking' };
      else if (this.access[kind]) access[kind] = this.access[kind];
    }
    this.access = access;
    this.emit();
    void this.run();
  }

  dispose(): void {
    this.controller.abort();
  }

  private blocked(kind: DirectoryKind): boolean {
    const status = this.access[kind]?.status;
    return status === 'notGranted' || status === 'failed';
  }

  private setAccess(kind: DirectoryKind, access: DirectoryAccess): void {
    this.access = { ...this.access, [kind]: access };
  }

  private emit(): void {
    if (this.controller.signal.aborted) return;
    this.onChange({
      results: this.results,
      loading: this.running || DIRECTORY_KINDS.some((kind) => this.queues[kind].length > 0 && !this.blocked(kind)),
      access: this.access,
    });
  }

  private record(entries: [string, DirectoryLookupResult][]): void {
    const results = new Map(this.results);
    for (const [key, result] of entries) results.set(key, result);
    this.results = results;
    this.emit();
  }

  private async run(): Promise<void> {
    if (this.running) return;
    const signal = this.controller.signal;
    this.running = true;
    this.emit();
    try {
      for (;;) {
        const kind = DIRECTORY_KINDS.find((candidate) => this.queues[candidate].length > 0 && !this.blocked(candidate));
        if (!kind) break;
        await this.lookUp(kind, signal);
      }
    } catch {
      if (!signal.aborted) {
        const error = { code: 'UnexpectedNameLookupError', message: 'Owner names could not be looked up. Retry the name lookup.' };
        for (const kind of DIRECTORY_KINDS) {
          if (this.queues[kind].length > 0) this.setAccess(kind, { status: 'failed', error });
        }
      }
    } finally {
      this.running = false;
      this.emit();
    }
  }

  /** Looks up one batch of a single kind with a token for that kind. */
  private async lookUp(kind: DirectoryKind, signal: AbortSignal): Promise<void> {
    const batch = this.queues[kind].splice(0, MAX_DIRECTORY_BATCH);
    const attempt = this.attempt;
    let token: string;
    try {
      token = await getDirectoryAccessToken(kind, this.forceRefresh.has(kind));
    } catch (error) {
      signal.throwIfAborted();
      // Without a token this kind waits for a retry; the other kinds continue.
      this.queues[kind].unshift(...batch);
      if (attempt === this.attempt) {
        this.setAccess(kind, error instanceof AdminAuthError && error.code === 'DirectoryPermissionNotGranted' ?
          { status: 'notGranted', code: error.detail ?? error.code } :
          {
            status: 'failed',
            error: error instanceof AdminAuthError ? { code: error.code, message: error.message } : {
              code: 'DirectoryAccessUnavailable', message: 'Microsoft Graph did not issue a token for owner names.',
            },
          });
      }
      this.emit();
      return;
    }
    signal.throwIfAborted();
    if (attempt === this.attempt) this.forceRefresh.delete(kind);
    if (this.access[kind]?.status !== 'granted') {
      this.setAccess(kind, { status: 'granted' });
      this.emit();
    }
    this.client = this.client ? this.client.nextBatch(token) : new DirectoryLookup(token, fetch, Date.now, undefined, signal);
    let lookups: PrincipalLookup[];
    try {
      lookups = await this.client.lookupPrincipals(batch.map(({ id, type }) => ({ id, type })));
    } catch (error) {
      signal.throwIfAborted();
      const failure: ApiFailure = error instanceof InventoryError ? error.failure : {
        code: 'NameLookupFailed', message: 'Owner names could not be looked up. Retry the name lookup.',
      };
      if (failure.status === 401 || failure.status === 403) {
        this.queues[kind].unshift(...batch);
        this.setAccess(kind, { status: 'failed', error: failure });
        this.emit();
        return;
      }
      lookups = batch.map((principal) => ({ id: principal.id, result: { status: 'failed', error: failure } }));
    }
    signal.throwIfAborted();
    if (lookups.every(({ result }) => result.status === 'denied')) {
      // The token can't read this kind after all, so it is reported as a missing permission, not per owner.
      this.queues[kind].unshift(...batch);
      this.setAccess(kind, { status: 'notGranted', code: 'GraphHttp403' });
      this.emit();
      return;
    }
    const finished: [string, DirectoryLookupResult][] = [];
    const throttled: QueuedPrincipal[] = [];
    const attempts = this.throttledAttempts.get(kind) ?? 0;
    let retryAt = 0;
    lookups.forEach(({ id, result }, index) => {
      if (result.status === 'failed' && isTransient(result.error) && attempts < MAX_THROTTLED_ATTEMPTS) {
        throttled.push(batch[index]);
        retryAt = Math.max(retryAt, result.error.retryAt ?? Date.now() + DEFAULT_THROTTLE_WAIT_MS);
      } else {
        finished.push([id.toLowerCase(), result]);
      }
    });
    if (finished.length > 0) this.record(finished);
    if (throttled.length > 0) {
      this.throttledAttempts.set(kind, attempts + 1);
      this.queues[kind].unshift(...throttled);
      await delay(Math.min(Math.max(retryAt - Date.now(), 0), MAX_THROTTLE_WAIT_MS), signal);
    } else {
      this.throttledAttempts.delete(kind);
    }
  }
}
