import { Page } from 'playwright';
import { SELECTORS } from './selectors';
import { PurchaseConfig, PaymentMethod } from './config';
import { log, logError, takeScreenshot, wait } from './utils';

const MIDASBUY_URL = 'https://www.midasbuy.com/midasbuy/eg/buy/pubgm';

// Candidate labels per method, tried in order. Midasbuy serves the EG page in
// Arabic intermittently — channel names may render translated, so each method
// lists English first, then unambiguous substrings, then Arabic fallbacks.
// NOTE: bare "Vodafone" is NOT safe for ewallet — the carrier-billing channel
// ("Orange / Vodafone / Etisalat / WE") also contains it. "Vodafone Cash" is
// unique to the wallet channel.
const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string[]> = {
  ewallet: ['Vodafone Cash/Orange Cash/Etisalat Cash', 'Vodafone Cash', 'فودافون كاش'],
  credit: ['Credit/ Debit/ Prepaid Card', 'Prepaid Card', 'بطاقة'],
  fawry: ['Fawry', 'فوري'],
  carrier: ['Orange / Vodafone / Etisalat / WE'],
};

/** Remove all promo/banner overlays that block pointer events */
async function clearOverlays(page: Page): Promise<void> {
  await page.evaluate(() => {
    // Remove iframe promo wrappers
    document.querySelectorAll('div.activity-iframe-wrapper').forEach((el) => el.remove());
    // Remove any full-screen promo/banner popups
    document.querySelectorAll(
      '[class*="activity-banner"], [class*="ActivityBanner"], [class*="promo-pop"], [class*="PromoPop"], [class*="BannerPop"], [class*="banner-pop"]'
    ).forEach((el) => el.remove());
    // Remove any fixed/absolute overlay divs sitting above z-index 100
    document.querySelectorAll('div[style*="z-index"]').forEach((el) => {
      const zIndex = parseInt((el as HTMLElement).style.zIndex, 10);
      const pos = (el as HTMLElement).style.position;
      if ((pos === 'fixed' || pos === 'absolute') && zIndex > 100) {
        (el as HTMLElement).remove();
      }
    });
  });
}

/** Dismiss the Midasbuy cookie consent banner (Arabic/English). It renders at
 *  a variable delay and can reappear, so this is called at multiple points. */
async function dismissCookieBanner(page: Page): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const dismissed = await page.evaluate(() => {
      const accepts = ['قبول جميع', 'قبول', 'Accept all', 'Accept All', 'Accept'];
      const els = document.querySelectorAll('button, [class*="btn"], [class*="Button"]');
      for (const acc of accepts) {
        for (const el of Array.from(els)) {
          const t = (el.textContent || '').trim();
          if (t.includes(acc) && t.length < 80 && !/نعم|^Yes$/.test(t)) {
            (el as HTMLElement).click();
            return t.slice(0, 50);
          }
        }
      }
      return null;
    });
    if (dismissed) return true;
    await page.waitForTimeout(600);
  }
  return false;
}

/** Fill the player-ID dialog (the one opened by the header login_text OR by the
 *  modal's "أدخل معرف اللاعب الآن" CTA) and submit it. Returns true if an input
 *  was filled. */
async function fillPlayerIdDialog(page: Page, playerId: string): Promise<boolean> {
  const filled = await page.evaluate((pid: string) => {
    const input = (
      document.querySelector('input[placeholder*="إدخال حساب معرف لاعب"]') ||
      document.querySelector('input[placeholder*="معرف اللاعب"]') ||
      document.querySelector('input[placeholder*="Player ID"]') ||
      document.querySelector('input[placeholder*="player"]') ||
      document.querySelector('[class*="SelectServerBox"] input')
    ) as HTMLInputElement | null;
    if (!input) return false;
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(input, pid); else input.value = pid;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, playerId);
  if (!filled) return false;
  await page.waitForTimeout(1200);
  for (const okText of ['OK', 'موافق', 'تأكيد', 'Confirm']) {
    if (await jsClickButtonByText(page, okText)) break;
  }
  await page.waitForTimeout(2500); // server validates the player
  // Dismiss the "congrats / player confirmed" dialog if it appears.
  for (const okText of ['OK', 'موافق', 'تأكيد']) {
    if (await jsClickButtonByText(page, okText)) break;
  }
  return true;
}

/** Click a button by its text content via JS (bypasses all overlays) */
async function jsClickButtonByText(page: Page, text: string): Promise<boolean> {
  return page.evaluate((t: string) => {
    const buttons = document.querySelectorAll('[class*="Button_text"]');
    for (const btn of buttons) {
      if (btn.textContent === t) {
        const target = btn.closest('[class*="Button_icon"]') || btn;
        (target as HTMLElement).click();
        return true;
      }
    }
    return false;
  }, text);
}

export async function runPurchaseFlow(page: Page, config: PurchaseConfig): Promise<void> {
  try {
    await phase1_loadAndCleanup(page, config);
    await phase2_enterPlayerId(page, config);
    await phase3_selectSkuAndCheckout(page, config);
    await phase4_selectPaymentMethod(page, config);
    await phase5_initiatePurchase(page, config);

    if (config.dryRun) {
      log('dry-run', 'Stopping before payment confirmation (--dry-run enabled)');
      await takeScreenshot(page, 'dry-run-stop');
      return;
    }

    // Capture the timestamp before phase 6 so the OTP wait only matches
    // SMS that arrived after this purchase initiated.
    const purchaseStartedAt = Date.now();
    await phase6_confirmAndPay(page, config);
    await phase7_paymobWallet(page, config, purchaseStartedAt);
    log('done', 'Purchase flow completed successfully');
  } catch (err) {
    logError('flow', `Purchase flow failed: ${err}`);
    await takeScreenshot(page, 'error').catch(() => {});
    throw err;
  }
}

// ── Phase 1: Navigate, remove overlays, dismiss dialogs ──────────────────────

async function phase1_loadAndCleanup(page: Page, config: PurchaseConfig): Promise<void> {
  log('phase-1', 'Navigating to Midasbuy...');
  await page.goto(MIDASBUY_URL, { waitUntil: 'domcontentloaded', timeout: config.timeout });
  await page.waitForTimeout(3000);

  await clearOverlays(page);
  await wait(page);

  // Dismiss region mismatch dialog — close it WITHOUT switching regions (press Escape or click X)
  log('phase-1', 'Dismissing region dialog without switching...');
  try {
    // Try pressing Escape to close the dialog
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    // Also try clicking any close/X button in a dialog
    await page.evaluate(() => {
      const closeBtn = document.querySelector(
        '[class*="close"], [class*="Close"], [class*="icon-close"], [aria-label="close"], [aria-label="Close"]'
      ) as HTMLElement | null;
      closeBtn?.click();
    });
    await page.waitForTimeout(1000);
  } catch { /* ignore */ }

  // If redirected away from /eg/ (e.g. to /gb/), force navigate back
  if (!page.url().includes('/eg/')) {
    log('phase-1', `Redirected to ${page.url()}, forcing back to /eg/...`);
    await page.goto(MIDASBUY_URL, { waitUntil: 'domcontentloaded', timeout: config.timeout });
    await page.waitForTimeout(3000);
    // Close the dialog again with Escape — do NOT click Yes/No
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(1000);
  }

  log('phase-1', `On URL: ${page.url()}`);

  await clearOverlays(page);

  // Dismiss cookie consent ONLY — never click "Yes"/"نعم" as those trigger region redirect.
  // The EG/Arabic banner button is "قبول جميع ملفات تعريف الارتباط الاختيارية"
  // (Accept all optional cookies) with class MidasbuyUI-btn_* — substring-match
  // it across all clickable elements, retrying since it can render late.
  log('phase-1', 'Dismissing cookie popups...');
  for (let attempt = 0; attempt < 4; attempt++) {
    const dismissed = await page.evaluate(() => {
      const accepts = ['قبول جميع', 'قبول', 'Accept all', 'Accept All', 'Accept'];
      const els = document.querySelectorAll('button, [class*="btn"], [class*="Button"]');
      for (const acc of accepts) {
        for (const el of Array.from(els)) {
          const t = (el.textContent || '').trim();
          // Match accept-cookie wording; avoid the region "Yes/نعم" dialog.
          if (t.includes(acc) && t.length < 80 && !/نعم|^Yes$/.test(t)) {
            (el as HTMLElement).click();
            return t.slice(0, 50);
          }
        }
      }
      return null;
    });
    if (dismissed) {
      log('phase-1', `Cookie banner dismissed: "${dismissed}"`);
      await page.waitForTimeout(800);
      break;
    }
    await page.waitForTimeout(800);
  }

  // Final safety check: if somehow redirected to /gb/, navigate back to /eg/
  if (!page.url().includes('/eg/')) {
    log('phase-1', `URL drifted to ${page.url()}, forcing back to /eg/...`);
    await page.goto(MIDASBUY_URL, { waitUntil: 'domcontentloaded', timeout: config.timeout });
    await page.waitForTimeout(3000);
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(1000);
  }

  await wait(page);

  await takeScreenshot(page, 'phase1-done');
  log('phase-1', 'Page loaded and cleaned up');
}

// ── Phase 2: Enter Player ID via the dialog ──────────────────────────────────

async function phase2_enterPlayerId(page: Page, config: PurchaseConfig): Promise<void> {
  log('phase-2', `Entering player ID: ${config.playerId}`);

  await clearOverlays(page);

  // Click the "Enter Player ID" prompt to open the entry dialog. Midasbuy
  // renamed the class UserTabBox_login_text → MidasbuyUI-login_text /
  // MidasbuyUI-use_tab_box. Click whichever exists (try both generations).
  const opened = await page.evaluate(() => {
    const sel = '[class*="UserTabBox_login_text"], [class*="login_text"], [class*="use_tab_box"]';
    const els = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
    // Prefer the one whose text mentions player ID.
    let target = els.find((e) => /معرف اللاعب|player id/i.test(e.textContent || ''));
    if (!target) target = els[0];
    if (target) { target.click(); return (target.className || '').toString().slice(0, 40); }
    return null;
  });
  log('phase-2', `Clicked player-ID prompt: ${opened || 'NOT FOUND'}`);
  await page.waitForTimeout(2500);
  await clearOverlays(page);

  // The player-ID entry lives in a same-origin IFRAME
  // (common-sdk?id=playerid_enter) — invisible to document.querySelectorAll on
  // the top frame. Locate that frame and fill its input + click its OK button.
  log('phase-2', 'Locating playerid_enter iframe...');
  let typed = false;
  for (let attempt = 0; attempt < 6 && !typed; attempt++) {
    const frame = page.frames().find((f) => /playerid_enter/i.test(f.url()));
    if (!frame) {
      await page.waitForTimeout(1000);
      // Re-click the prompt in case the dialog closed.
      if (attempt === 2) {
        await page.evaluate(() => {
          const sel = '[class*="login_text"], [class*="use_tab_box"]';
          const el =
            Array.from(document.querySelectorAll(sel)).find((e) =>
              /معرف اللاعب|player/i.test(e.textContent || '')
            ) || document.querySelector(sel);
          (el as HTMLElement | null)?.click();
        });
        await page.waitForTimeout(2000);
      }
      continue;
    }
    try {
      const input = frame
        .locator('input[placeholder*="إدخال حساب معرف لاعب"], input[placeholder*="Player ID"], input[type="text"]')
        .first();
      await input.waitFor({ state: 'visible', timeout: 4000 });
      await input.click();
      await input.fill('');
      await input.type(config.playerId, { delay: 50 });
      await page.waitForTimeout(500);
      const val = await input.inputValue().catch(() => '');
      typed = val.replace(/\D/g, '') === config.playerId;
      if (typed) {
        // Click OK inside the frame.
        const ok = frame.locator('button:has-text("OK"), [class*="Button_text"]:has-text("OK"), button:has-text("موافق")');
        const cnt = await ok.count();
        for (let i = 0; i < cnt; i++) {
          if (await ok.nth(i).isVisible().catch(() => false)) {
            await ok.nth(i).click();
            break;
          }
        }
        log('phase-2', 'Player ID filled in iframe + OK clicked');
      }
    } catch (e) {
      log('phase-2', `iframe fill attempt ${attempt + 1} failed: ${String(e).slice(0, 60)}`);
    }
    if (!typed) await page.waitForTimeout(1000);
  }
  if (!typed) log('phase-2', 'WARNING: could not fill playerid_enter iframe');
  await wait(page);

  // Wait for player name validation from server
  log('phase-2', 'Waiting for player name validation...');
  await page.waitForTimeout(3000);

  // Verify player name appeared by checking for the player ID in the page
  const nameVisible = await page.evaluate((playerId: string) => {
    const all = document.querySelectorAll('*');
    for (const e of all) {
      if (e.children.length === 0 && e.textContent?.includes(playerId)) {
        const parent = e.parentElement;
        const sibling = parent?.querySelector('[class*="name"], [class*="Name"]');
        if (sibling) return sibling.textContent;
      }
    }
    return null;
  }, config.playerId);

  if (nameVisible) {
    log('phase-2', `Player validated: ${nameVisible}`);
  } else {
    log('phase-2', 'Warning: Could not confirm player name, continuing...');
  }

  // Dismiss congratulations dialog that appears after entering a valid player ID
  await page.waitForTimeout(1000);
  for (const okText of ['OK', 'موافق', 'تأكيد']) {
    if (await jsClickButtonByText(page, okText)) break;
  }
  await wait(page);

  await takeScreenshot(page, 'phase2-done');
}

// ── Phase 3: Click the SKU card (opens checkout panel) ───────────────────────

async function phase3_selectSkuAndCheckout(page: Page, config: PurchaseConfig): Promise<void> {
  log('phase-3', `Selecting SKU: ${config.sku} UC`);

  await clearOverlays(page);

  // Wait for SKU cards to load. Midasbuy renamed their CSS-module classes
  // (RechargeClassCard_recharge_class_box no longer matches) — count the
  // broader selector union so the loop breaks as soon as ANY card variant
  // renders instead of burning all 10 retries.
  for (let i = 0; i < 10; i++) {
    const count = await page.evaluate(() =>
      document.querySelectorAll(
        '[class*="RechargeClassCard_recharge_class_box"], [class*="recharge_class"], [class*="RechargeClass"]'
      ).length
    );
    if (count > 0) break;
    log('phase-3', `Waiting for SKU cards to load (${i + 1}/10)...`);
    await page.waitForTimeout(1500);
    await clearOverlays(page);
  }

  // Debug: log all available SKU card texts and classes
  const debugInfo = await page.evaluate(() => {
    const allCardSelectors = [
      '[class*="RechargeClassCard_recharge_class_box"]',
      '[class*="recharge_class"]',
      '[class*="RechargeClass"]',
      '[class*="sku-card"]',
      '[class*="SkuCard"]',
      '[class*="product-item"]',
      '[class*="ProductItem"]',
      '[class*="goods-item"]',
      '[class*="GoodsItem"]',
    ];
    const found: string[] = [];
    for (const sel of allCardSelectors) {
      const els = document.querySelectorAll(sel);
      if (els.length > 0) {
        found.push(`${sel} (${els.length}): ` + Array.from(els).slice(0, 3).map(e => e.textContent?.trim().substring(0, 40)).join(' | '));
      }
    }
    return found;
  });
  for (const info of debugInfo) log('phase-3', `DEBUG: ${info}`);

  const clicked = await page.evaluate((targetSku: number) => {
    // Try multiple selectors to find SKU cards
    const selectors = [
      '[class*="RechargeClassCard_recharge_class_box"]',
      '[class*="recharge_class"]',
      '[class*="RechargeClass"]',
      '[class*="sku-card"]',
      '[class*="SkuCard"]',
    ];
    for (const sel of selectors) {
      const cards = document.querySelectorAll(sel);
      for (const card of cards) {
        const text = card.textContent || '';
        // Strip ANY leading non-digit prefix — handles "Popular" (en),
        // "热门" (zh), "شهير" (ar), and whatever badge text Midasbuy adds
        // next. The SKU number is always the first digit-run in the card
        // (e.g. "شهير300+25..." → "300").
        const cleaned = text.trim().replace(/^\D+/, '');
        const match = cleaned.match(/^(\d+)/);
        if (match && parseInt(match[1], 10) === targetSku) {
          (card as HTMLElement).click();
          return `Clicked: ${text.substring(0, 60)} (selector: ${sel})`;
        }
      }
    }
    return null;
  }, config.sku);

  if (!clicked) {
    throw new Error(`SKU ${config.sku} UC not found on page`);
  }

  log('phase-3', clicked);
  await page.waitForTimeout(2000);

  // Verify checkout panel opened. Midasbuy renamed their CSS modules
  // (ChannelListNew/PayPriceDetailPc → MidasbuyUI-channel_box/payment_box/
  // check_box), so accept either generation of class names.
  const panelOpen = await page.evaluate(() => {
    return !!document.querySelector(
      '[class*="ChannelListNew"], [class*="PayPriceDetailPc"], [class*="channel_box"], [class*="payment_box"]'
    );
  });

  if (!panelOpen) {
    throw new Error('Checkout panel did not open after clicking SKU card');
  }

  await takeScreenshot(page, 'phase3-done');
  log('phase-3', 'SKU selected, checkout panel open');
}

// ── Phase 4: Select payment method in checkout panel ─────────────────────────

// Find the payment-sdk iframe (the redesigned checkout — channels + pay button
// all live inside it). Retries while it mounts.
async function getPaymentFrame(page: Page, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const f = page.frames().find((fr) => /payment-sdk/i.test(fr.url()));
    if (f) return f;
    await page.waitForTimeout(500);
  }
  return null;
}

async function phase4_selectPaymentMethod(page: Page, config: PurchaseConfig): Promise<void> {
  const labels = PAYMENT_METHOD_LABELS[config.paymentMethod];
  log('phase-4', `Selecting payment method: ${config.paymentMethod} (candidates: ${labels.join(' | ')})`);

  if (await dismissCookieBanner(page)) log('phase-4', 'Cleared late cookie banner');

  // The entire checkout (payment channels + pay button) is rendered inside the
  // "payment-sdk" IFRAME. Operate there, not the top document.
  const frame = await getPaymentFrame(page);
  if (!frame) throw new Error('payment-sdk iframe not found');
  log('phase-4', 'Found payment-sdk iframe');

  // Select the payment channel inside the iframe and verify it goes active.
  // Credit Card is the default; a missed click leaves the wrong method.
  let selected = false;
  for (let attempt = 0; attempt < 6 && !selected; attempt++) {
    selected = await frame.evaluate((searchLabels: string[]) => {
      const items = Array.from(
        document.querySelectorAll('[class*="ChannelPayList_payment_wrap"], [class*="ChannelPayList_payment_item"], [class*="check_box"]')
      );
      const isActive = (el: Element) =>
        /active|selected|checked/i.test((el.className || '').toString()) ||
        /active|selected|checked/i.test((el.parentElement?.className || '').toString());
      for (const searchLabel of searchLabels) {
        for (const item of items) {
          if (item.textContent?.includes(searchLabel)) {
            (item as HTMLElement).click();
            const radio = item.querySelector('input, [class*="radio"], [class*="check"]');
            if (radio) (radio as HTMLElement).click();
            return true;
          }
        }
      }
      return false;
    }, labels);
    if (selected) break;
    log('phase-4', `Payment channel not found in iframe yet, retry ${attempt + 1}/6...`);
    await page.waitForTimeout(1200);
  }

  if (!selected) {
    const available = await frame.evaluate(() =>
      Array.from(document.querySelectorAll('[class*="ChannelPayList_payment_wrap"], [class*="check_box"]'))
        .map((i) => (i.textContent || '').trim().substring(0, 45))
        .filter((t, idx, a) => t && a.indexOf(t) === idx)
    );
    throw new Error(`Payment method "${config.paymentMethod}" not found in iframe. Available: ${JSON.stringify(available)}`);
  }
  log('phase-4', 'Payment channel selected (Vodafone Cash) in iframe');
  await page.waitForTimeout(1500);
  await takeScreenshot(page, 'phase4-done');
}

// Locate the Pay button across both Midasbuy UI generations. Runs inside
// page.evaluate. Returns metadata only (the click happens separately so
// phase 4 can verify without clicking).
function findPayButtonInPage(): { text: string; disabled: boolean } | null {
  // Legacy layout
  const legacy = document.querySelector('[class*="PayPriceDetailPc"] button') as HTMLButtonElement | null;
  if (legacy) return { text: legacy.textContent || '', disabled: legacy.disabled };
  const el = (window as any).__findProceedBtn ? (window as any).__findProceedBtn() : null;
  if (!el) return null;
  const disabled =
    (el as HTMLButtonElement).disabled === true || /disable/i.test((el.className || '').toString());
  return { text: (el.textContent || '').trim().slice(0, 40), disabled };
}

// Locate the checkout modal's primary CTA by POSITION relative to the
// "الإجمالي" (Total) label — robust to its text, which changes between
// "تسجيل الدخول" (sign in), "أدخل معرف اللاعب" (enter player ID), and a pay
// verb depending on state. The CTA is the wide pointer button just below the
// total. Defined on window so both phase 4 (verify) and phase 5 (click) reuse
// it via page.evaluate.
function installProceedFinder(): void {
  (window as any).__findProceedBtn = function (): HTMLElement | null {
    // The modal CTA is a WIDE teal button (~300-400px) reading "تسجيل الدخول"
    // (a Midasbuy logo image follows, so it's not in textContent). It sits in
    // the modal body (top > 100), unlike the small header login link (w~154,
    // top < 100). Match by text + width + not-header, then return the nearest
    // clickable ancestor. Also accept legacy pay verbs.
    let best: HTMLElement | null = null;
    let bestW = 0;
    document.querySelectorAll('*').forEach((el) => {
      const t = (el.textContent || '').trim();
      if (t.length < 2 || t.length > 50) return;
      if (/طرق الدفع/.test(t)) return;
      if (/ملفات تعريف الارتباط|cookie|قبول جميع|رفض جميع|خدمة الزبائن/i.test(t)) return;
      const isPayVerb = /ادفع|الدفع الآن|اشتر الآن|pay now|buy now|proceed to pay/i.test(t);
      const isLoginCta = /تسجيل الدخول/.test(t) && !/التسجيل/.test(t);
      // After a payment method is chosen, the modal CTA relabels to
      // "أدخل معرف اللاعب" (Enter Player ID) — still the proceed button.
      const isEnterIdCta = /أدخل معرف اللاعب|معرف اللاعب|enter player id/i.test(t);
      if (!isPayVerb && !isLoginCta && !isEnterIdCta) return;
      const r = (el as HTMLElement).getBoundingClientRect();
      if (r.width < 200 || r.height < 28 || r.height > 90) return; // wide modal CTA only
      if (r.top < 100) return; // exclude page header
      if (r.width > bestW) { bestW = r.width; best = el as HTMLElement; }
    });
    if (!best) return null;
    // Walk up to a pointer-cursor ancestor if the matched node itself isn't clickable.
    let el: HTMLElement | null = best as HTMLElement;
    for (let i = 0; i < 4 && el; i++) {
      if (window.getComputedStyle(el).cursor === 'pointer') return el;
      el = el.parentElement as HTMLElement | null;
    }
    return best;
  };
}

// ── Phase 5: Click Pay button + capture payment tab ──────────────────────────

async function phase5_initiatePurchase(page: Page, config: PurchaseConfig): Promise<void> {
  log('phase-5', 'Clicking Pay button (inside payment-sdk iframe)...');

  const context = page.context();
  const popupPromise = context.waitForEvent('page', { timeout: 30000 }).catch(() => null);

  const frame = await getPaymentFrame(page);
  if (!frame) throw new Error('payment-sdk iframe gone before pay');

  // The pay button is inside the iframe. It MUST be clicked with a real pointer
  // gesture (Playwright .click(), not JS .click()) — a JS click takes a
  // different/login path and never opens the agreement dialog. Once Vodafone
  // Cash is selected the button reads "دفع" (Pay).
  const clickPay = async () => {
    const fr = await getPaymentFrame(page);
    if (!fr) return null;
    const sels = [
      '[class*="PayPriceDetailPc_payButton"]',
      '[class*="slide_payment_box"]',
      '[class*="PayPriceDetailPc"] button',
      '[class*="payButton"]',
    ];
    for (const s of sels) {
      const loc = fr.locator(s).first();
      if (await loc.isVisible({ timeout: 1500 }).catch(() => false)) {
        const txt = (await loc.textContent().catch(() => ''))?.trim().slice(0, 30) || '';
        await loc.click({ timeout: 5000 }).catch(() => {});
        return `${s}: ${txt}`;
      }
    }
    return null;
  };

  const payClicked = await clickPay();
  log('phase-5', `Pay click: ${payClicked || 'NOT FOUND'}`);

  // Fail fast on an invalid player ID. When Midasbuy rejects the entered ID,
  // the pay CTA reads "أدخل معرف اللاعب" (Enter Player ID) instead of "دفع"
  // (Pay) — proceeding just times out with a misleading "Payment tab did not
  // open". Surface the real cause instead.
  if (payClicked && /أدخل معرف اللاعب|enter player id|معرف اللاعب/i.test(payClicked)) {
    await takeScreenshot(page, 'phase5-invalid-player');
    throw new Error(`Invalid player ID: Midasbuy did not accept "${config.playerId}" (pay button still says "Enter Player ID")`);
  }

  await page.waitForTimeout(2500);
  await takeScreenshot(page, 'phase5-done');

  // Clicking "دفع" opens the PopFollowAgreement dialog INSIDE the payment-sdk
  // iframe: 3 consent rows (CheckBoxText_check_wrap) + an OK button
  // (PopFollowAgreement_btn_box). Tick each row once, then click OK — all in
  // the iframe. Retry since the dialog renders slightly after the click.
  let agreementDone = false;
  for (let attempt = 0; attempt < 5 && !agreementDone; attempt++) {
    const af = await getPaymentFrame(page);
    if (!af) break;
    const present = await af.locator('[class*="PopFollowAgreement"]').first().isVisible({ timeout: 1500 }).catch(() => false);
    if (!present) { await page.waitForTimeout(1200); continue; }

    // Tick EVERY checkbox in the age-verification dialog (3 consent boxes), then
    // OK. The clickable square sits at the start of each CheckBoxText row; the
    // wrap isn't reliably actionable, so JS-click the actual checkbox element.
    const ticked = await af.evaluate(() => {
      let count = 0;
      const rows = Array.from(document.querySelectorAll('[class*="CheckBoxText_check_wrap"]'));
      for (const row of rows) {
        const txt = (row.textContent || '').trim();
        if (/لا تذكر|don't remind|do not remind/i.test(txt)) continue; // skip "don't remind"
        // The checkbox square: a leaf element before the text, or any real input.
        const input = row.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
        if (input) {
          if (!input.checked) { input.click(); count++; }
          continue;
        }
        // No <input> — click the first child (the square icon) then the row.
        const square = (row.querySelector('[class*="check"]:not([class*="text"]), [class*="box"]:not([class*="text_box"])') || row.firstElementChild || row) as HTMLElement;
        square.click();
        count++;
      }
      return count;
    }).catch(() => 0);
    log('phase-5', `Age-verify: ticked ${ticked} boxes`);
    await page.waitForTimeout(700);

    // Click the agreement OK with a REAL gesture.
    const okLoc = af
      .locator('[class*="PopFollowAgreement_btn_box"], [class*="PopFollowAgreement"] [class*="Button_btn_wrap"]')
      .first();
    if (await okLoc.isVisible({ timeout: 2000 }).catch(() => false)) {
      await okLoc.click({ timeout: 4000 }).catch(() => {});
      agreementDone = true;
      log('phase-5', `Age-verify OK clicked (${ticked} boxes ticked)`);
    } else {
      log('phase-5', 'Agreement OK button not visible yet');
      await page.waitForTimeout(1000);
    }
  }
  if (!agreementDone) log('phase-5', 'No PopFollowAgreement dialog handled (may not be required this run)');
  await page.waitForTimeout(2500);
  await takeScreenshot(page, 'phase5-after-agreement');

  // A login dialog may still appear (top document) — dismiss it; guest
  // checkout proceeds. Also handles any remaining confirm dialogs.
  await handlePostPayDialogs(page);

  log('phase-5', 'Waiting for payment tab...');
  let popup = await Promise.race([popupPromise, page.waitForTimeout(8000).then(() => null)]);

  if (!popup) {
    log('phase-5', 'No payment tab yet — re-clicking pay after dialog dismissal');
    const popupPromise2 = context.waitForEvent('page', { timeout: 30000 }).catch(() => null);
    const re = await clickPay();
    log('phase-5', `Pay re-click: ${re || 'NOT FOUND'}`);
    await page.waitForTimeout(2500);
    // The agreement dialog may appear on the re-click too — handle it again.
    const af = await getPaymentFrame(page);
    if (af) {
      await af.evaluate(() => {
        if (!document.querySelector('[class*="PopFollowAgreement"]')) return;
        const seen = new Set<string>();
        document.querySelectorAll('[class*="CheckBoxText_check_wrap"]').forEach((w) => {
          const k = (w.textContent || '').trim();
          if (k && !seen.has(k)) { seen.add(k); (w as HTMLElement).click(); }
        });
        const ok = document.querySelector('[class*="PopFollowAgreement_btn_box"]') as HTMLElement | null;
        if (ok) ok.click();
      }).catch(() => {});
    }
    await page.waitForTimeout(1500);
    await handlePostPayDialogs(page);
    popup = await popupPromise2;
  }

  if (!popup) {
    await takeScreenshot(page, 'phase5-no-popup');
    throw new Error('Payment tab did not open after clicking Pay button');
  }

  log('phase-5', `Payment tab opened: ${popup.url()}`);

  // Midasbuy opens a FAILURE callback instead of the PayerMax form when it
  // rejects the recharge (e.g. the account is region-locked). Detect it here and
  // throw a STRUCTURED terminal reason ("invalid_region:" / "payment_failed:")
  // so the eshenly callback can auto-refund, instead of letting the flow fall
  // through to a misleading "page/browser has been closed" timeout in phase-6.
  {
    const purl = popup.url();
    if (/\/callback\/fail/i.test(purl)) {
      let emsg = '';
      let ecode = '';
      try {
        const sp = new URL(purl).searchParams;
        emsg = decodeURIComponent(sp.get('error_message') || '');
        ecode = sp.get('error_code') || '';
      } catch {
        /* ignore parse errors — fall through to generic payment_failed */
      }
      await takeScreenshot(page, 'phase5-payment-rejected');
      if (/another region|choose another region|region to recharge/i.test(emsg) || /12202/.test(`${ecode} ${emsg}`)) {
        throw new Error(`invalid_region: Midasbuy rejected the recharge \u2014 this account must top up from another region [${ecode || 'FKV2 12202'}]`);
      }
      throw new Error(`payment_failed: Midasbuy rejected the payment${emsg ? ` \u2014 ${emsg.slice(0, 160)}` : ''}${ecode ? ` [${ecode}]` : ''}`);
    }
  }

  (page as any).__paymentTab = popup;
}

/** Handle confirm and agreement dialogs that may appear after clicking Pay */
async function handlePostPayDialogs(page: Page): Promise<void> {
  // Step 0: Close login dialog ("تسجيل الدخول أو الاشتراك") if it appears — click the X button
  await page.waitForTimeout(1000);
  const loginDialogClosed = await page.evaluate(() => {
    // Find the X close button in the login dialog
    const closeBtn = document.querySelector(
      '[class*="login"] [class*="close"], [class*="Login"] [class*="close"], ' +
      '[class*="sign"] [class*="close"], [class*="SignIn"] [class*="close"]'
    ) as HTMLElement | null;
    if (closeBtn) { closeBtn.click(); return true; }

    // Fallback: find any X/close button that's inside a dialog overlay
    const allClose = document.querySelectorAll('[class*="icon_close"], [class*="iconClose"], [class*="btn_close"], [class*="btnClose"]');
    for (const el of allClose) {
      (el as HTMLElement).click();
      return true;
    }
    return false;
  });
  if (loginDialogClosed) {
    log('phase-5', 'Login dialog closed (X button)');
    await page.waitForTimeout(1500);
  }

  // Step 1: Handle confirm dialog ("تأكيد الدّفع" in Arabic, "Confirm Payment" in English)
  const confirmClicked = await page.evaluate(() => {
    const confirmTexts = ['تأكيد الدّفع', 'Confirm Payment', 'Confirm'];
    const allEls = document.querySelectorAll('*');
    for (const el of allEls) {
      if (el.children.length === 0 && confirmTexts.includes(el.textContent?.trim() || '')) {
        (el as HTMLElement).click();
        return true;
      }
    }
    return false;
  });

  if (confirmClicked) {
    log('phase-5', 'Clicked "تأكيد الدّفع" (confirm payment)');
    await page.waitForTimeout(2000);
  }

  // Step 2: Handle agreement dialog (PopFollowAgreement)
  // Wait for the agreement dialog to appear after confirm
  await page.waitForTimeout(1500);

  // Find the agreement dialog and check all checkboxes one by one
  const agreementFound = await page.evaluate(() => {
    const dialog = document.querySelector('[class*="PopFollowAgreement_pop_mode_box"]');
    if (!dialog || !dialog.classList.toString().includes('active')) return false;

    // Click each CheckBoxText_check_wrap (the full checkbox row)
    const wraps = dialog.querySelectorAll('[class*="CheckBoxText_check_wrap"]');
    wraps.forEach((wrap) => (wrap as HTMLElement).click());
    return wraps.length;
  });

  if (agreementFound) {
    log('phase-5', `Agreement dialog found, clicked ${agreementFound} checkbox rows`);
    await page.waitForTimeout(1000);

    // Click OK button inside PopFollowAgreement_btn_box
    await page.evaluate(() => {
      const dialog = document.querySelector('[class*="PopFollowAgreement_pop_mode_box"]');
      if (!dialog) return;
      const btn = dialog.querySelector('[class*="Button_btn__"]') as HTMLElement | null;
      if (btn) {
        btn.click();
        return;
      }
      const texts = dialog.querySelectorAll('[class*="Button_text"]');
      for (const t of texts) {
        if (t.textContent?.trim() === 'OK') {
          (t as HTMLElement).click();
          return;
        }
      }
    });
    log('phase-5', 'Agreement OK button clicked');
    await page.waitForTimeout(3000);
  } else {
    log('phase-5', 'No agreement dialog found, continuing...');
  }

  // Step 3: Handle DOB + terms dialog ("الرجاء القراءة والموافقة") — check all boxes and click OK
  await page.waitForTimeout(1000);
  const dobDialogFound = await page.evaluate(() => {
    // Check all unchecked checkboxes
    const checkboxes = document.querySelectorAll('input[type="checkbox"]:not(:checked)');
    checkboxes.forEach((cb) => (cb as HTMLElement).click());

    // Click any checkbox-like elements that appear unchecked
    const checkWraps = document.querySelectorAll('[class*="CheckBox"], [class*="check_wrap"]');
    checkWraps.forEach((el) => {
      if (!el.classList.toString().includes('checked') && !el.querySelector('input:checked')) {
        (el as HTMLElement).click();
      }
    });

    // Click the OK button in any visible dialog
    const allBtns = document.querySelectorAll('button, [class*="Button_btn"]');
    for (const btn of allBtns) {
      const txt = btn.textContent?.trim();
      if (txt === 'OK' || txt === 'موافق') {
        (btn as HTMLElement).click();
        return true;
      }
    }
    return checkboxes.length > 0;
  });

  if (dobDialogFound) {
    log('phase-5', 'DOB/terms dialog handled, clicked OK');
    await page.waitForTimeout(2000);
  }

  await takeScreenshot(page, 'phase5-after-dialogs');
}

// ── Phase 6: Fill PayerMax payment form ─────────────────────────────────────

async function phase6_confirmAndPay(page: Page, config: PurchaseConfig): Promise<void> {
  const paymentTab = (page as any).__paymentTab as Page;
  if (!paymentTab) {
    throw new Error('No payment tab available — phase 5 may have failed');
  }

  log('phase-6', 'Waiting for PayerMax form to load...');
  // Wait for redirect from midasbuy intermediate page to PayerMax
  try {
    await paymentTab.waitForURL(/checkout\.payermax\.com|payermax/i, { timeout: 15000 });
    log('phase-6', `Redirected to: ${paymentTab.url()}`);
  } catch {
    log('phase-6', `Page URL after wait: ${paymentTab.url()}`);
  }
  // PayerMax is a hash-route SPA that never settles 'networkidle'/'load' — use
  // domcontentloaded + a fixed hydration wait so we don't hang 30s.
  await paymentTab.waitForLoadState('domcontentloaded').catch(() => {});
  await paymentTab.waitForLoadState('load', { timeout: 10000 }).catch(() => {});
  await paymentTab.waitForTimeout(4000);
  await takeScreenshot(paymentTab, 'phase6-payermax-loaded');
  await fillPayerMaxForm(paymentTab, config);
}

async function fillPayerMaxForm(paymentPage: Page, config: PurchaseConfig): Promise<void> {
  log('phase-6', 'Filling PayerMax payment form...');

  // Fill phone and email using click + keyboard typing
  // PayerMax uses custom input components that block Playwright's fill()
  // Strategy: click the label to focus the input, select all, then type

  // Fill mobile number
  try {
    const phoneLabel = paymentPage.getByText('Mobile Number');
    await phoneLabel.waitFor({ state: 'visible', timeout: 10000 });
    await phoneLabel.click();
    await paymentPage.waitForTimeout(300);
    // Select all existing text and replace
    await paymentPage.keyboard.press('ControlOrMeta+a');
    await paymentPage.keyboard.press('Delete');
    await paymentPage.keyboard.type(config.phone, { delay: 50 });
    log('phase-6', `Phone filled: ${config.phone}`);
  } catch {
    log('phase-6', 'ERROR: Could not fill phone input');
  }
  await paymentPage.waitForTimeout(500);

  // Fill email
  try {
    const emailLabel = paymentPage.getByText('Email');
    await emailLabel.click();
    await paymentPage.waitForTimeout(300);
    await paymentPage.keyboard.press('ControlOrMeta+a');
    await paymentPage.keyboard.press('Delete');
    await paymentPage.keyboard.type(config.email, { delay: 50 });
    log('phase-6', `Email filled: ${config.email}`);
  } catch {
    log('phase-6', 'ERROR: Could not fill email input');
  }
  await paymentPage.waitForTimeout(500);

  // Verify the form actually contains our values — catches the case where the
  // form was pre-populated (e.g. customer's info from upstream) and our fill
  // didn't clear it cleanly.
  const formValues = await paymentPage.evaluate(() => {
    return Array.from(document.querySelectorAll('input')).map((i) => ({
      type: i.type,
      placeholder: i.placeholder || '',
      value: i.value || '',
    }));
  });
  const phoneOk = formValues.some((f) => f.value === config.phone);
  const emailOk = formValues.some((f) => f.value === config.email);
  if (!phoneOk || !emailOk) {
    log('phase-6', `Form values mismatch: ${JSON.stringify(formValues)}`);
    throw new Error(`PayerMax form does not contain expected values (phoneOk=${phoneOk} emailOk=${emailOk})`);
  }
  log('phase-6', 'Form values verified');

  // Uncheck "Save information" — it's checked by default, click to toggle off
  try {
    const saveCheckbox = paymentPage.getByText(/save information/i);
    if (await saveCheckbox.isVisible({ timeout: 2000 })) {
      await saveCheckbox.click();
      log('phase-6', 'Unchecked "Save information"');
    }
  } catch {
    log('phase-6', 'Warning: Could not find save checkbox');
  }

  await takeScreenshot(paymentPage, 'phase6-before-pay');

  // Click "Pay E£ XX.XX" button
  const payBtn = paymentPage.getByRole('button', { name: /pay/i });
  try {
    await payBtn.waitFor({ state: 'visible', timeout: 5000 });
    const btnText = await payBtn.textContent();
    log('phase-6', `Clicking pay button: "${btnText}"`);
    await payBtn.click();
  } catch {
    // Fallback: try finding any submit button
    log('phase-6', 'Primary pay button not found, trying fallback...');
    await paymentPage.evaluate(() => {
      const btns = document.querySelectorAll('button');
      for (const btn of btns) {
        if (btn.textContent?.toLowerCase().includes('pay')) {
          btn.click();
          return;
        }
      }
    });
  }

  await paymentPage.waitForTimeout(3000);
  await takeScreenshot(paymentPage, 'phase6-done');
  log('phase-6', 'Payment submitted via PayerMax');

  // Wait 2 seconds after payment to capture final state
  await paymentPage.waitForTimeout(2000);
  await takeScreenshot(paymentPage, 'phase6-after-payment');
}

// ── Phase 7: Paymob/Vodafone Cash wallet checkout (PIN + OTP) ───────────────

async function phase7_paymobWallet(page: Page, config: PurchaseConfig, purchaseStartedAt: number): Promise<void> {
  if (!config.walletPin) {
    log('phase-7', 'WALLET_PIN not set, skipping Paymob checkout');
    return;
  }

  const paymentTab = (page as any).__paymentTab as Page;
  const context = page.context();

  log('phase-7', 'Waiting for Paymob/Vodafone Cash checkout window...');

  // Paymob opens in a new browser-context page after PayerMax submits.
  // It may already be open by the time we get here.
  let paymobPage: Page | null =
    context.pages().find((p) => /vcheckout\.paymob(solutions)?\.com\/checkout/i.test(p.url())) || null;

  if (!paymobPage) {
    paymobPage = await context
      .waitForEvent('page', { timeout: 45000, predicate: (p) => /vcheckout\.paymob(solutions)?\.com\/checkout/i.test(p.url()) })
      .catch(() => null);
  }

  if (!paymobPage) {
    // Sometimes PayerMax navigates the same tab instead of opening a new one
    if (paymentTab && /vcheckout\.paymob(solutions)?\.com\/checkout/i.test(paymentTab.url())) {
      paymobPage = paymentTab;
    }
  }

  if (!paymobPage) {
    throw new Error('Paymob checkout window did not appear within 45s');
  }

  try {
    await paymobPage.waitForLoadState('domcontentloaded', { timeout: 15000 });
    await paymobPage.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  } catch { /* continue anyway */ }

  log('phase-7', `Paymob URL: ${paymobPage.url()}`);
  await takeScreenshot(paymobPage, 'phase7-paymob-loaded');
  await dumpPaymobHtml(paymobPage, 'phase7-paymob-loaded');

  // Extract expected amount from the PayerMax URL (e.g. &amount=41.99)
  const m = (paymentTab?.url() || '').match(/[?&]amount=([\d.]+)/);
  const expectedAmount = m ? parseFloat(m[1]) : NaN;
  if (Number.isFinite(expectedAmount)) {
    log('phase-7', `Expected charge amount: ${expectedAmount} EGP`);
  } else {
    log('phase-7', 'Warning: could not detect amount from PayerMax URL');
  }

  // Fill PIN — verified after fill so we don't silently submit empty
  await fillAndVerifyPaymob(paymobPage, 'pin', config.walletPin);
  log('phase-7', 'PIN entered and verified');

  // Long-poll the OTP receiver for an OTP matching this amount
  log('phase-7', `Polling OTP receiver (timeout ${Math.round(config.otpTimeoutMs / 1000)}s)...`);
  const otp = await waitForOtp(config, expectedAmount, purchaseStartedAt);
  if (!otp) {
    await takeScreenshot(paymobPage, 'phase7-otp-timeout');
    throw new Error('OTP not received within timeout');
  }
  log('phase-7', `OTP received: ${otp}`);

  await fillAndVerifyPaymob(paymobPage, 'otp', otp);
  log('phase-7', 'OTP entered and verified');
  await takeScreenshot(paymobPage, 'phase7-before-pay');

  // Snapshot DOM before click so we can diff after
  const preClickError = await readPaymobErrorText(paymobPage);
  const preClickUrl = paymobPage.url();
  const clickedAt = Date.now();

  // Click "Pay with Wallet"
  const payBtn = paymobPage.getByRole('button', { name: /pay with wallet|الدفع/i });
  try {
    await payBtn.waitFor({ state: 'visible', timeout: 5000 });
    await payBtn.click();
    log('phase-7', 'Clicked Pay with Wallet');
  } catch {
    log('phase-7', 'Pay button not found by role, trying fallback...');
    await paymobPage.evaluate(() => {
      const btns = document.querySelectorAll('button, input[type="submit"]');
      for (const b of btns) {
        const txt = (b as HTMLElement).innerText || (b as HTMLInputElement).value || '';
        if (/pay|wallet|دفع/i.test(txt)) {
          (b as HTMLElement).click();
          return;
        }
      }
    });
  }

  // Paymob's post_pay redirect carries a SIGNED success=true (txn_response_code=0)
  // — the authoritative "wallet debited" signal for the PayerMax→Paymob flow.
  // Trust it and finish immediately; do NOT burn the full SMS timeout after the
  // payment already went through (that was the old Promise.all bug — every run
  // stalled ~45s waiting for a confirmation SMS it no longer needed). The
  // Vodafone SMS is only the fallback when Paymob does NOT clearly succeed.
  const outcome = await waitForPaymobOutcome(paymobPage, preClickUrl, preClickError);
  await takeScreenshot(paymobPage, 'phase7-after-pay');

  if (outcome.kind === 'success') {
    const txnId = (paymobPage.url().match(/[?&]id=(\d+)/) || [])[1] || 'paymob';
    log('phase-7', `✅ Paymob confirmed payment (success=true) → ${paymobPage.url()}`);
    // Machine-parsable line for the trigger-worker to capture the txn id.
    console.log(`PAYMENT_CONFIRMED txn=${txnId} amount=${Number.isFinite(expectedAmount) ? expectedAmount : 0} merchant=Paymob`);
    return;
  }

  // Paymob did NOT clearly succeed (error/timeout). The wallet may still have
  // been debited (UI lied / slow) — give the confirmation SMS its window as the
  // authoritative fallback before declaring failure.
  const paymentSms = await waitForPaymentSms(config, expectedAmount, clickedAt);
  if (paymentSms) {
    log('phase-7',
      `⚠️ DELIVERY VERIFICATION NEEDED — Vodafone debited (txn=${paymentSms.txnId} amount=${paymentSms.amount}) but merchant UI reported ${outcome.kind}: ${outcome.message || paymobPage.url()}`);
    console.log(`PAYMENT_CONFIRMED txn=${paymentSms.txnId} amount=${paymentSms.amount} merchant=${paymentSms.merchant}`);
    return;
  }

  // Failure path: capture HTML and the error text
  await dumpPaymobHtml(paymobPage, 'phase7-failure');
  if (outcome.kind === 'error') {
    log('phase-7', `Paymob error text: "${outcome.message}"`);
    throw new Error(`Paymob rejected payment: ${outcome.message}`);
  }
  log('phase-7', `Paymob did not redirect or show error within 30s. URL: ${paymobPage.url()}`);
  throw new Error('Paymob did not reach a terminal state within 30s after clicking Pay');
}

async function waitForPaymentSms(
  config: PurchaseConfig,
  expectedAmount: number,
  sinceMs: number,
): Promise<{ amount: number; merchant: string; txnId: string } | null> {
  if (!config.otpReceiverUrl || !config.otpReceiverToken) return null;
  const amountParam = Number.isFinite(expectedAmount) ? `&amount=${expectedAmount}` : '';
  const merchantParam = `&merchant=${encodeURIComponent(config.merchantName)}`;
  const url = `${config.otpReceiverUrl}/payment/wait?since=${sinceMs}&timeout=${config.paymentSmsTimeoutMs}${amountParam}${merchantParam}`;
  try {
    const res = await fetch(url, {
      headers: { 'X-Token': config.otpReceiverToken },
      signal: AbortSignal.timeout(config.paymentSmsTimeoutMs + 5000),
    });
    if (!res.ok) {
      if (res.status === 404) {
        log('phase-7', 'Payment SMS endpoint not deployed yet (receiver returned 404) — skipping SMS check');
        return null;
      }
      if (res.status === 408) {
        log('phase-7', 'Payment SMS timeout — no matching SMS received within window');
        return null;
      }
      log('phase-7', `Payment SMS receiver returned ${res.status}`);
      return null;
    }
    const body = (await res.json()) as {
      ok?: boolean;
      amount?: number;
      merchant?: string;
      txn_id?: string;
    };
    if (!body.ok || !body.txn_id) return null;
    return {
      amount: body.amount ?? NaN,
      merchant: body.merchant ?? '',
      txnId: body.txn_id,
    };
  } catch (err) {
    log('phase-7', `Payment SMS receiver error: ${err}`);
    return null;
  }
}

async function fillAndVerifyPaymob(page: Page, kind: 'pin' | 'otp', value: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await fillPaymobInput(page, kind, value);
    await page.waitForTimeout(300);
    const ok = await page.evaluate(({ kind, expectedLen }) => {
      const inputs = Array.from(
        document.querySelectorAll<HTMLInputElement>('input:not([readonly]):not([disabled])'),
      ).filter((i) => !/^\d{10,12}$/.test(i.value)); // exclude pre-filled wallet number
      const idx = kind === 'pin' ? 0 : 1;
      const inp = inputs[idx];
      return inp ? inp.value.length === expectedLen : false;
    }, { kind, expectedLen: value.length });
    if (ok) return;
    log('phase-7', `${kind} fill verification failed (attempt ${attempt + 1}/3), retrying...`);
  }
  throw new Error(`Failed to enter ${kind} value into Paymob form after 3 attempts`);
}

interface PaymobOutcome {
  kind: 'success' | 'error' | 'timeout';
  message?: string;
}

async function waitForPaymobOutcome(
  page: Page,
  initialUrl: string,
  preClickError: string | null,
): Promise<PaymobOutcome> {
  const start = Date.now();
  while (Date.now() - start < 30_000) {
    // 1. URL change away from the Paymob checkout form → success/failure
    const currentUrl = page.url();
    if (currentUrl !== initialUrl && !/vcheckout\.paymob(solutions)?\.com\/checkout/i.test(currentUrl)) {
      // Wait for the destination page to settle, then verify success vs failure
      await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
      const finalUrl = page.url();
      // Paymob post_pay URL carries success=true|false in the query string
      const pm = finalUrl.match(/[?&]success=(true|false)\b/i);
      if (pm) {
        if (pm[1].toLowerCase() === 'true') return { kind: 'success' };
        const errMatch = finalUrl.match(/[?&]data\.message=([^&]+)/);
        return { kind: 'error', message: `Paymob declined: ${errMatch ? decodeURIComponent(errMatch[1]) : finalUrl}` };
      }
      // PayerMax/Midasbuy result page convention
      if (/\/result\/SUCCESS\b/i.test(finalUrl)) return { kind: 'success' };
      if (/\/result\/FAIL\b/i.test(finalUrl)) {
        return { kind: 'error', message: `Merchant reported failure: ${finalUrl}` };
      }
      // Different host but not the expected result format — log and assume success
      return { kind: 'success' };
    }
    // 2. New error text appearing → failure
    //    Wrap in try/catch: if the page navigates mid-evaluate, that's a strong
    //    success signal (Paymob only navigates on success).
    let errorText: string | null = null;
    try {
      errorText = await readPaymobErrorText(page);
    } catch (err) {
      if (/Execution context was destroyed|Target closed|frame was detached/i.test(String(err))) {
        // Page is navigating — let next loop iteration see the new URL
        await page.waitForTimeout(500);
        continue;
      }
      throw err;
    }
    if (errorText && errorText !== preClickError) {
      return { kind: 'error', message: errorText };
    }
    await page.waitForTimeout(500);
  }
  return { kind: 'timeout' };
}

async function readPaymobErrorText(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const isRedColor = (color: string): boolean => {
      // rgb(220, 53, 69), rgb(255, 0, 0), #d32, #c00...
      const m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (m) {
        const r = parseInt(m[1], 10);
        const g = parseInt(m[2], 10);
        const b = parseInt(m[3], 10);
        return r > 150 && g < 100 && b < 100;
      }
      return /^#[ce][a-f0-9]{2}/i.test(color);
    };

    const candidates: Element[] = [];
    // Explicit error classes
    candidates.push(
      ...document.querySelectorAll(
        '[class*="error" i], [class*="invalid" i], [class*="alert" i], [class*="fail" i], [role="alert"]',
      ),
    );
    // Red text — scan all small text elements
    document.querySelectorAll('p, div, span, label, small, strong').forEach((el) => {
      const text = el.textContent?.trim() || '';
      if (text.length < 4 || text.length > 300) return;
      const cs = window.getComputedStyle(el as HTMLElement);
      if (isRedColor(cs.color)) candidates.push(el);
    });

    for (const c of candidates) {
      const text = c.textContent?.trim() || '';
      if (text.length >= 4 && text.length <= 300 && !/checkout|wallet/i.test(text)) {
        return text;
      }
    }
    return null;
  });
}

async function dumpPaymobHtml(page: Page, label: string): Promise<void> {
  try {
    const html = await page.content();
    const fs = await import('fs/promises');
    const path = await import('path');
    const dir = path.join(process.cwd(), 'screenshots');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-${label}.html`);
    await fs.writeFile(file, html, 'utf8');
    log('phase-7', `HTML snapshot: ${file}`);
  } catch (err) {
    log('phase-7', `Failed to dump HTML: ${err}`);
  }
}

async function fillPaymobInput(paymobPage: Page, kind: 'pin' | 'otp', value: string): Promise<void> {
  // Find the actual input element via label proximity (handles Arabic + English labels,
  // skips the read-only wallet number input)
  const inputHandle = await paymobPage.evaluateHandle((kind) => {
    const labelPattern = kind === 'pin'
      ? /الرقم السري للمحفظة|PIN/i
      : /الرقم السري المتغير|OTP/i;
    const excludePattern = kind === 'pin'
      ? /الرقم السري المتغير|OTP/i
      : /الرقم السري للمحفظة|PIN/i;

    const candidateInputs = Array.from(
      document.querySelectorAll<HTMLInputElement>('input:not([readonly]):not([disabled])'),
    ).filter((i) => !/^\d{10,12}$/.test(i.value));

    // For each candidate, walk up the DOM to find an ancestor whose visible text
    // matches our label but NOT the other field's label.
    for (const inp of candidateInputs) {
      let el: Element | null = inp.parentElement;
      let depth = 0;
      while (el && depth < 6) {
        const text = (el.textContent || '').trim();
        if (labelPattern.test(text) && !excludePattern.test(text)) {
          return inp;
        }
        el = el.parentElement;
        depth++;
      }
    }
    return null;
  }, kind);

  const element = inputHandle.asElement() as Awaited<ReturnType<Page['$']>> | null;
  if (element) {
    // Real keyboard typing — works against React/Vue/Svelte controlled components
    await element.scrollIntoViewIfNeeded().catch(() => {});
    await element.click({ delay: 30 });
    await paymobPage.keyboard.press('ControlOrMeta+a').catch(() => {});
    await paymobPage.keyboard.press('Delete').catch(() => {});
    await paymobPage.keyboard.type(value, { delay: 60 });
    return;
  }

  // Fallback: nth non-readonly visible input. PIN field is the only one before OTP arrives.
  const inputs = paymobPage.locator('input:not([readonly]):not([disabled])').filter({
    has: paymobPage.locator(':not([value^="01"])'),
  });
  const count = await inputs.count();
  const idx = kind === 'pin' ? 0 : Math.min(1, count - 1);
  const target = inputs.nth(idx);
  await target.scrollIntoViewIfNeeded().catch(() => {});
  await target.click({ delay: 30 });
  await paymobPage.keyboard.press('ControlOrMeta+a').catch(() => {});
  await paymobPage.keyboard.press('Delete').catch(() => {});
  await paymobPage.keyboard.type(value, { delay: 60 });
}

async function waitForOtp(config: PurchaseConfig, expectedAmount: number, sinceMs: number): Promise<string | null> {
  if (!config.otpReceiverUrl || !config.otpReceiverToken) {
    log('phase-7', 'OTP receiver not configured (OTP_RECEIVER_URL / OTP_RECEIVER_TOKEN)');
    return null;
  }
  const amountParam = Number.isFinite(expectedAmount) ? `&amount=${expectedAmount}` : '';
  // Poll in SHORT chunks (25s each) up to the full timeout. The receiver is
  // behind a Cloudflare tunnel that 524s any single request held longer than
  // ~100s, so a slow OTP SMS (e.g. 150s) was never seen by one long poll.
  // `since` stays pinned so a later chunk still matches an OTP that landed
  // during an earlier (timed-out) chunk.
  const CHUNK_MS = 25_000;
  const deadline = Date.now() + config.otpTimeoutMs;
  while (Date.now() < deadline) {
    const chunk = Math.min(CHUNK_MS, deadline - Date.now());
    const url = `${config.otpReceiverUrl}/otp/wait?since=${sinceMs}&timeout=${chunk}${amountParam}`;
    try {
      const res = await fetch(url, {
        headers: { 'X-Token': config.otpReceiverToken },
        signal: AbortSignal.timeout(chunk + 8000),
      });
      if (res.ok) {
        const body = (await res.json()) as { otp?: string };
        if (body.otp) return body.otp;
      } else if (res.status !== 408 && res.status !== 524 && res.status !== 504) {
        log('phase-7', `OTP receiver returned ${res.status}`);
      }
    } catch (err) {
      log('phase-7', `OTP poll chunk error (continuing): ${String(err).slice(0, 60)}`);
    }
  }
  log('phase-7', `OTP not received within ${Math.round(config.otpTimeoutMs / 1000)}s`);
  return null;
}
