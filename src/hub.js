// Business logic for the WhatsApp hub: ingest Meta events, store conversations
// and messages, forward silently, and derive response-time metrics.

import crypto from 'node:crypto';
import { query, withTransaction } from './db.js';
import { broadcast } from './events.js';
import { metaConfig, sendTextMessage, describeInbound, MetaError } from './meta.js';

const newId = () => crypto.randomUUID();
const MAX_EVENTS = 200;

// ---------------------------------------------------------------------------
// Telemetry ring buffer (feeds the dashboard "Events" panel and /api/metrics)
// ---------------------------------------------------------------------------

const eventLog = [];
let eventSeq = 0;

export function logEvent(type, detail = {}) {
  const entry = { id: ++eventSeq, at: new Date().toISOString(), type, detail };
  eventLog.unshift(entry);
  if (eventLog.length > MAX_EVENTS) eventLog.length = MAX_EVENTS;
  broadcast('event', entry);
  return entry;
}

export function recentEvents(limit = 50) {
  return eventLog.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function normalizeWaId(value) {
  return String(value ?? '').replace(/[^\d]/g, '');
}

function toDate(timestamp, fallback = new Date()) {
  if (!timestamp) return fallback;
  const seconds = Number(timestamp);
  if (Number.isFinite(seconds) && seconds > 0) return new Date(seconds * 1000);
  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

// Normalises Meta Cloud API payloads (and the built-in simulator's payloads)
// into a flat list of events.
export function extractEvents(payload) {
  const events = [];
  if (!payload || typeof payload !== 'object') return events;

  if (payload.simulate) {
    if (payload.message) events.push({ kind: 'message', message: payload.message, contacts: payload.message.name ? [{ profile: { name: payload.message.name } }] : [] });
    if (payload.status) events.push({ kind: 'status', status: payload.status });
    return events;
  }

  for (const entry of Array.isArray(payload.entry) ? payload.entry : []) {
    for (const change of Array.isArray(entry.changes) ? entry.changes : []) {
      const value = change?.value || {};
      for (const message of Array.isArray(value.messages) ? value.messages : []) {
        events.push({ kind: 'message', message, contacts: value.contacts || [], metadata: value.metadata || {} });
      }
      for (const status of Array.isArray(value.statuses) ? value.statuses : []) {
        events.push({ kind: 'status', status, metadata: value.metadata || {} });
      }
    }
    if (Array.isArray(entry.messaging)) {
      for (const item of entry.messaging) events.push({ kind: 'unknown', raw: item });
    }
  }

  if (Array.isArray(payload.messages)) {
    for (const message of payload.messages) events.push({ kind: 'message', message, contacts: payload.contacts || [] });
  }
  if (Array.isArray(payload.statuses)) {
    for (const status of payload.statuses) events.push({ kind: 'status', status });
  }

  return events;
}

export async function ingest(payload, { source = 'meta', signature = null } = {}) {
  const events = extractEvents(payload);
  const summary = { received: events.length, messages: 0, statuses: 0, duplicates: 0, unknown: 0, errors: [] };

  for (const event of events) {
    try {
      if (event.kind === 'message') {
        const stored = await storeInboundMessage(event);
        if (stored.duplicate) summary.duplicates += 1;
        else summary.messages += 1;
      } else if (event.kind === 'status') {
        const updated = await storeStatusUpdate(event.status);
        if (updated) summary.statuses += 1;
        else summary.duplicates += 1;
      } else {
        summary.unknown += 1;
      }
    } catch (error) {
      summary.errors.push(error.message);
      logEvent('ingest-error', { message: error.message, payload: event.message?.id || null });
    }
  }

  await query(
    `insert into webhook_events (source, signature_valid, payload, handled, error)
     values ($1, $2, $3, $4, $5)`,
    [source, signature?.valid ?? null, payload ?? null, summary.messages + summary.statuses, summary.errors.join('; ') || null]
  );

  logEvent('webhook-ingest', { source, ...summary });
  return summary;
}

// Creates/refreshes contact + conversation and stores the inbound message.
// Reopens a closed conversation when the contact writes again.
export async function storeInboundMessage({ message, contacts = [] }) {
  const from = normalizeWaId(message?.from);
  if (!from) throw new Error('inbound message without a from number');

  const profileName = contacts?.[0]?.profile?.name || message?.name || null;
  const { type, body } = describeInbound(message);
  const createdAt = toDate(message?.timestamp);
  const waMessageId = message?.id || null;

  const result = await withTransaction(async (q) => {
    let row = (await q('select * from contacts where wa_id = $1', [from]))[0];
    if (!row) {
      row = (await q('insert into contacts (id, wa_id, profile_name) values ($1, $2, $3) returning *', [newId(), from, profileName]))[0];
    } else if (profileName && row.profile_name !== profileName) {
      row = (await q('update contacts set profile_name = $2, updated_at = now() where id = $1 returning *', [row.id, profileName]))[0];
    }
    const contact = row;

    let conversation = (await q('select * from conversations where contact_id = $1', [contact.id]))[0];
    if (!conversation) {
      conversation = (await q(
        `insert into conversations (id, contact_id, status, first_inbound_at, last_inbound_at, last_message_at, last_message_direction)
         values ($1, $2, 'open', $3, $3, $3, 'inbound') returning *`,
        [newId(), contact.id, createdAt]
      ))[0];
      logEvent('conversation-opened', { conversationId: conversation.id, waId: from, name: profileName });
    } else {
      conversation = (await q(
        `update conversations
            set status = 'open',
                closed_at = null,
                first_inbound_at = coalesce(first_inbound_at, $2),
                last_inbound_at = $2,
                last_message_at = $2,
                last_message_direction = 'inbound',
                updated_at = now()
          where id = $1 returning *`,
        [conversation.id, createdAt]
      ))[0];
    }

    const inserted = (await q(
      `insert into messages (id, conversation_id, wa_message_id, direction, type, body, status, created_at, meta)
       values ($1, $2, $3, 'inbound', $4, $5, 'received', $6, $7)
       on conflict (wa_message_id) do nothing
       returning *`,
      [newId(), conversation.id, waMessageId, type, body, createdAt, message ?? null]
    ))[0];

    if (!inserted) return { duplicate: true, conversation, contact };
    return { duplicate: false, conversation, contact, message: inserted };
  });

  if (result.duplicate) {
    logEvent('duplicate-message', { waMessageId, from });
    return result;
  }

  const payload = {
    conversation: { ...result.conversation, contact: result.contact },
    message: result.message
  };
  broadcast('message', payload);
  broadcast('conversation', result.conversation);
  logEvent('message-in', { waId: from, name: profileName, body: result.message.body, conversationId: result.conversation.id });

  maybeForward(result.conversation, result.contact, result.message).catch((error) => {
    logEvent('forward-error', { message: error.message });
  });

  return result;
}

// Delivery/read receipts. Statuses only ever move forward, and `failed` sticks.
const STATUS_RANK = { accepted: 1, sent: 1, delivered: 2, read: 3, failed: 4 };

export async function storeStatusUpdate(status = {}) {
  const waMessageId = status.id;
  if (!waMessageId) return false;

  const rows = await query('select id, conversation_id, status from messages where wa_message_id = $1', [waMessageId]);
  const message = rows[0];
  if (!message) {
    logEvent('status-for-unknown-message', { waMessageId, status: status.status });
    return false;
  }

  const next = String(status.status || '').toLowerCase();
  const current = String(message.status || '').toLowerCase();
  const at = toDate(status.timestamp, new Date());

  if (current === 'failed' && next !== 'failed') return false;
  if (current === 'read' && (STATUS_RANK[next] ?? 0) < 3) return false;
  if ((STATUS_RANK[next] ?? 0) > 0 && (STATUS_RANK[next] ?? 0) < (STATUS_RANK[current] ?? 0)) return false;

  const error = Array.isArray(status.errors) && status.errors.length ? status.errors[0] : null;
  await query('update messages set status = $2, status_updated_at = $3, error = $4 where id = $1', [message.id, next, at, error]);

  const payload = { messageId: message.id, conversationId: message.conversation_id, waMessageId, status: next, at };
  broadcast('status', payload);
  logEvent('status-update', { waMessageId, status: next });
  return true;
}

// ---------------------------------------------------------------------------
// Outbound
// ---------------------------------------------------------------------------

async function ensureConversationForOutbound(waId) {
  const at = new Date();
  return withTransaction(async (q) => {
    let contact = (await q('select * from contacts where wa_id = $1', [waId]))[0];
    if (!contact) contact = (await q('insert into contacts (id, wa_id) values ($1, $2) returning *', [newId(), waId]))[0];

    let conversation = (await q('select * from conversations where contact_id = $1', [contact.id]))[0];
    if (!conversation) {
      conversation = (await q(
        `insert into conversations (id, contact_id, status, last_message_at, last_message_direction)
         values ($1, $2, 'open', $3, 'outbound') returning *`,
        [newId(), contact.id, at]
      ))[0];
    } else {
      conversation = (await q(
        `update conversations
            set status = 'open', closed_at = null, last_message_at = $2, last_message_direction = 'outbound', updated_at = now()
          where id = $1 returning *`,
        [conversation.id, at]
      ))[0];
    }
    return { contact, conversation };
  });
}

// Records the outbound message, and stamps the first-response time when this is
// the first business reply after the contact's latest inbound message.
async function recordOutbound({ conversationId, waMessageId, body, status, error, meta, simulated }) {
  const at = new Date();
  return withTransaction(async (q) => {
    const message = (await q(
      `insert into messages (id, conversation_id, wa_message_id, direction, type, body, status, status_updated_at, error, meta, created_at)
       values ($1, $2, $3, 'outbound', 'text', $4, $5, $6, $7, $8, $9)
       on conflict (wa_message_id) do nothing
       returning *`,
      [newId(), conversationId, waMessageId, body, status, at, error ?? null, meta ?? null, at]
    ))[0];

    if (!message) return null;

    let conversation = (await q(
      `update conversations
          set last_message_at = $2, last_message_direction = 'outbound', updated_at = now()
        where id = $1 returning *`,
      [conversationId, at]
    ))[0];

    const needsResponse = conversation.first_inbound_at
      && (!conversation.first_response_at || new Date(conversation.first_inbound_at) > new Date(conversation.first_response_at));

    if (needsResponse && status !== 'failed') {
      const seconds = Math.max(0, Math.round((at.getTime() - new Date(conversation.first_inbound_at).getTime()) / 1000));
      conversation = (await q(
        `update conversations
            set first_response_at = $2, first_response_seconds = $3, updated_at = now()
          where id = $1 returning *`,
        [conversationId, at, seconds]
      ))[0];
      logEvent('first-response', { conversationId, seconds });
    }

    return { message, conversation };
  });
}

export async function sendOutbound(to, text) {
  const waId = normalizeWaId(to);
  const { contact, conversation } = await ensureConversationForOutbound(waId);
  const cfg = metaConfig();

  if (cfg.simulateMeta) {
    const waMessageId = `wamid.SIM.${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const stored = await recordOutbound({
      conversationId: conversation.id, waMessageId, body: text,
      status: 'sent', meta: { simulated: true }, simulated: true
    });
    const payload = { conversation: { ...stored.conversation, contact }, message: stored.message };
    broadcast('message', payload);
    broadcast('conversation', stored.conversation);
    logEvent('message-out', { waId, body: text, simulated: true, conversationId: conversation.id });
    return { simulated: true, conversation: stored.conversation, contact, message: stored.message };
  }

  let sent;
  try {
    sent = await sendTextMessage(waId, text);
  } catch (error) {
    const metaError = error instanceof MetaError ? error : new MetaError(error.message);
    const stored = await recordOutbound({
      conversationId: conversation.id,
      waMessageId: `local.FAILED.${crypto.randomUUID()}`,
      body: text,
      status: 'failed',
      error: { kind: metaError.kind, status: metaError.status, message: metaError.message, details: metaError.details },
      meta: null
    });
    broadcast('conversation', stored.conversation);
    logEvent('message-out-failed', { waId, kind: metaError.kind, message: metaError.message });
    metaError.storedMessageId = stored.message?.id ?? null;
    throw metaError;
  }

  const stored = await recordOutbound({
    conversationId: conversation.id, waMessageId: sent.waMessageId, body: text, status: 'sent', meta: sent.raw
  });
  const payload = { conversation: { ...stored.conversation, contact }, message: stored.message };
  broadcast('message', payload);
  broadcast('conversation', stored.conversation);
  logEvent('message-out', { waId, body: text, waMessageId: sent.waMessageId, conversationId: conversation.id });
  return { simulated: false, conversation: stored.conversation, contact, message: stored.message };
}

// Auto-forward: reply once per inbound message when AUTO_FORWARD_TEXT is set.
async function maybeForward(conversation, contact, message) {
  const template = (process.env.AUTO_FORWARD_TEXT || '').trim();
  if (!template || message.direction !== 'inbound') return;
  const body = template.replaceAll('{{message}}', message.body || '').replaceAll('{{name}}', contact.profile_name || contact.wa_id);
  await sendOutbound(contact.wa_id, body);
  logEvent('auto-forward', { conversationId: conversation.id, waId: contact.wa_id });
}

// ---------------------------------------------------------------------------
// Queries for the dashboard
// ---------------------------------------------------------------------------

export async function listConversations({ search = '', status = 'all', limit = 50 } = {}) {
  const params = [];
  const where = [];

  if (search.trim()) {
    params.push(`%${search.trim()}%`);
    where.push(`(c.wa_id like $${params.length} or coalesce(c.profile_name, '') ilike $${params.length})`);
  }
  if (status !== 'all') {
    params.push(status);
    where.push(`v.status = $${params.length}`);
  }
  params.push(Math.min(Math.max(Number(limit) || 50, 1), 200));

  return query(
    `select v.*, c.wa_id, c.profile_name, c.updated_at as contact_updated_at
       from conversations v
       join contacts c on c.id = v.contact_id
      ${where.length ? 'where ' + where.join(' and ') : ''}
      order by v.last_message_at desc nulls last
      limit $${params.length}`,
    params
  );
}

export async function getConversation(id) {
  const conversations = await query(
    `select v.*, c.wa_id, c.profile_name, c.created_at as contact_created_at
       from conversations v join contacts c on c.id = v.contact_id
      where v.id = $1`,
    [id]
  );
  if (!conversations.length) return null;
  const messages = await query('select * from messages where conversation_id = $1 order by created_at asc limit 500', [id]);
  return { conversation: conversations[0], messages };
}

export async function setConversationStatus(id, status) {
  const rows = await query(
    `update conversations
        set status = $2, closed_at = case when $2 = 'closed' then now() else null end, updated_at = now()
      where id = $1 returning *`,
    [id, status]
  );
  if (rows.length) {
    broadcast('conversation', rows[0]);
    logEvent('conversation-status', { conversationId: id, status });
  }
  return rows[0] || null;
}

export async function metrics() {
  const [totals] = await query(
    `select
        count(*) filter (where direction = 'inbound')  as inbound,
        count(*) filter (where direction = 'outbound') as outbound,
        count(*) filter (where direction = 'outbound' and status = 'failed') as failed,
        count(*) filter (where direction = 'outbound' and status = 'delivered') as delivered,
        count(*) filter (where direction = 'outbound' and status = 'read') as read
      from messages`
  );

  const [contacts] = await query('select count(*)::int as total from contacts');

  const [conversations] = await query(
    `select
        count(*)::int as total,
        count(*) filter (where status = 'open')::int as open,
        count(*) filter (where status = 'open' and last_message_direction = 'inbound')::int as awaiting_reply,
        avg(first_response_seconds) as avg_first_response_seconds,
        count(*) filter (where first_response_seconds is not null)::int as measured
      from conversations`
  );

  const throughput = await query(
    `select to_char(date_trunc('day', created_at), 'YYYY-MM-DD') as day,
            count(*) filter (where direction = 'inbound')::int  as inbound,
            count(*) filter (where direction = 'outbound')::int as outbound
       from messages
      where created_at > now() - interval '13 days'
      group by 1 order by 1`
  );

  const [webhook] = await query('select count(*)::int as total, max(received_at) as last_at from webhook_events');

  return {
    messages: {
      inbound: Number(totals?.inbound || 0),
      outbound: Number(totals?.outbound || 0),
      failed: Number(totals?.failed || 0),
      delivered: Number(totals?.delivered || 0),
      read: Number(totals?.read || 0)
    },
    contacts: contacts?.total || 0,
    conversations: {
      total: conversations?.total || 0,
      open: conversations?.open || 0,
      awaitingReply: conversations?.awaiting_reply || 0,
      avgFirstResponseSeconds: conversations?.avg_first_response_seconds != null
        ? Math.round(Number(conversations.avg_first_response_seconds))
        : null,
      measuredResponses: conversations?.measured || 0
    },
    webhookEvents: { total: webhook?.total || 0, lastReceivedAt: webhook?.last_at || null },
    throughput
  };
}

export async function resetDemoData() {
  await query('truncate messages, conversations, contacts, webhook_events restart identity cascade');
  logEvent('demo-reset', {});
  broadcast('reset', {});
}
