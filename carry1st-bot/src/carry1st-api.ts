// Headless Carry1st order creation. Replaces the browser product-page + pack-selection
// flow (the slow, fragile part) with direct HTTP to Carry1st's own internal API
// (shop-proxy.carry1st.com). Returns the Pay1st redirectUrl — the payment step
// (Pay1st form + Paymob wallet OTP) still runs in the browser via the existing bot.
import { randomBytes } from "node:crypto";

const BASE = "https://shop-proxy.carry1st.com";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const IP = process.env.CARRY1ST_CLIENT_IP || "41.128.145.134";
const CHANNEL_ID = parseInt(process.env.CARRY1ST_CHANNEL_ID || "125", 10); // Paymob wallet channel

export interface CreateOrderArgs {
  productUrl: string; // https://shop.carry1st.com/en/EG/product/<slug>/direct-topup
  bundleLabel: string; // e.g. "39 Silver" — matches product_bundles[].name
  recipientIdentifier: string; // player/user id
  recipientExtraInfo?: Record<string, unknown>; // zone/server for games that need it
  customer: { firstName: string; lastName: string; email: string; msisdn: string };
}
export type CreateOrderResult =
  | { ok: true; redirectUrl: string; reference: string; amount: number; validatedName?: string; productBundleId: number }
  | { ok: false; stage: string; error: string };

interface Pack { id: number; name: string; price: number; }

/** Parse productId + the packs (label → bundleId + price) from the product page HTML. */
export function parseProduct(html: string): { productId: number; packs: Pack[] } | null {
  const pid = html.match(/\\?"productId\\?":(\d+)/);
  const productId = pid ? parseInt(pid[1], 10) : NaN;
  const packs: Pack[] = [];
  const re = /\\?"id\\?":(\d+),\\?"name\\?":\\?"([^"\\]+)\\?"(?:[^}]*?)\\?"price\\?":([\d.]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) packs.push({ id: Number(m[1]), name: m[2], price: Number(m[3]) });
  if (!productId || !packs.length) return null;
  return { productId, packs };
}

export async function createCarry1stOrder(args: CreateOrderArgs): Promise<CreateOrderResult> {
  const dev = "c1s-" + randomBytes(9).toString("base64url");
  const cookies: Record<string, string> = {
    c1st_deviceId: dev, c1st_country: "EG", c1st_locale: "en", c1st_ipAddress: IP,
  };
  const cookieHeader = () => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  const mergeSetCookie = (r: Response) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const c of (r.headers as any).getSetCookie?.() ?? []) {
      const kv = c.split(";")[0]; const i = kv.indexOf("=");
      if (i > 0) cookies[kv.slice(0, i).trim()] = kv.slice(i + 1);
    }
  };
  const H = (token?: string): Record<string, string> => ({
    origin: "https://shop.carry1st.com", referer: "https://shop.carry1st.com/", "user-agent": UA,
    "x-device-id": dev, "x-country-code": "EG", "x-platform": "SHOP",
    "x-client-time": new Date().toISOString(), cookie: cookieHeader(),
    ...(token ? { "x-csrf-token": token } : {}),
  });
  const jf = async (u: string, o: RequestInit, tries = 3): Promise<Response> => {
    let e: unknown;
    for (let i = 0; i < tries; i++) {
      try { return await fetch(u, { ...o, signal: AbortSignal.timeout(15000) }); }
      catch (err) { e = err; await new Promise((r) => setTimeout(r, 1500)); }
    }
    throw e;
  };

  try {
    // 1. Product page → productId + packs; resolve the pack by label.
    const html = await (await jf(args.productUrl, { headers: { "user-agent": UA } })).text();
    const prod = parseProduct(html);
    if (!prod) return { ok: false, stage: "parse", error: "could not parse productId/packs from page" };
    const pack = prod.packs.find((p) => p.name.trim() === args.bundleLabel.trim());
    if (!pack) return { ok: false, stage: "pack", error: `pack "${args.bundleLabel}" not found (have: ${prod.packs.map((p) => p.name).join(", ").slice(0, 220)})` };

    // 2. CSRF token (+ c1st_csrfSecret cookie).
    const r1 = await jf(`${BASE}/api/csrf-token`, { headers: H() });
    mergeSetCookie(r1);
    const token = ((await r1.json().catch(() => ({}))) as { token?: string }).token;
    if (!token) return { ok: false, stage: "csrf", error: `csrf ${r1.status}` };

    // 3. Validate the recipient (identifies the user server-side, keyed by x-device-id).
    const vurl = `${BASE}/api/shop/orders/user-validation?countryCode=EG&productBundleId=${pack.id}&productId=${prod.productId}&recipientIdentifier=${encodeURIComponent(args.recipientIdentifier)}&quantity=1&validationType=GAME`;
    const rv = await jf(vurl, { headers: H(token) });
    mergeSetCookie(rv);
    const vj = (await rv.json().catch(() => ({}))) as { customerInfo?: { userName?: string }; errorMessage?: string };
    if (rv.status !== 200) return { ok: false, stage: "validate", error: `validate ${rv.status}: ${vj.errorMessage || JSON.stringify(vj).slice(0, 120)}` };

    // 4. Create the order.
    const body = {
      countryCode: "EG", currencyCode: "EGP",
      firstName: args.customer.firstName, lastName: args.customer.lastName, email: args.customer.email,
      dialCode: "20", phone: args.customer.msisdn.replace(/^20/, ""), msisdn: args.customer.msisdn,
      partnerSource: "SHOP", platform: "WEB", channelId: CHANNEL_ID, payWithDiscountPoint: false,
      ipAddress: IP, userAgent: UA,
      items: [{
        recipientIdentifier: args.recipientIdentifier, quantity: 1, productBundleId: pack.id,
        recipientExtraInfo: JSON.stringify(args.recipientExtraInfo ?? {}), price: pack.price,
      }],
    };
    const r3 = await jf(`${BASE}/api/shop/orders/create`, {
      method: "POST",
      headers: { ...H(token), "content-type": "application/vnd.carry1st.order.order+json" },
      body: JSON.stringify(body),
    });
    const cj = (await r3.json().catch(() => ({}))) as { redirectUrl?: string; reference?: string; amount?: number; errorMessage?: string };
    if (r3.status !== 201 || !cj.redirectUrl) return { ok: false, stage: "create", error: `create ${r3.status}: ${cj.errorMessage || JSON.stringify(cj).slice(0, 120)}` };

    return {
      ok: true, redirectUrl: cj.redirectUrl, reference: cj.reference || "", amount: cj.amount ?? pack.price,
      validatedName: vj.customerInfo?.userName, productBundleId: pack.id,
    };
  } catch (err) {
    return { ok: false, stage: "exception", error: String(err).slice(0, 150) };
  }
}
