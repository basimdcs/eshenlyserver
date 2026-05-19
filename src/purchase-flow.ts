import { Page } from 'playwright';
import { SELECTORS } from './selectors';
import { PurchaseConfig, PaymentMethod } from './config';
import { log, logError, takeScreenshot, wait } from './utils';

const MIDASBUY_URL = 'https://www.midasbuy.com/midasbuy/eg/buy/pubgm';

const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  ewallet: 'Vodafone Cash/Orange Cash/Etisalat Cash',
  credit: 'Credit/ Debit/ Prepaid Card',
  fawry: 'Fawry',
  carrier: 'Orange / Vodafone / Etisalat / WE',
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

  // Dismiss cookie consent ONLY — never click "Yes"/"نعم" as those trigger region redirect
  log('phase-1', 'Dismissing cookie popups...');
  for (const text of ['قبول', 'Accept']) {
    try { await jsClickButtonByText(page, text); } catch { /* may not exist */ }
  }
  // Target cookie button directly by class
  try {
    await page.evaluate(() => {
      const btn = document.querySelector('[class*="cookie"] button, [class*="Cookie"] button') as HTMLElement | null;
      btn?.click();
    });
  } catch { /* may not exist */ }
  await page.waitForTimeout(1000);

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

  // Click the player ID area to open the dialog
  await page.evaluate(() => {
    const el = document.querySelector('[class*="UserTabBox_login_text"]') as HTMLElement | null;
    el?.click();
  });
  await page.waitForTimeout(1500);
  await clearOverlays(page);

  // Type player ID via JS (bypasses overlay interception on the input)
  log('phase-2', 'Typing player ID...');
  await page.evaluate((playerId: string) => {
    // Try Arabic and English placeholders
    const input = (
      document.querySelector('input[placeholder*="إدخال حساب معرف لاعب"]') ||
      document.querySelector('input[placeholder*="Player ID"]') ||
      document.querySelector('input[placeholder*="player"]') ||
      document.querySelector('[class*="SelectServerBox"] input')
    ) as HTMLInputElement | null;
    if (input) {
      input.focus();
      input.value = '';
      // Use native input setter to trigger React's onChange
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (nativeInputValueSetter) {
        nativeInputValueSetter.call(input, playerId);
      } else {
        input.value = playerId;
      }
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, config.playerId);
  await wait(page);

  // Click OK to submit
  log('phase-2', 'Submitting player ID...');
  await jsClickButtonByText(page, 'OK');

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
  await jsClickButtonByText(page, 'OK');
  await wait(page);

  await takeScreenshot(page, 'phase2-done');
}

// ── Phase 3: Click the SKU card (opens checkout panel) ───────────────────────

async function phase3_selectSkuAndCheckout(page: Page, config: PurchaseConfig): Promise<void> {
  log('phase-3', `Selecting SKU: ${config.sku} UC`);

  await clearOverlays(page);

  // Wait for SKU cards to load
  for (let i = 0; i < 10; i++) {
    const count = await page.evaluate(() =>
      document.querySelectorAll('[class*="RechargeClassCard_recharge_class_box"]').length
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
        const cleaned = text.replace(/Popular/gi, '').replace(/热门/g, '').trim();
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

  // Verify checkout panel opened
  const panelOpen = await page.evaluate(() => {
    return !!document.querySelector('[class*="ChannelListNew"], [class*="PayPriceDetailPc"]');
  });

  if (!panelOpen) {
    throw new Error('Checkout panel did not open after clicking SKU card');
  }

  await takeScreenshot(page, 'phase3-done');
  log('phase-3', 'SKU selected, checkout panel open');
}

// ── Phase 4: Select payment method in checkout panel ─────────────────────────

async function phase4_selectPaymentMethod(page: Page, config: PurchaseConfig): Promise<void> {
  const label = PAYMENT_METHOD_LABELS[config.paymentMethod];
  log('phase-4', `Selecting payment method: ${config.paymentMethod} (${label})`);

  // Retry up to 5 times with 1s wait — payment channels may load slowly
  let clicked = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    clicked = await page.evaluate((searchLabel: string) => {
      const items = document.querySelectorAll('[class*="ChannelPayList_payment_item"]');
      for (const item of items) {
        if (item.textContent?.includes(searchLabel)) {
          (item as HTMLElement).click();
          return true;
        }
      }
      return false;
    }, label);

    if (clicked) break;
    log('phase-4', `Payment channels not loaded yet, retrying (${attempt + 1}/5)...`);
    await page.waitForTimeout(1500);
  }

  if (!clicked) {
    // List available payment methods for debugging
    const available = await page.evaluate(() => {
      const items = document.querySelectorAll('[class*="ChannelPayList_payment_item"]');
      return Array.from(items).map((item) => item.textContent?.trim().substring(0, 60) || '');
    });
    throw new Error(
      `Payment method "${config.paymentMethod}" not found. Available: ${JSON.stringify(available)}`,
    );
  }

  await page.waitForTimeout(1500);

  // Verify pay button is enabled
  const btnState = await page.evaluate(() => {
    const btn = document.querySelector('[class*="PayPriceDetailPc"] button') as HTMLButtonElement | null;
    if (!btn) return null;
    return { text: btn.textContent, disabled: btn.disabled };
  });

  if (!btnState) {
    throw new Error('Pay button not found after selecting payment method');
  }

  if (btnState.disabled) {
    throw new Error(`Pay button is disabled (text: "${btnState.text}"). This payment method may require login.`);
  }

  log('phase-4', `Pay button ready: "${btnState.text}" (enabled)`);
  await takeScreenshot(page, 'phase4-done');
}

// ── Phase 5: Click Pay button + capture payment tab ──────────────────────────

async function phase5_initiatePurchase(page: Page, config: PurchaseConfig): Promise<void> {
  log('phase-5', 'Clicking Pay button...');

  // IMPORTANT: Set up the new-tab listener BEFORE clicking Pay,
  // because the tab may open immediately (before confirm/agreement dialogs)
  const context = page.context();
  const popupPromise = context.waitForEvent('page', { timeout: 30000 }).catch(() => null);

  await page.evaluate(() => {
    const btn = document.querySelector('[class*="PayPriceDetailPc"] button') as HTMLButtonElement | null;
    btn?.click();
  });

  await page.waitForTimeout(2000);
  await takeScreenshot(page, 'phase5-done');
  log('phase-5', 'Pay button clicked');

  // Handle any confirm/agreement dialogs that appear on the main page
  // (these may or may not appear depending on session state)
  await handlePostPayDialogs(page);

  // Now wait for the payment tab that was triggered by clicking Pay
  log('phase-5', 'Waiting for payment tab...');
  const popup = await popupPromise;

  if (!popup) {
    await takeScreenshot(page, 'phase5-no-popup');
    throw new Error('Payment tab did not open after clicking Pay button');
  }

  log('phase-5', `Payment tab opened: ${popup.url()}`);
  // Store the popup page for phase 6
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
  await paymentTab.waitForLoadState('networkidle');
  await paymentTab.waitForTimeout(2000);
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
    await paymentPage.keyboard.press('Meta+a');
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
    await paymentPage.keyboard.press('Meta+a');
    await paymentPage.keyboard.type(config.email, { delay: 50 });
    log('phase-6', `Email filled: ${config.email}`);
  } catch {
    log('phase-6', 'ERROR: Could not fill email input');
  }
  await paymentPage.waitForTimeout(500);

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
    context.pages().find((p) => /paymobsolutions\.com|vcheckout\.paymob/i.test(p.url())) || null;

  if (!paymobPage) {
    paymobPage = await context
      .waitForEvent('page', { timeout: 45000, predicate: (p) => /paymobsolutions\.com|vcheckout\.paymob/i.test(p.url()) })
      .catch(() => null);
  }

  if (!paymobPage) {
    // Sometimes PayerMax navigates the same tab instead of opening a new one
    if (paymentTab && /paymobsolutions\.com|vcheckout\.paymob/i.test(paymentTab.url())) {
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

  // Wait for a terminal state: URL change (success) or error text on page (failure)
  const outcome = await waitForPaymobOutcome(paymobPage, preClickUrl, preClickError);
  await takeScreenshot(paymobPage, 'phase7-after-pay');

  if (outcome.kind === 'success') {
    log('phase-7', `Paymob completed → redirected to ${paymobPage.url()}`);
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
    // 1. URL change away from Paymob → success
    const currentUrl = page.url();
    if (currentUrl !== initialUrl && !/paymobsolutions\.com|vcheckout\.paymob/i.test(currentUrl)) {
      // Wait for the destination page to settle, then verify success vs failure
      await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
      const finalUrl = page.url();
      // page-gateway/user/result/SUCCESS or FAIL is the standard merchant result page
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
  const url = `${config.otpReceiverUrl}/otp/wait?since=${sinceMs}&timeout=${config.otpTimeoutMs}${amountParam}`;
  try {
    const res = await fetch(url, {
      headers: { 'X-Token': config.otpReceiverToken },
      signal: AbortSignal.timeout(config.otpTimeoutMs + 5000),
    });
    if (!res.ok) {
      log('phase-7', `OTP receiver returned ${res.status}`);
      return null;
    }
    const body = (await res.json()) as { otp?: string };
    return body.otp || null;
  } catch (err) {
    log('phase-7', `OTP receiver error: ${err}`);
    return null;
  }
}
