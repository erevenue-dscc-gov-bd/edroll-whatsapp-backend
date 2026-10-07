// Meta webhook endpoints + a built-in simulator.
//
// GET  /api/webhook/whatsapp  — Meta's verification handshake (hub.challenge)
// POST /api/webhook/whatsapp  — inbound messages and delivery statuses
// GET  /api/webhook/status    — what is configured, for the dashboard
// POST /api/webhook/simulate  — fabricate a Meta-shaped payload (no credentials needed)

import express from 'express';
import { metaConfig, verifySignature } from '../meta.js';
import { ingest, logEvent, normalizeWaId } from '../hub.js';

const router = express.Router();

router.get('/whatsapp', (req, res) => {
  const cfg = metaConfig();
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && cfg.verifyToken && token === cfg.verifyToken) {
    if (!cfg.appSecret) {
      console.warn('[webhook] META_APP_SECRET is not set — payload signatures will NOT be verified in production.');
    }
    logEvent('webhook-verified', { challenge: String(challenge ?? '') });
    return res.status(200).type('text/plain').send(String(challenge ?? ''));
  }

  logEvent('webhook-verify-rejected', { mode: mode || null, tokenProvided: Boolean(token) });
  return res.status(403).json({ error: 'Webhook verification failed: hub.verify_token mismatch.' });
});

router.post('/whatsapp', async (req, res) => {
  const signature = verifySignature(req.rawBody ?? Buffer.alloc(0), req.get('x-hub-signature-256'));

  if (signature.valid === false) {
    logEvent('webhook-signature-invalid', { reason: signature.reason });
    return res.status(403).json({ error: `Invalid signature: ${signature.reason}` });
  }

  // Always acknowledge promptly; Meta retries aggressively on non-200.
  res.status(200).json({ received: true, signatureChecked: signature.valid });

  try {
    await ingest(req.body, { source: 'meta', signature });
  } catch (error) {
    console.error('[webhook] ingest failed:', error.message);
    logEvent('webhook-error', { message: error.message });
  }
});

router.get('/status', (_req, res) => {
  const cfg = metaConfig();
  res.json({
    configured: Boolean(cfg.verifyToken),
    verifyTokenConfigured: Boolean(cfg.verifyToken),
    appSecretConfigured: Boolean(cfg.appSecret),
    signatureVerification: cfg.appSecret ? 'enabled' : 'disabled (set META_APP_SECRET)',
    credentialsConfigured: cfg.credentialsConfigured,
    simulatorEnabled: cfg.simulatorEnabled,
    callbackPath: '/api/webhook/whatsapp',
    note: cfg.credentialsConfigured
      ? 'Ready for Meta: point the app callback at /api/webhook/whatsapp and subscribe to the messages field.'
      : 'No Meta credentials yet — use POST /api/webhook/simulate to exercise the pipeline.'
  });
});

// Builds a real Cloud-API-shaped payload and pushes it through the normal
// ingest path, so simulated traffic exercises exactly the same code.
router.post('/simulate', async (req, res) => {
  const cfg = metaConfig();
  if (!cfg.simulatorEnabled) {
    return res.status(403).json({ error: 'Simulator is disabled because Meta credentials are configured. Set ENABLE_SIMULATOR=true to force it on.' });
  }

  const body = req.body || {};
  const from = normalizeWaId(body.from || body.waId);
  const text = body.text ?? body.body;
  const statusUpdate = body.status;

  if (!from && !statusUpdate) return res.status(400).json({ error: 'Provide "from" + "text" for an inbound message, or "status" for a delivery receipt.' });
  if (from && !text) return res.status(400).json({ error: '"text" is required when simulating an inbound message.' });

  try {
    const summary = { messages: 0, statuses: 0, duplicates: 0 };

    if (from) {
      const payload = {
        object: 'whatsapp_business_account',
        entry: [{
          id: 'SIMULATOR',
          changes: [{
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: 'simulated', phone_number_id: 'simulated' },
              contacts: [{ profile: { name: body.name || undefined }, wa_id: from }],
              messages: [{
                from,
                id: `wamid.SIMIN.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
                timestamp: String(Math.floor(Date.now() / 1000)),
                type: 'text',
                text: { body: String(text) }
              }]
            }
          }]
        }]
      };
      const result = await ingest(payload, { source: 'simulator', signature: { valid: null, reason: 'simulator' } });
      summary.messages += result.messages;
      summary.duplicates += result.duplicates;
    }

    if (statusUpdate) {
      const payload = {
        object: 'whatsapp_business_account',
        entry: [{
          id: 'SIMULATOR',
          changes: [{
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: 'simulated', phone_number_id: 'simulated' },
              statuses: [{
                id: statusUpdate.id || statusUpdate.waMessageId,
                status: statusUpdate.status || 'delivered',
                timestamp: String(Math.floor(Date.now() / 1000)),
                recipient_id: statusUpdate.recipientId || from || null
              }]
            }
          }]
        }]
      };
      const result = await ingest(payload, { source: 'simulator', signature: { valid: null, reason: 'simulator' } });
      summary.statuses += result.statuses;
      summary.duplicates += result.duplicates;
    }

    res.json({ ok: true, simulated: true, summary });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
