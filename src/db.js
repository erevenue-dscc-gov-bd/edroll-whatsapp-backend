// Storage layer.
//
// Two interchangeable drivers, same SQL and same call signatures:
//   * DATABASE_URL set  -> real PostgreSQL (Supabase, RDS, local server) via `pg`
//   * DATABASE_URL unset -> embedded Postgres (PGlite) persisted to .data/pg
//
// This means the hub runs with zero credentials, and moving to Supabase is a
// connection-string change rather than a rewrite.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');
const DEFAULT_PGLITE_DIR = path.join(__dirname, '..', '.data', 'pg');

const DATABASE_URL = (process.env.DATABASE_URL || '').trim();

let mode = null;          // 'postgres' | 'pglite'
let pool = null;          // pg.Pool
let pglite = null;        // PGlite instance
let initError = null;

function needsSsl(connectionString) {
  if (process.env.DATABASE_SSL === 'disable') return false;
  if (process.env.DATABASE_SSL === 'require') return true;
  return !/@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(connectionString);
}

export async function initDb() {
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');

  if (DATABASE_URL) {
    const mod = await import('pg');
    const Pool = mod.default?.Pool ?? mod.Pool;
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: needsSsl(DATABASE_URL) ? { rejectUnauthorized: false } : undefined,
      max: Number(process.env.DATABASE_POOL_MAX || 10)
    });
    pool.on('error', (error) => console.error('[db] idle client error:', error.message));
    await pool.query(schema);
    mode = 'postgres';
    return { mode, target: 'DATABASE_URL (PostgreSQL)' };
  }

  const { PGlite } = await import('@electric-sql/pglite');
  const dir = process.env.PGLITE_DIR || DEFAULT_PGLITE_DIR;
  fs.mkdirSync(dir, { recursive: true });
  pglite = new PGlite(dir);
  await pglite.exec(schema);
  mode = 'pglite';
  return { mode, target: dir };
}

export function dbReady() {
  return Boolean(mode) && !initError;
}

export function dbError() {
  return initError;
}

export function dbMode() {
  return mode || 'uninitialised';
}

export async function query(text, params = []) {
  if (mode === 'postgres') return (await pool.query(text, params)).rows;
  if (mode === 'pglite') return (await pglite.query(text, params)).rows;
  throw new Error('Database is not initialised');
}

// Runs `fn` inside a transaction. `fn` receives a query function bound to it.
export async function withTransaction(fn) {
  if (mode === 'postgres') {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(async (text, params = []) => (await client.query(text, params)).rows);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  if (mode === 'pglite') {
    return pglite.transaction(async (tx) => fn(async (text, params = []) => (await tx.query(text, params)).rows));
  }

  throw new Error('Database is not initialised');
}

export async function health() {
  if (!mode) return { connected: false, mode: 'uninitialised', error: initError?.message };
  try {
    const rows = await query('select 1 as ok');
    return { connected: rows[0]?.ok === 1, mode };
  } catch (error) {
    return { connected: false, mode, error: error.message };
  }
}

export async function closeDb() {
  if (pool) await pool.end().catch(() => {});
  if (pglite) await pglite.close().catch(() => {});
}

export function markInitError(error) {
  initError = error;
}
