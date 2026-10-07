# Edroll WhatsApp Backend

Node.js/Express backend for the Edroll WhatsApp Hub: Meta WhatsApp Cloud API
integration, conversation and message storage in Postgres, a Meta webhook
receiver with signature verification, realtime updates, and response-time
metrics — plus a browser dashboard to operate it.

It runs with **zero configuration**: with no credentials it uses an embedded
Postgres for storage and simulates Meta traffic, so the whole pipeline is
demonstrable. Add credentials and it sends for real against the same code path.

## Features

- **Meta webhook**: `GET` verification handshake, `POST` event processing for
  inbound messages and delivery/read receipts, HMAC-SHA256 signature
  verification when `META_APP_SECRET` is set, deduplication on `wamid`, and
  statuses that only move forward (`read` never regresses to `delivered`).
- **Outbound sending** through the Cloud API, with failed sends stored together
  with Meta's error payload instead of vanishing.
- **Storage** in Postgres: contacts, conversations, messages, webhook audit log,
  automatic first-response timestamps.
- **Realtime** dashboard updates over Server-Sent Events (no extra dependency).
- **Metrics**: inbound/outbound volume, failed/delivered/read counts, open and
  awaiting-reply conversations, average first-response time, 14-day throughput.
- **Auto-forward** replies via `AUTO_FORWARD_TEXT` (off by default).
- **Simulator**: fabricate Meta-shaped payloads with no credentials.

## 1. Install and run

```bash
npm install
npm start        # or: npm run dev  (restarts on file changes)
```

- Dashboard: `http://localhost:3000/`
- API: `http://localhost:3000/api/health`

Without a `.env` file the server prints `outbound sends SIMULATED` and uses the
embedded database — everything below works immediately.

### Try it in 30 seconds

```bash
# seed three demo conversations (with replies and a delivery receipt)
curl -X POST http://localhost:3000/api/demo/seed

# fabricate an inbound message
curl -X POST http://localhost:3000/api/webhook/simulate \
  -H 'Content-Type: application/json' \
  -d '{"from":"8801712345678","name":"Ayesha Khan","text":"I need help with my renewal."}'

# reply to it
curl -X POST http://localhost:3000/api/messages/send \
  -H 'Content-Type: application/json' \
  -d '{"to":"8801712345678","text":"Hello Ayesha, we are on it."}'
```

## 2. Configure Meta credentials

Copy `.env.example` to `.env` and fill in:

| Variable | Purpose |
| --- | --- |
| `META_PHONE_NUMBER_ID` | WhatsApp sender phone number ID |
| `META_ACCESS_TOKEN` | Permanent system-user token |
| `META_VERIFY_TOKEN` | Any random string; must match the Meta app dashboard |
| `META_APP_SECRET` | Enables webhook signature verification (recommended) |
| `META_GRAPH_VERSION` | Graph API version, default `v23.0` |

Keep `.env` private (it is git-ignored). Never put the access token in HTML or
frontend code — all Meta calls happen server-side.

### Point Meta at the webhook

1. Expose this server over HTTPS (e.g. a tunnel for local testing).
2. In the Meta app dashboard → WhatsApp → Configuration, set the callback URL to
   `https://<your-host>/api/webhook/whatsapp` and the verify token to your
   `META_VERIFY_TOKEN`.
3. Subscribe to the `messages` field.
4. `GET /api/webhook/status` reports exactly what is configured.

**Outbound network required.** `POST /api/messages/send` calls
`graph.facebook.com`. On hosts without outbound internet it returns `502` with an
explanatory message within the timeout instead of hanging, and the attempt is
still stored with `status = failed`.

## 3. Storage

| `DATABASE_URL` | Behaviour |
| --- | --- |
| unset | Embedded Postgres (PGlite) persisted to `.data/pg` — zero setup |
| set | Real PostgreSQL / Supabase via `pg`, same schema and queries |

For Supabase, copy the **connection pooler** URI from the dashboard:

```env
DATABASE_URL=postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres
```

Tables are created automatically on boot (`src/schema.sql`, idempotent
`create table if not exists`). SSL is enabled automatically for remote hosts;
override with `DATABASE_SSL=require|disable`. Both drivers return identical
shapes, so switching is a connection-string change, not a rewrite.

## API

| Method | Route | Notes |
| --- | --- | --- |
| GET | `/` | Dashboard UI |
| GET | `/api/health` | Service, database, Meta mode, realtime clients |
| GET | `/api/health/db` | Real `select 1` against the database |
| GET | `/api/config` | Which credentials are present (never their values) |
| GET | `/api/conversations` | `?q=` search, `?status=open\|closed\|all`, `?limit=` |
| GET | `/api/conversations/:id` | Conversation plus its messages |
| POST | `/api/conversations/:id/status` | `{"status":"open"}` or `{"status":"closed"}` |
| POST | `/api/messages/send` | `{"to":"8801XXXXXXXXX","text":"Hello"}` |
| GET | `/api/metrics` | Volumes, SLA and 14-day throughput |
| GET | `/api/events` | Recent server events (ring buffer) |
| GET | `/api/stream` | SSE stream: `message`, `status`, `conversation`, `event`, `reset` |
| GET | `/api/webhook/whatsapp` | Meta verification handshake |
| POST | `/api/webhook/whatsapp` | Meta event receiver (signature-checked) |
| GET | `/api/webhook/status` | Webhook configuration summary |
| POST | `/api/webhook/simulate` | Fabricate a Meta-shaped event |
| POST | `/api/demo/seed` | Populate demo conversations |
| POST | `/api/demo/reset` | Delete all stored data |

`POST /api/messages/send` responses: `400` invalid/missing fields, `503`
credentials missing (real mode), `502`/`504` Meta unreachable or timed out,
otherwise `200` with the stored message.

### Metrics definitions

- `avgFirstResponseSeconds` — mean of `conversations.first_response_seconds`,
  measured from a contact's latest inbound message to the first business reply
  after it. Failed sends do not count as a response.
- `awaitingReply` — open conversations whose most recent message is inbound.
- Statuses: outbound messages progress `sent → delivered → read`; `failed`
  sticks.

## Architecture

```
server.js                 Express wiring, raw-body capture for signatures, startup/shutdown
src/schema.sql            Postgres schema (PGlite and PostgreSQL compatible)
src/db.js                 Dual driver: pg (DATABASE_URL) or embedded PGlite
src/meta.js               Graph API send, signature verification, inbound parsing
src/hub.js                Ingest, storage, conversation lifecycle, metrics
src/events.js             Server-Sent Events hub
src/routes/api.js         REST API + demo helpers
src/routes/webhook.js     Meta webhook + simulator
public/index.html         Dashboard: inbox, thread, metrics, live events, simulator
```

Auto-forward is off unless `AUTO_FORWARD_TEXT` is set; it supports `{{message}}`
and `{{name}}`, and replies once per inbound message.

## Testing the webhook locally

```bash
# verification handshake (returns the challenge)
curl "http://localhost:3000/api/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=change-this-webhook-token&hub.challenge=12345"

# a signed payload, exactly as Meta sends it
BODY='{"object":"whatsapp_business_account","entry":[{"changes":[{"field":"messages","value":{"contacts":[{"profile":{"name":"Test"},"wa_id":"8801712345678"}],"messages":[{"from":"8801712345678","id":"wamid.TEST1","timestamp":"1759723000","type":"text","text":{"body":"hi"}}]}}]}]}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$META_APP_SECRET" | awk '{print $2}')"
curl -X POST http://localhost:3000/api/webhook/whatsapp \
  -H "X-Hub-Signature-256: $SIG" -H 'Content-Type: application/json' -d "$BODY"
```

## Not included yet

1. Authentication and RBAC — the API is currently open.
2. Multi-tenant accounts/teams and per-agent assignment.
3. Media upload/download for images and documents (non-text types are stored as
   labelled text placeholders).
4. Graph API template messages for sending outside the 24-hour customer window.
5. A migration tool — the schema is applied idempotently at boot.
6. Deploying the dashboard to GitHub Pages works, but Pages is static: point it
   at a separately hosted backend, or serve the dashboard from this server (as
   it does by default).
