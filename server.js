import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v23.0';
const PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID || '';
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || '';
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || '';
const GRAPH_TIMEOUT_MS = Number(process.env.GRAPH_TIMEOUT_MS || 15000);

// FRONTEND_ORIGIN accepts a comma-separated allowlist. When it is empty we
// reflect the caller's origin, so hosted previews, localhost and file:// demos
// all work without extra configuration.
const allowedOrigins = (process.env.FRONTEND_ORIGIN || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(null, false);
    }
  })
);
app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  if (req.path.startsWith('/api')) console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

// Built-in console UI (public/index.html) so the API can be exercised from a browser.
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'edroll-whatsapp-backend',
    metaConfigured: Boolean(PHONE_NUMBER_ID && ACCESS_TOKEN),
    uptimeSeconds: Math.round(process.uptime())
  });
});

app.get('/api/health/db', (_req, res) => {
  // Replace this with a PostgreSQL/Supabase health query once DATABASE_URL is set.
  res.json({
    connected: false,
    mode: 'database-not-configured',
    note: 'Set DATABASE_URL and wire the pg pool here to enable this check.'
  });
});

app.get('/api/webhook/status', (_req, res) => {
  res.json({ configured: false, note: 'Webhook routes are intentionally left for your later setup.' });
});

// Meta WhatsApp Cloud API send-message proxy.
// Credentials stay on the server; never put META_ACCESS_TOKEN in the HTML.
app.post('/api/messages/send', async (req, res) => {
  try {
    const { to, text } = req.body || {};
    if (!to || !text) return res.status(400).json({ error: 'to and text are required' });
    if (!PHONE_NUMBER_ID || !ACCESS_TOKEN) {
      return res.status(503).json({
        error: 'Meta credentials are not configured. Add META_PHONE_NUMBER_ID and META_ACCESS_TOKEN to .env.'
      });
    }

    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { preview_url: false, body: text }
      }),
      signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return res.status(response.status).json({ error: 'Meta API error', details: data });
    res.json({ ok: true, meta: data });
  } catch (error) {
    if (error.name === 'TimeoutError') {
      return res.status(504).json({ error: `Meta Graph API did not respond within ${GRAPH_TIMEOUT_MS}ms.` });
    }
    if (error instanceof TypeError) {
      return res.status(502).json({
        error: 'Could not reach graph.facebook.com from this host.',
        hint: 'The server has no outbound internet access to Meta. Run it on a host that does, then retry.',
        details: error.message
      });
    }
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/config', (_req, res) => {
  res.json({
    metaGraphVersion: GRAPH_VERSION,
    phoneNumberConfigured: Boolean(PHONE_NUMBER_ID),
    accessTokenConfigured: Boolean(ACCESS_TOKEN),
    verifyTokenConfigured: Boolean(VERIFY_TOKEN),
    webhookConfigured: false,
    allowedOrigins: allowedOrigins.length ? allowedOrigins : 'any'
  });
});

// Webhook placeholder: add GET verification + POST event handling later.
app.get('/api/webhook/whatsapp', (_req, res) => res.status(501).json({ error: 'Webhook verification not configured yet' }));
app.post('/api/webhook/whatsapp', (_req, res) => res.status(501).json({ error: 'Webhook event handler not configured yet' }));

app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown API route' }));

app.listen(PORT, HOST, () => {
  console.log(`Edroll WhatsApp backend running on http://${HOST}:${PORT}`);
  console.log(`Meta credentials: ${PHONE_NUMBER_ID && ACCESS_TOKEN ? 'configured' : 'NOT configured (set them in .env)'}`);
});
