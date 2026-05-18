import { chromium } from 'playwright';
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
    proxy: proxyConfig,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
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

main();
