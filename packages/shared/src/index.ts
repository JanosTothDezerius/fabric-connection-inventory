/**
 * Entity map shared by the data registration package and typed browser client.
 *
 * It remains empty while the data service is disabled. Data capabilities add
 * entity keys here so every runtime consumes the same schema contract.
 */
export type UniversalAppSchema = Record<string, never>;

export {
  DEFAULT_THROTTLE_WAIT_MS, FabricInventory, InventoryError, delay, requireTenantAdminToken, safeResult,
} from './fabric-api.js';
export {
  MAX_SCAN_WORKSPACES, WorkspaceScanner, connectionUsageFromScan,
  type DependentItem, type WorkspaceScan, type WorkspaceUsage,
} from './scanner-api.js';
export {
  DIRECTORY_KINDS, DIRECTORY_READ_PERMISSIONS, DirectoryLookup, MAX_DIRECTORY_BATCH, directoryKind, directoryTokenScopes,
  isDirectoryPrincipal, requireDirectoryToken,
  type DirectoryKind, type DirectoryLookupResult, type PrincipalLookup, type PrincipalReference,
} from './directory-api.js';
export {
  ADMIN_READ_PERMISSION, CONNECTION_OWNER_PERMISSION, ConnectionOwnership, requireTenantWriteToken, tenantPermissions,
  type TenantPermission, type TenantWriteAccess,
} from './ownership-api.js';

export interface ApiFailure {
  code: string;
  message: string;
  status?: number;
  requestId?: string;
  /** Epoch milliseconds before which Fabric should not receive a retry. */
  retryAt?: number;
}

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ApiFailure };

export interface ConnectionRecord {
  id: string;
  displayName: string;
  connectorType: string;
  connectivityType: string;
  endpoint: string;
  privacyLevel?: string;
  gatewayId?: string;
  credentialType?: string;
  createdDateTime?: string;
  lastCredentialUsedDateTime?: string;
}

export interface ConnectionOwner {
  id: string;
  type: string;
  displayName?: string;
  userPrincipalName?: string;
  role: 'Owner' | 'PendingOwner';
  /** Email address found by a Microsoft Entra ID lookup. */
  mail?: string;
  /** Outcome of looking up, in Microsoft Entra ID, a name that Fabric did not return. */
  directoryStatus?: 'resolved' | 'notFound' | 'denied' | 'failed';
}

export interface ConnectionRow extends ConnectionRecord {
  owners: ConnectionOwner[];
  ownerStatus: 'pending' | 'loaded' | 'error';
  ownerError?: ApiFailure;
}

export interface ConnectionPage {
  connections: ConnectionRecord[];
  nextToken: string | null;
}

export interface OwnerLookup {
  connectionId: string;
  result: ApiResult<ConnectionOwner[]>;
}

export interface OwnerBatch {
  results: OwnerLookup[];
}

export interface InventorySnapshot {
  connections: ConnectionRow[];
  inventoryComplete: boolean;
  phase: 'connections' | 'owners' | 'done' | 'error';
  updatedAt: string | null;
  error?: ApiFailure;
  /** Set while requests are paused for Fabric throttling: epoch milliseconds when they resume. */
  pausedUntil?: number;
}

export interface LoadInventoryOptions {
  signal: AbortSignal;
  onProgress: (snapshot: InventorySnapshot) => void;
  /**
   * A snapshot with a complete connection list. Its connections are kept and only
   * owner lookups that have not succeeded are requested again.
   */
  resumeFrom?: InventorySnapshot;
}
