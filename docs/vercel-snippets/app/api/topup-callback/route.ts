// Drop into: eshenly.com/app/api/topup-callback/route.ts
import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
// import { db } from "@/lib/db";           // your existing DB client
// import { sendDeliveryEmail } from "@/lib/email";
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

  // Idempotent update — safe to receive twice (worker retries up to 5x)
  // await db.order.update({
  //   where: { id: payload.order_id },
  //   data: {
  //     status: payload.status === "success" ? "delivered" : "failed",
  //     tradeToken: payload.trade_token,
  //     amountCharged: payload.amount_charged,
  //     botError: payload.error,
  //     deliveredAt: payload.status === "success" ? new Date() : null,
  //   },
  // });

  if (payload.status === "success") {
    // await sendDeliveryEmail(payload.order_id);
  } else {
    // await refundOrder(payload.order_id, payload.error || "delivery_failed");
  }

  // Always return 2xx if signature was valid — even if the body refers to an
  // unknown order. Returning 4xx/5xx will trigger up to 5 retries from the bot.
  return NextResponse.json({ ok: true });
}
