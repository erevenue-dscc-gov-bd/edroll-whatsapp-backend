// REST API + realtime stream for the hub dashboard.

import express from 'express';
import { health as dbHealth, dbMode, dbError } from '../db.js';
import { metaConfig, MetaError } from '../meta.js';
import { addClient, clientCount } from '../events.js';
import {
  ingest, logEvent, recentEvents, sendOutbound, normalizeWaId,
  listConversations, getConversation, setConversationStatus, metrics, resetDemoData
} from '../hub.js';

const router = express.Router();

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// --- status -----------------------------------------------------------------

router.get('/health', (_req, res) => {
  const cfg = metaConfig();
  res.json({
    ok: true,
    service: 'edroll-whatsapp-backend',
    uptimeSeconds: Math.round(process.uptime()),
    database: { connected: Boolean(dbMode() !== 'uninitialised' && !dbError()), mode: dbMode() },
    meta: { credentialsConfigured: cfg.credentialsConfigured, simulated: cfg.simulateMeta },
    realtimeClients: clientCount()
  });
});

router.get('/health/db', wrap(async (_req, res) => {
  res.json(await dbHealth());
}));

router.get('/config', (_req, res) => {
  const cfg = metaConfig();
  res.json({
    metaGraphVersion: cfg.graphVersion,
    phoneNumberConfigured: Boolean(cfg.phoneNumberId),
    accessTokenConfigured: Boolean(cfg.accessToken),
    verifyTokenConfigured: Boolean(cfg.verifyToken),
    appSecretConfigured: Boolean(cfg.appSecret),
    webhookConfigured: Boolean(cfg.verifyToken),
    simulateMeta: cfg.simulateMeta,
    simulatorEnabled: cfg.simulatorEnabled,
    autoForward: Boolean((process.env.AUTO_FORWARD_TEXT || '').trim())
  });
});

router.get('/events', (req, res) => {
  res.json({ events: recentEvents(Number(req.query.limit) || 50) });
});

// --- realtime ---------------------------------------------------------------

router.get('/stream', (req, res) => {
  addClient(req, res);
});

// --- conversations ----------------------------------------------------------

router.get('/conversations', wrap(async (req, res) => {
  const conversations = await listConversations({
    search: req.query.q || '',
    status: req.query.status || 'all',
    limit: req.query.limit
  });
  res.json({ conversations });
}));

router.get('/conversations/:id', wrap(async (req, res) => {
  const result = await getConversation(req.params.id);
  if (!result) return res.status(404).json({ error: 'Conversation not found' });
  res.json(result);
}));

router.post('/conversations/:id/status', wrap(async (req, res) => {
  const status = req.body?.status;
  if (!['open', 'closed'].includes(status)) return res.status(400).json({ error: 'status must be "open" or "closed"' });
  const conversation = await setConversationStatus(req.params.id, status);
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
  res.json({ ok: true, conversation });
}));

// --- send -------------------------------------------------------------------

router.post('/messages/send', wrap(async (req, res) => {
  const { to, text } = req.body || {};
  const waId = normalizeWaId(to);
  if (!to || !text) return res.status(400).json({ error: 'to and text are required' });
  if (waId.length < 6) return res.status(400).json({ error: 'to must be a full international number, e.g. 8801XXXXXXXXX' });

  try {
    const result = await sendOutbound(waId, String(text));
    res.json({
      ok: true,
      simulated: result.simulated,
      conversationId: result.conversation.id,
      message: result.message,
      meta: result.message?.meta ?? null,
      note: result.simulated
        ? 'Stored locally: no Meta credentials configured, so nothing was actually sent.'
        : undefined
    });
  } catch (error) {
    const metaError = error instanceof MetaError ? error : new MetaError(error.message);
    res.status(metaError.status || 502).json({
      error: metaError.message,
      kind: metaError.kind,
      details: metaError.details,
      storedMessageId: metaError.storedMessageId ?? null
    });
  }
}));

// --- metrics ----------------------------------------------------------------

router.get('/metrics', wrap(async (_req, res) => {
  res.json(await metrics());
}));

// --- demo helpers -----------------------------------------------------------

router.post('/demo/reset', wrap(async (_req, res) => {
  await resetDemoData();
  res.json({ ok: true, reset: true });
}));

router.post('/demo/seed', wrap(async (_req, res) => {
  const simulated = metaConfig().simulateMeta;
  const scenarios = [
    { name: 'Rahim Ahmed', waId: '8801711000001', minutesAgo: 12, text: 'Assalamu alaikum. I need help renewing my trade licence.' },
    { name: 'Nusrat Jahan', waId: '8801811000002', minutesAgo: 45, text: 'Is the student assessment form submitted online?' },
    { name: 'Karim Traders', waId: '8801911000003', minutesAgo: 180, text: 'Our payment was deducted but the receipt did not download.' }
  ];

  const created = [];
  for (const scenario of scenarios) {
    const at = new Date(Date.now() - scenario.minutesAgo * 60000);
    const payload = {
      object: 'whatsapp_business_account',
      entry: [{
        id: 'SEED',
        changes: [{
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: 'seeded', phone_number_id: 'seeded' },
            contacts: [{ profile: { name: scenario.name }, wa_id: scenario.waId }],
            messages: [{
              from: scenario.waId,
              id: `wamid.SEED.${scenario.waId}`,
              timestamp: String(Math.floor(at.getTime() / 1000)),
              type: 'text',
              text: { body: scenario.text }
            }]
          }
        }]
      }]
    };

    const summary = await ingest(payload, { source: 'demo-seed', signature: { valid: null, reason: 'seeded' } });
    created.push({ waId: scenario.waId, stored: summary.messages, duplicates: summary.duplicates });

    // Only fabricate business replies in simulated mode; with real credentials
    // this would fire actual WhatsApp messages at demo numbers.
    if (simulated && summary.messages > 0) {
      const reply = await sendOutbound(scenario.waId, `Thanks ${scenario.name.split(' ')[0]}, our team is looking into this and will reply shortly.`);
      await sleep(150);
      await ingest({
        object: 'whatsapp_business_account',
        entry: [{
          id: 'SEED',
          changes: [{
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: 'seeded', phone_number_id: 'seeded' },
              statuses: [{ id: reply.message.wa_message_id, status: 'delivered', timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: scenario.waId }]
            }
          }]
        }]
      }, { source: 'demo-seed', signature: { valid: null, reason: 'seeded' } });
    }
  }

  logEvent('demo-seed', { scenarios: created.length, simulatedReplies: simulated });
  res.json({ ok: true, created, simulatedReplies: simulated });
}));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default router;
