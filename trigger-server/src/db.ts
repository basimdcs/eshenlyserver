import Database from 'better-sqlite3';
import * as path from 'path';

const DB_PATH = process.env.QUEUE_DB || path.join(__dirname, '..', 'queue.db');

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL UNIQUE,
    player_id TEXT NOT NULL,
    sku INTEGER NOT NULL,
    callback_url TEXT NOT NULL,
    customer_email TEXT,
    status TEXT NOT NULL CHECK(status IN ('queued','running','success','failed','callback_failed')),
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    amount_charged REAL,
    trade_token TEXT,
    error TEXT,
    duration_ms INTEGER,
    callback_attempts INTEGER NOT NULL DEFAULT 0,
    callback_last_status INTEGER,
    callback_last_error TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, created_at);
  CREATE INDEX IF NOT EXISTS idx_jobs_order_id ON jobs(order_id);
`);

export type JobStatus = 'queued' | 'running' | 'success' | 'failed' | 'callback_failed';

export interface Job {
  id: string;
  order_id: string;
  player_id: string;
  sku: number;
  callback_url: string;
  customer_email: string | null;
  status: JobStatus;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  amount_charged: number | null;
  trade_token: string | null;
  error: string | null;
  duration_ms: number | null;
  callback_attempts: number;
  callback_last_status: number | null;
  callback_last_error: string | null;
}

export function insertJob(job: {
  id: string;
  order_id: string;
  player_id: string;
  sku: number;
  callback_url: string;
  customer_email: string | null;
}): void {
  db.prepare(`
    INSERT INTO jobs (id, order_id, player_id, sku, callback_url, customer_email, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)
  `).run(job.id, job.order_id, job.player_id, job.sku, job.callback_url, job.customer_email, Date.now());
}

export function findByOrderId(order_id: string): Job | undefined {
  return db.prepare('SELECT * FROM jobs WHERE order_id = ?').get(order_id) as Job | undefined;
}

export function findById(id: string): Job | undefined {
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Job | undefined;
}

export function claimNextQueued(): Job | undefined {
  const claim = db.transaction(() => {
    const next = db.prepare(`
      SELECT * FROM jobs WHERE status = 'queued'
      ORDER BY created_at ASC LIMIT 1
    `).get() as Job | undefined;
    if (!next) return undefined;
    db.prepare(`UPDATE jobs SET status = 'running', started_at = ? WHERE id = ?`).run(Date.now(), next.id);
    return { ...next, status: 'running' as const, started_at: Date.now() };
  });
  return claim();
}

export function markFinished(
  id: string,
  status: Extract<JobStatus, 'success' | 'failed'>,
  details: { amount_charged?: number | null; trade_token?: string | null; error?: string | null; duration_ms: number },
): void {
  db.prepare(`
    UPDATE jobs SET
      status = ?, finished_at = ?, amount_charged = ?, trade_token = ?, error = ?, duration_ms = ?
    WHERE id = ?
  `).run(
    status,
    Date.now(),
    details.amount_charged ?? null,
    details.trade_token ?? null,
    details.error ?? null,
    details.duration_ms,
    id,
  );
}

export function recordCallbackAttempt(id: string, status: number | null, error: string | null): void {
  db.prepare(`
    UPDATE jobs SET
      callback_attempts = callback_attempts + 1,
      callback_last_status = ?,
      callback_last_error = ?,
      status = CASE WHEN ? BETWEEN 200 AND 299 THEN status ELSE 'callback_failed' END
    WHERE id = ?
  `).run(status, error, status ?? -1, id);
}

export function jobsNeedingCallback(): Job[] {
  return db.prepare(`
    SELECT * FROM jobs
    WHERE status IN ('success', 'failed', 'callback_failed')
      AND (callback_attempts < 5 OR callback_last_status IS NULL)
      AND finished_at IS NOT NULL
  `).all() as Job[];
}
