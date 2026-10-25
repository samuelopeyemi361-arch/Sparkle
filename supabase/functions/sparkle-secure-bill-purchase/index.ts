import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const CABLE = new Set(["dstv", "gotv", "startimes"]);
const EDUCATION = new Set(["waec", "neco", "nabteb"]);
const BASE = "https://api.gsubz.com";

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: cors });
}
function str(v: unknown) { return String(v ?? "").trim(); }
function statusOf(d: any) {
  return str(d?.status ?? d?.data?.status ?? d?.content?.status ?? d?.data?.content?.status ?? d?.data?.transaction_status ?? d?.transaction_status).toLowerCase().replace(/[\s-]+/g, "_");
}
function successStatus(s: string) { return ["successful", "success", "completed"].includes(s); }
function failureStatus(s: string) { return ["failed", "failure", "error", "rejected", "cancelled"].includes(s); }
function planCode(p: any) { return str(p?.value ?? p?.variation_code ?? p?.variationCode ?? p?.code ?? p?.id ?? p?.plan); }
function planPrice(p: any) { return Number(p?.api_price ?? p?.price ?? p?.amount ?? p?.selling_price ?? p?.sellingPrice); }
function planName(p: any) { return str(p?.displayName ?? p?.display_name ?? p?.name ?? p?.label ?? p?.title ?? p?.package_name ?? p?.packageName ?? p?.plan_name); }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply({ success: false, status: "not_started", error: "POST required" }, 405);

  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return reply({ success: false, status: "not_started", error: "Sign in required" }, 401);

  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const gsubzKey = Deno.env.get("GSUBZ_API_KEY");
  if (!url || !anon || !serviceKey || !gsubzKey) return reply({ success: false, status: "not_started", error: "Secure purchase service is not configured." }, 503);

  const userClient = createClient(url, anon, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data: { user }, error: authError } = await userClient.auth.getUser();
  if (authError || !user) return reply({ success: false, status: "not_started", error: "Session expired. Sign in again." }, 401);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return reply({ success: false, status: "not_started", error: "Invalid request." }, 400); }

  const serviceID = str(body.serviceID ?? body.service).toLowerCase();
  const isCable = CABLE.has(serviceID);
  const isEducation = EDUCATION.has(serviceID);
  const phone = str(body.phone ?? body.phoneNumber);
  const biller = str(body.customerID ?? body.billersCode ?? body.smartcard ?? body.iuc ?? (CABLE.has(serviceID) ? phone : ""));
  const selectedPlan = str(body.plan ?? body.variation_code ?? body.planValue);
  const requestId = str(body.requestID ?? body.requestId ?? body.reference).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
  const pin = str(body.pin);

  if (!isCable && !isEducation) return reply({ success: false, status: "not_started", error: "Unsupported cable or education service." }, 400);
  if (!requestId || requestId.length < 8) return reply({ success: false, status: "not_started", error: "A valid purchase reference is required." }, 400);
  if (isEducation && !/^0\d{10}$/.test(phone)) return reply({ success: false, status: "not_started", error: "Enter a valid 11-digit phone number." }, 400);
  if (!selectedPlan || selectedPlan.length > 200) return reply({ success: false, status: "not_started", error: "Select a valid plan." }, 400);
  if (isCable && (!biller || biller.length < 5 || biller.length > 40)) return reply({ success: false, status: "not_started", error: "Enter a valid smartcard/IUC number." }, 400);
  if (!/^\d{4}$/.test(pin)) return reply({ success: false, status: "not_started", error: "Enter your 4-digit transaction PIN." }, 400);

  // Verify the PIN server-side before any wallet or supplier action.
  let pinResponse: Response;
  try {
    pinResponse = await fetch(`${url}/functions/v1/sparkle-transaction-pin`, {
      method: "POST",
      headers: { Authorization: auth, apikey: anon, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "verify", pin }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return reply({ success: false, status: "not_started", error: "PIN verification is unavailable. No order was sent." }, 502);
  }
  const pinResult: any = await pinResponse.json().catch(() => null);
  if (!pinResponse.ok || pinResult?.success !== true) {
    return reply({ success: false, status: "not_started", error: pinResult?.error || pinResult?.message || "PIN verification failed. No order was sent." }, 400);
  }

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const reference = `SPK-BILL-${requestId}`;

  // Server-side catalogue check: never trust a price sent by the browser.
  let catalogue: any;
  try {
    const r = await fetch(`${BASE}/api/plans/?service=${encodeURIComponent(serviceID)}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(20000),
    });
    catalogue = await r.json();
    if (!r.ok) return reply({ success: false, status: "not_started", error: "Could not verify the current plan price. No money was deducted." }, 502);
  } catch {
    return reply({ success: false, status: "not_started", error: "Plan price verification is unavailable. No money was deducted." }, 502);
  }

  const candidates = [catalogue?.plans, catalogue?.data?.plans, catalogue?.data?.data?.plans, catalogue?.result?.plans, catalogue?.results?.plans, Array.isArray(catalogue?.data) ? catalogue.data : null, Array.isArray(catalogue?.result) ? catalogue.result : null, Array.isArray(catalogue?.results) ? catalogue.results : null, Array.isArray(catalogue) ? catalogue : null];
  const plans = candidates.find((x) => Array.isArray(x)) ?? [];
  const chosen = plans.find((p: any) => planCode(p) === selectedPlan || planName(p).toLowerCase() === selectedPlan.toLowerCase());
  const amount = chosen ? Math.round((planPrice(chosen) + Number.EPSILON) * 100) / 100 : NaN;
  const reviewedAmount = Number(body.amount);
  if (!Number.isFinite(reviewedAmount) || Math.round((reviewedAmount + Number.EPSILON) * 100) / 100 !== amount) {
    return reply({ success: false, status: "not_started", error: "The selected plan price does not match the live provider price. Refresh plans and review again. No money was deducted." }, 409);
  }
  if (!chosen || !Number.isFinite(amount) || amount < 1 || amount > 1000000 || !planName(chosen)) {
    return reply({ success: false, status: "not_started", error: "The selected plan or its current price could not be verified. No money was deducted." }, 409);
  }

  // Verify cable subscriber against provider before reserving money.
  if (isCable) {
    try {
      const verifyForm = new FormData();
      verifyForm.append("api", gsubzKey);
      verifyForm.append("serviceID", serviceID);
      verifyForm.append("billersCode", biller);
      const vr = await fetch(`${BASE}/api/verify-customer/`, {
        method: "POST",
        headers: { Authorization: `Bearer ${gsubzKey}`, Accept: "application/json" },
        body: verifyForm,
        signal: AbortSignal.timeout(20000),
      });
      const vd: any = await vr.json().catch(() => null);
      const vs = statusOf(vd);
      const content = vd?.content ?? vd?.data?.content ?? vd?.data ?? vd;
      const customerName = str(content?.customerName ?? content?.customer_name ?? content?.Customer_Name ?? content?.name);
      if (!vr.ok || !successStatus(vs) || !customerName) {
        return reply({ success: false, status: "not_started", error: str(vd?.api_response ?? vd?.description ?? vd?.message) || "Subscriber verification failed. No money was deducted." }, 422);
      }
    } catch {
      return reply({ success: false, status: "not_started", error: "Subscriber verification is unavailable. No money was deducted." }, 502);
    }
  }

  const reserve = await admin.rpc("sparkle_airtime_wallet_action", {
    p_user_id: user.id,
    p_action: "reserve",
    p_reference: reference,
    p_amount: amount,
    p_service: isCable ? "Cable TV" : "Education Pin",
    p_phone: phone,
    p_metadata: { provider: "GSubz", provider_service: serviceID, plan_code: selectedPlan, plan_name: planName(chosen), biller: isCable ? biller : null, currency: "NGN" },
  });
  if (reserve.error) return reply({ success: false, status: "not_started", error: "Wallet reservation failed. No provider order was sent." }, 500);
  if (!reserve.data?.success) return reply({ success: false, status: "not_started", error: reserve.data?.error || "Wallet reservation failed." }, /insufficient/i.test(str(reserve.data?.error)) ? 402 : 400);
  if (reserve.data?.duplicate) return reply({ success: false, status: reserve.data.status || "pending", reference, error: "This reference was already processed. Check transaction history before retrying." }, 409);

  const form = new FormData();
  form.append("serviceID", serviceID);
  if (isCable) {
    form.append("variation_code", selectedPlan);
    form.append("customerID", biller);
    form.append("billersCode", biller);
    form.append("phone", phone);
  } else {
    form.append("plan", selectedPlan);
    form.append("phone", phone);
  }
  form.append("amount", "");
  form.append("api", gsubzKey);
  form.append("requestID", reference);

  let provider: any;
  let httpOK = false;
  try {
    const pr = await fetch(`${BASE}/api/pay/`, {
      method: "POST",
      headers: { Authorization: `Bearer ${gsubzKey}`, Accept: "application/json" },
      body: form,
      signal: AbortSignal.timeout(45000),
    });
    httpOK = pr.ok;
    provider = await pr.json().catch(async () => ({ raw: (await pr.text()).slice(0, 1000) }));
  } catch {
    await admin.rpc("sparkle_airtime_wallet_action", {
      p_user_id: user.id, p_action: "pending", p_reference: reference, p_amount: amount,
      p_service: isCable ? "Cable TV" : "Education Pin", p_phone: phone,
      p_metadata: { provider: "GSubz", provider_service: serviceID, plan_code: selectedPlan, provider_timeout: true },
    });
    return reply({ success: false, status: "pending", reference, amount, error: "Provider response is uncertain. Funds remain reserved while Sparkle checks the order. Do not retry yet." }, 202);
  }

  const providerStatus = statusOf(provider);
  if (httpOK && successStatus(providerStatus)) {
    const final = await admin.rpc("sparkle_airtime_wallet_action", {
      p_user_id: user.id, p_action: "success", p_reference: reference, p_amount: amount,
      p_service: isCable ? "Cable TV" : "Education Pin", p_phone: phone,
      p_metadata: { provider: "GSubz", provider_service: serviceID, plan_code: selectedPlan, plan_name: planName(chosen), provider_response: provider },
    });
    if (final.error || !final.data?.success) return reply({ success: false, status: "pending", reference, amount, error: "Provider reported success, but Sparkle needs to reconcile the transaction. Do not retry." }, 202);
    return reply({ success: true, status: "successful", reference, service: isCable ? "Cable TV" : "Education Pin", serviceID, plan: planName(chosen), phone, amount, provider });
  }

  if (failureStatus(providerStatus)) {
    const refund = await admin.rpc("sparkle_airtime_wallet_action", {
      p_user_id: user.id, p_action: "failure", p_reference: reference, p_amount: amount,
      p_service: isCable ? "Cable TV" : "Education Pin", p_phone: phone,
      p_metadata: { provider: "GSubz", provider_service: serviceID, plan_code: selectedPlan, provider_response: provider, stage: "refunded" },
    });
    if (refund.error || !refund.data?.success) return reply({ success: false, status: "pending", reference, amount, error: "Provider rejected the order, but the refund needs reconciliation. Do not retry." }, 202);
    return reply({ success: false, status: "refunded", reference, amount, error: "Purchase failed. Your Sparkle wallet has been refunded.", provider });
  }

  await admin.rpc("sparkle_airtime_wallet_action", {
    p_user_id: user.id, p_action: "pending", p_reference: reference, p_amount: amount,
    p_service: isCable ? "Cable TV" : "Education Pin", p_phone: phone,
    p_metadata: { provider: "GSubz", provider_service: serviceID, plan_code: selectedPlan, provider_response: provider, provider_http_ok: httpOK },
  });
  return reply({ success: false, status: "pending", reference, amount, error: "The provider has not confirmed this order. Funds remain reserved while Sparkle checks it. Do not retry yet.", provider }, 202);
});