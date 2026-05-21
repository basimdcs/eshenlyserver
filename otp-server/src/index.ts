import * as http from 'http';
import 'dotenv/config';

const PORT = parseInt(process.env.OTP_PORT || '8787', 10);
const HOST = process.env.OTP_HOST || '127.0.0.1';
const TOKEN = process.env.OTP_TOKEN || '';
if (!TOKEN) {
  console.error('OTP_TOKEN env required');
  process.exit(1);
}

type Entry = { otp: string; amount: number; ts: number; raw: string };
type PaymentEntry = { amount: number; merchant: string; txnId: string; ts: number; raw: string };
const recent: Entry[] = [];
const recentPayments: PaymentEntry[] = [];
const MAX_RECENT = 50;
const ENTRY_TTL_MS = 10 * 60 * 1000;

function log(tag: string, msg: string): void {
  console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`);
}

function parsePayment(text: string): { amount: number; merchant: string; txnId: string } | null {
  // Vodafone Cash payment confirmation SMS, e.g.:
  // "تم دفع مبلغ 93.0جنية لCarry1st. رصيد محفظتك الحالي 1625.76 جنيه.
  //  رقم العملية 020176427512 تاريخ العملية 21-05-26 13:41."
  const amt = text.match(/تم\s*دفع\s*مبلغ\s*([\d.]+)\s*جني[هة]\s*ل\s*([^\s.,]+)/);
  if (!amt) return null;
  const amount = parseFloat(amt[1]);
  const merchant = amt[2];
  const tx = text.match(/رقم\s*العملية\s*(\d+)/);
  if (!Number.isFinite(amount) || !merchant || !tx) return null;
  return { amount, merchant, txnId: tx[1] };
}

function parseOtp(text: string): { otp: string; amount: number } | null {
  // Arabic: "هو 388058 بمبلغ 41.99"
  const arabic = text.match(/هو\s+(\d{4,8})\s+بمبلغ\s+([\d.]+)/);
  if (arabic) {
    return { otp: arabic[1], amount: parseFloat(arabic[2]) };
  }
  // English fallback: "OTP is 388058 ... 41.99"
  const en = text.match(/(?:OTP|code|password)[^\d]*(\d{4,8})[^\d]*(\d+\.\d+)/i);
  if (en) {
    return { otp: en[1], amount: parseFloat(en[2]) };
  }
  // Loose: any 6-digit number — only used when we can't extract amount
  const loose = text.match(/(?<!\d)(\d{6})(?!\d)/);
  if (loose) {
    return { otp: loose[1], amount: NaN };
  }
  return null;
}

function pruneOld(): void {
  const cutoff = Date.now() - ENTRY_TTL_MS;
  while (recent.length > 0 && recent[0].ts < cutoff) recent.shift();
  while (recentPayments.length > 0 && recentPayments[0].ts < cutoff) recentPayments.shift();
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function authOk(req: http.IncomingMessage): boolean {
  const header = req.headers['x-token'] || req.headers['authorization'];
  if (typeof header !== 'string') return false;
  const token = header.replace(/^Bearer\s+/i, '').trim();
  return token === TOKEN;
}

async function handlePost(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!authOk(req)) {
    res.writeHead(401).end('unauthorized');
    return;
  }
  const body = await readBody(req);
  let text = body;
  // Accept both raw SMS body and JSON {body: "..."} or {text: "..."}
  if (body.trim().startsWith('{')) {
    try {
      const j = JSON.parse(body);
      text = j.body || j.text || j.message || j.sms || body;
    } catch {
      // fall through to raw
    }
  }
  pruneOld();

  // Try payment confirmation first — it's a strict pattern that wouldn't accidentally match an OTP SMS.
  const payment = parsePayment(text);
  if (payment) {
    recentPayments.push({
      amount: payment.amount,
      merchant: payment.merchant,
      txnId: payment.txnId,
      ts: Date.now(),
      raw: text.slice(0, 200),
    });
    while (recentPayments.length > MAX_RECENT) recentPayments.shift();
    log('post', `stored PAYMENT amount=${payment.amount} merchant=${payment.merchant} txn=${payment.txnId}`);
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({ ok: true, matched: true, kind: 'payment', ...payment })
    );
    return;
  }

  const parsed = parseOtp(text);
  if (!parsed) {
    log('post', `no OTP/payment found in: ${text.slice(0, 120)}`);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, matched: false }));
    return;
  }
  recent.push({ otp: parsed.otp, amount: parsed.amount, ts: Date.now(), raw: text.slice(0, 200) });
  while (recent.length > MAX_RECENT) recent.shift();
  log('post', `stored OTP ${parsed.otp} amount=${parsed.amount}`);
  res.writeHead(200, { 'content-type': 'application/json' }).end(
    JSON.stringify({ ok: true, matched: true, kind: 'otp', otp: parsed.otp, amount: parsed.amount })
  );
}

async function handlePaymentWait(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!authOk(req)) {
    res.writeHead(401).end('unauthorized');
    return;
  }
  const url = new URL(req.url!, 'http://x');
  const amount = parseFloat(url.searchParams.get('amount') || 'NaN');
  const merchantFilter = (url.searchParams.get('merchant') || '').trim();
  const sinceMs = parseInt(url.searchParams.get('since') || '0', 10);
  const timeoutMs = Math.min(parseInt(url.searchParams.get('timeout') || '30000', 10), 120000);

  const start = Date.now();
  pruneOld();

  const tryFind = (): PaymentEntry | null => {
    pruneOld();
    for (let i = recentPayments.length - 1; i >= 0; i--) {
      const e = recentPayments[i];
      if (e.ts < sinceMs) continue;
      if (Number.isFinite(amount) && Math.abs(e.amount - amount) > 0.01) continue;
      if (merchantFilter && !e.merchant.toLowerCase().includes(merchantFilter.toLowerCase())) continue;
      return e;
    }
    return null;
  };

  while (Date.now() - start < timeoutMs) {
    const hit = tryFind();
    if (hit) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          ok: true,
          amount: hit.amount,
          merchant: hit.merchant,
          txn_id: hit.txnId,
          ts: hit.ts,
        })
      );
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  res.writeHead(408, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: 'timeout' }));
}

async function handleWait(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!authOk(req)) {
    res.writeHead(401).end('unauthorized');
    return;
  }
  const url = new URL(req.url!, 'http://x');
  const amount = parseFloat(url.searchParams.get('amount') || 'NaN');
  const sinceMs = parseInt(url.searchParams.get('since') || '0', 10);
  const timeoutMs = Math.min(parseInt(url.searchParams.get('timeout') || '180000', 10), 300000);

  const start = Date.now();
  pruneOld();

  const tryFind = (): Entry | null => {
    pruneOld();
    for (let i = recent.length - 1; i >= 0; i--) {
      const e = recent[i];
      if (e.ts < sinceMs) continue;
      if (Number.isFinite(amount) && Math.abs(e.amount - amount) > 0.01 && Number.isFinite(e.amount)) continue;
      return e;
    }
    return null;
  };

  // Long-poll: check every 1s up to timeoutMs
  while (Date.now() - start < timeoutMs) {
    const hit = tryFind();
    if (hit) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, otp: hit.otp, amount: hit.amount, ts: hit.ts }));
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  res.writeHead(408, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: 'timeout' }));
}

const server = http.createServer(async (req, res) => {
  const remoteAddr = req.socket.remoteAddress;
  try {
    const url = new URL(req.url!, 'http://x');
    log('req', `${remoteAddr} ${req.method} ${url.pathname}${url.search}`);
    if (req.method === 'POST' && url.pathname === '/otp') {
      await handlePost(req, res);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/otp/wait') {
      await handleWait(req, res);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/payment/wait') {
      await handlePaymentWait(req, res);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200).end('ok');
      return;
    }
    res.writeHead(404).end('not found');
  } catch (err) {
    log('error', `${remoteAddr} ${String(err)}`);
    res.writeHead(500).end('error');
  }
});

server.listen(PORT, HOST, () => {
  log('start', `OTP receiver listening on ${HOST}:${PORT}`);
});
