import 'dotenv/config';
import express from 'express';
import cors from 'cors';

const app = express();
const PORT = Number(process.env.PORT || 3000);
const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v23.0';
const PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID || '';
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || '';
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || '';

app.use(cors({ origin: process.env.FRONTEND_ORIGIN || true }));
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'edroll-whatsapp-backend', metaConfigured: Boolean(PHONE_NUMBER_ID && ACCESS_TOKEN) });
});

app.get('/api/health/db', (_req, res) => {
  // Replace this with PostgreSQL/Supabase health query when DB is added.
  res.json({ connected: false, mode: 'database-not-configured' });
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
      return res.status(503).json({ error: 'Meta credentials are not configured. Add them to .env.' });
    }

    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: false, body: text } })
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: 'Meta API error', details: data });
    res.json({ ok: true, meta: data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/config', (_req, res) => {
  res.json({ metaGraphVersion: GRAPH_VERSION, phoneNumberConfigured: Boolean(PHONE_NUMBER_ID), accessTokenConfigured: Boolean(ACCESS_TOKEN), webhookConfigured: false });
});

// Webhook placeholder: add GET verification + POST event handling later.
app.get('/api/webhook/whatsapp', (_req, res) => res.status(501).json({ error: 'Webhook verification not configured yet' }));
app.post('/api/webhook/whatsapp', (_req, res) => res.status(501).json({ error: 'Webhook event handler not configured yet' }));

app.listen(PORT, () => console.log(`Edroll WhatsApp backend running on http://localhost:${PORT}`));
