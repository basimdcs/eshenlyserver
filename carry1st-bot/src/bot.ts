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

  constructor(config: FullConfig) {
    this.config = config;
  }

  async launch() {
    log("Launching browser", this.config.headless ? "headless" : "headed");
    this.browser = await chromium.launch({
      headless: this.config.headless,
      proxy: this.config.proxy ? { server: this.config.proxy } : undefined,
    });
    const context = await this.browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    });
    this.page = await context.newPage();
    if (this.config.proxy) log("Using proxy", this.config.proxy);
  }

  async navigateToProduct() {
    const url = `https://shop.carry1st.com/en/${this.config.countryCode}/product/pubg-mobile-uc-top-up-gm/direct-topup`;
    log("Navigating", url);
    await this.page.goto(url, { waitUntil: "networkidle" });
    await sleep(2000);
  }

  async dismissPopups() {
    log("Dismissing popups");
    // Country detection dialog — click the X/close button
    try {
      const closeBtn = this.page.locator(
        'button:has-text("Continue"), [aria-label="Close"], button:has-text("×"), dialog button'
      );
      const visible = await closeBtn.first().isVisible({ timeout: 3000 });
      if (visible) {
        await closeBtn.first().click();
        log("Dismissed popup");
        await sleep(1000);
      }
    } catch {
      log("No popup found, continuing");
    }
  }

  async enterPlayerId() {
    log("Entering Player ID", this.config.playerId);
    const input = this.page.locator(
      'input[placeholder*="Player ID"], input[name="Player ID"], input[placeholder*="player"]'
    );
    await input.first().waitFor({ state: "visible", timeout: 10000 });
    await input.first().fill(this.config.playerId);
    await sleep(1500);
  }

  async selectBundle() {
    log("Selecting bundle", this.config.bundleLabel);
    const bundleBtn = this.page
      .locator("button, div[role='button'], label")
      .filter({ hasText: this.config.bundleLabel });
    await bundleBtn.first().waitFor({ state: "visible", timeout: 10000 });
    await bundleBtn.first().click();
    await sleep(1500);
  }

  async selectPaymentMethod() {
    log("Selecting payment", this.config.paymentMethod);
    const payBtn = this.page
      .locator("button, div[role='button'], label")
      .filter({ hasText: this.config.paymentMethod });
    await payBtn.first().waitFor({ state: "visible", timeout: 10000 });
    await payBtn.first().click();
    await sleep(1500);
  }

  async fillContactDetails() {
    log("Filling contact details");
    const { firstName, surname, email, phone } = this.config;

    if (!firstName || !surname || !email || !phone) {
      throw new Error(
        "Contact details (FIRST_NAME, SURNAME, EMAIL, PHONE) are all required in .env"
      );
    }

    // Fill each field
    await this.fillField("First name", firstName);
    await this.fillField("Surname", surname);
    await this.fillField("Email", email);
    await this.fillField("Phone number", phone);

    await sleep(1000);
  }

  private async fillField(label: string, value: string) {
    // Try multiple strategies to find the field
    const strategies = [
      () => this.page.getByLabel(label),
      () => this.page.getByPlaceholder(label),
      () => this.page.locator(`input[name="${label}"]`),
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
    // Debug: dump all visible inputs
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
    log("Clicking BUY NOW");
    const buyBtn = this.page.locator('button:has-text("BUY NOW")');
    await buyBtn.first().waitFor({ state: "visible", timeout: 10000 });
    await buyBtn.first().click();

    log("Waiting for redirect to pay.carry1st.com");
    await this.page.waitForURL("**/pay.carry1st.com/**", { timeout: 30000 });
    log("Redirected to payment page", this.page.url());
    await sleep(2000);
  }

  async confirmPayment() {
    log("Confirming payment on Pay1st page");
    await sleep(5000);

    // Playwright reports the Pay Now button as "not visible" due to CSS framework quirks.
    // Use JS click directly to bypass visibility checks.
    await this.page.evaluate(() => {
      const btn = document.querySelector('button[aria-label="Pay Now"]') as HTMLButtonElement;
      if (btn) {
        btn.click();
      } else {
        // Fallback: find by text
        const buttons = Array.from(document.querySelectorAll("button"));
        const payBtn = buttons.find((b) => b.textContent?.trim() === "Pay Now");
        if (payBtn) payBtn.click();
        else throw new Error("Pay Now button not found in DOM");
      }
    });
    log("Clicked Pay Now");
  }

  async waitForResult() {
    log(
      "Waiting for payment result",
      "Check your phone for OTP (5 min timeout)"
    );
    try {
      // After Pay Now, the page may navigate or a new tab may open
      // Check for new pages (popups/tabs)
      const context = this.page.context();
      const pages = context.pages();
      const activePage = pages[pages.length - 1]; // Use the latest page/tab

      // Listen for new pages that may open
      context.on("page", (newPage) => {
        log("New tab opened", newPage.url());
        this.page = newPage;
      });

      // Wait for navigation or URL change indicating result
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
      await this.enterPlayerId();
      await this.selectBundle();
      await this.selectPaymentMethod();
      await this.fillContactDetails();
      await this.clickBuyNow();
      await this.confirmPayment();
      await this.waitForResult();
    } catch (err: any) {
      log("ERROR", err.message);
      // Take a screenshot for debugging
      try {
        await this.page.screenshot({ path: "error-screenshot.png" });
        log("Screenshot saved", "error-screenshot.png");
      } catch {}
      throw err;
    } finally {
      if (!this.config.headless) {
        log("Keeping browser open for inspection. Press Ctrl+C to exit.");
        await sleep(600000); // 10 min
      }
      await this.browser.close();
    }
  }
}
