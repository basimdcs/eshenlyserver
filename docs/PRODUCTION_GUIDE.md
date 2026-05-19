# Production Guide — eshenly.com → Bot

Everything you need to wire the bot purchase to your Paymob webhook on eshenly.com.

## 1. Architecture

```
   ┌─────────────────────────────┐
   │ Customer pays on eshenly.com │
   │   (existing Paymob iframe)   │
   └──────────────┬──────────────┘
                  │
                  ▼
   ┌─────────────────────────────────────────┐
   │ Paymob → eshenly.com/api/webhooks/paymob │
   │   (your existing webhook handler)        │
   └──────────────┬──────────────────────────┘
                  │  After Paymob HMAC verification
                  │  triggerBot({ orderId, playerId, sku })
                  ▼
   ┌──────────────────────────────────────────────┐
   │ HTTPS POST (HMAC signed + idempotency key)    │
   │ → https://bot-442aa810f595.eshenly.com/trigger│
   └──────────────┬───────────────────────────────┘
                  │  Cloudflare Tunnel
                  ▼
   ┌─────────────────────────────────────────────┐
   │ trigger-server (signed-webhook receiver)     │
   │   • verifies HMAC, timestamp, idempotency    │
   │   • SKU allowlist [60,300,600,1500,3000,6000]│
   │   • queues to SQLite                          │
   │   • returns 202 { job_id }                    │
   └──────────────┬───────────────────────────────┘
                  │
                  ▼
   ┌─────────────────────────────────────────────┐
   │ trigger-worker (single concurrency)          │
   │   • picks job, spawns bot under 1.5 GB cgroup│
   │   • bot ~90s: Midasbuy → PayerMax → Paymob   │
   │   • OTP arrives via iPhone Shortcut          │
   │   • detects Paymob success=true              │
   │   • POSTs signed callback to your site       │
   └──────────────┬───────────────────────────────┘
                  │  HTTPS + different HMAC secret
                  ▼
   ┌─────────────────────────────────────────────────────────┐
   │ eshenly.com/api/topup-callback                           │
   │   • verifies HMAC signature                              │
   │   • updates order.status to delivered or failed          │
   │   • sends email / triggers refund                        │
   └─────────────────────────────────────────────────────────┘
```

End-to-end: ~90 seconds from "customer pays" to "UC delivered".

## 2. Secrets (set these once)

In Vercel → eshenly project → Settings → Environment Variables → **add for all environments**:

| Variable | Value |
|----------|-------|
| `BOT_TRIGGER_URL` | `https://bot-442aa810f595.eshenly.com/trigger` |
| `BOT_TRIGGER_SECRET` | `79a53dd0f74613bd821df4cdffb62246d9a7099cc0514fbff760f09af764858e` |
| `BOT_CALLBACK_SECRET` | `995c19ec655190e0333d711e803c7e4822bb5868e14b5bfa0b9d385cf3bd35e5` |
| `NEXT_PUBLIC_SITE_URL` | `https://eshenly.com` *(if not already set)* |

**Different secrets for trigger vs callback** — compromising one doesn't expose the other.

After saving, redeploy (Vercel will prompt).

## 3. Files to add to your Vercel repo

### File 1 — `lib/bot-trigger.ts`

The signed-request helper. Drop this into your shared lib folder.

```ts
import crypto from "node:crypto";

export type UCSku = 60 | 300 | 600 | 1500 | 3000 | 6000;

export interface TriggerArgs {
  orderId: string;            // your DB order ID — used as idempotency key
  playerId: string;           // 8–12 digit PUBG ID
  sku: UCSku;
  customerEmail?: string;
}

export type TriggerResult =
  | { ok: true; jobId: string; replay: boolean }
  | { ok: false; error: string; status?: number };

export async function triggerBot(args: TriggerArgs): Promise<TriggerResult> {
  const triggerUrl = process.env.BOT_TRIGGER_URL;
  const secret = process.env.BOT_TRIGGER_SECRET;
  if (!triggerUrl || !secret) {
    return { ok: false, error: "BOT_TRIGGER_URL or BOT_TRIGGER_SECRET not set" };
  }

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

  let res: Response;
  try {
    res = await fetch(triggerUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-timestamp": String(ts),
        "x-idempotency-key": args.orderId,
        "x-signature": signature,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    return { ok: false, error: `network: ${String(err)}` };
  }

  const json = (await res.json().catch(() => ({}))) as {
    job_id?: string; replay?: boolean; error?: string;
  };

  if ((res.status === 202 || res.status === 200) && json.job_id) {
    return { ok: true, jobId: json.job_id, replay: !!json.replay };
  }
  return { ok: false, error: json.error || `http ${res.status}`, status: res.status };
}
```

### File 2 — `app/api/topup-callback/route.ts`

Receives the bot's signed callback when a job finishes (success or failure).

```ts
import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
// Wire in your existing imports:
// import { db } from "@/lib/db";
// import { sendDeliveryEmail, sendFailureEmail } from "@/lib/email";
// import { refundOrder } from "@/lib/refunds";

const SECRET = process.env.BOT_CALLBACK_SECRET!;
const MAX_AGE_MS = 5 * 60 * 1000;

interface CallbackBody {
  order_id: string;
  job_id: string;
  status: "success" | "failed";
  amount_charged: number | null;
  trade_token: string | null;
  duration_ms: number;
  error: string | null;
}

export async function POST(req: NextRequest) {
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

  let payload: CallbackBody;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: false, error: "body_invalid_json" }, { status: 400 });
  }

  // Idempotent — worker may retry up to 5 times if your endpoint returns 5xx
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
    await sendDeliveryEmail(payload.order_id);
  } else {
    await sendFailureEmail(payload.order_id, payload.error || "delivery_failed");
    await refundOrder(payload.order_id, payload.error || "delivery_failed");
  }

  // Always 2xx on valid signature — worker will retry on non-2xx
  return NextResponse.json({ ok: true });
}
```

## 4. Wire it into your existing Paymob webhook

Find your Paymob webhook handler (likely `app/api/webhooks/paymob/route.ts`). After you've verified Paymob's HMAC and confirmed the transaction succeeded, add the trigger call.

The full handler skeleton:

```ts
import { NextRequest, NextResponse } from "next/server";
import { triggerBot } from "@/lib/bot-trigger";
// import { db } from "@/lib/db";
// import { verifyPaymobHmac } from "@/lib/paymob";

export async function POST(req: NextRequest) {
  const body = await req.json();

  // STEP 1: Verify Paymob's HMAC (you already do this)
  const isValid = verifyPaymobHmac(body, req.headers.get("hmac"));
  if (!isValid) return NextResponse.json({ ok: false }, { status: 401 });

  // STEP 2: Only act on real successful transactions
  const txn = body.obj;
  if (!txn.success || txn.is_voided || txn.is_refunded || txn.error_occured) {
    return NextResponse.json({ ok: true, skipped: "not_success" });
  }

  // STEP 3: Look up your order — Paymob's `merchant_order_id` is what you sent
  const orderId = String(txn.order?.merchant_order_id ?? txn.order?.id);
  const order = await db.order.findUnique({ where: { id: orderId } });
  if (!order) {
    return NextResponse.json({ ok: false, error: "order_not_found" }, { status: 404 });
  }

  // STEP 4: Mark order paid (idempotent — Paymob may retry)
  if (order.status === "pending") {
    await db.order.update({
      where: { id: orderId },
      data: { status: "paid", paidAt: new Date() },
    });
  }

  // STEP 5: Trigger the bot. Safe to call multiple times with same orderId.
  const result = await triggerBot({
    orderId: order.id,
    playerId: order.playerId,
    sku: order.sku as 60 | 300 | 600 | 1500 | 3000 | 6000,
    customerEmail: order.customerEmail ?? undefined,
  });

  if (!result.ok) {
    // Log to your error tracker. Don't tell the customer — they paid.
    // You can sweep these later with a cron that re-calls triggerBot for paid-but-not-delivering orders.
    console.error("[paymob-webhook] trigger failed:", result.error, "order=", orderId);
    return NextResponse.json({ ok: true, queued: false, reason: result.error });
  }

  await db.order.update({
    where: { id: orderId },
    data: { status: "delivering", botJobId: result.jobId },
  });

  return NextResponse.json({ ok: true, queued: true, job_id: result.jobId });
}
```

## 5. Order schema additions

If your `Order` model doesn't have these fields, add them:

```prisma
// schema.prisma
model Order {
  id              String    @id @default(cuid())  // used as bot idempotency key
  playerId        String                          // 8-12 digit PUBG ID
  sku             Int                             // 60, 300, 600, 1500, 3000, 6000
  customerEmail   String?
  status          String    // pending | paid | delivering | delivered | failed
  // Bot integration
  botJobId        String?
  tradeToken      String?   // from PayerMax, useful for support
  amountCharged   Float?    // EGP charged
  botError        String?   // failure reason if status=failed
  // Timestamps
  createdAt       DateTime  @default(now())
  paidAt          DateTime?
  deliveredAt     DateTime?
  // ...your existing fields
}
```

Status flow:
```
pending → paid → delivering → delivered  (success path)
                            └→ failed     (with botError populated, trigger refund)
```

## 6. UI: showing delivery progress to the customer

After triggering, you can poll the job status to update the customer's "delivering..." screen.

Endpoint to add: `app/api/topup-status/[orderId]/route.ts`

```ts
import { NextResponse } from "next/server";

export async function GET(_: Request, { params }: { params: { orderId: string } }) {
  const order = await db.order.findUnique({ where: { id: params.orderId } });
  if (!order) return NextResponse.json({ status: "unknown" }, { status: 404 });
  if (!order.botJobId) {
    return NextResponse.json({ status: order.status });
  }

  // Bot job status (unauthenticated; only returns non-sensitive state)
  const res = await fetch(`https://bot-442aa810f595.eshenly.com/jobs/${order.botJobId}`);
  const job = await res.json();

  return NextResponse.json({
    status: order.status,
    botStatus: job.status,           // queued | running | success | failed
    amountCharged: job.amount_charged,
  });
}
```

Client side: poll this every 5s until `status === "delivered"` or `"failed"`.

## 7. Testing

### Smoke test from your laptop (before going live)

This sends a signed trigger directly to the bot — bypassing eshenly.com entirely. Use it to confirm the secret + URL work.

```bash
ORDER_ID="manual_$(date +%s)"
TS=$(date +%s%3N)
BODY='{"player_id":"5922612859","sku":60,"callback_url":"https://eshenly.com/api/topup-callback"}'
SECRET="79a53dd0f74613bd821df4cdffb62246d9a7099cc0514fbff760f09af764858e"
SIG=$(printf "%s.%s.%s" "$TS" "$ORDER_ID" "$BODY" | \
  openssl dgst -sha256 -hmac "$SECRET" -r | awk '{print $1}')

curl -i -X POST https://bot-442aa810f595.eshenly.com/trigger \
  -H "content-type: application/json" \
  -H "x-timestamp: $TS" \
  -H "x-idempotency-key: $ORDER_ID" \
  -H "x-signature: $SIG" \
  -d "$BODY"
```

Expected: `HTTP/2 202` and `{"ok":true,"job_id":"<uuid>","status":"queued"}`. Job completes in ~90s, callback fires to your URL.

### End-to-end test (real Paymob payment)

1. Create a test order on eshenly.com with player ID `5922612859` and SKU `60` (small amount, ~E£ 42)
2. Pay via Vodafone Cash on `01044456628` (use PIN `063741`)
3. Watch the order status:
   - `pending` → `paid` (Paymob webhook fires)
   - `paid` → `delivering` (bot trigger queued)
   - `delivering` → `delivered` (bot callback fires, UC arrives in PUBG)

## 8. Edge cases (handled by the system)

| Scenario | What happens |
|----------|-------------|
| Paymob retries the webhook | Idempotency: bot returns existing job_id, no double charge |
| Vercel function crashes after triggering | Bot still runs, callback retried up to 5× over 2½ min |
| Customer pays but bot job fails | Callback marks order `failed`, your code triggers refund |
| OTP doesn't arrive on iPhone in 3 min | Bot times out, Paymob session abandoned (no charge), `status=failed` |
| Paymob rejects payment (wrong PIN, locked wallet) | Bot captures the rejection message, callback includes it |
| eshenly.com down when callback fires | Worker retries every 30s up to 5×; after that, job remains in `callback_failed` (visible in `/jobs/<id>`) |
| Two customers pay simultaneously | Queued, processed one after the other (~90s each, 2 GB VPS) |
| VPS reboots | All services auto-restart (systemd + cloudflared) |

## 9. Operations

### Daily check
Health: `curl https://bot-442aa810f595.eshenly.com/health` → `ok`

### See all jobs
```bash
ssh basim@41.128.145.134 'sqlite3 ~/eshenlyserver/trigger-server/queue.db "SELECT id, order_id, status, error FROM jobs ORDER BY created_at DESC LIMIT 20;"'
```

### Read a specific job's full bot log
```bash
ssh basim@41.128.145.134 'cat ~/eshenlyserver/trigger-server/logs/<job_id>.log'
```

### Watch the trigger-worker live
```bash
ssh basim@41.128.145.134 'tail -f ~/eshenlyserver/trigger-server/trigger-worker.log'
```

### If something's stuck
```bash
# Restart all bot services
ssh basim@41.128.145.134 'systemctl --user restart trigger-server trigger-worker otp-server'
```

### Manually retry a callback
The worker retries automatically. If a callback failed all 5 attempts, you can re-fire it by restarting the worker (it picks up unprocessed `callback_failed` jobs whose `callback_attempts < 5`).

## 10. Operational watchpoints

- **iPhone shortcut must stay active.** If iOS pauses the automation (sometimes happens after iOS updates), Paymob OTPs won't be forwarded → all purchases fail. Test it once a week by sending yourself a test SMS to `01044456628`.
- **Wallet balance.** The wallet on `01044456628` must have funds for every purchase. If it runs dry, the bot will get a Paymob "insufficient balance" rejection and the callback will mark the order failed.
- **VPS at 2 GB RAM** — currently one bot run uses ~700 MB peak. Comfortable margin, but if you ever upgrade Node/Playwright check the smoke test still fits under the 1.5 GB cgroup ceiling.
- **Midasbuy DOM changes.** If Midasbuy redesigns their checkout, phase 2/3/4 selectors may break. Bot will fail with a screenshot; check `~/eshenlyserver/screenshots/` for the broken phase and patch the selector.

## Quick reference card

```
PUBLIC ENDPOINT       https://bot-442aa810f595.eshenly.com
HEALTH                GET  /health           → "ok"
TRIGGER               POST /trigger          → 202 + job_id  (HMAC required)
JOB STATUS            GET  /jobs/<uuid>      → status JSON   (no auth)
OTP RECEIVER          POST /otp              → for iPhone shortcut only

VPS                   basim@41.128.145.134 (SSH key auth only, port 22 only open)
TUNNEL                Cloudflare (outbound from VPS; no inbound ports)
CONCURRENCY           1 bot at a time
RUN TIME              60-90 seconds per purchase
ALLOWED SKUs          60, 300, 600, 1500, 3000, 6000

WALLET (sender)       01044456628 (Vodafone Cash)
WALLET PIN            063741 (kept in VPS .env, never sent over wire)
```

That's the entire pipeline. Two files to copy, three env vars, and one patch to your existing Paymob webhook — and you're live.
