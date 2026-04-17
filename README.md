# AI Analyst Middleware

This is a minimal Render-ready middleware for `Free Trial` and `Paid` editions.

It is intentionally separate from the Salesforce package runtime:
- `Free Trial` and `Paid` should call this middleware.
- `Enterprise` should continue using direct customer-managed provider credentials.

## What it does

- exposes `GET /health`
- exposes `POST /api/narrate`
- validates a shared bearer token from Salesforce
- injects the vendor-owned OpenAI API key
- forwards the request to the OpenAI Responses API

## Local run

1. Copy `.env.example` values into your local environment.
2. Install dependencies:

```bash
cd middleware
npm install
```

3. Start the server:

```bash
npm start
```

4. Check health:

```bash
curl http://localhost:10000/health
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

## Render setup

1. Push the `middleware/` folder contents to a GitHub repo.
2. In Render, create a new `Web Service`.
3. Use:
   - Build Command: `npm install`
   - Start Command: `npm start`
4. Add environment variables:
   - `OPENAI_API_KEY`
   - `SALESFORCE_SHARED_TOKEN`
5. Verify `GET /health`

## Salesforce wiring

For `Free Trial` and `Paid`:
- point the middleware named credential to your Render base URL
- send `Authorization: Bearer <SALESFORCE_SHARED_TOKEN>`
- call `/api/narrate`

For `Enterprise`:
- keep direct provider named credentials unchanged
