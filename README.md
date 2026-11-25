# Fabric Connection Inventory

A Microsoft Fabric App, built with Rayfin, for Fabric administrators to
enumerate connections, owners, connector and authentication types, endpoint
paths, and the workloads that depend on each connection, and to take over a
connection by adding themselves as an owner. Only Take over changes anything in
Fabric; everything else only reads.

This repository is a **single-tenant deployment template**, not a shared
multitenant service. Each organization deploys its own Fabric App and configures
its own Microsoft Entra registration. No live tenant configuration, credentials,
connection inventory, or previous deployment records are included.

## Features

- Tenant-wide connection inventory with independent owner-role pagination.
- Search by name, ID, owner, connector type, authentication type, or endpoint.
- Multi-select filters for connector type, authentication type (for example
  Service Principal or OAuth2), and workspace, each showing how many connections
  match; sorting, details, and 25-row display pages.
- All `Owner` and `PendingOwner` assignments, with pending ownership labeled.
- Owner names: when Fabric returns only a principal ID, the name is looked up in
  Microsoft Entra ID and shown next to the ID. Users, security groups, and
  service principals are looked up separately, so each type shows names as soon
  as its Microsoft Graph permission is granted (see
  [API permissions](#api-permissions)).
- Dependent workloads: each connection's details list the semantic models,
  dataflows, data pipelines, Copy jobs, lakehouses, and other items bound to
  it, or state that no scanned item uses it.
- Take over: a connection's details have a **Take over** button that adds your
  signed-in account as an owner of that connection and keeps every existing
  owner. A notification at the bottom right reports whether it succeeded, and
  that connection's owners are looked up again and shown immediately, without
  reloading the inventory. Your own owner entries are marked **You**.
- Clear distinction between empty owner results, failed lookups, and unread rows.
- Refresh, cancellation, responsive layout, and light/dark themes.
- Paced requests that pause automatically while Fabric throttles, and owner
  lookups that resume without reloading the connection list.

The inventory only makes read-only requests:

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

Only **Take over** changes anything, and only when you select it. It sends one
request that adds your signed-in account as an owner, then reads that
connection's role assignments again:

```text
POST https://api.fabric.microsoft.com/v1/admin/connections/{id}/roleAssignments   (your account, role Owner)
```

Apart from that, the app never changes connections, ownership, credentials, or
source data. It never removes or changes existing role assignments, and never
contacts the displayed endpoints.

## Requirements

- Node.js 24 and npm.
- Access to the Fabric Apps/Rayfin preview npm packages through an approved npm
  registry. Registry credentials and machine-specific registry configuration are
  not included in this repository.
- A Fabric workspace on an available capacity in a supported region, with the
  Fabric Apps workload enabled.
- Permission to create/deploy Fabric Apps in that workspace.
- A Microsoft Entra account that can create app registrations, and an
  administrator who can grant tenant-wide admin consent (Cloud Application
  Administrator, Application Administrator, or Privileged Role Administrator)
  for the [API permissions](#api-permissions) below.
- A Fabric administrator account to sign in with. The app uses Fabric's admin
  APIs, which only Fabric administrators can call.

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
The CLI returns your app's hosting URL and Fabric item link. It also adds that
origin to `allowedRedirectUris` in `rayfin/rayfin.yml` for Rayfin's Fabric
sign-in handoff; you don't need to edit that file, and the entry is specific to
your deployment. It is separate from the Microsoft Entra redirect URI that you
register in step 2.

The initial deployment can render without administrator sign-in configuration,
but it cannot enumerate a tenant until the configuration below is supplied.
Do not treat this bootstrap deployment as a fully configured app.

### 2. Register the administrator sign-in app and its permissions

The app signs administrators in with its own single-tenant Microsoft Entra app
registration. In the [Microsoft Entra admin center](https://entra.microsoft.com),
go to **Entra ID** > **App registrations**:

1. Select **New registration**. Enter a name, choose **Accounts in this
   organizational directory only**, and under **Redirect URI** select
   **Single-page application (SPA)** with this exact URI, using the hosting
   origin from step 1: `https://<your-app-host>/admin-auth.html`.
2. Open **API permissions** > **Add a permission** and add the **delegated**
   permissions from the [table below](#api-permissions): the Power BI Service
   permission `Tenant.ReadWrite.All`, and a Microsoft Graph permission for each
   type of owner whose names you want to see. Remove permissions the app
   doesn't use, such as Microsoft Graph `User.Read`, which new registrations get
   by default.
3. Have an administrator select **Grant admin consent for [your tenant]** and
   confirm. Every permission's **Status** must then show
   **Granted for [your tenant]**. Repeat this whenever you add a permission.
4. On **Overview**, record the **Application (client) ID** and **Directory
   (tenant) ID** for step 3.

Don't add a client secret or certificate, and don't enable implicit grant
(access or ID tokens) under **Authentication**. MSAL uses the authorization-code
flow with PKCE.

#### API permissions

The app needs the Power BI Service permission `Tenant.ReadWrite.All`. Each
Microsoft Graph permission is optional and only adds the names of one type of
owner.

| API | Delegated permission | Required | Used for |
|---|---|---|---|
| Power BI Service | `Tenant.ReadWrite.All` | **Yes** | Listing connections and their owners, and adding you as an owner with **Take over** (Fabric admin APIs); finding dependent workloads (admin workspace scanner) |
| Microsoft Graph | `User.ReadBasic.All` | For user names | Reads the display name, user principal name, and email address of users that own connections |
| Microsoft Graph | `GroupMember.Read.All` | For group names | Reads the display name and email address of security groups that own connections |
| Microsoft Graph | `Application.Read.All` | For service principal names | Reads the display name and application ID of service principals, such as app registrations, managed identities, and workspace identities, that own connections |

- `Tenant.ReadWrite.All` is the only Power BI Service permission the app needs:
  Fabric requires it for adding a connection owner as an administrator, and it
  also covers every Fabric admin and workspace scanner API the app reads.
- **Every permission needs admin consent**, including `User.ReadBasic.All`.
  The portal's **Admin consent required** column shows **No** for that
  permission, but that only means users could consent for themselves. The app
  requests Microsoft Graph tokens silently and never asks users to consent, so
  without admin consent the permission isn't granted. Check the **Status**
  column instead: it must show **Granted for [your tenant]**.
- Add only delegated permissions; the app never uses application permissions.
  Prefer these least-privileged permissions to broader ones such as
  `Directory.Read.All`: every Microsoft Graph token the app receives carries all
  Graph permissions granted to this registration. If an administrator already
  granted a broader permission, the app uses it. For group names,
  `GroupMember.Read.All` is the narrowest permission Microsoft documents. It can
  also read group memberships, which the app never requests.
- Users, security groups, and service principals are looked up separately.
  Without one type's permission, only owners of that type show IDs, and a notice
  lists each missing permission with its purpose. Names of the other types, the
  inventory, and dependent workloads still work.
- For the Power BI Service, sign-in requests
  `https://api.fabric.microsoft.com/.default`, for connections, owners and Take
  over, and the workspace scanner then requests
  `https://analysis.windows.net/powerbi/api/.default`. Both tokens carry the
  granted `Tenant.ReadWrite.All`. Sign-in also requests the standard OpenID
  Connect sign-in and renewal scopes, which need no entry in the table. For
  owner names the app requests each Graph permission separately, such as
  `https://graph.microsoft.com/User.ReadBasic.All`, and checks
  `https://graph.microsoft.com/.default` for a broader permission granted
  instead. Requests after sign-in are silent and never open a sign-in window.
- A delegated permission only lets the app act as the signed-in account.
  Fabric still requires that account to be a Fabric administrator, and the only
  change the app makes with `Tenant.ReadWrite.All` is adding that account as a
  connection owner.

Consent doesn't make anyone an administrator. Fabric checks on each request that
the signed-in account is a Fabric administrator, and Microsoft Graph returns only
directory objects that the account may read, which member accounts can by
default.

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

### 4. Sign in and verify

Open the Fabric item, choose **Connect admin account**, then select **Continue
to Microsoft sign-in** in the temporary authentication window. Select a Fabric
administrator in your configured tenant. The authentication windows close after
sign-in and the inventory appears inside the Fabric App. The standalone hosting
URL also works.

A fully configured app shows:

1. **Inventory refreshed** once the connection list and all owner lookups have
   finished. Large tenants can take a while; when Fabric throttles requests, the
   app pauses and continues on its own.
2. **Dependent workloads scanned**. Expand a connection to see the items that
   use it under **Dependent workloads**.
3. Owner names above their IDs, with no **Owner names unavailable** or **Some
   owner names can't be shown** notice.
4. Above the summary, **Power BI Service permission: `Tenant.ReadWrite.All`,
   for the inventory and Take over**.

#### Troubleshooting permissions

| What you see | Cause | Fix |
|---|---|---|
| Microsoft sign-in asks for consent or admin approval, or **Admin sign-in did not grant the delegated Power BI Service permission…** | Power BI `Tenant.ReadWrite.All` is missing from the app registration or has no admin consent | Add it, have an administrator grant admin consent (step 2), then choose **Connect admin account** again |
| **Access denied. Your signed-in account must be a Fabric administrator…**, or **Dependent workloads could not be determined** with error code `PowerBiHttp403` | The account isn't a Fabric administrator, or `Tenant.ReadWrite.All` has no admin consent | Choose **Connect again** with a Fabric administrator, or grant the consent |
| **Owner names unavailable** or **Some owner names can't be shown**, listing permissions with error code `AADSTS65001` | Each listed Microsoft Graph permission is missing from the app registration or has no admin consent. **Admin consent required: No** in the portal doesn't mean granted | Add the listed permissions, have an administrator select **Grant admin consent**, check that each **Status** shows **Granted**, then select **Retry name lookups** |
| A listed permission with error code `GraphHttp403` | Microsoft Graph refused to read that type with the permissions granted | Grant the listed permission, then select **Retry name lookups** |
| **Names of … couldn't be looked up**, with an error code such as `AADSTS50076` | Microsoft Graph didn't issue a token for that type, for example because the session needs multifactor authentication again | Select **Retry name lookups**; if it continues, choose **Connect again** |
| An owner marked **Not found in Microsoft Entra ID** | The user, group, or service principal no longer exists | Nothing to grant; its ID stays visible |
| An owner marked **Name not readable with this app's permissions** | Microsoft Graph refused to read that one principal | Select **Retry name lookups** |
| An owner marked **Name lookup failed** | A temporary Microsoft Graph error | **Refresh inventory** looks the name up again |
| Only in the deployed app: **Dependent workloads could not be determined** with error code `NetworkError`, or owners marked **Name lookup failed** | The host's Content-Security-Policy, if it sets one, blocks these APIs | Allow `https://api.powerbi.com` and `https://graph.microsoft.com` in its `connect-src` |
| **Take over failed** with error code `FabricHttp403` | The account isn't a Fabric administrator, or Fabric refused the change | Choose **Connect again** with a Fabric administrator |
| **Take over failed** with another error code, such as `FabricHttp409` or a Fabric error code | Fabric didn't accept the change, for example because your account already has another role on the connection | Check the connection in Fabric's **Manage connections and gateways**; the notification shows the request ID for investigation |
| **Take over failed** saying it isn't known whether you were added | The request timed out or the network failed | Select **Refresh inventory** and check the connection's owners before trying again |
| After **Take over**, you're listed as **Pending owner** | Fabric adds an administrator who takes over a connection as a pending owner until they update its credentials | In Fabric, open **Settings** > **Manage connections and gateways**, edit the connection, and enter its credentials |

**Retry name lookups** and **Refresh inventory** request fresh Microsoft Graph
tokens, so newly granted permissions apply without signing in again. If names
still don't appear, choose **Connect again**.

### Updating an existing deployment

If you deployed an earlier version:

1. Make the app registration's permissions match
   [API permissions](#api-permissions):
   1. In **App registrations** > your app > **API permissions**, add the
      delegated Power BI Service permission `Tenant.ReadWrite.All` and the
      Microsoft Graph permissions you need, then have an administrator select
      **Grant admin consent**.
   2. Remove every permission that isn't in the table: select **…** next to it >
      **Remove permission**.
   3. Removing a permission doesn't revoke the consent already granted for it,
      so tokens would still carry it. In **Enterprise applications** > your
      app > **Permissions** > **Admin consent**, select **…** next to each
      removed permission > **Revoke permission**.
2. Rebuild and redeploy with the commands in step 3. In the app, choose
   **Connect again**, then verify as in step 4.

No new redirect URIs, `.env` settings, or `rayfin/rayfin.yml` changes are needed.

### Optional local development

For administrator sign-in locally, explicitly register
`http://localhost:5173/admin-auth.html` as an additional SPA redirect URI and set
`VITE_ADMIN_HOSTED_ORIGIN='http://localhost:5173'` in
`packages/frontend/.env.development.local`. Vite reads that file only for the
development server, so production builds keep the hosted origin from `.env`.
HTTP is accepted only for loopback development origins. The local app uses the
same app registration, so its API permissions and consent apply unchanged.

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
Fabric, Power BI, and Microsoft Graph requests use **each signed-in user's
delegated token**, not an app-owner token or a service principal. Database,
storage, and Functions services are disabled. **Take over** adds exactly one
owner, the account signed in to the app (the object ID in its token), and never
adds another principal or changes existing role assignments.

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

Results, including owner names and dependent workloads, remain in the current
browser's memory. There is no app database, automatic export, or committed
inventory. Every inventory load or refresh starts read-only metadata scans, and
Fabric keeps each scan result available for 24 hours. Name lookups read only
these directory properties: `id`, `displayName`, `userPrincipalName`, and `mail`
for users; `id`, `displayName`, and `mail` for groups; and `id`, `displayName`,
and `appId` for service principals. Sequential API reads are not an atomic
snapshot; connections may change during enumeration.

## Interpreting results

- The endpoint is `connectionDetails.path`. Some connectors return a logical
  label instead of a server URL.
- The authentication type is `credentialDetails.credentialType`. Connections
  without one can be selected with the **Not provided** filter option.
- Values selected within one filter match any of them; different filters must
  all match. Clearing a filter's selection stops it from filtering.
- The **Workspace** filter lists the workspaces that contain a dependent
  workload of at least one loaded connection. It shows the connections with a
  dependent workload in any selected workspace, so a connection used in several
  workspaces appears under each of them. Its results grow while the workspace
  scan runs and cover only what the scanner reports (see below).
- Fabric's role-assignment API often returns only the principal ID and type. The
  app then looks up users, security groups, and service principals by ID in
  Microsoft Entra ID, each type with its own Microsoft Graph permission, and
  shows the name next to the ID; names are never guessed. A type whose
  permission isn't granted keeps showing IDs while the other types show names.
  Other principal types, such as service principal profiles, keep showing their
  ID. A principal that no longer exists is marked "Not found in Microsoft Entra
  ID". Names Fabric does return are used as-is. A notice lists each missing
  permission with its purpose and the number of owners without a name (see
  [Troubleshooting permissions](#troubleshooting-permissions)).
- Dependent workloads come from the Fabric admin metadata scanner, which scans
  every workspace (including personal and inactive ones) in batches of 100. An
  item is listed when the scanner reports it bound to the connection (its data
  source ID is the connection ID); items in non-active workspaces are labeled
  with the workspace state, and misconfigured bindings are flagged. The scanner
  reports bindings for semantic models, dataflows, datamarts, and Fabric items
  such as data pipelines, Copy jobs, and lakehouses. Connections used only from
  code, such as in notebooks, are not detected, so "Not used by any workload"
  means no scanned item is bound to the connection.
- The scanner runs alongside the inventory with at most 3 concurrent scans, well
  within its limits (16 simultaneous `getInfo` requests and 500 per hour). Every
  inventory load or refresh lists workspaces once, and Fabric allows 30
  workspace lists per hour; beyond that, the workspace scan waits or asks you to
  retry later, while the connection inventory still loads. If some workspaces
  cannot be scanned, the results are marked incomplete and **Retry workspace
  scan** runs the scan again.
- Names and user principal names are shown only when Fabric or Microsoft Entra
  ID returns them. Otherwise, the principal ID and type remain visible.
- "No owners returned" describes the role-assignment response. It is not proof
  that a connection is orphaned.
- **Take over** uses Fabric's admin connection management API, which is in
  preview. Fabric records an administrator added this way as a pending owner
  (`PendingOwner`) until they update the connection's credentials, which makes
  them an owner. The button is unavailable while you own the connection or are
  its pending owner. After a take over, only that connection's owners are looked
  up again; **Refresh inventory** shows the latest owners of every connection.
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
  and shows when to try again. The workspace scan handles Power BI throttling the
  same way.
- Completed owner results are kept when a run stops or is cancelled after the
  connection list is complete. **Resume owner lookups** (or **Retry failed owner
  lookups**) requests only unresolved or failed owners, without listing
  connections again. **Refresh inventory** starts over: it lists connections and
  scans workspaces again, and retries owner names that could not be read.
  **Cancel** stops both the inventory and the workspace scan.

## Project layout and checks

```text
packages/frontend/       React UI, protected app shell, MSAL sign-in and orchestration
packages/shared/         Browser-safe Fabric, Power BI scanner and Microsoft Graph clients, contracts and API tests
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
deployed app with that tenant's account, as in step 4.

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
- [Admin Add Connection Role Assignment](https://learn.microsoft.com/en-us/rest/api/fabric/admin/connections/add-connection-role-assignment)
- [Metadata scanning (scanner API)](https://learn.microsoft.com/en-us/fabric/governance/metadata-scanning-overview)
- [Microsoft Graph JSON batching](https://learn.microsoft.com/en-us/graph/json-batching)
- [Microsoft Graph permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference)
- [Grant tenant-wide admin consent](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/grant-admin-consent)
- [Review and revoke permissions granted to an app](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/manage-application-permissions)
- [The `.default` scope](https://learn.microsoft.com/en-us/entra/identity-platform/scopes-oidc#the-default-scope)
- [Microsoft Entra SPA configuration](https://learn.microsoft.com/en-us/entra/identity-platform/scenario-spa-app-configuration)
