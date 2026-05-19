# Vercel Integration Guide

How to wire `eshenly.com` (Next.js on Vercel) to trigger the Midasbuy bot
after a customer pays, and how to receive the result.

## Architecture

```
[Customer pays] → [your payment provider] → [Vercel webhook]
                                                 │
                                                 ▼
                                  POST signed trigger to bot
                                                 │
                                                 ▼
                               https://bot-442aa810f595.eshenly.com/trigger
                                                 │
                                                 ▼
                                  Bot runs (~60–90s) → callback
                                                 │
                                                 ▼
                                  POST to /api/topup-callback on eshenly.com
                                                 │
                                                 ▼
                                  Update order → email customer / refund on fail
```

## Vercel environment variables to add

In `vercel.com → eshenly project → Settings → Environment Variables`,
add (all environments):

| Key | Value |
|---|---|
| `BOT_TRIGGER_URL` | `https://bot-442aa810f595.eshenly.com/trigger` |
| `BOT_TRIGGER_SECRET` | `79a53dd0f74613bd821df4cdffb62246d9a7099cc0514fbff760f09af764858e` |
| `BOT_CALLBACK_SECRET` | `995c19ec655190e0333d711e803c7e4822bb5868e14b5bfa0b9d385cf3bd35e5` |

## 1. Trigger the bot after payment confirmation

Wherever your existing payment-confirmation handler lives (after you've
verified the payment with your provider), call this helper:

```ts
// app/lib/bot-trigger.ts (or wherever)
import crypto from "node:crypto";

interface TriggerArgs {
  orderId: string;            // your order ID — used as idempotency key
  playerId: string;           // 8-12 digit PUBG ID provided by customer
  sku: 60 | 300 | 600 | 1500 | 3000 | 6000;
  customerEmail?: string;
}

export async function triggerBot(args: TriggerArgs): Promise<
  | { ok: true; jobId: string; replay: boolean }
  | { ok: false; error: string }
> {
  const triggerUrl = process.env.BOT_TRIGGER_URL!;
  const secret = process.env.BOT_TRIGGER_SECRET!;
  const callbackUrl = `${process.env.NEXT_PUBLIC_SITE_URL || "https://eshenly.com"}/api/topup-callback`;

  const ts = Date.now();
  const body = JSON.stringify({
    player_id: args.playerId,
    sku: args.sku,
    callback_url: callbackUrl,
    customer_email: args.customerEmail,
  });
  const signature = crypto
    .createHmac("sha256", secret)
    .update(`${ts}.${args.orderId}.${body}`)
    .digest("hex");

  const res = await fetch(triggerUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-timestamp": String(ts),
      "x-idempotency-key": args.orderId,
      "x-signature": signature,
    },
    body,
  });

  const json = (await res.json()) as { ok: boolean; job_id?: string; replay?: boolean; error?: string };

  if (res.status === 202 || res.status === 200) {
    return { ok: true, jobId: json.job_id!, replay: !!json.replay };
  }
  return { ok: false, error: json.error || `http ${res.status}` };
}
```

Then in your payment webhook (or after redirect, depending on your provider):

```ts
// app/api/webhooks/paymob/route.ts (example for Paymob)
import { NextRequest, NextResponse } from "next/server";
import { triggerBot } from "@/lib/bot-trigger";

export async function POST(req: NextRequest) {
  const body = await req.text();
  // STEP 1: Verify the payment provider's signature on the webhook.
  // Use Paymob's HMAC scheme here. NEVER trust the payload otherwise.
  // const valid = verifyPaymobSignature(body, req.headers.get("hmac"));
  // if (!valid) return NextResponse.json({ ok: false }, { status: 401 });

  const event = JSON.parse(body);
  if (event.type !== "TRANSACTION.SUCCEEDED") return NextResponse.json({ ok: true });

  // STEP 2: Look up your order from the payment ref → get playerId + sku
  const order = await db.order.findUnique({ where: { paymentRef: event.transaction.id } });
  if (!order) return NextResponse.json({ ok: false, reason: "order_not_found" }, { status: 404 });

  // STEP 3: Trigger the bot. Idempotency key = your order ID.
  const result = await triggerBot({
    orderId: order.id,
    playerId: order.playerId,
    sku: order.sku as 60 | 300 | 600 | 1500 | 3000 | 6000,
    customerEmail: order.customerEmail,
  });

  if (!result.ok) {
    // Bot rejected the request — investigate. Don't expose details to customer.
    console.error("trigger failed", result.error);
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  await db.order.update({
    where: { id: order.id },
    data: { status: "bot_triggered", botJobId: result.jobId },
  });

  return NextResponse.json({ ok: true });
}
```

## 2. Receive the bot's callback

```ts
// app/api/topup-callback/route.ts
import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";

const SECRET = process.env.BOT_CALLBACK_SECRET!;
const MAX_AGE_MS = 5 * 60 * 1000; // reject callbacks older than 5 min

export async function POST(req: NextRequest) {
  // Read raw body — signature is computed over the exact bytes
  const raw = await req.text();

  const ts = req.headers.get("x-timestamp");
  const sig = req.headers.get("x-signature");
  if (!ts || !sig) {
    return NextResponse.json({ ok: false, error: "missing_headers" }, { status: 400 });
  }

  const tsNum = parseInt(ts, 10);
  if (!Number.isFinite(tsNum) || Math.abs(Date.now() - tsNum) > MAX_AGE_MS) {
    return NextResponse.json({ ok: false, error: "timestamp_invalid" }, { status: 401 });
  }

  const expected = crypto.createHmac("sha256", SECRET).update(`${ts}.${raw}`).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(sig, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return NextResponse.json({ ok: false, error: "signature_invalid" }, { status: 401 });
  }

  const payload = JSON.parse(raw) as {
    order_id: string;
    job_id: string;
    status: "success" | "failed";
    amount_charged: number | null;
    trade_token: string | null;
    duration_ms: number;
    error: string | null;
  };

  // Idempotent update
  await db.order.update({
    where: { id: payload.order_id },
    data: {
      status: payload.status === "success" ? "delivered" : "failed",
      tradeToken: payload.trade_token,
      amountCharged: payload.amount_charged,
      botError: payload.error,
      deliveredAt: payload.status === "success" ? new Date() : null,
    },
  });

  if (payload.status === "success") {
    // Email customer the success notification
    // await sendDeliveryEmail(payload.order_id);
  } else {
    // Trigger refund flow
    // await refundOrder(payload.order_id, payload.error || "delivery_failed");
  }

  return NextResponse.json({ ok: true });
}
```

## 3. Optional: poll job status (UI live progress)

If your checkout flow shows a "Delivering UC…" page, you can poll the bot
job status to show live progress:

```ts
// app/api/topup-status/[orderId]/route.ts
import { NextResponse } from "next/server";

export async function GET(_: Request, { params }: { params: { orderId: string } }) {
  const order = await db.order.findUnique({ where: { id: params.orderId } });
  if (!order?.botJobId) return NextResponse.json({ status: "pending" });

  const res = await fetch(`https://bot-442aa810f595.eshenly.com/jobs/${order.botJobId}`);
  const job = await res.json();
  return NextResponse.json({
    status: order.status,           // your order status (DB)
    botStatus: job.status,          // bot status (queued/running/success/failed)
    amountCharged: job.amount_charged,
  });
}
```

This endpoint is unauthenticated by design — it only returns non-sensitive job state, gated by knowing the job UUID.

## Security checklist

- [ ] `BOT_TRIGGER_SECRET` and `BOT_CALLBACK_SECRET` stored only in Vercel env vars (not git, not client bundles)
- [ ] Different secrets for trigger vs callback (compromise of one doesn't expose the other)
- [ ] Payment-provider webhook signature verified BEFORE triggering bot
- [ ] Customer's player_id validated server-side (8-12 digits, no XSS)
- [ ] SKU restricted to allowlist on both sides
- [ ] `order_id` is the bot's idempotency key — never reuse it across orders
- [ ] Callback handler uses `timingSafeEqual` for signature comparison
- [ ] Callback timestamp window enforced (5 min)
- [ ] DB writes in callback are idempotent (safe to receive twice)

## Failure modes the system handles

| Failure | What happens |
|---|---|
| Vercel webhook retries (same order) | Idempotency: bot returns existing job_id, no double charge |
| Bot crashes mid-flight | Cgroup kills bot under 1500MB; worker reports failed; callback fires |
| OTP doesn't arrive in 3 min | Bot times out, Paymob session abandoned (no charge), callback reports failed |
| Callback to Vercel fails | Worker retries up to 5 times every 30s |
| eshenly.com down briefly | Same retry mechanism rides through |
| VPS rebooted | All services restart automatically (systemd + cloudflared) |
| Cloudflare tunnel disconnects | cloudflared reconnects automatically (4 redundant connections) |
