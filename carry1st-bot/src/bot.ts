import { chromium, type Browser, type Page, type Locator, type Response, type Frame } from "playwright";
import type { FullConfig } from "./types.js";
import { createCarry1stOrder } from "./carry1st-api.js";

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
  // Signed Paymob post_pay callback captured at the network level — an
  // authoritative "wallet debited / declined" signal. Carry1st's own redirect
  // lies (shows /payment/failure even on success), so we never trust that; but
  // the underlying accept.paymobsolutions.com/post_pay?success=... IS signed.
  private paymobSignal: { success: boolean; txnId: string } | null = null;
  private onPaymobResp: (res: Response) => void = () => {};
  private onPaymobNav: (frame: Frame) => void = () => {};

  private capturePaymobSignal(u: string): void {
    if (this.paymobSignal) return;
    const m = u.match(
      /accept\.paymobsolutions\.com\/api\/acceptance\/post_pay[^ "']*[?&]success=(true|false)/i
    );
    if (!m) return;
    const idm = u.match(/[?&]id=(\d+)/);
    this.paymobSignal = { success: m[1].toLowerCase() === "true", txnId: idm ? idm[1] : "paymob" };
    log("Paymob callback captured", `success=${m[1]} txn=${this.paymobSignal.txnId}`);
  }
  // Latest Carry1st player-validation API result (captured from the XHR the
  // page fires after the account ID is entered). Lets us fail fast with the
  // real reason instead of timing out on a permanently-disabled BUY NOW.
  private validation: { ok: boolean; status: number; errorCode?: string; errorMessage?: string } | null = null;

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

    // Browser-side guard: auto-dismiss Carry1st's country popup the instant
    // it renders. Without this, the Radix dialog overlay can appear mid-click
    // and block it ("subtree intercepts pointer events"). Inlined into a
    // single arrow so tsx doesn't wrap helpers with __name (which is undefined
    // in the browser context and would throw on eval).
    await context.addInitScript(() => {
      const obs = new MutationObserver(() => {
        const dlg = document.querySelector('[role="dialog"], .dialog-container');
        if (!dlg) return;
        // Search buttons across the whole document — the dismiss button
        // may be a sibling of the overlay, not a child of dialog-container.
        const all = Array.from(document.querySelectorAll("button"));
        for (const btn of all) {
          const txt = (btn.textContent || "").trim();
          if (txt === "Ignore" || txt === "تجاهل" || txt === "×" || txt === "✕") {
            (btn as HTMLElement).click();
            return;
          }
          const aria = btn.getAttribute("aria-label") || "";
          if (aria === "Close" || aria === "close") {
            (btn as HTMLElement).click();
            return;
          }
        }
      });
      const start = () => {
        try { obs.observe(document.body, { childList: true, subtree: true }); } catch {}
      };
      if (document.body) start();
      else document.addEventListener("DOMContentLoaded", start);
    });

    this.page = await context.newPage();

    // Capture Carry1st's player-validation API response. The page calls
    //   GET shop-proxy.carry1st.com/api/shop/orders/user-validation?...&recipientIdentifier=<id>
    // right after the account ID is entered. A non-2xx (or a body with
    // errorCode/errorMessage) means the ID/bundle can't be purchased as guest
    // (e.g. 0800 "Sign in to claim this promotion", or an invalid player ID) —
    // capture it so we can abort with the real reason.
    this.page.on("response", async (res) => {
      try {
        if (!/\/orders\/user-validation/i.test(res.url())) return;
        const status = res.status();
        let errorCode: string | undefined;
        let errorMessage: string | undefined;
        const text = await res.text().catch(() => "");
        if (text) {
          try {
            const j = JSON.parse(text);
            errorCode = j.errorCode;
            errorMessage = j.errorMessage;
          } catch {}
        }
        const ok = status >= 200 && status < 300 && !errorMessage;
        this.validation = { ok, status, errorCode, errorMessage };
        log(
          "Player-validation API",
          ok ? `ok (${status})` : `FAILED status=${status} code=${errorCode || "?"} msg="${errorMessage || ""}"`
        );
      } catch {}
    });

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
        await this.page.goto(landingUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
        await sleep(2000);
      } catch (err) {
        log("Locale-establishing nav failed (continuing)", String(err).slice(0, 100));
      }
    }

    log("Navigating", this.config.url);
    // "networkidle" never settles on Carry1st (continuous analytics/ads polling)
    // and the chromium renderer OOMs waiting for it on small-RAM VPS. Use
    // domcontentloaded + a fixed hydration wait instead.
    await this.page.goto(this.config.url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await this.page.waitForLoadState("load", { timeout: 15000 }).catch(() => {});
    await sleep(3000);
  }

  // Nuke any country-popup overlay still present in the DOM. Faster and more
  // reliable than clicking a dismiss button — works even if the dismiss
  // button is in a weird state. Clears Radix's body/html scroll locks too.
  private async forceRemoveOverlay() {
    await this.page
      .evaluate(() => {
        document
          .querySelectorAll('[role="dialog"], .dialog-container')
          .forEach((el) => el.remove());
        // Radix Dialog adds pointer-events/overflow styles + data-* attrs to
        // body and html to lock scroll. Clear all of them.
        for (const el of [document.body, document.documentElement]) {
          el.style.removeProperty("pointer-events");
          el.style.removeProperty("overflow");
          el.style.removeProperty("padding-right");
          el.removeAttribute("data-scroll-locked");
        }
      })
      .catch(() => {});
  }

  // Click an element by text via JS evaluate — bypasses Playwright's
  // actionability poll and any pointer-event-blocking overlay.
  private async clickByText(text: string): Promise<boolean> {
    return await this.page.evaluate((t: string) => {
      const all = Array.from(document.querySelectorAll("button, div, label, a, span"));
      const target = all.find((el) => (el.textContent || "").trim() === t);
      if (!target) return false;
      // Walk up to find a clickable ancestor (Carry1st cards have nested spans).
      let click: Element | null = target;
      for (let i = 0; i < 5 && click; i++) {
        if (click instanceof HTMLElement) {
          click.click();
          return true;
        }
        click = click.parentElement;
      }
      return false;
    }, text);
  }

  // Click an element where ANY descendant has this text (substring match).
  private async clickByPartialText(text: string): Promise<boolean> {
    return await this.page.evaluate((t: string) => {
      const all = Array.from(document.querySelectorAll("button, div, label, a"));
      const target = all.find((el) => {
        const txt = (el.textContent || "").trim();
        return txt.includes(t) && txt.length < 200;
      });
      if (!target) return false;
      (target as HTMLElement).click();
      return true;
    }, text);
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
    // Wait up to 8s for the country popup to render, then dismiss. Carry1st's
    // dialog typically appears ~1s after page load, but the MutationObserver
    // from launch() handles whatever appears. This is a belt-and-suspenders
    // fallback in case the observer's first sweep happens before the dialog
    // mounts (race condition).
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const overlay = await this.page
        .locator('[role="dialog"]:visible, .dialog-container')
        .first()
        .isVisible({ timeout: 300 })
        .catch(() => false);
      if (overlay) {
        await this.ensureNoOverlay("initial");
        // Wait a moment for the dialog teardown animation to finish so the
        // overlay actually unmounts before the next click.
        await sleep(1000);
        return;
      }
      await sleep(500);
    }
    log("No popup appeared within 8s");
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

  // Carry1st groups a product's bundles under category "tabs" — small rounded
  // pills (e.g. "Blood Strike Gold" default + "Blood Strike Pass"). The target
  // bundle can live under a non-default tab that the initial view doesn't show.
  // Click each tab pill and re-check for the bundle (also expanding any "Show
  // more products" under the newly active tab). Returns true once the bundle is
  // visible. Only invoked when the bundle is missing from the default view, so
  // the normal Gold-on-default flow is unaffected.
  private async clickCategoryTabsUntilBundle(
    bundleBtn: Locator
  ): Promise<boolean> {
    // NOTE: keep this evaluate free of NAMED inner functions. tsx/esbuild
    // (keepNames) rewrites `const foo = () => {}` to reference a `__name`
    // helper that doesn't exist in the browser context, throwing
    // "ReferenceError: __name is not defined". Inline the pill test instead.
    const tabTexts: string[] = await this.page.evaluate(() => {
      const els = Array.from(
        document.querySelectorAll("div, button, [role='tab']")
      );
      const seen = new Set<string>();
      const out: string[] = [];
      for (const e of els) {
        const c = (e as HTMLElement).className;
        if (typeof c !== "string") continue;
        // Category tab pills: small rounded single-line h-8 toggles.
        if (
          !/whitespace-nowrap/.test(c) ||
          !/rounded-\[?8/.test(c) ||
          !/\bh-8\b/.test(c)
        )
          continue;
        const t = (e.textContent || "").replace(/\s+/g, " ").trim();
        if (t.length < 2 || t.length > 40) continue;
        // Skip bundle pills (e.g. "50 + 1 Golds") so we never misclick a bundle.
        if (/^\d/.test(t) || t.includes("+")) continue;
        if (seen.has(t)) continue;
        seen.add(t);
        out.push(t);
      }
      return out;
    });
    log("Category tabs found", JSON.stringify(tabTexts));
    for (const t of tabTexts) {
      try {
        const tab = this.page.getByText(t, { exact: true }).first();
        await tab.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
        await tab.click({ timeout: 4000 });
        log("Clicked category tab", t);
        await sleep(1500);
        if (
          await bundleBtn
            .first()
            .isVisible({ timeout: 4000 })
            .catch(() => false)
        ) {
          return true;
        }
        // Bundle may be behind a "Show more products" expander on this tab.
        const showMore = this.page
          .locator('button, div[role="button"]')
          .filter({ hasText: "Show more products" });
        if (
          await showMore
            .first()
            .isVisible({ timeout: 1500 })
            .catch(() => false)
        ) {
          log("Expanding 'Show more products' under tab", t);
          await showMore
            .first()
            .click()
            .catch(() => {});
          await sleep(1500);
          if (
            await bundleBtn
              .first()
              .isVisible({ timeout: 4000 })
              .catch(() => false)
          ) {
            return true;
          }
        }
      } catch (e) {
        log("Category tab click failed", `${t}: ${String(e)}`);
      }
    }
    return false;
  }

  async selectBundle() {
    await this.ensureNoOverlay("before bundle");
    // Belt + suspenders: also force-remove any stale overlay nodes.
    await this.forceRemoveOverlay();
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
      await bundleBtn.first().waitFor({ state: "visible", timeout: 20000 });
    } catch (err) {
      // Bundle isn't on the current view. Carry1st groups bundles under
      // category "tabs" (e.g. "Blood Strike Gold" default + "Blood Strike
      // Pass"); the target may live under a non-default tab. Click through the
      // tabs and re-check before giving up.
      const foundUnderTab = await this.clickCategoryTabsUntilBundle(bundleBtn);
      if (foundUnderTab) {
        log("Bundle reached via category tab");
      } else {
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
    }
    // Try normal click first; if blocked by an overlay that snuck in, fall
    // back to a JS click that bypasses pointer-event interception.
    try {
      await bundleBtn.first().click({ timeout: 5000 });
    } catch (err) {
      log("Normal bundle click failed — trying JS click + overlay force-remove");
      await this.forceRemoveOverlay();
      const ok = await this.clickByPartialText(this.config.bundleLabel);
      if (!ok) throw err;
    }
    await sleep(1500);
  }

  async selectPaymentMethod() {
    await this.ensureNoOverlay("before payment");
    log("Selecting payment", this.config.paymentMethod);

    // Wait for the "Select Payment Method" header to render — section is
    // lazy-loaded after bundle selection on some products.
    try {
      const header = this.page.locator("text=/Select Payment Method/i").first();
      await header.waitFor({ state: "visible", timeout: 20000 });
      // Scroll the header into view so the payment cards below it render
      // (some products lazily mount the cards based on viewport visibility).
      await header.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
      await sleep(1500);
    } catch {
      // Header not found — page might be Arabic ("اختر طريقة الدفع") or
      // payment selection might not exist on this product.
    }

    // Carry1st renders payment options as bare <div> cards (not buttons),
    // so the original button-only selector missed them. Try multiple
    // strategies in order of specificity.
    const strategies = [
      () => this.page.getByRole("button", { name: this.config.paymentMethod, exact: true }),
      () => this.page.getByText(this.config.paymentMethod, { exact: true }),
      () => this.page.locator(`button, [role="button"], div, label, a`).filter({ hasText: this.config.paymentMethod }),
    ];

    let target = null;
    for (const strat of strategies) {
      const loc = strat().first();
      if (await loc.isVisible({ timeout: 4000 }).catch(() => false)) {
        target = loc;
        break;
      }
    }

    if (!target) {
      log(
        "Payment selector not found on product page",
        `("${this.config.paymentMethod}" not visible) — skipping; Pay1st may handle it`
      );
      return;
    }

    try {
      await target.click({ timeout: 3000 });
    } catch {
      log("Normal payment click failed — JS click fallback");
      await this.forceRemoveOverlay();
      const ok = await this.clickByText(this.config.paymentMethod);
      if (!ok) await target.click({ force: true, timeout: 3000 });
    }
    await sleep(1500);
  }

  async fillContactDetails() {
    log("Filling contact details");
    const { firstName, surname, email, phone } = this.config;
    // Field set varies per product. Some checkouts (e.g. Yalla Ludo) only ask
    // for an email; first name / surname / phone are absent. Treat those as
    // best-effort and only hard-require Email.
    await this.fillField("First name", firstName, { optional: true });
    await this.fillField("Surname", surname, { optional: true });
    await this.fillField("Email", email);
    await this.fillField("Phone number", phone, { optional: true });
    await sleep(1000);
  }

  private async fillField(
    label: string,
    value: string,
    opts: { optional?: boolean } = {}
  ) {
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
    if (opts.optional) {
      log(`  Skipping optional "${label}" — not present on this checkout`);
      return;
    }
    log(`  Could not find "${label}". Visible inputs:`, attrs.join(" | "));
    throw new Error(`Could not find input field: ${label}`);
  }

  async clickBuyNow() {
    await this.ensureNoOverlay("before BUY NOW");

    // Fail fast if Carry1st's player-validation API rejected the ID/bundle —
    // otherwise BUY NOW stays disabled forever and we'd burn 30s timing out.
    if (this.validation && !this.validation.ok) {
      const code = this.validation.errorCode || "unknown";
      const msg = this.validation.errorMessage || `http ${this.validation.status}`;
      throw new Error(`Carry1st validation rejected: [${code}] ${msg}`);
    }

    log("Clicking BUY NOW");
    this.purchaseStartedAt = Date.now();
    const buyBtn = this.page.locator('button:has-text("BUY NOW")');
    await buyBtn.first().waitFor({ state: "visible", timeout: 25000 });

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

    // The Pay1st "Confirm and pay" page has its OWN billing form (First Name /
    // Surname / Email / Phone — "the name, mobile number and email you use for
    // this payment account"). For most products these carry over from the
    // shop-side contact form, but some checkouts (e.g. Yalla Ludo) collect only
    // an email upstream, leaving these blank here. An empty form fails
    // validation and "Pay Now" silently does nothing. Fill any empty field.
    const { firstName, surname, email, phone } = this.config;
    await this.fillField("First Name", firstName, { optional: true });
    await this.fillField("Surname", surname, { optional: true });
    await this.fillField("Email", email, { optional: true });
    await this.fillField("Phone number", phone, { optional: true });
    await sleep(800);

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

    const clickedAt = Date.now();

    // Capture the SIGNED Paymob post_pay callback at the network level BEFORE the
    // page can redirect to Carry1st's (unreliable) result page.
    this.onPaymobResp = (res: Response) => {
      try { this.capturePaymobSignal(res.url()); } catch {}
    };
    this.onPaymobNav = (frame: Frame) => {
      try { if (frame === paymobPage.mainFrame()) this.capturePaymobSignal(frame.url()); } catch {}
    };
    paymobPage.on("response", this.onPaymobResp);
    paymobPage.on("framenavigated", this.onPaymobNav);

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

    // Two AUTHORITATIVE confirmations, whichever lands first: the signed Paymob
    // post_pay callback (captured above) or the Vodafone debit SMS. Deliver on
    // either success; fail fast on a signed Paymob decline; fail (manual) if
    // neither confirms. Carry1st's own /success|/failure redirect is NOT trusted.
    let paymentSms: { amount: number; merchant: string; txnId: string } | null = null;
    const deadline = clickedAt + this.config.paymentSmsTimeoutMs;
    while (Date.now() < deadline) {
      if (this.paymobSignal) break;
      paymentSms = await this.waitForPaymentSms(clickedAt, 3000);
      if (paymentSms) break;
    }
    try { await paymobPage.screenshot({ path: "paymob-after-pay.png", fullPage: true }); } catch {}
    paymobPage.off("response", this.onPaymobResp);
    paymobPage.off("framenavigated", this.onPaymobNav);

    if (paymentSms) {
      log("✅ Vodafone SMS confirmed payment",
        `txn=${paymentSms.txnId} amount=${paymentSms.amount} merchant=${paymentSms.merchant}`);
      console.log(`PAYMENT_CONFIRMED txn=${paymentSms.txnId} amount=${paymentSms.amount} merchant=${paymentSms.merchant}`);
      if (this.paymobSignal && !this.paymobSignal.success) {
        log("⚠️ NOTE", `Vodafone debited but Paymob callback reported success=false (txn=${this.paymobSignal.txnId})`);
      }
      return;
    }
    if (this.paymobSignal) {
      if (this.paymobSignal.success) {
        log("✅ Signed Paymob callback confirmed payment", `txn=${this.paymobSignal.txnId}`);
        console.log(`PAYMENT_CONFIRMED txn=${this.paymobSignal.txnId} amount=${Number.isFinite(this.expectedAmount) ? this.expectedAmount : 0} merchant=Paymob`);
        return;
      }
      throw new Error(`Paymob declined the payment (success=false, txn=${this.paymobSignal.txnId})`);
    }
    throw new Error(`No Vodafone SMS and no signed Paymob callback within ${this.config.paymentSmsTimeoutMs}ms — payment unconfirmed, needs verification`);
  }

  private async waitForPaymentSms(
    sinceMs: number,
    overrideTimeoutMs?: number
  ): Promise<{ amount: number; merchant: string; txnId: string } | null> {
    if (!this.config.otpReceiverUrl || !this.config.otpReceiverToken) return null;
    const timeoutMs = overrideTimeoutMs ?? this.config.paymentSmsTimeoutMs;
    const amountParam = Number.isFinite(this.expectedAmount)
      ? `&amount=${this.expectedAmount}`
      : "";
    const merchantParam = `&merchant=${encodeURIComponent(this.config.merchantName)}`;
    const url = `${this.config.otpReceiverUrl}/payment/wait?since=${sinceMs}&timeout=${timeoutMs}${amountParam}${merchantParam}`;
    try {
      const res = await fetch(url, {
        headers: { "X-Token": this.config.otpReceiverToken },
        signal: AbortSignal.timeout(timeoutMs + 5000),
      });
      if (!res.ok) {
        if (res.status === 404) {
          log("Payment SMS endpoint not deployed yet", "(receiver returned 404) — skipping SMS check");
          return null;
        }
        if (res.status === 408) {
          if (!overrideTimeoutMs) log("Payment SMS timeout", "no matching SMS received");
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
    // Poll in SHORT chunks (25s each) up to the full timeout. The receiver is
    // behind a Cloudflare tunnel that 524s any single request held longer than
    // ~100s — so a slow OTP SMS (e.g. 150s) was never seen by one long poll.
    // `since` stays pinned to purchaseStartedAt so a later chunk still matches
    // an OTP that arrived during an earlier (timed-out) chunk.
    const CHUNK_MS = 25_000;
    const deadline = Date.now() + this.config.otpTimeoutMs;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const chunk = Math.min(CHUNK_MS, remaining);
      const url = `${this.config.otpReceiverUrl}/otp/wait?since=${this.purchaseStartedAt}&timeout=${chunk}${amountParam}`;
      try {
        const res = await fetch(url, {
          headers: { "X-Token": this.config.otpReceiverToken },
          signal: AbortSignal.timeout(chunk + 8000),
        });
        if (res.ok) {
          const body = (await res.json()) as { otp?: string };
          if (body.otp) return body.otp;
        } else if (res.status !== 408 && res.status !== 524 && res.status !== 504) {
          // 408 = receiver's own "no OTP yet"; 524/504 = Cloudflare cut-off —
          // both are expected between chunks. Anything else is a real error.
          log("OTP receiver returned", String(res.status));
        }
      } catch (err) {
        log("OTP poll chunk error (continuing)", String(err).slice(0, 60));
      }
    }
    log("OTP not received within timeout", `${Math.round(this.config.otpTimeoutMs / 1000)}s`);
    return null;
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

  private toMsisdn(phone: string): string {
    let p = (phone || "").replace(/\D/g, "");
    if (p.startsWith("20")) return p;
    if (p.startsWith("0")) return "20" + p.slice(1);
    if (p.startsWith("1")) return "20" + p;
    return p;
  }

  /** Create the Carry1st order via the headless API (no browser). */
  async createOrderViaApi() {
    const entries = Object.entries(this.config.fields);
    const recip = entries.find(([k]) => /user\s*id|player\s*id|\bid\b/i.test(k)) || entries[0];
    const recipientIdentifier = recip ? recip[1] : "";
    const extra = Object.fromEntries(entries.filter(([k]) => k !== (recip ? recip[0] : "")));
    return createCarry1stOrder({
      productUrl: this.config.url,
      bundleLabel: this.config.bundleLabel,
      recipientIdentifier,
      recipientExtraInfo: Object.keys(extra).length ? extra : undefined,
      customer: {
        firstName: this.config.firstName,
        lastName: this.config.surname,
        email: this.config.email,
        msisdn: this.toMsisdn(this.config.phone),
      },
    });
  }

  async run() {
    await this.launch();
    try {
      // API-FIRST: create the Carry1st order headlessly (replaces the slow, fragile
      // product-page + pack-selection browser flow — the exact step that timed out
      // and failed orders), then jump the browser straight to the Pay1st payment URL.
      // Falls back to the full browser flow on any error, so an order can never fail
      // during the migration. Disable with CARRY1ST_USE_API=false.
      let onPaymentPage = false;
      if (process.env.CARRY1ST_USE_API !== "false") {
        try {
          const api = await this.createOrderViaApi();
          if (api.ok) {
            log("✅ API order created", `ref=${api.reference} amount=${api.amount} user=${api.validatedName || "?"}`);
            await this.page.goto(api.redirectUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
            onPaymentPage = true;
          } else {
            log("⚠️ API path failed → browser fallback", `${api.stage}: ${api.error}`);
          }
        } catch (e) {
          log("⚠️ API path threw → browser fallback", String(e).slice(0, 120));
        }
      }

      if (!onPaymentPage) {
        await this.navigateToProduct();
        await this.dismissPopups();
        await this.fillProductFields();
        await sleep(5000);
        await this.selectBundle();
        await this.fillContactDetails();
        await this.selectPaymentMethod();
        if (this.config.stopBeforeBuy) {
          log("STOP-BEFORE-BUY", "All fields filled. BUY NOW not clicked. No payment triggered.");
          try {
            await this.page.screenshot({ path: "pre-buy-screenshot.png", fullPage: true });
            log("Screenshot saved", "pre-buy-screenshot.png");
          } catch {}
          return;
        }
        await this.clickBuyNow();
      }
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
