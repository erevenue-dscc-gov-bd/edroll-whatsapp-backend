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

Keep `.env` private. Do not place the Meta access token in the HTML/frontend.

## 3. Run

```bash
npm run dev
```

Backend: `http://localhost:3000`

## API

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

## Webhook

Webhook routes are deliberately placeholders. Add Meta verification and inbound/status event processing later, as requested.

## Next production steps

1. Add PostgreSQL/Supabase.
2. Add authentication and RBAC.
3. Store accounts, contacts, conversations and messages.
4. Implement Meta webhook verification and event processing.
5. Add real-time Socket.IO/WebSocket updates.
6. Calculate first-response and SLA metrics from stored timestamps.
7. Deploy behind HTTPS.
