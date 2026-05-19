import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import 'dotenv/config';
import { hmacSign } from './crypto';
import { claimNextQueued, markFinished, recordCallbackAttempt, jobsNeedingCallback, Job } from './db';

const CALLBACK_SECRET = process.env.CALLBACK_SECRET || '';
const BOT_DIR = process.env.BOT_DIR || path.resolve(__dirname, '..', '..');
const BOT_SCRIPT = path.join(BOT_DIR, 'bin', 'run-bot.sh');
const POLL_INTERVAL_MS = 2000;
const CALLBACK_RETRY_INTERVAL_MS = 30 * 1000;

if (!CALLBACK_SECRET || CALLBACK_SECRET.length < 32) {
  console.error('CALLBACK_SECRET env required (>= 32 chars)');
  process.exit(1);
}

function log(tag: string, msg: string): void {
  console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`);
}

function runBot(job: Job): Promise<{ exitCode: number; logTail: string; amount: number | null; tradeToken: string | null; logFile: string }> {
  return new Promise((resolve) => {
    const args = ['--player-id', job.player_id, '--sku', String(job.sku)];

    // Per-job log file for full traceability (kept even on success)
    const logsDir = path.join(__dirname, '..', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const logFile = path.join(logsDir, `${job.id}.log`);
    const logStream = fs.createWriteStream(logFile, { flags: 'a' });
    logStream.write(`# job=${job.id} order=${job.order_id} player=${job.player_id} sku=${job.sku} started=${new Date().toISOString()}\n`);

    log('spawn', `${BOT_SCRIPT} ${args.join(' ')} → ${logFile}`);
    const child = spawn(BOT_SCRIPT, args, {
      cwd: BOT_DIR,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const lines: string[] = [];
    let amount: number | null = null;
    let tradeToken: string | null = null;
    const capture = (chunk: Buffer) => {
      logStream.write(chunk);
      const text = chunk.toString('utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        lines.push(line);
        if (lines.length > 400) lines.shift();
        const m1 = line.match(/Expected charge amount:\s*([\d.]+)/);
        if (m1) amount = parseFloat(m1[1]);
        const m2 = line.match(/Payment tab opened:\s*(\S+)/);
        if (m2) {
          const tk = m2[1].match(/[?&]tradeToken=([^&]+)/);
          if (tk) tradeToken = decodeURIComponent(tk[1]);
        }
      }
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.on('close', (exitCode) => {
      logStream.end(`# exit=${exitCode} finished=${new Date().toISOString()}\n`);
      resolve({ exitCode: exitCode ?? -1, logTail: lines.slice(-60).join('\n'), amount, tradeToken, logFile });
    });
  });
}

async function postCallback(job: Job): Promise<{ status: number | null; error: string | null }> {
  const body = JSON.stringify({
    order_id: job.order_id,
    job_id: job.id,
    status: job.status === 'success' ? 'success' : 'failed',
    amount_charged: job.amount_charged,
    trade_token: job.trade_token,
    duration_ms: job.duration_ms,
    error: job.error,
  });
  const ts = Date.now();
  const sig = hmacSign(CALLBACK_SECRET, [String(ts), body]);
  try {
    const res = await fetch(job.callback_url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-timestamp': String(ts),
        'x-signature': sig,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    return { status: res.status, error: res.ok ? null : `http ${res.status}` };
  } catch (err) {
    return { status: null, error: String(err) };
  }
}

async function processOne(job: Job): Promise<void> {
  const start = Date.now();
  log('start', `job=${job.id} order=${job.order_id} player=${job.player_id} sku=${job.sku}`);
  const result = await runBot(job);
  const duration = Date.now() - start;
  if (result.exitCode === 0) {
    markFinished(job.id, 'success', {
      amount_charged: result.amount,
      trade_token: result.tradeToken,
      duration_ms: duration,
      error: null,
    });
    log('success', `job=${job.id} amount=${result.amount} duration=${duration}ms`);
  } else {
    // Prefer a clean "Paymob rejected payment: ..." line if present, else last error-ish line
    const allLines = result.logTail.split('\n');
    const paymobErr = allLines.reverse().find((l) => /Paymob rejected payment:/i.test(l));
    const errLine = paymobErr
      || allLines.find((l) => /\[error|ERROR|Failed|throw/i.test(l))
      || `exit ${result.exitCode}`;
    markFinished(job.id, 'failed', {
      amount_charged: result.amount,
      trade_token: result.tradeToken,
      duration_ms: duration,
      error: errLine.slice(0, 500),
    });
    log('failed', `job=${job.id} exit=${result.exitCode} error="${errLine.slice(0, 200)}" log=${result.logFile}`);
  }
}

async function flushCallbacks(): Promise<void> {
  const pending = jobsNeedingCallback();
  for (const job of pending) {
    const { status, error } = await postCallback(job);
    recordCallbackAttempt(job.id, status, error);
    if (status && status >= 200 && status < 300) {
      log('callback-ok', `job=${job.id} → ${job.callback_url}`);
    } else {
      log('callback-fail', `job=${job.id} attempts=${job.callback_attempts + 1} status=${status} err=${error}`);
    }
  }
}

async function loop(): Promise<void> {
  log('start', `worker started, bot at ${BOT_SCRIPT}`);
  let lastCallbackFlush = 0;
  while (true) {
    try {
      const job = claimNextQueued();
      if (job) {
        await processOne(job);
        await flushCallbacks();
        lastCallbackFlush = Date.now();
        continue;
      }
      if (Date.now() - lastCallbackFlush > CALLBACK_RETRY_INTERVAL_MS) {
        await flushCallbacks();
        lastCallbackFlush = Date.now();
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    } catch (err) {
      log('error', `loop error: ${err}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

loop().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
