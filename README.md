# Edroll WhatsApp Backend

Node.js/Express backend starter for the Edroll WhatsApp Hub prototype.

## 1. Install

```bash
npm install
```

## 2. Configure Meta credentials

Copy `.env.example` to `.env` and fill in:

- `META_PHONE_NUMBER_ID`
- `META_ACCESS_TOKEN`
- `META_GRAPH_VERSION`
- `META_VERIFY_TOKEN`

Keep `.env` private (it is git-ignored). Do not place the Meta access token in the HTML/frontend.

Optional settings:

- `HOST` — defaults to `0.0.0.0` so hosted previews/containers can reach the server.
- `FRONTEND_ORIGIN` — comma-separated CORS allowlist, e.g. `https://hub.example.com,http://localhost:5500`. Leave blank to allow any origin.
- `GRAPH_TIMEOUT_MS` — outbound timeout for Meta Graph calls, default `15000`.

> **Outbound network required.** `POST /api/messages/send` calls `graph.facebook.com`.
> On sandboxes/hosts without outbound internet the endpoint returns `502` with an
> explanatory message instead of hanging. Run it where Meta is reachable to send for real.

## 3. Run

```bash
npm run dev
```

Backend: `http://localhost:3000`
Browser console: `http://localhost:3000/` (status cards + endpoint tester, see `public/index.html`)

## API

- `GET /` — built-in console UI for checking status and sending a test message
- `GET /api/health`
- `GET /api/config`
- `GET /api/health/db`
- `GET /api/webhook/status`
- `POST /api/messages/send`

### Send message body

```json
{
  "to": "8801XXXXXXXXX",
  "text": "Hello from Edroll"
}
```

Responses: `400` missing fields, `503` credentials not configured, `502`/`504` Meta
unreachable or timed out, otherwise `200` with the Meta payload.

## Webhook

Webhook routes are deliberately placeholders. Add Meta verification and inbound/status event processing later, as requested.

## Next production steps

1. Add PostgreSQL/Supabase (`DATABASE_URL` + `pg`), and make `GET /api/health/db` query it.
2. Add authentication and RBAC.
3. Store accounts, contacts, conversations and messages.
4. Implement Meta webhook verification (`GET`) and inbound/status event processing (`POST`).
5. Add real-time Socket.IO/WebSocket updates.
6. Calculate first-response and SLA metrics from stored timestamps.
7. Deploy behind HTTPS.
