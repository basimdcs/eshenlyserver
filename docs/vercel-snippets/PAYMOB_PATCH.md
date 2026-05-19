# How to plug the bot trigger into your existing Paymob webhook

You already have a Paymob webhook handler verifying Paymob's HMAC. After that
verification passes and you know the payment succeeded, add **one call** to
`triggerBot()`.

## Where it goes

Find your existing Paymob webhook handler. It's usually at one of:
- `app/api/webhooks/paymob/route.ts`
- `pages/api/webhooks/paymob.ts`
- `app/api/paymob/webhook/route.ts`

The structure looks something like this (yours may differ in details):

```ts
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const body = await req.json();

  // 1. Verify Paymob HMAC — you already have this
  const valid = verifyPaymobHmac(body, req.headers.get("hmac"));
  if (!valid) return NextResponse.json({ ok: false }, { status: 401 });

  // 2. Only act on successful transactions
  const txn = body.obj;
  if (!txn.success || txn.is_voided || txn.is_refunded) {
    return NextResponse.json({ ok: true });
  }

  // 3. Look up the order — Paymob's `merchant_order_id` is yours
  const orderId = String(txn.order?.merchant_order_id ?? txn.order?.id);
  const order = await db.order.findUnique({ where: { id: orderId } });
  if (!order) {
    return NextResponse.json({ ok: false, error: "order_not_found" }, { status: 404 });
  }

  // ╔═══════════════════════════════════════════════════════════╗
  // ║  ADD THIS BLOCK — the only new piece                       ║
  // ╠═══════════════════════════════════════════════════════════╣
  if (order.status !== "paid") {
    await db.order.update({ where: { id: orderId }, data: { status: "paid" } });
  }

  const result = await triggerBot({
    orderId: order.id,
    playerId: order.playerId,
    sku: order.sku as 60 | 300 | 600 | 1500 | 3000 | 6000,
    customerEmail: order.customerEmail ?? undefined,
  });

  if (!result.ok) {
    // Trigger failed — log it, alert yourself, queue a manual retry.
    // Don't surface this to the customer; they already paid.
    console.error("[paymob-webhook] trigger failed:", result.error);
    return NextResponse.json({ ok: true, queued: false });
  }

  await db.order.update({
    where: { id: orderId },
    data: { status: "delivering", botJobId: result.jobId },
  });
  // ╚═══════════════════════════════════════════════════════════╝

  return NextResponse.json({ ok: true, queued: true });
}
```

## Important: triggerBot is idempotent

If Paymob retries the webhook (which they sometimes do), `triggerBot()`
returns the **same** `jobId` for the same `orderId` — no double charge.

That means you can leave the existing call in place even if Paymob sends
the webhook 3 times.

## Edge cases your existing flow likely already handles

- Customer paid but never received UC because bot job failed: handled by
  `/api/topup-callback` setting `status: failed` — kick off your refund flow there.
- Paymob webhook lost in transit: Paymob will retry. If your DB still says
  "paid" but not "delivering", you might also want a periodic sweeper that
  re-calls `triggerBot()` for unstarted orders.

## Environment variables to set in Vercel

Settings → Environment Variables → add for **all** environments:

| Key | Value |
|---|---|
| `BOT_TRIGGER_URL` | `https://bot-442aa810f595.eshenly.com/trigger` |
| `BOT_TRIGGER_SECRET` | `79a53dd0f74613bd821df4cdffb62246d9a7099cc0514fbff760f09af764858e` |
| `BOT_CALLBACK_SECRET` | `995c19ec655190e0333d711e803c7e4822bb5868e14b5bfa0b9d385cf3bd35e5` |

After adding them, redeploy (Vercel will prompt you).

## Quick smoke test from your laptop

Before pointing real customers at it, you can test the trigger from a
terminal on your Mac:

```bash
ORDER_ID="manual_$(date +%s)"
TS=$(date +%s%3N)
BODY='{"player_id":"5922612859","sku":60,"callback_url":"https://eshenly.com/api/topup-callback"}'
SIG=$(printf "%s.%s.%s" "$TS" "$ORDER_ID" "$BODY" | \
  openssl dgst -sha256 -hmac "79a53dd0f74613bd821df4cdffb62246d9a7099cc0514fbff760f09af764858e" -r | awk '{print $1}')

curl -i -X POST https://bot-442aa810f595.eshenly.com/trigger \
  -H "content-type: application/json" \
  -H "x-timestamp: $TS" \
  -H "x-idempotency-key: $ORDER_ID" \
  -H "x-signature: $SIG" \
  -d "$BODY"
```

You should get `HTTP/1.1 202` and `{"ok":true,"job_id":"<uuid>","status":"queued"}`,
followed ~90s later by a POST to `https://eshenly.com/api/topup-callback`
that your handler should log.
