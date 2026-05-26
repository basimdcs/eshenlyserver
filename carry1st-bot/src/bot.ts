import { chromium, type Browser, type Page } from "playwright";
import type { FullConfig } from "./types.js";

function log(step: string, detail?: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${step}${detail ? ` — ${detail}` : ""}`);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export class Carry1stBot {
  private browser!: Browser;
  private page!: Page;
  private config: FullConfig;
  private purchaseStartedAt: number = 0;
  private expectedAmount: number = NaN;

  constructor(config: FullConfig) {
    this.config = config;
  }

  async launch() {
    log("Launching browser", this.config.headless ? "headless" : "headed");
    this.browser = await chromium.launch({
      headless: this.config.headless,
      channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
      executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined,
      proxy: this.config.proxy ? { server: this.config.proxy } : undefined,
      // Carry1st pages are heavy React apps — --single-process + 384MB V8 cap
      // crashes the renderer mid-load. Opt-in via LOW_MEMORY_BROWSER=true if
      // you're squeezed for RAM and willing to risk it.
      args: process.env.LOW_MEMORY_BROWSER === "true"
        ? [
            "--disable-blink-features=AutomationControlled",
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--disable-extensions",
            "--disable-background-networking",
            "--disable-background-timer-throttling",
            "--disable-default-apps",
            "--disable-sync",
            "--no-first-run",
            "--mute-audio",
            "--single-process",
            "--no-zygote",
            "--renderer-process-limit=1",
            "--disable-features=site-per-process,IsolateOrigins,TranslateUI",
            "--js-flags=--max-old-space-size=384",
          ]
        : [
            "--disable-blink-features=AutomationControlled",
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--disable-extensions",
            "--disable-background-networking",
            "--disable-default-apps",
            "--no-first-run",
            "--mute-audio",
          ],
    });
    const context = await this.browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    });

    // Browser-side guard: dismiss any country popup the instant it renders.
    // Runs in the page context via MutationObserver — no Playwright round-trip.
    // Without this, the Radix dialog overlay can appear mid-click and block it.
    // We pick language-neutral dismiss targets (never "Continue to Egypt",
    // which silently switches the site to Arabic).
    await context.addInitScript(() => {
      const dismissDialog = () => {
        const dlg = document.querySelector('[role="dialog"], .dialog-container');
        if (!dlg) return;
        const buttons = Array.from(dlg.querySelectorAll("button"));
        const targets = [
          (b: HTMLButtonElement) => (b.textContent || "").trim() === "Ignore",
          (b: HTMLButtonElement) => (b.textContent || "").trim() === "تجاهل",
          (b: HTMLButtonElement) => b.getAttribute("aria-label") === "Close",
          (b: HTMLButtonElement) => b.getAttribute("aria-label") === "close",
          (b: HTMLButtonElement) => ["×", "✕"].includes((b.textContent || "").trim()),
        ];
        for (const pick of targets) {
          const btn = buttons.find(pick as (b: Element) => boolean) as HTMLButtonElement | undefined;
          if (btn) {
            btn.click();
            return;
          }
        }
      };
      const obs = new MutationObserver(() => dismissDialog());
      const start = () => obs.observe(document.body, { childList: true, subtree: true });
      if (document.body) start();
      else document.addEventListener("DOMContentLoaded", start);
      // Also dismiss any dialog already present at script-eval time.
      dismissDialog();
    });

    this.page = await context.newPage();

    // Block heavy/irrelevant resources to keep the renderer from OOMing on
    // small-RAM VPSes. Default ON — opt out with BLOCK_MEDIA=false.
    if (process.env.BLOCK_MEDIA !== "false") {
      // Don't block stylesheets — Carry1st validation may depend on layout.
      const blockedTypes = new Set(["image", "media", "font"]);
      const blockedHostPatterns = [
        /google-analytics\.com/,
        /googletagmanager\.com/,
        /doubleclick\.net/,
        /facebook\.net/,
        /hotjar\.com/,
        /clarity\.ms/,
        /segment\.io/,
        /datadoghq/,
      ];
      await this.page.route("**/*", (route) => {
        const req = route.request();
        if (blockedTypes.has(req.resourceType())) return route.abort();
        const url = req.url();
        if (blockedHostPatterns.some((p) => p.test(url))) return route.abort();
        return route.continue();
      });
      log("Resource blocking enabled", "images/media/fonts/css/analytics");
    }

    if (this.config.proxy) log("Using proxy", this.config.proxy);
  }

  async navigateToProduct() {
    // Visit the country/locale landing page FIRST so Carry1st commits to
    // EG + EN before the product page renders. Skipping this step causes
    // some product pages (Blood Strike confirmed) to never render the
    // "Select Payment Method" section, leaving BUY NOW perma-disabled.
    // Derived from the product URL — same origin, same /en/<COUNTRY>/ prefix.
    const localeMatch = this.config.url.match(/^(https:\/\/shop\.carry1st\.com\/[^/]+\/[^/]+)/);
    if (localeMatch) {
      const landingUrl = localeMatch[1];
      log("Establishing locale", landingUrl);
      try {
        await this.page.goto(landingUrl, { waitUntil: "domcontentloaded", timeout: 25000 });
        await sleep(2000);
      } catch (err) {
        log("Locale-establishing nav failed (continuing)", String(err).slice(0, 100));
      }
    }

    log("Navigating", this.config.url);
    // "networkidle" never settles on Carry1st (continuous analytics/ads polling)
    // and the chromium renderer OOMs waiting for it on small-RAM VPS. Use
    // domcontentloaded + a fixed hydration wait instead.
    await this.page.goto(this.config.url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await this.page.waitForLoadState("load", { timeout: 15000 }).catch(() => {});
    await sleep(3000);
  }

  // Carry1st's country-picker popup is intermittent and renders at variable
  // delay (1-20s after navigation). Once present, its overlay (Radix Dialog
  // z-60) blocks all clicks. Call this before every critical interaction.
  private async ensureNoOverlay(reason: string = "") {
    const overlaySelector =
      '[role="dialog"]:visible, [data-state="open"][aria-hidden="true"], .dialog-container';
    const overlayPresent = async () =>
      this.page
        .locator(overlaySelector)
        .first()
        .isVisible({ timeout: 200 })
        .catch(() => false);

    if (!(await overlayPresent())) return;

    // Language-neutral dismissals first. "Continue to Egypt" silently switches
    // the site to Arabic, breaking every English-label selector downstream.
    const dismissSelectors = [
      'button:has-text("Ignore")',
      'button:has-text("تجاهل")',
      '[aria-label="Close"]',
      '[aria-label="close"]',
      'button:has-text("×")',
      'button:has-text("✕")',
    ];

    const tag = reason ? ` (${reason})` : "";
    log(`Overlay detected${tag} — dismissing`);

    for (let attempt = 0; attempt < 4; attempt++) {
      for (const sel of dismissSelectors) {
        try {
          const btn = this.page.locator(sel).first();
          if (await btn.isVisible({ timeout: 200 }).catch(() => false)) {
            await btn.click({ timeout: 2000 });
            await sleep(500);
            if (!(await overlayPresent())) {
              log("Overlay dismissed");
              return;
            }
          }
        } catch {}
      }
      // Fallback: Escape key
      await this.page.keyboard.press("Escape").catch(() => {});
      await sleep(500);
      if (!(await overlayPresent())) {
        log("Overlay dismissed (via Escape)");
        return;
      }
    }
    log("Overlay still present after 4 attempts — proceeding anyway");
  }

  async dismissPopups() {
    log("Dismissing popups");
    // Initial sweep — wait up to 5s for the overlay to render, then dismiss.
    // Most products render it within 2-3s. Some (e.g. Blood Strike) render
    // later, but ensureNoOverlay() before each click handles that case.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const overlay = await this.page
        .locator('[role="dialog"]:visible, .dialog-container')
        .first()
        .isVisible({ timeout: 300 })
        .catch(() => false);
      if (overlay) {
        await this.ensureNoOverlay("initial");
        return;
      }
      await sleep(500);
    }
    log("No popup yet (will recheck before each click)");
  }

  async fillProductFields() {
    const entries = Object.entries(this.config.fields);
    if (entries.length === 0) {
      log("No product fields to fill (gift-card style)");
      return;
    }
    log("Filling product fields", entries.map(([k]) => k).join(", "));
    for (const [label, value] of entries) {
      await this.fillField(label, value);
      await sleep(1000);
    }
  }

  async selectBundle() {
    await this.ensureNoOverlay("before bundle");
    log("Selecting bundle", this.config.bundleLabel);
    const bundleBtn = this.page
      .locator("button, div[role='button'], label")
      .filter({ hasText: this.config.bundleLabel });
    try {
      await bundleBtn.first().waitFor({ state: "visible", timeout: 5000 });
    } catch {
      // Bundle may be behind a "Show more products" expander.
      const showMore = this.page.locator('button, div[role="button"]').filter({ hasText: "Show more products" });
      if (await showMore.first().isVisible({ timeout: 2000 }).catch(() => false)) {
        log("Bundle not visible — clicking 'Show more products' to expand");
        await showMore.first().click();
        await sleep(1500);
      }
    }
    try {
      await bundleBtn.first().waitFor({ state: "visible", timeout: 8000 });
    } catch (err) {
      log("Bundle not found — dumping all bundle-like candidates");
      const candidates = await this.page.evaluate(() => {
        const els = Array.from(
          document.querySelectorAll("button, div[role='button'], label")
        );
        return els
          .map((e) => (e.textContent || "").replace(/\s+/g, " ").trim())
          .filter((t) => t.length > 0 && t.length < 200)
          .filter((t, i, arr) => arr.indexOf(t) === i);
      });
      log("Candidate button texts", JSON.stringify(candidates, null, 2));
      throw err;
    }
    await bundleBtn.first().click();
    await sleep(1500);
  }

  async selectPaymentMethod() {
    await this.ensureNoOverlay("before payment");
    log("Selecting payment", this.config.paymentMethod);
    // The "Select Payment Method" section renders 5-15s after bundle selection
    // on some products (Blood Strike). Wait for the section header first, then
    // click the specific method — much more reliable than racing on the button.
    try {
      await this.page
        .locator("text=/Select Payment Method/i")
        .first()
        .waitFor({ state: "visible", timeout: 20000 });
    } catch {
      // Header not found within 20s. Either the section never renders on this
      // product, or the page is in a different language. Try the button
      // directly as a fallback with a short timeout.
    }
    const payBtn = this.page
      .locator("button, div[role='button'], label")
      .filter({ hasText: this.config.paymentMethod });
    try {
      await payBtn.first().waitFor({ state: "visible", timeout: 8000 });
    } catch {
      // Genuinely no payment selector on this product (or our method isn't
      // listed). Log and continue — Pay1st may still handle it. If BUY NOW
      // stays disabled, the diagnostic dump below will reveal why.
      log(
        "Payment selector not found on product page",
        `("${this.config.paymentMethod}" not visible within 28s)`
      );
      return;
    }
    await payBtn.first().click();
    await sleep(1500);
  }

  async fillContactDetails() {
    log("Filling contact details");
    const { firstName, surname, email, phone } = this.config;
    await this.fillField("First name", firstName);
    await this.fillField("Surname", surname);
    await this.fillField("Email", email);
    await this.fillField("Phone number", phone);
    await sleep(1000);
  }

  private async fillField(label: string, value: string) {
    // Exact-match strategies first so "Email" doesn't match "Valid Email for Voucher".
    const strategies = [
      () => this.page.getByLabel(label, { exact: true }),
      () => this.page.getByPlaceholder(label, { exact: true }),
      () => this.page.locator(`input[aria-label="${label}"]`),
      () => this.page.locator(`input[name="${label}"]`),
      () => this.page.getByLabel(label),
      () => this.page.getByPlaceholder(label),
      () => this.page.locator(`input[placeholder*="${label}"]`),
    ];
    for (const strategy of strategies) {
      const loc = strategy();
      try {
        const visible = await loc.first().isVisible({ timeout: 2000 });
        if (visible) {
          await loc.first().fill(value);
          log(`  Filled "${label}"`, value);
          await sleep(500);
          return;
        }
      } catch {}
    }
    const inputs = await this.page.locator("input:visible").all();
    const attrs = [];
    for (const inp of inputs) {
      const name = await inp.getAttribute("name");
      const ph = await inp.getAttribute("placeholder");
      const ariaLabel = await inp.getAttribute("aria-label");
      attrs.push(`name="${name}" placeholder="${ph}" aria-label="${ariaLabel}"`);
    }
    log(`  Could not find "${label}". Visible inputs:`, attrs.join(" | "));
    throw new Error(`Could not find input field: ${label}`);
  }

  async clickBuyNow() {
    await this.ensureNoOverlay("before BUY NOW");
    log("Clicking BUY NOW");
    this.purchaseStartedAt = Date.now();
    const buyBtn = this.page.locator('button:has-text("BUY NOW")');
    await buyBtn.first().waitFor({ state: "visible", timeout: 10000 });

    // Diagnostic: if disabled, dump form state before timing out.
    const isDisabled = await buyBtn.first().isDisabled().catch(() => false);
    if (isDisabled) {
      log("BUY NOW is disabled — dumping form state");
      const state = await this.page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll("input")).map((i) => ({
          name: i.getAttribute("name"),
          placeholder: i.getAttribute("placeholder"),
          ariaLabel: i.getAttribute("aria-label"),
          type: i.type,
          value: i.value,
          required: i.required,
          checked: i.type === "radio" || i.type === "checkbox" ? i.checked : undefined,
        }));
        const buyBtn = document.querySelector("button:has(span)") as HTMLElement | null;
        const buyText =
          Array.from(document.querySelectorAll("button")).find((b) =>
            (b.textContent || "").includes("BUY NOW")
          ) || buyBtn;
        return { inputs, buyHtml: buyText?.outerHTML?.slice(0, 400) || null };
      });
      log("Form inputs", JSON.stringify(state.inputs, null, 2));
      if (state.buyHtml) log("BUY NOW button HTML", state.buyHtml);
    }

    await buyBtn.first().click();

    log("Waiting for redirect to pay.carry1st.com");
    await this.page.waitForURL("**/pay.carry1st.com/**", { timeout: 30000 });
    log("Redirected to payment page", this.page.url());
    await sleep(2000);

    // Capture amount from the Pay1st summary so the OTP receiver can match it.
    try {
      const amount = await this.page.evaluate(() => {
        const text = document.body.innerText || "";
        const m = text.match(/EGP\s*([\d,]+\.?\d*)/i);
        return m ? parseFloat(m[1].replace(/,/g, "")) : NaN;
      });
      if (Number.isFinite(amount)) {
        this.expectedAmount = amount;
        log("Expected charge amount", `${amount} EGP`);
      } else {
        log("Warning", "could not parse amount from Pay1st page");
      }
    } catch {}
  }

  async confirmPayment() {
    log("Confirming payment on Pay1st page");
    await sleep(5000);

    // Playwright reports the Pay Now button as "not visible" due to CSS framework quirks.
    // Use JS click directly to bypass visibility checks. Pay1st may render in
    // Arabic ("ادفع الآن") even when shop locale is en — try both languages.
    // Inline to avoid tsx wrapping nested arrow fns with `__name` (which is
    // undefined in the browser context).
    await this.page.evaluate(() => {
      let btn = document.querySelector('button[aria-label="Pay Now"]') as HTMLButtonElement | null;
      if (!btn) btn = document.querySelector('button[aria-label="ادفع الآن"]') as HTMLButtonElement | null;
      if (!btn) {
        const buttons = Array.from(document.querySelectorAll("button"));
        for (const b of buttons) {
          const t = (b.textContent || "").trim();
          if (t === "Pay Now" || t === "ادفع الآن" || t.indexOf("ادفع") >= 0) {
            btn = b as HTMLButtonElement;
            break;
          }
        }
      }
      if (!btn) throw new Error("Pay Now button not found in DOM");
      btn.click();
    });
    log("Clicked Pay Now");
  }

  async payWithWallet() {
    if (!this.config.walletPin) {
      log("payWithWallet skipped", "WALLET_PIN not set");
      return;
    }

    log("Waiting for Paymob/Vodafone Cash checkout window...");
    const paymobPage = await this.resolvePaymobPage();
    if (!paymobPage) throw new Error("Paymob checkout did not appear within 45s");

    try {
      await paymobPage.waitForLoadState("domcontentloaded", { timeout: 15000 });
      await paymobPage.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    } catch {}

    log("Paymob URL", paymobPage.url());
    try {
      await paymobPage.screenshot({ path: "paymob-loaded.png", fullPage: true });
    } catch {}

    if (Number.isFinite(this.expectedAmount)) {
      log("Expected amount (from Pay1st)", `${this.expectedAmount} EGP`);
    }

    await this.fillAndVerifyPaymob(paymobPage, "pin", this.config.walletPin);
    log("PIN entered and verified");

    log("Polling OTP receiver", `timeout ${Math.round(this.config.otpTimeoutMs / 1000)}s`);
    const otp = await this.waitForOtp();
    if (!otp) {
      try { await paymobPage.screenshot({ path: "paymob-otp-timeout.png", fullPage: true }); } catch {}
      throw new Error("OTP not received within timeout");
    }
    log("OTP received", otp);

    await this.fillAndVerifyPaymob(paymobPage, "otp", otp);
    log("OTP entered and verified");
    try { await paymobPage.screenshot({ path: "paymob-before-pay.png", fullPage: true }); } catch {}

    const preClickUrl = paymobPage.url();
    const preClickError = await this.readPaymobErrorText(paymobPage);
    const clickedAt = Date.now();

    log("Clicking 'Pay with Wallet'");
    const payBtn = paymobPage.getByRole("button", { name: /pay with wallet|الدفع/i });
    try {
      await payBtn.waitFor({ state: "visible", timeout: 5000 });
      await payBtn.click();
    } catch {
      log("Pay with Wallet not found by role — fallback");
      await paymobPage.evaluate(() => {
        const btns = document.querySelectorAll('button, input[type="submit"]');
        for (const b of Array.from(btns)) {
          const txt = (b as HTMLElement).innerText || (b as HTMLInputElement).value || "";
          if (/pay|wallet|دفع/i.test(txt)) {
            (b as HTMLElement).click();
            return;
          }
        }
      });
    }

    // Race two signals: Carry1st's redirect (UI signal) and the Vodafone payment
    // confirmation SMS (money-moved signal — authoritative). Carry1st sometimes
    // redirects to /payment/failure even when the wallet was actually debited.
    const [urlOutcome, paymentSms] = await Promise.all([
      this.waitForPaymobOutcome(paymobPage, preClickUrl, preClickError),
      this.waitForPaymentSms(clickedAt),
    ]);
    try { await paymobPage.screenshot({ path: "paymob-after-pay.png", fullPage: true }); } catch {}

    if (paymentSms) {
      log("✅ Vodafone SMS confirmed payment",
        `txn=${paymentSms.txnId} amount=${paymentSms.amount} merchant=${paymentSms.merchant}`);
      // Machine-parsable line for the trigger-worker to capture.
      console.log(`PAYMENT_CONFIRMED txn=${paymentSms.txnId} amount=${paymentSms.amount} merchant=${paymentSms.merchant}`);
      if (urlOutcome.kind === "success") {
        log("✅ Merchant UI also confirmed success", paymobPage.url());
      } else {
        log("⚠️ DELIVERY VERIFICATION NEEDED",
          `Vodafone debited but merchant UI reported ${urlOutcome.kind}: ${urlOutcome.message || paymobPage.url()}`);
      }
      return;
    }

    // No payment SMS arrived — fall back to URL signal.
    if (urlOutcome.kind === "success") {
      log("⚠️ UI says success but no Vodafone SMS yet", "treating as success but flag for follow-up");
      return;
    }
    if (urlOutcome.kind === "error") {
      throw new Error(`Paymob rejected payment: ${urlOutcome.message}`);
    }
    throw new Error(`No payment SMS within ${this.config.paymentSmsTimeoutMs}ms and no URL settlement. URL: ${paymobPage.url()}`);
  }

  private async waitForPaymentSms(
    sinceMs: number
  ): Promise<{ amount: number; merchant: string; txnId: string } | null> {
    if (!this.config.otpReceiverUrl || !this.config.otpReceiverToken) return null;
    const amountParam = Number.isFinite(this.expectedAmount)
      ? `&amount=${this.expectedAmount}`
      : "";
    const merchantParam = `&merchant=${encodeURIComponent(this.config.merchantName)}`;
    const url = `${this.config.otpReceiverUrl}/payment/wait?since=${sinceMs}&timeout=${this.config.paymentSmsTimeoutMs}${amountParam}${merchantParam}`;
    try {
      const res = await fetch(url, {
        headers: { "X-Token": this.config.otpReceiverToken },
        signal: AbortSignal.timeout(this.config.paymentSmsTimeoutMs + 5000),
      });
      if (!res.ok) {
        if (res.status === 404) {
          log("Payment SMS endpoint not deployed yet", "(receiver returned 404) — skipping SMS check");
          return null;
        }
        if (res.status === 408) {
          log("Payment SMS timeout", "no matching SMS received");
          return null;
        }
        log("Payment SMS receiver returned", String(res.status));
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
        merchant: body.merchant ?? "",
        txnId: body.txn_id,
      };
    } catch (err) {
      log("Payment SMS receiver error", String(err));
      return null;
    }
  }

  private async resolvePaymobPage(): Promise<Page | null> {
    const ctx = this.page.context();
    const isPaymob = (p: Page) =>
      /vcheckout\.paymob(solutions)?\.com\/checkout/i.test(p.url());

    // 1. Already on Paymob in current tab (Carry1st flow navigates in-place).
    if (isPaymob(this.page)) return this.page;

    // 2. Other open tab is on Paymob.
    const existing = ctx.pages().find(isPaymob);
    if (existing) return existing;

    // 3. Wait for either a new tab OR a navigation in the current tab.
    const newTabP = ctx.waitForEvent("page", { timeout: 45000, predicate: isPaymob }).catch(() => null);
    const navP = this.page
      .waitForURL((u) => /vcheckout\.paymob(solutions)?\.com\/checkout/i.test(u.toString()), { timeout: 45000 })
      .then(() => this.page)
      .catch(() => null);
    const winner = await Promise.race([newTabP, navP]);
    return winner;
  }

  private async fillAndVerifyPaymob(page: Page, kind: "pin" | "otp", value: string) {
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.fillPaymobInput(page, kind, value);
      await page.waitForTimeout(300);
      const ok = await page.evaluate(
        ({ kind, expectedLen }: { kind: "pin" | "otp"; expectedLen: number }) => {
          const inputs = Array.from(
            document.querySelectorAll<HTMLInputElement>("input:not([readonly]):not([disabled])")
          ).filter((i) => !/^\d{10,12}$/.test(i.value));
          const idx = kind === "pin" ? 0 : 1;
          const inp = inputs[idx];
          return inp ? inp.value.length === expectedLen : false;
        },
        { kind, expectedLen: value.length }
      );
      if (ok) return;
      log(`${kind} fill verification failed`, `attempt ${attempt + 1}/3`);
    }
    throw new Error(`Failed to enter ${kind} into Paymob form after 3 attempts`);
  }

  private async fillPaymobInput(page: Page, kind: "pin" | "otp", value: string) {
    // Locate input by walking up the DOM looking for the matching label (handles
    // Arabic + English) and skipping the pre-filled wallet-number input.
    const handle = await page.evaluateHandle((kind: "pin" | "otp") => {
      const labelPattern = kind === "pin"
        ? /الرقم السري للمحفظة|PIN/i
        : /الرقم السري المتغير|OTP/i;
      const excludePattern = kind === "pin"
        ? /الرقم السري المتغير|OTP/i
        : /الرقم السري للمحفظة|PIN/i;
      const candidates = Array.from(
        document.querySelectorAll<HTMLInputElement>("input:not([readonly]):not([disabled])")
      ).filter((i) => !/^\d{10,12}$/.test(i.value));
      for (const inp of candidates) {
        let el: Element | null = inp.parentElement;
        let depth = 0;
        while (el && depth < 6) {
          const text = (el.textContent || "").trim();
          if (labelPattern.test(text) && !excludePattern.test(text)) {
            return inp;
          }
          el = el.parentElement;
          depth++;
        }
      }
      return null;
    }, kind);

    const element = handle.asElement();
    if (element) {
      await element.scrollIntoViewIfNeeded().catch(() => {});
      await element.click({ delay: 30 });
      await page.keyboard.press("ControlOrMeta+a").catch(() => {});
      await page.keyboard.press("Delete").catch(() => {});
      await page.keyboard.type(value, { delay: 60 });
      return;
    }

    // Fallback by index (PIN = 0, OTP = 1) among non-readonly inputs.
    const inputs = page.locator("input:not([readonly]):not([disabled])");
    const idx = kind === "pin" ? 0 : 1;
    const target = inputs.nth(idx);
    await target.scrollIntoViewIfNeeded().catch(() => {});
    await target.click({ delay: 30 });
    await page.keyboard.press("ControlOrMeta+a").catch(() => {});
    await page.keyboard.press("Delete").catch(() => {});
    await page.keyboard.type(value, { delay: 60 });
  }

  private async waitForOtp(): Promise<string | null> {
    if (!this.config.otpReceiverUrl || !this.config.otpReceiverToken) {
      log("OTP receiver not configured", "OTP_RECEIVER_URL / OTP_RECEIVER_TOKEN");
      return null;
    }
    const amountParam = Number.isFinite(this.expectedAmount)
      ? `&amount=${this.expectedAmount}`
      : "";
    const url = `${this.config.otpReceiverUrl}/otp/wait?since=${this.purchaseStartedAt}&timeout=${this.config.otpTimeoutMs}${amountParam}`;
    try {
      const res = await fetch(url, {
        headers: { "X-Token": this.config.otpReceiverToken },
        signal: AbortSignal.timeout(this.config.otpTimeoutMs + 5000),
      });
      if (!res.ok) {
        log("OTP receiver returned", String(res.status));
        return null;
      }
      const body = (await res.json()) as { otp?: string };
      return body.otp || null;
    } catch (err) {
      log("OTP receiver error", String(err));
      return null;
    }
  }

  private async waitForPaymobOutcome(
    page: Page,
    initialUrl: string,
    preClickError: string | null
  ): Promise<{ kind: "success" | "error" | "timeout"; message?: string }> {
    const start = Date.now();
    while (Date.now() - start < 30_000) {
      const currentUrl = page.url();
      if (
        currentUrl !== initialUrl &&
        !/vcheckout\.paymob(solutions)?\.com\/checkout/i.test(currentUrl)
      ) {
        await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
        const finalUrl = page.url();
        const pm = finalUrl.match(/[?&]success=(true|false)\b/i);
        if (pm) {
          if (pm[1].toLowerCase() === "true") return { kind: "success" };
          const errMatch = finalUrl.match(/[?&]data\.message=([^&]+)/);
          return {
            kind: "error",
            message: `Paymob declined: ${errMatch ? decodeURIComponent(errMatch[1]) : finalUrl}`,
          };
        }
        // Carry1st may redirect to its own /success or /failure path.
        if (/success|complete|paid|thank/i.test(finalUrl)) return { kind: "success" };
        if (/fail|cancel|decline|error/i.test(finalUrl)) {
          return { kind: "error", message: `Merchant reported failure: ${finalUrl}` };
        }
        // Unknown destination — log and assume success (Paymob only navigates on success).
        return { kind: "success" };
      }
      let errorText: string | null = null;
      try {
        errorText = await this.readPaymobErrorText(page);
      } catch (err) {
        if (/Execution context was destroyed|Target closed|frame was detached/i.test(String(err))) {
          await page.waitForTimeout(500);
          continue;
        }
        throw err;
      }
      if (errorText && errorText !== preClickError) {
        return { kind: "error", message: errorText };
      }
      await page.waitForTimeout(500);
    }
    return { kind: "timeout" };
  }

  private async readPaymobErrorText(page: Page): Promise<string | null> {
    return page.evaluate(() => {
      const candidates: Element[] = [];
      candidates.push(
        ...Array.from(
          document.querySelectorAll(
            '[class*="error" i], [class*="invalid" i], [class*="alert" i], [class*="fail" i], [role="alert"]'
          )
        )
      );
      document.querySelectorAll("p, div, span, label, small, strong").forEach((el) => {
        const text = el.textContent?.trim() || "";
        if (text.length < 4 || text.length > 300) return;
        const cs = window.getComputedStyle(el as HTMLElement);
        const m = cs.color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (m) {
          const r = parseInt(m[1], 10);
          const g = parseInt(m[2], 10);
          const b = parseInt(m[3], 10);
          if (r > 150 && g < 100 && b < 100) candidates.push(el);
        }
      });
      for (const c of candidates) {
        const text = c.textContent?.trim() || "";
        if (text.length >= 4 && text.length <= 300 && !/checkout|wallet/i.test(text)) {
          return text;
        }
      }
      return null;
    });
  }

  async snapshotAllPages(prefix: string) {
    const context = this.page.context();
    // Brief settle so newly-opened tabs finish loading.
    await sleep(8000);
    const pages = context.pages();
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      try {
        await p.screenshot({ path: `${prefix}-${i}.png`, fullPage: true });
        log("Screenshot saved", `${prefix}-${i}.png — url: ${p.url()}`);
      } catch (err) {
        log(`Screenshot failed for tab ${i}`, String(err));
      }
    }
  }

  async waitForResult() {
    log("Waiting for payment result", "Check your phone for OTP (5 min timeout)");
    try {
      const context = this.page.context();
      const pages = context.pages();
      const activePage = pages[pages.length - 1];
      context.on("page", (newPage) => {
        log("New tab opened", newPage.url());
        this.page = newPage;
      });
      await activePage.waitForEvent("close", { timeout: 300000 }).catch(() => {});
      log("Payment flow completed", "Check browser for final status");
    } catch {
      log("Timeout or error waiting for result", "Check browser/phone for status");
    }
  }

  async run() {
    await this.launch();
    try {
      await this.navigateToProduct();
      await this.dismissPopups();
      await this.fillProductFields();
      await this.selectBundle();
      await this.selectPaymentMethod();
      await this.fillContactDetails();
      if (this.config.stopBeforeBuy) {
        log("STOP-BEFORE-BUY", "All fields filled. BUY NOW not clicked. No payment triggered.");
        try {
          await this.page.screenshot({ path: "pre-buy-screenshot.png", fullPage: true });
          log("Screenshot saved", "pre-buy-screenshot.png");
        } catch {}
        return;
      }
      await this.clickBuyNow();
      if (this.config.stopBeforePay) {
        log("STOP-BEFORE-PAY", "On pay.carry1st.com. Pay Now NOT clicked. No OTP sent.");
        try {
          await this.page.screenshot({ path: "pre-pay-screenshot.png", fullPage: true });
          log("Screenshot saved", "pre-pay-screenshot.png");
        } catch {}
        return;
      }
      await this.confirmPayment();
      if (this.config.stopAfterPay) {
        log("STOP-AFTER-PAY", "Pay Now clicked. Snapshotting OTP/PIN page(s)...");
        await this.snapshotAllPages("post-pay-screenshot");
        return;
      }
      if (this.config.walletPin) {
        await this.payWithWallet();
      } else {
        await this.waitForResult();
      }
    } catch (err: any) {
      log("ERROR", err.message);
      try {
        await this.page.screenshot({ path: "error-screenshot.png", fullPage: true });
        log("Screenshot saved", "error-screenshot.png");
      } catch {}
      throw err;
    } finally {
      if (!this.config.headless) {
        log("Keeping browser open for inspection. Press Ctrl+C to exit.");
        await sleep(600000);
      }
      await this.browser.close();
    }
  }
}
