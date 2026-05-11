# AI Analyst Middleware

Brand: `Interpreta`
Suite/package: `AI Analyst Suite`
Valid product entitlement names: `Report Narrator`, `Dashboard Narrator`

This is a Render-ready middleware for `Free Trial` and `Paid` editions, with the first Postgres-backed entitlement skeleton for launch operations.

It is intentionally separate from the Salesforce package runtime:
- `Free Trial` and `Paid` should call this middleware.
- `Enterprise` should continue using direct customer-managed provider credentials.

## What it does

- exposes `GET /health`
- exposes `GET /health/dependencies`
- exposes `POST /lma/license-sync`
- exposes `POST /api/subscriber-bootstrap`
- exposes `POST /api/narrate`
- exposes `POST /api/license-status`
- exposes `POST /refresh-license-status`
- validates a shared bearer token from Salesforce
- validates `x-aias-lma-secret` for LMA provisioning traffic
- injects the vendor-owned OpenAI API key
- forwards the request to the OpenAI Responses API
- stores subscriber license data in Postgres
- rejects suite or brand names when a product entitlement name is required
- treats `/lma/license-sync` as the only write path for `subscribers`, `product_entitlements`, and `license_events`
- stores new subscriber middleware tokens hashed in Postgres when the token-hash columns are available

## Local run

1. Copy `.env.example` values into your local environment.
2. Install dependencies:

```bash
cd middleware
npm install
```

3. Initialize the database schema if you want to test entitlement sync locally:

```bash
npm run db:init
```

4. Start the server:

```bash
npm start
```

5. Check health:

```bash
curl http://localhost:10000/health
```

6. Check dependency readiness:

```bash
curl http://localhost:10000/health/dependencies
```

## Request format

```json
{
  "product": "Report Narrator",
  "operation": "reportNarration",
  "edition": "Paid",
  "model": "gpt-4.1-mini",
  "payload": {
    "input": "Prompt text or normalized input payload"
  }
}
```

## Required environment variables

- `OPENAI_API_KEY`
- `SALESFORCE_SHARED_TOKEN`
- `ALLOW_LEGACY_SHARED_TOKEN=true|false`
- `LMA_SYNC_SECRET` for `/lma/license-sync` in non-local environments
- `DATABASE_URL`
- `PGSSLMODE=require` when using Render Postgres

## Render setup

1. Push the `middleware/` folder contents to a GitHub repo.
2. In Render, create a new `Web Service`.
3. Create a managed `PostgreSQL` database in the same Render account.
4. Copy the Render Postgres connection string into the web service environment as `DATABASE_URL`.
5. Use:
   - Build Command: `npm install`
   - Start Command: `npm start`
6. Add environment variables:
   - `OPENAI_API_KEY`
   - `SALESFORCE_SHARED_TOKEN`
   - `ALLOW_LEGACY_SHARED_TOKEN=true`
   - `LMA_SYNC_SECRET`
   - `DATABASE_URL`
   - `PGSSLMODE=require`
7. Run the schema init once after deploy:

```bash
npm run db:init
```

8. Verify:
   - `GET /health`
   - `GET /health/dependencies`

## Salesforce wiring

For `Free Trial` and `Paid`:
- point the middleware named credential to your Render base URL
- send `x-salesforce-token: <subscriber bootstrap token>`
- call `/api/narrate`
- use `/api/subscriber-bootstrap` only for package-controlled token bootstrap
- use `/refresh-license-status` for read-only entitlement refresh
- `/api/license-status` remains as a backward-compatible alias for the same read-only refresh behavior

Bootstrap behavior:
- `/api/subscriber-bootstrap` is package-controlled token setup only.
- The route never creates subscribers or entitlements.
- The route issues or rotates a subscriber token only after `/lma/license-sync` has already provisioned the subscriber in Postgres.
- If the subscriber has not arrived from LMA sync yet, the route returns `LICENSE_PENDING_LMA_SYNC`.
- Explicit bootstrap auth headers remain accepted for backward compatibility, and temporary legacy support for `x-salesforce-token: <SALESFORCE_SHARED_TOKEN>` is still limited to bootstrap only.

Protected route auth:
- `/refresh-license-status`, `/api/license-status`, and `/api/narrate` require a valid per-subscriber `x-salesforce-token`.
- The legacy shared token is not accepted on protected refresh or narration routes because those routes must be org-bound.

For `Enterprise`:
- keep direct provider named credentials unchanged

For provisioning:
- send `x-aias-lma-secret: <LMA_SYNC_SECRET>` to `/lma/license-sync`
- have your LMA/PBO integration post the LMA license snapshot for that org
- do not send per-product entitlement arrays; the middleware writes both valid product rows itself

## Entitlement database model

This scaffold uses three tables:

- `subscribers`
  - one row per subscriber org / installation
- `product_entitlements`
  - one row per product per subscriber
  - stores edition, active state, trial dates, and capability flags
- `license_events`
  - audit history for license changes

`POST /refresh-license-status` expects:

```json
{
  "orgId": "00D...",
  "packageName": "AI Analyst Suite"
}
```

and returns the subscriber plus current entitlements for that org.

If Render has not received the LMA sync yet, it returns:

```json
{
  "success": true,
  "status": "LICENSE_PENDING_LMA_SYNC",
  "message": "License setup is still in progress. Please refresh license status in a few minutes.",
  "entitlements": []
}
```

If the subscriber exists but one expected product row is missing, the response includes a placeholder entitlement for that product with `status: "PRODUCT_NOT_FOUND"` and `edition: "LICENSE_PENDING_LMA_SYNC"` so the managed package can block safely instead of falling through to trial-expired behavior.

Refresh license status is strictly read-only against Render entitlements:
- it validates `orgId`
- it finds the existing subscriber by `org_id`
- it reads only the existing `product_entitlements` rows for `Report Narrator` and `Dashboard Narrator`
- it does not create or update `subscribers`
- it does not create or update `product_entitlements`

`POST /api/subscriber-bootstrap` expects:

```json
{
  "orgId": "00D...",
  "packageName": "AI Analyst Suite"
}
```

and returns only the subscriber identity plus the protected middleware token for that org.

Bootstrap token behavior:
- bootstrap never creates `subscribers`
- bootstrap never creates or modifies `product_entitlements`
- if the subscriber row is missing because LMA sync has not arrived yet, bootstrap returns `LICENSE_PENDING_LMA_SYNC`
- if the subscriber exists, bootstrap rotates and returns a fresh per-subscriber middleware token
- the plaintext token is returned only in the bootstrap response and should be stored only in protected Salesforce runtime config
- middleware stores the token hash in Postgres when the hash columns are present

If Render has not received the LMA sync yet, bootstrap returns:

```json
{
  "success": true,
  "status": "LICENSE_PENDING_LMA_SYNC",
  "message": "License setup is still in progress. Please refresh license status in a few minutes."
}
```

`POST /lma/license-sync` expects a payload like:

```json
{
  "orgId": "00D...",
  "packageName": "AI Analyst Suite",
  "licenseStatus": "Trial",
  "seats": 10,
  "expirationDate": "2026-05-01",
  "subscriberName": "Acme",
  "subscriberEmail": "admin@example.com",
  "lmaLicenseId": "a00...",
  "lmaPackageVersionId": "a01...",
  "source": "LMA"
}
```

`POST /lma/license-sync` behavior:

- authenticates only with `x-aias-lma-secret`
- trims and validates `orgId`, `packageName`, and `licenseStatus`
- upserts the subscriber row by `org_id`
- upserts exactly two `product_entitlements` rows: `Report Narrator` and `Dashboard Narrator`
- maps `Trial` to `trial` + active, `Active` to `paid` + active, and `Suspended` / `Expired` / `Uninstalled` to inactive
- preserves existing `enterprise` entitlements unless `forceDowngrade: true` is provided
- stores LMA details in entitlement `metadata`
- records `license_events` when that table is available

This route is the only middleware path allowed to create or update `subscribers`, `product_entitlements`, and `license_events`. `POST /api/subscriber-bootstrap`, `POST /api/license-status`, and `POST /api/narrate` must remain read-only with respect to entitlements.
