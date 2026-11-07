import { createClient } from "npm:@supabase/supabase-js@2";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const clean = (value: unknown) => String(value ?? "").trim();
const normalise = (value: unknown) =>
  clean(value).toLowerCase().replace(/[\s-]+/g, "_");

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function validSignature(rawBody: string, timestamp: string, supplied: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(timestamp + "." + rawBody),
  );
  return constantTimeEqual("sha256=" + toHex(digest), supplied);
}

function numericField(transaction: any, ...keys: string[]): number {
  for (const key of keys) {
    const raw = transaction?.[key];
    if (raw === null || raw === undefined || clean(raw) === "") continue;
    const parsed = Number(clean(raw).replace(/[,₦\s]/g, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return Number.NaN;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ success: false, error: "POST required." }, 405);

  const secret = Deno.env.get("GSUBZ_WEBHOOK_SECRET") || "";
  if (!secret) {
    console.error("[gsubz-webhook] GSUBZ_WEBHOOK_SECRET is not configured.");
    return json({ success: false, error: "Webhook signing secret is not configured." }, 503);
  }

  const timestamp = clean(req.headers.get("X-Gsubz-Timestamp"));
  const signature = clean(req.headers.get("X-Gsubz-Signature"));
  if (!/^\d{10}$/.test(timestamp) || !signature.startsWith("sha256=")) {
    return json({ success: false, error: "Invalid webhook signature headers." }, 401);
  }
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) {
    return json({ success: false, error: "Webhook timestamp expired." }, 401);
  }

  const rawBody = await req.text();
  if (rawBody.length > 128_000) return json({ success: false, error: "Webhook payload too large." }, 413);

  let signatureValid = false;
  try {
    signatureValid = await validSignature(rawBody, timestamp, signature, secret);
  } catch (error) {
    console.error("[gsubz-webhook] Signature verification error:", error instanceof Error ? error.message : "unknown");
  }
  if (!signatureValid) return json({ success: false, error: "Invalid webhook signature." }, 401);

  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json({ success: false, error: "Invalid JSON payload." }, 400);
  }

  const eventId = clean(event?.eventId);
  const headerEvent = clean(req.headers.get("X-Gsubz-Event"));
  const deliveryId = clean(req.headers.get("X-Gsubz-Delivery"));
  if (!eventId || (deliveryId && deliveryId !== eventId) ||
      (headerEvent && headerEvent !== clean(event?.event))) {
    return json({ success: false, error: "Webhook event headers do not match the payload." }, 400);
  }

  // GSubz sends several event families on the same key. This receiver is
  // deliberately scoped to slow Data purchases made by Sparkle only.
  if (clean(event?.event) !== "transaction.updated") {
    return json({ success: true, ignored: true });
  }
  const changeType = clean(event?.data?.change?.type).toUpperCase();
  if (changeType !== "COMPLETED") {
    return json({ success: true, ignored: true, reason: "Not a final purchase result." });
  }

  const transaction = event?.data?.transaction;
  const reference = clean(transaction?.requestID ?? transaction?.requestId);
  if (!/^SPK-DT-[A-Za-z0-9_-]{8,100}$/i.test(reference)) {
    return json({ success: true, ignored: true, reason: "Not a Sparkle Data reference." });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SECRET_KEY") || "";
  if (!supabaseUrl || !serviceKey) {
    console.error("[gsubz-webhook] Supabase service credentials are unavailable.");
    return json({ success: false, error: "Webhook processing is temporarily unavailable." }, 503);
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: tx, error: lookupError } = await admin
    .from("wallet_transactions")
    .select("id,user_id,amount,service,type,status,metadata,reference")
    .eq("reference", reference)
    .maybeSingle();

  if (lookupError) {
    console.error("[gsubz-webhook] Transaction lookup failed:", lookupError.message);
    return json({ success: false, error: "Could not locate the Sparkle transaction." }, 503);
  }
  if (!tx) {
    // Retry delivery is useful if the callback arrives before the reservation
    // is visible. Never create a wallet entry from an unmatched supplier event.
    return json({ success: false, error: "Sparkle transaction is not visible yet." }, 503);
  }
  if (clean(tx.service).toLowerCase() !== "data" || clean(tx.type).toLowerCase() !== "debit") {
    return json({ success: true, ignored: true, reason: "Reference is not a Data debit." });
  }
  if (clean(tx.status).toLowerCase() !== "pending") {
    return json({ success: true, duplicate: true, status: tx.status });
  }

  const providerStatus = normalise(transaction?.status ?? transaction?.transaction_status);
  const successful = ["successful", "success", "completed", "complete", "transaction_successful"].includes(providerStatus);
  const failed = ["failed", "failure", "rejected", "cancelled", "canceled", "transaction_failed", "transaction_failure"].includes(providerStatus);
  const supplierPaid = numericField(transaction, "amountPaid", "amount_paid", "paid_amount");
  const providerTransactionId = clean(transaction?.transactionID ?? transaction?.transaction_id) || null;

  const providerMetadata = {
    ...transaction,
    gsubz_webhook: {
      eventId,
      event: clean(event?.event),
      change: event?.data?.change ?? null,
      createdAt: event?.createdAt ?? null,
      receivedAt: new Date().toISOString(),
    },
  };

  let action: "success" | "failure" | "pending" = "pending";
  let trackingState = "needs_review";
  let issue = "GSubz final callback did not include a safe, complete settlement result.";

  if (successful) {
    action = "success";
    trackingState = "completed";
    issue = "";
  } else if (failed && supplierPaid === 0) {
    action = "failure";
    trackingState = "refunded";
    issue = "";
  } else if (failed && Number.isFinite(supplierPaid) && supplierPaid > 0) {
    issue = "GSubz reported failure but also reported a supplier charge. Automatic refund is blocked pending reconciliation.";
  } else if (!Number.isFinite(supplierPaid)) {
    issue = "GSubz reported failure without a readable amountPaid value. Automatic refund is held for reconciliation.";
  }

  const metadata = {
    provider: "GSubz",
    provider_response: providerMetadata,
    ...(providerTransactionId ? { provider_transaction_id: providerTransactionId } : {}),
    gsubz_webhook_event_id: eventId,
    gsubz_webhook_received_at: new Date().toISOString(),
    reconciliation: true,
    reconciliationSource: "gsubz_signed_webhook",
    dataTrackingState: trackingState,
    dataTrackingIssue: issue || null,
    ...(action === "pending" ? { dataNextCheckAt: new Date(Date.now() + 60_000).toISOString() } : {}),
  };

  const { data: result, error: settleError } = await admin.rpc("sparkle_airtime_wallet_action", {
    p_user_id: tx.user_id,
    p_action: action,
    p_reference: reference,
    p_amount: Number(tx.amount),
    p_service: "Data",
    p_phone: clean(tx.metadata?.phone),
    p_metadata: metadata,
  });

  if (settleError || result?.success !== true) {
    console.error("[gsubz-webhook] Wallet settlement was not confirmed:", settleError?.message || result?.error || "unknown");
    return json({ success: false, error: "Sparkle could not finalize this supplier result yet." }, 503);
  }

  console.log("[gsubz-webhook] Data transaction reconciled:", {
    reference,
    state: action === "success" ? "successful" : action === "failure" ? "refunded" : "needs_review",
    eventId,
    providerTransactionId,
  });

  return json({
    success: true,
    reference,
    state: action === "success" ? "successful" : action === "failure" ? "refunded" : "needs_review",
  });
});
