// Drop into: eshenly.com/lib/bot-trigger.ts  (or wherever your server lib lives)
import crypto from "node:crypto";

export type UCSku = 60 | 300 | 600 | 1500 | 3000 | 6000;

export interface TriggerArgs {
  orderId: string; // your DB order ID — used as idempotency key
  playerId: string; // 8–12 digit PUBG ID
  sku: UCSku;
  customerEmail?: string;
}

export type TriggerResult =
  | { ok: true; jobId: string; replay: boolean }
  | { ok: false; error: string; status?: number };

/**
 * Sends a signed trigger to the bot. Safe to call multiple times with the
 * same orderId — the bot will return the existing job_id, not double-charge.
 */
export async function triggerBot(args: TriggerArgs): Promise<TriggerResult> {
  const triggerUrl = process.env.BOT_TRIGGER_URL;
  const secret = process.env.BOT_TRIGGER_SECRET;
  if (!triggerUrl || !secret) {
    return { ok: false, error: "BOT_TRIGGER_URL or BOT_TRIGGER_SECRET not set" };
  }

  const callbackUrl = `${
    process.env.NEXT_PUBLIC_SITE_URL || "https://eshenly.com"
  }/api/topup-callback`;

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
    ok?: boolean;
    job_id?: string;
    replay?: boolean;
    error?: string;
  };

  if ((res.status === 202 || res.status === 200) && json.job_id) {
    return { ok: true, jobId: json.job_id, replay: !!json.replay };
  }
  return {
    ok: false,
    error: json.error || `http ${res.status}`,
    status: res.status,
  };
}
