import {
  InventoryError, PacedApiClient, UUID, child, identifier, invalidResponse, object, text,
} from './fabric-api.js';

const SCANNER_ROOT = 'https://api.powerbi.com/v1.0/myorg/admin/workspaces';
/** The scanner accepts at most 100 workspaces per scan. */
export const MAX_SCAN_WORKSPACES = 100;
const MAX_WORKSPACE_LIST_BYTES = 32 * 1024 * 1024;
const MAX_SCAN_RESULT_BYTES = 64 * 1024 * 1024;
const ITEM_TYPES: Record<string, string> = {
  datasets: 'Semantic model',
  dataflows: 'Dataflow',
  datamarts: 'Datamart',
  reports: 'Report',
  dashboards: 'Dashboard',
};

export interface WorkspaceScan {
  id: string;
  /** NotStarted, Running, Succeeded or Failed. */
  status: string;
}

/** An item that the admin scanner reports as bound to a data source (connection). */
export interface DependentItem {
  id: string;
  name: string;
  /** Display label, such as "Semantic model". */
  type: string;
  workspaceId: string;
  workspaceName?: string;
  /** Set only when the workspace is not active, such as "Deleted". */
  workspaceState?: string;
  /** The scanner lists the binding as misconfigured. */
  misconfigured?: boolean;
}

export interface WorkspaceUsage {
  workspaceCount: number;
  /** Dependent items keyed by the lower-case ID of the data source (connection) they are bound to. */
  itemsByConnection: Map<string, DependentItem[]>;
}

/** Reads a property case-insensitively; scanner payloads mix camelCase and PascalCase keys. */
function property(source: Record<string, unknown>, name: string): unknown {
  if (Object.hasOwn(source, name)) return source[name];
  const lower = name.toLowerCase();
  const key = Object.keys(source).find((candidate) => candidate.toLowerCase() === lower);
  return key === undefined ? undefined : source[key];
}

function label(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.slice(0, 1_024) : undefined;
}

/** A Fabric-style label for a scan collection, such as "Copy job" for CopyJob or "KQL database" for KQLDatabase. */
function itemType(key: string): string {
  const known = key.toLowerCase();
  if (Object.hasOwn(ITEM_TYPES, known)) return ITEM_TYPES[known];
  return key.replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/([A-Z]{2,})([A-Z][a-z])/g, '$1 $2').split(' ')
    .map((word, index) => index === 0 || /^[A-Z\d]{2,}$/.test(word) ? word : word.toLowerCase())
    .join(' ');
}

function datasourceIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const usage of value) {
    if (!usage || typeof usage !== 'object' || Array.isArray(usage)) continue;
    const id = property(usage as Record<string, unknown>, 'datasourceInstanceId');
    if (typeof id === 'string' && UUID.test(id)) ids.push(id.toLowerCase());
  }
  return ids;
}

/**
 * Maps a scan result to the items bound to each data source. A bound data source ID is the
 * gateway data source ID, which is the Fabric connection ID. Every item collection is read,
 * so item types that report data source usage in future are included too.
 */
export function connectionUsageFromScan(value: unknown): WorkspaceUsage {
  const body = object(value);
  const workspaces = property(body, 'workspaces');
  if (!Array.isArray(workspaces)) invalidResponse();
  const itemsByConnection = new Map<string, DependentItem[]>();
  const seen = new Set<string>();
  for (const entry of workspaces) {
    const workspace = object(entry);
    const workspaceId = label(property(workspace, 'id'))?.toLowerCase() ?? '';
    const workspaceName = label(property(workspace, 'name'));
    const state = label(property(workspace, 'state'));
    for (const [key, list] of Object.entries(workspace)) {
      if (!Array.isArray(list)) continue;
      for (const candidate of list) {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
        const artifact = candidate as Record<string, unknown>;
        const bindings = [
          ...datasourceIds(property(artifact, 'datasourceUsages')).map((id) => ({ id, misconfigured: false })),
          ...datasourceIds(property(artifact, 'misconfiguredDatasourceUsages')).map((id) => ({ id, misconfigured: true })),
        ];
        if (bindings.length === 0) continue;
        const id = label(property(artifact, 'id')) ?? label(property(artifact, 'objectId')) ?? '';
        const name = label(property(artifact, 'name')) ?? label(property(artifact, 'displayName')) ?? '(unnamed item)';
        const type = itemType(key);
        for (const binding of bindings) {
          // An item listed as both bound and misconfigured is reported once, as bound.
          const dedupe = `${binding.id}|${workspaceId}|${type}|${id || name}`;
          if (seen.has(dedupe)) continue;
          seen.add(dedupe);
          const items = itemsByConnection.get(binding.id) ?? [];
          items.push({
            id, name, type, workspaceId,
            ...(workspaceName ? { workspaceName } : {}),
            ...(state && state.toLowerCase() !== 'active' ? { workspaceState: state } : {}),
            ...(binding.misconfigured ? { misconfigured: true } : {}),
          });
          itemsByConnection.set(binding.id, items);
        }
      }
    }
  }
  return { workspaceCount: workspaces.length, itemsByConnection };
}

function scan(value: unknown): WorkspaceScan {
  const body = object(value);
  return { id: identifier(body.id), status: text(body.status, true)! };
}

/** Read-only client for the Fabric admin metadata scanning (scanner) API. */
export class WorkspaceScanner extends PacedApiClient {
  protected override readonly serviceName = 'Power BI';
  protected override readonly errorPrefix = 'PowerBiHttp';

  protected override failureMessage(status: number): string {
    return status === 403 ?
      'Access to the admin workspace scanner was denied. Your signed-in account must be a Fabric administrator and have delegated Tenant.Read.All consent for this app.' :
      status === 401 ? 'Power BI rejected the resource token. Check its audience, expiry, and consent.' :
      status === 404 ? 'The workspace scan was not found. Scan results expire after 24 hours; scan again.' :
      status === 503 ? 'Power BI remained unavailable after bounded retries.' :
      `Power BI returned HTTP ${status}. Retry or use the request ID to investigate.`;
  }

  /** IDs of every workspace, including personal and inactive ones, which can still use shared connections. */
  async listWorkspaceIds(): Promise<string[]> {
    const url = new URL(`${SCANNER_ROOT}/modified`);
    url.searchParams.set('excludePersonalWorkspaces', 'false');
    url.searchParams.set('excludeInActiveWorkspaces', 'false');
    const body = await this.send(url, 'GET', undefined, MAX_WORKSPACE_LIST_BYTES);
    if (!Array.isArray(body)) invalidResponse();
    return [...new Set(body.map((entry) => identifier(child(entry).id).toLowerCase()))];
  }

  /** Starts a scan of data source usage and lineage; schemas, expressions and item users are not requested. */
  async startScan(workspaceIds: string[]): Promise<WorkspaceScan> {
    if (!Array.isArray(workspaceIds) || workspaceIds.length < 1 || workspaceIds.length > MAX_SCAN_WORKSPACES ||
        workspaceIds.some((id) => typeof id !== 'string' || !UUID.test(id)) ||
        new Set(workspaceIds).size !== workspaceIds.length) {
      throw new InventoryError({
        code: 'InvalidInput', message: `Supply between one and ${MAX_SCAN_WORKSPACES} unique workspace UUIDs.`,
      });
    }
    const url = new URL(`${SCANNER_ROOT}/getInfo`);
    url.searchParams.set('lineage', 'True');
    url.searchParams.set('datasourceDetails', 'True');
    return scan(await this.send(url, 'POST', { workspaces: workspaceIds }));
  }

  async scanStatus(scanId: string): Promise<WorkspaceScan> {
    return scan(await this.send(new URL(`${SCANNER_ROOT}/scanStatus/${identifier(scanId)}`)));
  }

  async scanResult(scanId: string): Promise<WorkspaceUsage> {
    const url = new URL(`${SCANNER_ROOT}/scanResult/${identifier(scanId)}`);
    return connectionUsageFromScan(await this.send(url, 'GET', undefined, MAX_SCAN_RESULT_BYTES));
  }
}
