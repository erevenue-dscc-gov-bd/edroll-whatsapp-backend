import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { initDb, closeDb, dbMode, markInitError } from './src/db.js';
import { metaConfig } from './src/meta.js';
import { closeAll } from './src/events.js';
import apiRoutes from './src/routes/api.js';
import webhookRoutes from './src/routes/webhook.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

// FRONTEND_ORIGIN accepts a comma-separated allowlist. When empty the caller's
// origin is reflected, so hosted previews, localhost and file:// demos all work.
const allowedOrigins = (process.env.FRONTEND_ORIGIN || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(null, false);
  }
}));

// Keep the raw bytes so Meta's X-Hub-Signature-256 can be verified.
app.use(express.json({
  limit: '1mb',
  verify: (req, _res, buf) => { req.rawBody = Buffer.from(buf); }
}));

app.use((req, _res, next) => {
  if (req.path.startsWith('/api')) console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

app.use('/api/webhook', webhookRoutes);
app.use('/api', apiRoutes);
app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown API route' }));

// Dashboard (public/index.html) served from this same origin.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
  }
}));

app.use((error, req, res, _next) => {
  console.error('[server]', error.message);
  if (!res.headersSent) res.status(500).json({ error: error.message });
});

async function start() {
  try {
    const info = await initDb();
    console.log(`[db] ready (${info.mode}) → ${info.target}`);
  } catch (error) {
    markInitError(error);
    console.error(`[db] initialisation failed: ${error.message}`);
    console.error('[db] the API will start, but storage-backed routes will return errors.');
  }

  const cfg = metaConfig();
  const server = app.listen(PORT, HOST, () => {
    console.log(`Edroll WhatsApp backend running on http://${HOST}:${PORT}`);
    console.log(`[meta] credentials ${cfg.credentialsConfigured ? 'configured' : 'NOT configured'} · outbound sends ${cfg.simulateMeta ? 'SIMULATED and stored locally' : 'live via graph.facebook.com'}`);
    console.log(`[db] mode: ${dbMode()}`);
    console.log('[ready] dashboard at /, webhook at /api/webhook/whatsapp');
  });

  const shutdown = async (signal) => {
    console.log(`\n[shutdown] ${signal} received`);
    closeAll();
    server.close();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

start();
