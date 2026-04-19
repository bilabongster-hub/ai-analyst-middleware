# AI Analyst Middleware

This is a Render-ready middleware for `Free Trial` and `Paid` editions, with the first Postgres-backed entitlement skeleton for launch operations.

It is intentionally separate from the Salesforce package runtime:
- `Free Trial` and `Paid` should call this middleware.
- `Enterprise` should continue using direct customer-managed provider credentials.

## What it does

- exposes `GET /health`
- exposes `GET /health/dependencies`
- exposes `POST /api/narrate`
- exposes `POST /api/license-status`
- validates a shared bearer token from Salesforce
- injects the vendor-owned OpenAI API key
- forwards the request to the OpenAI Responses API
- stores subscriber license data in Postgres

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
- send `x-salesforce-token: <SALESFORCE_SHARED_TOKEN>`
- call `/api/narrate`

For `Enterprise`:
- keep direct provider named credentials unchanged

## Entitlement database model

This scaffold uses three tables:

- `subscribers`
  - one row per subscriber org / installation
- `product_entitlements`
  - one row per product per subscriber
  - stores edition, active state, trial dates, and capability flags
- `license_events`
  - audit history for license changes

`POST /api/license-status` expects:

```json
{
  "orgId": "00D..."
}
```

and returns the subscriber plus current entitlements for that org.
