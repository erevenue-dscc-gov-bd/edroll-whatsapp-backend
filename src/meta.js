// Meta WhatsApp Cloud API integration: credentials, signature verification and sending.

import crypto from 'node:crypto';

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v23.0';
const PHONE_NUMBER_ID = (process.env.META_PHONE_NUMBER_ID || '').trim();
const ACCESS_TOKEN = (process.env.META_ACCESS_TOKEN || '').trim();
const APP_SECRET = (process.env.META_APP_SECRET || '').trim();
const VERIFY_TOKEN = (process.env.META_VERIFY_TOKEN || '').trim();
const GRAPH_TIMEOUT_MS = Number(process.env.GRAPH_TIMEOUT_MS || 15000);

// Simulated Meta mode: when no credentials exist the hub would be untestable, so
// outbound sends are recorded locally instead of calling the Graph API.
// Force with SIMULATE_META=true|false.
const SIMULATE_FLAG = (process.env.SIMULATE_META || '').trim().toLowerCase();
const SIMULATE_META = SIMULATE_FLAG
  ? ['1', 'true', 'yes', 'on'].includes(SIMULATE_FLAG)
  : !(PHONE_NUMBER_ID && ACCESS_TOKEN);

export function metaConfig() {
  return {
    graphVersion: GRAPH_VERSION,
    phoneNumberId: PHONE_NUMBER_ID,
    accessToken: ACCESS_TOKEN,
    appSecret: APP_SECRET,
    verifyToken: VERIFY_TOKEN,
    timeoutMs: GRAPH_TIMEOUT_MS,
    credentialsConfigured: Boolean(PHONE_NUMBER_ID && ACCESS_TOKEN),
    simulateMeta: SIMULATE_META,
    simulatorEnabled: SIMULATE_META || ['1', 'true', 'yes', 'on'].includes((process.env.ENABLE_SIMULATOR || '').toLowerCase())
  };
}

export class MetaError extends Error {
  constructor(message, { kind = 'http', status = 502, details = null } = {}) {
    super(message);
    this.name = 'MetaError';
    this.kind = kind;       // unreachable | timeout | http | not-configured
    this.status = status;
    this.details = details;
  }
}

// Verifies Meta's X-Hub-Signature-256 over the raw request body.
// Returns { valid: true | false | null, reason }. `null` means the check could
// not be performed because META_APP_SECRET is not configured.
export function verifySignature(rawBody, signatureHeader) {
  if (!APP_SECRET) return { valid: null, reason: 'META_APP_SECRET is not configured, signature not checked' };
  if (!signatureHeader) return { valid: false, reason: 'missing X-Hub-Signature-256 header' };

  const expected = `sha256=${crypto.createHmac('sha256', APP_SECRET).update(rawBody).digest('hex')}`;
  const received = String(signatureHeader);
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  if (a.length !== b.length) return { valid: false, reason: 'signature length mismatch' };
  return { valid: crypto.timingSafeEqual(a, b), reason: 'ok' };
}

export function signPayload(rawBody) {
  if (!APP_SECRET) return null;
  return `sha256=${crypto.createHmac('sha256', APP_SECRET).update(rawBody).digest('hex')}`;
}

// Sends a text message through the Graph API.
// Throws MetaError; callers decide how to persist/return the failure.
export async function sendTextMessage(to, text) {
  const { credentialsConfigured } = metaConfig();
  if (!credentialsConfigured) {
    throw new MetaError('Meta credentials are not configured.', { kind: 'not-configured', status: 503 });
  }

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`;
  let response;
  try {
    response = await fetch(url, {
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
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      throw new MetaError(`Meta Graph API did not respond within ${GRAPH_TIMEOUT_MS}ms.`, { kind: 'timeout', status: 504 });
    }
    throw new MetaError(`Could not reach graph.facebook.com from this host (${error.message}).`, {
      kind: 'unreachable',
      status: 502,
      details: {
        hint: 'This server has no outbound access to Meta. Run it on a host that does to send for real.'
      }
    });
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new MetaError(data?.error?.message || 'Meta API error', { kind: 'http', status: response.status, details: data });
  }

  return { waMessageId: data?.messages?.[0]?.id || null, raw: data };
}

// Extracts text out of the various inbound message shapes Meta sends.
export function describeInbound(message) {
  const type = message?.type || 'unknown';
  const value = message?.[type];

  if (type === 'text') return { type, body: value?.body ?? null };
  if (type === 'button') return { type, body: value?.text ?? value?.payload ?? null };
  if (type === 'interactive') {
    const reply = value?.button_reply || value?.list_reply;
    return { type, body: reply?.title ?? null };
  }
  if (type === 'image' || type === 'video' || type === 'document' || type === 'audio' || type === 'sticker') {
    return { type, body: value?.caption || `[${type}]` };
  }
  if (type === 'location') {
    return { type, body: value?.name || `[location ${value?.latitude ?? '?'},${value?.longitude ?? '?'}]` };
  }
  if (type === 'contacts') return { type, body: '[contact card]' };
  if (type === 'reaction') return { type, body: `[reaction ${value?.emoji ?? ''}]`.trim() };
  return { type, body: `[${type}]` };
}
