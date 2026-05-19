import * as http from 'http';
import * as crypto from 'crypto';
import 'dotenv/config';
import { hmacVerify } from './crypto';
import { insertJob, findByOrderId, findById } from './db';

const PORT = parseInt(process.env.TRIGGER_PORT || '8788', 10);
const HOST = process.env.TRIGGER_HOST || '127.0.0.1';
const TRIGGER_SECRET = process.env.TRIGGER_SECRET || '';
const ALLOWED_SKUS = (process.env.ALLOWED_SKUS || '60,300,600,1500,3000,6000')
  .split(',')
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => Number.isFinite(n));
const MAX_BODY_BYTES = 16 * 1024;
const TIMESTAMP_TOLERANCE_MS = 60 * 1000;

if (!TRIGGER_SECRET || TRIGGER_SECRET.length < 32) {
  console.error('TRIGGER_SECRET env required (>= 32 chars)');
  process.exit(1);
}

function log(tag: string, msg: string): void {
  console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`);
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function reject(res: http.ServerResponse, status: number, code: string, msg?: string): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: false, code, error: msg || code }));
}

async function handleTrigger(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  // Capture raw body — signature is over the exact bytes
  const raw = await readBody(req);

  const tsHeader = req.headers['x-timestamp'];
  const idemHeader = req.headers['x-idempotency-key'];
  const sigHeader = req.headers['x-signature'];

  if (typeof tsHeader !== 'string' || typeof idemHeader !== 'string' || typeof sigHeader !== 'string') {
    return reject(res, 400, 'missing_headers', 'X-Timestamp, X-Idempotency-Key, X-Signature required');
  }
  const ts = parseInt(tsHeader, 10);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > TIMESTAMP_TOLERANCE_MS) {
    return reject(res, 401, 'timestamp_invalid', `timestamp out of range (server now ${Date.now()})`);
  }
  // Idempotency key sanity
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(idemHeader)) {
    return reject(res, 400, 'idem_key_invalid');
  }

  const sigOk = hmacVerify(TRIGGER_SECRET, [String(ts), idemHeader, raw.toString('utf8')], sigHeader);
  if (!sigOk) {
    log('reject', `bad signature from ${req.socket.remoteAddress} idem=${idemHeader}`);
    return reject(res, 401, 'signature_invalid');
  }

  // Parse body
  let payload: { player_id?: string; sku?: number; callback_url?: string; customer_email?: string };
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    return reject(res, 400, 'body_invalid_json');
  }

  if (!payload.player_id || !/^\d{8,12}$/.test(payload.player_id)) {
    return reject(res, 400, 'player_id_invalid', 'expected 8-12 digit player ID');
  }
  if (typeof payload.sku !== 'number' || !ALLOWED_SKUS.includes(payload.sku)) {
    return reject(res, 400, 'sku_not_allowed', `sku must be one of: ${ALLOWED_SKUS.join(',')}`);
  }
  if (!payload.callback_url || !/^https:\/\//i.test(payload.callback_url)) {
    return reject(res, 400, 'callback_url_invalid', 'callback_url must be HTTPS');
  }
  if (payload.customer_email && payload.customer_email.length > 256) {
    return reject(res, 400, 'customer_email_invalid');
  }

  // Idempotency check
  const existing = findByOrderId(idemHeader);
  if (existing) {
    log('idempotent', `${idemHeader} → existing job ${existing.id} status=${existing.status}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, job_id: existing.id, status: existing.status, replay: true }));
    return;
  }

  // Enqueue
  const jobId = crypto.randomUUID();
  try {
    insertJob({
      id: jobId,
      order_id: idemHeader,
      player_id: payload.player_id,
      sku: payload.sku,
      callback_url: payload.callback_url,
      customer_email: payload.customer_email || null,
    });
  } catch (err) {
    // Race: another concurrent insert with same order_id
    const again = findByOrderId(idemHeader);
    if (again) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, job_id: again.id, status: again.status, replay: true }));
      return;
    }
    log('error', `insert failed: ${err}`);
    return reject(res, 500, 'enqueue_failed');
  }

  log('queued', `order=${idemHeader} player=${payload.player_id} sku=${payload.sku} job=${jobId}`);
  res.writeHead(202, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, job_id: jobId, status: 'queued' }));
}

async function handleJobStatus(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
  // No auth here — non-sensitive; only returns job state.
  // Could add token if needed.
  const job = findById(id);
  if (!job) return reject(res, 404, 'job_not_found');
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    ok: true,
    job_id: job.id,
    order_id: job.order_id,
    status: job.status,
    amount_charged: job.amount_charged,
    duration_ms: job.duration_ms,
    error: job.error,
  }));
}

const server = http.createServer(async (req, res) => {
  const remote = req.socket.remoteAddress;
  try {
    const url = new URL(req.url || '/', 'http://x');
    log('req', `${remote} ${req.method} ${url.pathname}`);
    if (req.method === 'POST' && url.pathname === '/trigger') {
      await handleTrigger(req, res);
      return;
    }
    const m = url.pathname.match(/^\/jobs\/([a-f0-9-]{36})$/);
    if (req.method === 'GET' && m) {
      await handleJobStatus(req, res, m[1]);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
      return;
    }
    res.writeHead(404).end('not found');
  } catch (err) {
    log('error', String(err));
    res.writeHead(500).end('error');
  }
});

server.listen(PORT, HOST, () => {
  log('start', `trigger-server listening on ${HOST}:${PORT}`);
  log('config', `allowed SKUs: ${ALLOWED_SKUS.join(',')}`);
});
