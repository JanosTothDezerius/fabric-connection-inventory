import { ADMIN_READ_PERMISSION, CONNECTION_OWNER_PERMISSION, type TenantPermission } from '@rayfin-app/shared';

function Permission({ name }: { name: string }) {
  return <span className="font-monospace">{name}</span>;
}

/**
 * Names the Fabric admin permission this app has and what it allows. Tenant.ReadWrite.All already allows everything
 * Tenant.Read.All does, so the app needs exactly one of them; when both are granted, Tenant.Read.All is redundant.
 */
export function AdminPermissionNote({ permissions }: { permissions: readonly TenantPermission[] }) {
  const write = permissions.includes(CONNECTION_OWNER_PERMISSION);
  const read = permissions.includes(ADMIN_READ_PERMISSION);
  if (write && read) {
    return (
      <p>
        Power BI Service permissions: <Permission name={CONNECTION_OWNER_PERMISSION} /> and <Permission name={ADMIN_READ_PERMISSION} />.
        {' '}<Permission name={CONNECTION_OWNER_PERMISSION} /> already allows everything <Permission name={ADMIN_READ_PERMISSION} /> does,
        {' '}so an administrator can revoke <Permission name={ADMIN_READ_PERMISSION} />.
      </p>
    );
  }
  if (write) {
    return <p>Power BI Service permission: <Permission name={CONNECTION_OWNER_PERMISSION} />, for the inventory and Take over.</p>;
  }
  if (read) {
    return (
      <p>
        Power BI Service permission: <Permission name={ADMIN_READ_PERMISSION} />, for the inventory only.
        {' '}Take over needs <Permission name={CONNECTION_OWNER_PERMISSION} /> in its place.
      </p>
    );
  }
  return null;
}
