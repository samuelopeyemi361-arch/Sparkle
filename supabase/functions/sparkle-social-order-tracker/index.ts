import { createClient } from "npm:@supabase/supabase-js@2";

const BASE = "https://api.gsubz.com";
const TRACKER_TOKEN_SHA256 = "8699435a56e90224958e5f675984f766adcd9e3036a8125de195dc6705def227";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, apikey, x-sparkle-social-tracker",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

function reply(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: cors });
}
function str(v: unknown) { return String(v ?? "").trim(); }
function money2(v: number) { return Math.ceil((v + Number.EPSILON) * 100) / 100; }
function statusOf(d: any) {
  return str(d?.status ?? d?.data?.status ?? d?.content?.status ?? d?.data?.content?.status ?? d?.transaction_status)
    .toLowerCase().replace(/[\s-]+/g, "_");
}
function isSuccess(s: string) { return ["successful", "success", "completed", "complete"].includes(s); }
function isFailure(s: string) { return ["failed", "failure", "error", "rejected", "cancelled", "canceled"].includes(s); }
function socialOrderOf(d: any) {
  return d?.order ?? d?.content?.order ?? d?.data?.order ?? d?.data?.content?.order ?? d?.result?.order ?? null;
}
function socialOrderStatus(order: any) {
  return str(order?.status).toLowerCase().replace(/[\s-]+/g, "_");
}
function socialOrderProgress(order: any, quantity = 0) {
  if (!order || typeof order !== "object") return null;
  const numeric = (value: unknown) => {
    if (value === null || value === undefined || String(value).trim() === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  return {
    status: str(order.status) || "Processing",
    start_count: numeric(order.start_count ?? order.startCount),
    remains: numeric(order.remains),
    quantity: Number.isSafeInteger(quantity) && quantity > 0 ? quantity : null,
  };
}
function socialPaymentSuccess(status: string) {
  return isSuccess(status) || ["transaction_successful", "transaction_success"].includes(status);
}
function socialPaymentFailure(status: string) {
  return isFailure(status) || ["transaction_failed", "transaction_failure", "transaction_refunded"].includes(status);
}
function socialOrderHasNoDelivery(order: any, quantity: number) {
  const status = socialOrderStatus(order);
  const terminalFailure = ["failed", "failure", "error", "rejected", "cancelled", "canceled", "refunded"].includes(status);
  const remains = Number(order?.remains);
  return terminalFailure && Number.isSafeInteger(quantity) && quantity > 0
    && Number.isFinite(remains) && remains >= quantity;
}
function socialOrderComplete(order: any, progress: any) {
  const status = socialOrderStatus(order);
  return ["completed", "complete", "successful", "success", "finished", "delivered"].includes(status)
    || progress?.remains === 0;
}
function retailFromSupplier(actualCost: number, quotedRetail: number, reservedAmount: number) {
  const safeActual = Number.isFinite(actualCost) && actualCost >= 0 ? actualCost : 0;
  const factor = 1.25;
  const calculated = money2((safeActual > 0 ? safeActual : quotedRetail / factor) * factor);
  return Math.min(reservedAmount, Math.max(0, calculated));
}
async function providerPost(key: string, requestId: string) {
  const form = new FormData();
  form.append("api", key);
  form.append("requestID", requestId);
  const response = await fetch(`${BASE}/api/verify/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    body: form,
    signal: AbortSignal.timeout(55000),
  });
  const data = await response.json().catch(() => null);
  return { response, data };
}
async function validTrackerToken(req: Request) {
  const supplied = req.headers.get("x-sparkle-social-tracker") || "";
  if (supplied.length !== 64) return false;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(supplied)));
  const actual = Array.from(digest, b => b.toString(16).padStart(2, "0")).join("");
  let difference = 0;
  for (let i = 0; i < TRACKER_TOKEN_SHA256.length; i++) {
    difference |= actual.charCodeAt(i) ^ TRACKER_TOKEN_SHA256.charCodeAt(i);
  }
  return difference === 0;
}
function intervalForAge(ageMs: number) {
  if (ageMs < 60 * 60 * 1000) return 60 * 1000;
  if (ageMs < 24 * 60 * 60 * 1000) return 5 * 60 * 1000;
  return 15 * 60 * 1000;
}
async function saveTrackingState(admin: any, tx: any, meta: Record<string, any>, patch: Record<string, any>, terminal = false) {
  const current = await admin.from("wallet_transactions").select("metadata")
    .eq("reference", tx.reference).eq("user_id", tx.user_id).eq("service", "Social Media Market").maybeSingle();
  if (current.error) throw new Error(current.error.message);
  const base: Record<string, any> = current.data?.metadata && typeof current.data.metadata === "object"
    ? current.data.metadata : meta;
  const now = new Date();
  const attempts = Math.max(0, Number(base.socialTrackingAttempts || 0)) + 1;
  const ageMs = Math.max(0, now.getTime() - new Date(tx.created_at || now.toISOString()).getTime());
  const updated = {
    ...base,
    ...patch,
    socialAutoTrack: !terminal,
    socialTrackingTerminal: terminal,
    socialTrackingAttempts: attempts,
    socialTrackingLeaseUntil: null,
    lastSocialStatusCheckAt: now.toISOString(),
    socialNextCheckAt: terminal ? null : new Date(now.getTime() + intervalForAge(ageMs)).toISOString(),
  };
  const saved = await admin.from("wallet_transactions").update({ metadata: updated })
    .eq("reference", tx.reference)
    .eq("user_id", tx.user_id)
    .eq("service", "Social Media Market");
  if (saved.error) throw new Error(saved.error.message);
  return updated;
}
async function claimSocialOrder(admin: any, tx: any) {
  const meta: Record<string, any> = tx.metadata || {};
  const dueAt = str(meta.socialNextCheckAt);
  if (!dueAt || !Number.isFinite(Date.parse(dueAt)) || Date.parse(dueAt) > Date.now()) return false;
  const leaseUntil = new Date(Date.now() + 110 * 1000).toISOString();
  const claimedMetadata = {
    ...meta,
    socialTrackingLeaseUntil: leaseUntil,
    socialNextCheckAt: leaseUntil,
  };
  const claimed = await admin.from("wallet_transactions")
    .update({ metadata: claimedMetadata })
    .eq("reference", tx.reference)
    .eq("user_id", tx.user_id)
    .eq("service", "Social Media Market")
    .eq("metadata->>socialNextCheckAt", dueAt)
    .select("reference")
    .maybeSingle();
  if (claimed.error) throw new Error(claimed.error.message);
  return !!claimed.data;
}
async function processSocialOrder(admin: any, tx: any, gsubzKey: string) {
  const meta: Record<string, any> = tx.metadata || {};
  const reference = str(tx.reference);
  const requestId = str(meta.providerRequestID);
  const quantity = Number(meta.quantity || 0);
  if (!/^SPKDIG-[A-Za-z0-9_-]{8,100}$/.test(reference)
      || !/^SPKDIG-[A-Za-z0-9_-]{8,100}$/.test(requestId)
      || !Number.isSafeInteger(quantity) || quantity < 1) {
    await saveTrackingState(admin, tx, meta, {
      socialTrackingState: "needs_review",
      socialTrackingIssue: "Missing or invalid supplier tracking details",
    }, true);
    return "needs_review";
  }
  const ageMs = Math.max(0, Date.now() - new Date(tx.created_at || Date.now()).getTime());
  if (ageMs > 7 * 24 * 60 * 60 * 1000) {
    await saveTrackingState(admin, tx, meta, {
      socialTrackingState: "needs_review",
      socialTrackingIssue: "Automatic tracking window ended; manual review is required",
    }, true);
    return "needs_review";
  }

  let checked: any;
  try {
    checked = await providerPost(gsubzKey, requestId);
  } catch (error) {
    await saveTrackingState(admin, tx, meta, {
      socialTrackingState: "retrying",
      socialTrackingLastError: error instanceof Error ? error.message.slice(0, 220) : "Supplier status request failed",
    });
    return "retrying";
  }

  const provider = checked.data;
  const paymentStatus = statusOf(provider);
  const providerSuccess = socialPaymentSuccess(paymentStatus);
  const providerFailure = socialPaymentFailure(paymentStatus);
  const order = socialOrderOf(provider);
  const orderStatus = socialOrderStatus(order);
  const progress = socialOrderProgress(order, quantity);
  const progressPatch = {
    ...(provider && typeof provider === "object" ? { provider_verification: provider } : {}),
    ...(progress ? { socialOrderProgress: progress } : {}),
    socialTrackingLastHttpStatus: Number(checked.response.status),
  };

  // Order-level refund requires a successful supplier verification and proof
  // that the complete requested quantity remains undelivered.
  if (checked.response.ok && order && socialOrderHasNoDelivery(order, quantity)) {
    const refund = await admin.rpc("sparkle_social_refund_order", {
      p_user_id: tx.user_id,
      p_reference: reference,
      p_provider_order: order,
      p_reason: "Scheduled supplier verification proved that the full social order was undelivered",
    });
    if (refund.error || refund.data?.success !== true) {
      await saveTrackingState(admin, tx, meta, {
        ...progressPatch,
        socialTrackingState: "needs_review",
        socialTrackingIssue: refund.data?.error || refund.error?.message || "Supplier refund proof could not be reconciled",
      });
      return "needs_review";
    }
    await saveTrackingState(admin, tx, meta, {
      ...progressPatch,
      socialTrackingState: "refunded",
      socialRefundReference: refund.data.reference || null,
      socialRefundAmount: Number(refund.data.amount || tx.amount),
    }, true);
    return "refunded";
  }

  const unresolvedOrderFailure = !!order && [
    "partial", "partially_completed", "partially_complete",
    "cancelled", "canceled", "failed", "failure", "error", "rejected", "refunded",
  ].includes(orderStatus);

  // An accepted transaction must settle its reservation even where delivery
  // is partial or needs review. It does not trigger a refund.
  if (checked.response.ok && providerSuccess && String(tx.status).toLowerCase() === "pending") {
    const actualCost = Number(provider?.amountPaid ?? provider?.amount ?? meta.quotedSupplierCost);
    const reserved = Number(meta.reservedAmount || tx.amount);
    const finalAmount = retailFromSupplier(actualCost, Number(meta.quotedRetail || tx.amount), reserved);
    const settled = await admin.rpc("sparkle_digital_wallet_action", {
      p_user_id: tx.user_id,
      p_action: "success",
      p_reference: reference,
      p_amount: finalAmount,
      p_service: "Social Media Market",
      p_metadata: {
        status_checked: true,
        provider_verification: provider,
        actual_supplier_cost: Number.isFinite(actualCost) ? actualCost : null,
        final_customer_charge: finalAmount,
        ...(progress ? { socialOrderProgress: progress } : {}),
        socialTrackingState: unresolvedOrderFailure ? "needs_review" : "processing",
      },
    });
    if (settled.error || settled.data?.success !== true) {
      await saveTrackingState(admin, tx, meta, {
        ...progressPatch,
        socialTrackingState: "needs_review",
        socialTrackingIssue: settled.data?.error || settled.error?.message || "Confirmed payment could not be settled",
      });
      return "needs_review";
    }
  }

  // A verified failed supplier transaction with no order is transaction-level
  // proof; an HTTP error by itself is never sufficient evidence for a refund.
  if (checked.response.ok && providerFailure && !order) {
    const refund = await admin.rpc("sparkle_social_refund_order", {
      p_user_id: tx.user_id,
      p_reference: reference,
      p_provider_order: { status: "failed", source: "transaction", verificationStatus: paymentStatus },
      p_reason: "Scheduled supplier requestID verification confirmed transaction failure",
    });
    if (refund.error || refund.data?.success !== true) {
      await saveTrackingState(admin, tx, meta, {
        ...progressPatch,
        socialTrackingState: "needs_review",
        socialTrackingIssue: refund.data?.error || refund.error?.message || "Transaction failure refund needs reconciliation",
      });
      return "needs_review";
    }
    await saveTrackingState(admin, tx, meta, {
      ...progressPatch,
      socialTrackingState: "refunded",
      socialRefundReference: refund.data.reference || null,
      socialRefundAmount: Number(refund.data.amount || tx.amount),
    }, true);
    return "refunded";
  }

  if (checked.response.ok && providerSuccess && socialOrderComplete(order, progress)) {
    await saveTrackingState(admin, tx, meta, {
      ...progressPatch,
      socialTrackingState: "completed",
      socialTrackingIssue: null,
    }, true);
    return "completed";
  }

  if (unresolvedOrderFailure || (checked.response.ok && providerFailure)) {
    await saveTrackingState(admin, tx, meta, {
      ...progressPatch,
      socialTrackingState: "needs_review",
      socialTrackingIssue: "Supplier reports a partial or failed order without proof that the full quantity was undelivered",
    });
    return "needs_review";
  }

  await saveTrackingState(admin, tx, meta, {
    ...progressPatch,
    socialTrackingState: checked.response.ok && providerSuccess ? "processing" : "retrying",
    socialTrackingIssue: null,
  });
  return checked.response.ok && providerSuccess ? "processing" : "retrying";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply({ success: false, error: "POST required." }, 405);
  if (!(await validTrackerToken(req))) return reply({ success: false, error: "Not authorised." }, 401);

  let body: any;
  try { body = await req.json(); } catch { return reply({ success: false, error: "Invalid request body." }, 400); }
  if (str(body?.action) !== "social_tracking_worker") return reply({ success: false, error: "Unsupported worker action." }, 400);

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const gsubzKey = Deno.env.get("GSUBZ_API_KEY");
  if (!url || !serviceKey || !gsubzKey) return reply({ success: false, error: "The Social Market tracker is not configured." }, 503);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const now = new Date().toISOString();
  const { data: orders, error } = await admin.from("wallet_transactions")
    .select("user_id,reference,amount,service,status,metadata,created_at")
    .eq("service", "Social Media Market")
    .in("status", ["pending", "successful"])
    .eq("metadata->>digitalKind", "social")
    .eq("metadata->>socialAutoTrack", "true")
    .eq("metadata->>socialTrackingTerminal", "false")
    .lte("metadata->>socialNextCheckAt", now)
    .order("created_at", { ascending: true })
    .limit(12);
  if (error) return reply({ success: false, error: "Could not load active Social Market orders." }, 500);

  const results = await Promise.all((orders || []).map(async (tx: any) => {
    try {
      // Compare-and-set the due timestamp to claim this order for one worker run.
      // A concurrent cron invocation will see the new lease and skip this record.
      const claimed = await claimSocialOrder(admin, tx);
      if (!claimed) return { state: "skipped" };
      const state = await processSocialOrder(admin, tx, gsubzKey);
      return { state };
    } catch (e) {
      return { state: "error", error: e instanceof Error ? e.message.slice(0, 180) : "Unexpected tracking error" };
    }
  }));
  const counts: Record<string, number> = {};
  for (const item of results) counts[item.state] = (counts[item.state] || 0) + 1;
  return reply({ success: true, checked: results.length, counts, checkedAt: now });
});
