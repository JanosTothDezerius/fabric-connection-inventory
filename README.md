# Fabric Connection Inventory

A read-only Microsoft Fabric App, built with Rayfin, for tenant administrators
to enumerate connections, owners, connector and authentication types, endpoint
paths, and the workloads that depend on each connection.

This repository is a **single-tenant deployment template**, not a shared
multitenant service. Each organization deploys its own Fabric App and configures
its own Microsoft Entra registration. No live tenant configuration, credentials,
connection inventory, or previous deployment records are included.

## Features

- Tenant-wide connection inventory with independent owner-role pagination.
- Search by name, ID, owner, connector type, authentication type, or endpoint.
- Connector, authentication-type (for example Service Principal or OAuth2) and
  owner-status filters, sorting, details, and 25-row display pages.
- All `Owner` and `PendingOwner` assignments, with pending ownership labeled.
- Owner names: when Fabric returns only a principal ID, the user, group, or
  service principal name is looked up in Microsoft Entra ID and shown next to
  the ID (requires the optional Microsoft Graph permissions below).
- Dependent workloads: each connection's details list the semantic models,
  dataflows, data pipelines, Copy jobs, lakehouses, and other items bound to
  it, or state that no scanned item uses it.
- Clear distinction between empty owner results, failed lookups, and unread rows.
- Refresh, cancellation, responsive layout, and light/dark themes.
- Paced requests that pause automatically while Fabric throttles, and owner
  lookups that resume without reloading the connection list.

The app only makes read-only requests:

```text
GET  https://api.fabric.microsoft.com/v1/admin/connections
GET  https://api.fabric.microsoft.com/v1/admin/connections/{id}/roleAssignments
GET  https://api.powerbi.com/v1.0/myorg/admin/workspaces/modified
POST https://api.powerbi.com/v1.0/myorg/admin/workspaces/getInfo?lineage=True&datasourceDetails=True
GET  https://api.powerbi.com/v1.0/myorg/admin/workspaces/scanStatus/{scanId}
GET  https://api.powerbi.com/v1.0/myorg/admin/workspaces/scanResult/{scanId}
POST https://graph.microsoft.com/v1.0/$batch   (GET users, groups, and service principals by ID)
```

The `getInfo` POST only starts a metadata scan (data source usage and lineage;
no schemas, expressions, or item users), and the Graph `$batch` POST only
bundles `GET` requests.

It never changes connections, ownership, credentials, or source data, and never
contacts the displayed endpoints.

## Requirements

- Node.js 24 and npm.
- Access to the Fabric Apps/Rayfin preview npm packages through an approved npm
  registry. Registry credentials and machine-specific registry configuration are
  not included in this repository.
- A Fabric workspace on an available capacity in a supported region, with the
  Fabric Apps workload enabled.
- Permission to create/deploy Fabric Apps in that workspace.
- A Microsoft Entra administrator who can register a single-tenant SPA and
  approve delegated `Tenant.Read.All` (and, optionally, the Microsoft Graph read
  permissions that enable owner names).
- A Fabric administrator account to use the tenant inventory APIs.

## Deploy in your tenant

### 1. Install and create the Fabric App

```sh
npm ci
npx rayfin login --tenant <your-tenant-id>
npx rayfin login status
npx rayfin up --dry-run --workspace-id <your-workspace-id> --json
npx rayfin up --workspace-id <your-workspace-id> --json
```

Confirm the signed-in account and target workspace before deploying. Do not copy
another deployment's `.env`, `.env.local`, or `rayfin/.deployments.json`.
The CLI returns your app's hosting URL and Fabric item link.

The initial deployment can render without administrator sign-in configuration,
but it cannot enumerate a tenant until the configuration below is supplied.
Do not treat this bootstrap deployment as a fully configured app.

### 2. Register dedicated administrator sign-in

In the Microsoft Entra admin center for your tenant:

1. Register an application with **Accounts in this organizational directory only**.
2. Select the **Single-page application (SPA)** platform and register this exact
   redirect URI, replacing the origin with the hosting URL from step 1:
   `https://<your-app-host>/admin-auth.html`.
3. Add **Power BI Service -> Delegated permissions -> Tenant.Read.All** and grant
   the required administrator consent. Remove unused default permissions such as
   Microsoft Graph `User.Read` if they were added by the registration wizard.
   The same permission covers the admin workspace scanner used for dependent
   workloads.
4. Optional, for owner names: add **Microsoft Graph -> Delegated permissions**
   `User.ReadBasic.All` (user names), `GroupMember.Read.All` (group names), and,
   if service principals own connections, `Application.Read.All`, then grant
   administrator consent. `Directory.Read.All` also works but is broader. Without
   these permissions the inventory still works; owners show their IDs and the app
   explains which permission is missing.
5. Record the application/client ID and directory/tenant ID.

Do not create a client secret or enable implicit token issuance. MSAL uses the
authorization-code flow with PKCE. The app requests
`https://api.fabric.microsoft.com/Tenant.Read.All` and standard OIDC sign-in and
renewal scopes at sign-in. It then silently requests the same `Tenant.Read.All`
permission for the `https://analysis.windows.net/powerbi/api` audience (admin
workspace scanner) and `https://graph.microsoft.com/.default` (owner names, only
the Graph permissions an administrator granted). These silent requests never
open a sign-in window.

Consent does not make a user a tenant administrator. Fabric checks the signed-in
user's role and permissions on each API request.

### 3. Configure and redeploy

```sh
cp packages/frontend/.env.example packages/frontend/.env
```

Fill in the file:

| Variable | Required | Meaning |
|---|---|---|
| `VITE_ADMIN_TENANT_ID` | Yes | Your Microsoft Entra tenant UUID |
| `VITE_ADMIN_CLIENT_ID` | Yes | Your SPA registration's application/client UUID |
| `VITE_ADMIN_HOSTED_ORIGIN` | Yes | Exact app origin, such as `https://<your-app-host>`; no path, query, or fragment |
| `VITE_TENANT_LABEL` | No | Friendly tenant label displayed in the UI |
| `VITE_WORKSPACE_LABEL` | No | Friendly Fabric workspace label displayed in the UI |

These are public application identifiers, not secrets. Never put passwords,
client secrets, or access tokens in any `VITE_*` setting.
Use `.env`, not `.env.local`: the Rayfin CLI generates `.env.local` for its own
hosting and authentication settings.

```sh
npm run typecheck
npm run build
npm run lint
npm test
npx rayfin up --dry-run --workspace-id <your-workspace-id> --json
npx rayfin up --workspace-id <your-workspace-id> --json
```

Open the Fabric item, choose **Connect admin account**, then select **Continue
to Microsoft sign-in** in the temporary authentication window. Select an
administrator in your configured tenant. The authentication windows close after
sign-in and the inventory appears inside the Fabric App. The standalone hosting
URL also works. Confirm that the live inventory and owner lookups complete.

### Optional local development

For administrator sign-in locally, explicitly register
`http://localhost:5173/admin-auth.html` as an additional SPA redirect URI and set
`VITE_ADMIN_HOSTED_ORIGIN='http://localhost:5173'` in
`packages/frontend/.env.development.local`. Vite reads that file only for the
development server, so production builds keep the hosted origin from `.env`.
HTTP is accepted only for loopback development origins.

```sh
npm run dev -- --workspace-id <your-workspace-id>
```

This starts the official Rayfin development flow, which can create or configure
the backend in the explicit workspace, and applies the local `rayfin/rayfin.yml`
services to it. Review its target before approving a first-time create.

When the app is already deployed and `packages/frontend/.env.local` points at
that deployment, you can instead run only the local frontend against it, without
changing the backend. It signs in with your Rayfin CLI session (`npx rayfin login`):

```sh
npm run -w @rayfin-app/frontend dev -- --port 5173 --strictPort
```

## Authentication and data boundaries

The outer Fabric AuthGate and protected static hosting remain enabled.
Administrator API requests use **each signed-in user's delegated token**, not an
app-owner token or a service principal. Database, storage, and Functions services
are disabled.

MSAL holds the administrator session in memory only. Reloading may require a new
explicit connection. Disconnect immediately clears the inventory and the app's
administrator cache without globally signing the user out of Microsoft.
Token renewal never opens an unexpected sign-in popup.

The configured tenant and origin are enforced before requests. Missing or
invalid authentication configuration fails closed; the template never falls back
to another tenant.

The MSAL redirect bridge and popup relay are bundled on the app's origin. They must be
served with `Cache-Control: no-store` and without a
`Cross-Origin-Opener-Policy` header that would break popup communication. Verify
these response headers in your deployment. Keep the bridge outside React's
authentication gates.

Embedded views use MSAL 5's supported `popupRelayUri` flow. The same-origin relay
opens Microsoft sign-in after a user gesture and returns the authorization
response to the embedded app; MSAL validates the response's source, origin, and
state. The PKCE verifier and access tokens remain in the app frame. Relay
navigation is pinned to `https://login.microsoftonline.com`. Only authentication
uses temporary windows; the inventory remains in Fabric. The relay page is not
a new OAuth callback and needs no additional Entra redirect URI.

Results remain in the current browser's memory. There is no app database,
automatic export, or committed inventory. Sequential API reads are not an atomic
snapshot; connections may change during enumeration.

## Interpreting results

- The endpoint is `connectionDetails.path`. Some connectors return a logical
  label instead of a server URL.
- The authentication type is `credentialDetails.credentialType`. Connections
  without one can be selected with the **Not provided** filter option.
- Fabric's role-assignment API often returns only the principal ID and type. The
  app then looks up users, groups, and service principals by ID in Microsoft
  Entra ID and shows the name next to the ID; names are never guessed. A
  principal that no longer exists is marked "Not found in Microsoft Entra ID".
  Names Fabric does return are used as-is. If the app's Microsoft Graph
  permissions are missing, a notice names the permission to grant; **Retry name
  lookups** then uses a fresh token, so newly granted permissions apply without
  signing in again.
- Dependent workloads come from the Fabric admin metadata scanner, which scans
  every workspace (including personal and inactive ones) in batches of 100. An
  item is listed when the scanner reports it bound to the connection (its data
  source ID is the connection ID); items in non-active workspaces are labeled
  with the workspace state, and misconfigured bindings are flagged. The scanner
  reports bindings for semantic models, dataflows, datamarts, and Fabric items
  such as data pipelines, Copy jobs, and lakehouse shortcuts. Connections used
  only from code, such as in notebooks, are not detected, so "Not used by any
  workload" means no scanned item is bound to the connection.
- The scanner runs alongside the inventory with at most 3 concurrent scans, well
  within its limits (16 simultaneous `getInfo` requests, 500 per hour; the
  workspace list allows 30 requests per hour). If some workspaces cannot be
  scanned, the results are marked incomplete and **Retry workspace scan** runs
  the scan again.
- Names and user principal names are shown only when Fabric or Microsoft Entra
  ID returns them. Otherwise, the principal ID and type remain visible.
- "No owners returned" describes the role-assignment response. It is not proof
  that a connection is orphaned.
- Missing display names and metadata are marked explicitly.
- Partial results remain visibly incomplete. Unread or failed owner lookups never
  appear as successful empty results.
- Requests are paced to avoid bursts. When Fabric throttles a request (HTTP 429)
  or is briefly unavailable (HTTP 503), the app pauses and continues on its own at
  the time Fabric gives: the `Retry-After` header when the browser can read it,
  otherwise the "blocked until" time in the response body, otherwise one
  60-second quota window. After throttling, it slows down for the rest of the
  run. If throttling persists through three pauses without progress (backing off
  exponentially), or Fabric asks for a wait longer than 10 minutes, the run stops
  and shows when to try again.
- Completed owner results are kept when a run stops or is cancelled after the
  connection list is complete. **Resume owner lookups** (or **Retry failed owner
  lookups**) requests only unresolved or failed owners, without listing
  connections again; **Refresh inventory** starts over.

## Project layout and checks

```text
packages/frontend/       React UI, protected app shell, MSAL sign-in and orchestration
packages/shared/         Browser-safe API client, contracts and API tests
packages/data/           Empty schema retained by the official Rayfin template
rayfin/rayfin.yml        Protected Fabric App service configuration
```

```sh
npm run typecheck
npm run build
npm run lint
npm test
```

Tests use synthetic fixtures. A clean build does not prove that a new tenant has
granted the required consent or that its administrator has API access; verify the
deployed app with that tenant's account.

## Sharing and license

Share this source repository with another organization so it can deploy a
separate instance following the steps above. Sharing a hosting URL does not
grant administrator access or convert the app into a multitenant service.

This project is derived from Microsoft's MIT-licensed Rayfin starter and retains
its copyright and license notices. See [LICENSE](LICENSE).

## Documentation

- [Fabric Apps overview](https://learn.microsoft.com/en-us/fabric/apps/overview)
- [Rayfin CLI deployment](https://learn.microsoft.com/en-us/fabric/apps/create-app-with-cli)
- [Admin List Connections](https://learn.microsoft.com/en-us/rest/api/fabric/admin/connections/list-connections)
- [Admin List Connection Role Assignments](https://learn.microsoft.com/en-us/rest/api/fabric/admin/connections/list-connection-role-assignments)
- [Metadata scanning (scanner API)](https://learn.microsoft.com/en-us/fabric/governance/metadata-scanning-overview)
- [Microsoft Graph JSON batching](https://learn.microsoft.com/en-us/graph/json-batching)
- [Microsoft Entra SPA configuration](https://learn.microsoft.com/en-us/entra/identity-platform/scenario-spa-app-configuration)
