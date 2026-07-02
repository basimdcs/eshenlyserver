import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { parseArgs } from './config';
import { runPurchaseFlow } from './purchase-flow';
import { log, logError } from './utils';

async function main(): Promise<void> {
  const config = parseArgs();

  log('init', `Player ID: ${config.playerId}`);
  log('init', `SKU: ${config.sku} UC`);
  log('init', `Payment: ${config.paymentMethod}`);
  log('init', `Headless: ${config.headless}`);
  log('init', `Dry run: ${config.dryRun}`);

  const proxyUrl = process.env.PROXY;
  let proxyConfig: { server: string; username?: string; password?: string } | undefined;
  if (proxyUrl) {
    const parsed = new URL(proxyUrl);
    proxyConfig = {
      server: `${parsed.protocol}//${parsed.host}`,
      username: parsed.username || undefined,
      password: parsed.password || undefined,
    };
    log('init', `Proxy: ${parsed.host}`);
  }

  const browser = await chromium.launch({
    headless: config.headless,
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined,
    proxy: proxyConfig,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-default-apps',
      '--disable-sync',
      '--no-first-run',
      '--mute-audio',
      '--single-process',
      '--no-zygote',
      '--renderer-process-limit=1',
      '--disable-features=site-per-process,IsolateOrigins,TranslateUI',
      '--js-flags=--max-old-space-size=768',
    ],
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
  });

  // Remove webdriver flag
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  const page = await context.newPage();

  if (process.env.BLOCK_MEDIA === 'true') {
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (type === 'image' || type === 'media' || type === 'font') {
        return route.abort();
      }
      return route.continue();
    });
  }

  if (process.env.NETWORK_TRACE === 'true') {
    const tracePath = path.join(process.cwd(), `trace-${Date.now()}.jsonl`);
    const traceFile = fs.createWriteStream(tracePath, { flags: 'a' });
    log('trace', `Writing network trace to ${tracePath}`);

    const writeEntry = (entry: Record<string, unknown>) => {
      traceFile.write(JSON.stringify(entry) + '\n');
    };

    context.on('request', (req) => {
      const type = req.resourceType();
      if (type !== 'xhr' && type !== 'fetch' && type !== 'document') return;
      writeEntry({
        ts: Date.now(),
        kind: 'request',
        method: req.method(),
        url: req.url(),
        resourceType: type,
        headers: req.headers(),
        postData: req.postData() || null,
      });
    });

    context.on('response', async (res) => {
      const req = res.request();
      const type = req.resourceType();
      if (type !== 'xhr' && type !== 'fetch' && type !== 'document') return;
      let body: string | null = null;
      try {
        const buf = await res.body();
        body = buf.toString('utf8');
        if (body.length > 200_000) body = body.slice(0, 200_000) + '…[truncated]';
      } catch {
        body = null;
      }
      writeEntry({
        ts: Date.now(),
        kind: 'response',
        status: res.status(),
        url: res.url(),
        resourceType: type,
        headers: res.headers(),
        body,
      });
    });
  }

  try {
    await runPurchaseFlow(page, config);
    log('done', 'All phases completed successfully');
  } catch (err) {
    logError('main', `Failed: ${err}`);
    process.exitCode = 1;
  } finally {
    if (!config.headless) {
      log('done', 'Keeping browser open. Press Ctrl+C to exit.');
      await new Promise(() => {}); // wait forever
    }
    await browser.close();
  }
}

// Force process exit once main() settles — Playwright/undici can leave a
// lingering handle that keeps node alive after browser.close(), orphaning the
// process (which otherwise lingers, holding memory). In non-headless dev mode
// main() never resolves (it waits forever), so this only fires in production.
main().finally(() => {
  process.exit(process.exitCode || 0);
});
