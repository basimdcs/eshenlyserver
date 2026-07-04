import "dotenv/config";
import type { FullConfig } from "./types.js";

function printUsage() {
  console.log(`Usage: npx tsx src/index.ts --url <productUrl> --bundle <bundleLabel> [--payment <method>] [--fields <jsonObject>]

Required flags:
  --url        Full Carry1st product URL
               e.g. https://shop.carry1st.com/en/EG/product/pubg-mobile-uc-top-up-gm/direct-topup
  --bundle     Bundle label to click (substring match)
               e.g. "600 + 60 UC"

Optional flags:
  --payment          Payment method label (default: "Vodafone Cash")
  --fields           JSON object of in-form fields to fill, keyed by label/placeholder
                     e.g. '{"Player ID":"5292716602"}'
                     Use '{}' or omit for products with no game ID (gift cards).
  --stop-before-buy  Stop after filling everything but BEFORE clicking BUY NOW.
                     Safe rehearsal — no payment is triggered.
  --stop-before-pay  Click BUY NOW and reach pay.carry1st.com, but stop BEFORE
                     clicking Pay Now. Verifies redirect + Vodafone payment
                     page renders. No wallet OTP is sent.
  --stop-after-pay   Click Pay Now and screenshot the next page (Vodafone PIN/OTP
                     form). The bot does NOT enter the PIN or OTP — that's still
                     manual. Triggers OTP SMS to the wallet phone.

Required env (.env):
  CARRY1ST_FIRST_NAME, CARRY1ST_SURNAME, CARRY1ST_EMAIL, CARRY1ST_PHONE

Optional env (.env) — for full automation (PIN + OTP entry):
  WALLET_PIN              Vodafone Cash wallet PIN. If unset, bot stops at OTP page.
  OTP_RECEIVER_URL        Base URL of SMS→HTTP OTP forwarder (e.g. https://...)
  OTP_RECEIVER_TOKEN      Bearer token for OTP receiver auth
  OTP_TIMEOUT_MS          How long to wait for the OTP SMS (default: 180000)
  MERCHANT_NAME           Merchant name in Vodafone payment SMS (default: Carry1st)
  PAYMENT_SMS_TIMEOUT_MS  How long to wait for the payment SMS after click (default: 45000)

Optional env (.env):
  HEADLESS     true/false (default: true)
  PROXY        Proxy URL (e.g. http://user:pass@host:port)

Example:
  npx tsx src/index.ts \\
    --url "https://shop.carry1st.com/en/EG/product/pubg-mobile-uc-top-up-gm/direct-topup" \\
    --bundle "600 + 60 UC" \\
    --fields '{"Player ID":"5292716602"}'`);
}

function parseFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = "true";
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v.trim();
}

export function loadConfig(): FullConfig {
  const flags = parseFlags(process.argv.slice(2));

  const url = flags.url;
  const bundleLabel = flags.bundle;
  if (!url || !bundleLabel) {
    printUsage();
    process.exit(1);
  }
  if (!/^https:\/\/shop\.carry1st\.com\//.test(url)) {
    console.error(`Refusing to navigate: --url must be on shop.carry1st.com`);
    process.exit(1);
  }

  let fields: Record<string, string> = {};
  if (flags.fields) {
    try {
      const parsed = JSON.parse(flags.fields);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        fields = parsed as Record<string, string>;
      } else {
        throw new Error("not a plain object");
      }
    } catch (err) {
      console.error(`Invalid --fields JSON: ${(err as Error).message}`);
      process.exit(1);
    }
  }

  let validationData: Record<string, string> | undefined;
  if (flags["validation-data"]) {
    try {
      const parsed = JSON.parse(flags["validation-data"]);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        validationData = parsed as Record<string, string>;
      }
    } catch {
      /* ignore — API path falls back to the fields-derived extraInfo */
    }
  }

  return {
    url,
    bundleLabel,
    paymentMethod: flags.payment || "Vodafone Cash",
    fields,
    validationData,
    firstName: requireEnv("CARRY1ST_FIRST_NAME"),
    surname: requireEnv("CARRY1ST_SURNAME"),
    email: requireEnv("CARRY1ST_EMAIL"),
    phone: requireEnv("CARRY1ST_PHONE"),
    headless: process.env.HEADLESS !== "false",
    proxy: process.env.PROXY || undefined,
    stopBeforeBuy: flags["stop-before-buy"] === "true",
    stopBeforePay: flags["stop-before-pay"] === "true",
    stopAfterPay: flags["stop-after-pay"] === "true",
    walletPin: process.env.WALLET_PIN?.trim() || undefined,
    otpReceiverUrl: process.env.OTP_RECEIVER_URL?.trim() || undefined,
    otpReceiverToken: process.env.OTP_RECEIVER_TOKEN?.trim() || undefined,
    otpTimeoutMs: parseInt(process.env.OTP_TIMEOUT_MS || "180000", 10),
    merchantName: process.env.MERCHANT_NAME?.trim() || "Carry1st",
    paymentSmsTimeoutMs: parseInt(process.env.PAYMENT_SMS_TIMEOUT_MS || "45000", 10),
  };
}
