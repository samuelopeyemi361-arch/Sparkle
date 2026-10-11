
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const DATA_SERVICES = [
  "airtel_gifting",
  "airtel_sme",
  "etisalat_data",
  "glo_data",
  "glo_sme",
  "mtn_fibrex",
  "mtn_gifting",
  "mtn_sme",
];

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders,
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return reply({ success: false, error: "POST required" }, 405);
  }

  const authorization = req.headers.get("Authorization");

  if (!authorization?.startsWith("Bearer ")) {
    return reply({
      success: false,
      error: "Please sign in first.",
    }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const gsubzKey = Deno.env.get("GSUBZ_API_KEY");

  if (!supabaseUrl || !anonKey || !serviceKey || !gsubzKey) {
    return reply({
      success: false,
      error: "Data purchase service is not configured.",
    }, 500);
  }

  const userClient = createClient(supabaseUrl, anonKey, {
    global: {
      headers: { Authorization: authorization },
    },
    auth: { persistSession: false },
  });

  const {
    data: { user },
    error: authError,
  } = await userClient.auth.getUser();

  if (authError || !user) {
    return reply({
      success: false,
      error: "Your session has expired. Sign in again.",
    }, 401);
  }

  let body: Record<string, unknown>;

  try {
    body = await req.json();
  } catch {
    return reply({
      success: false,
      error: "Invalid request.",
    }, 400);
  }

  const serviceID = String(
    body.serviceID || body.service || "",
  ).trim().toLowerCase();

  const phone = String(
    body.phone || body.phoneNumber || "",
  ).trim();

  const plan = String(
    body.plan ||
    body.planValue ||
    body.value ||
    body.variation_code ||
    "",
  ).trim();

  const amount = Number(body.amount ?? body.price);

  if (!DATA_SERVICES.includes(serviceID)) {
    return reply({
      success: false,
      status: "not_started",
      error: "Please select a valid data plan.",
    }, 400);
  }

  if (!/^0\d{10}$/.test(phone)) {
    return reply({
      success: false,
      status: "not_started",
      error: "Enter a valid 11-digit phone number.",
    }, 400);
  }

  if (!plan || plan.length > 200) {
    return reply({
      success: false,
      status: "not_started",
      error: "Please select a data plan.",
    }, 400);
  }

  if (
    !Number.isSafeInteger(amount) ||
    amount < 1 ||
    amount > 1000000
  ) {
    return reply({
      success: false,
      status: "not_started",
      error: "The data plan price is invalid.",
    }, 400);
  }

  // Verify the user's transaction PIN before touching the wallet.
  const pin = typeof body.pin === "string" ? body.pin.trim() : "";

  if (!/^\d{4}$/.test(pin)) {
    return reply({
      success: false,
      status: "not_started",
      error: "Enter your 4-digit transaction PIN.",
    }, 400);
  }

  let pinResponse: Response;

  try {
    pinResponse = await fetch(
      `${supabaseUrl}/functions/v1/sparkle-transaction-pin`,
      {
        method: "POST",
        headers: {
          Authorization: authorization,
          apikey: anonKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "verify",
          pin,
        }),
        signal: AbortSignal.timeout(15000),
      },
    );
  } catch {
    return reply({
      success: false,
      status: "not_started",
      error: "PIN verification is unavailable. No purchase was sent.",
    }, 502);
  }

  let pinResult: any;

  try {
    pinResult = await pinResponse.json();
  } catch {
    return reply({
      success: false,
      status: "not_started",
      error: "PIN verification failed. No purchase was sent.",
    }, 502);
  }

  if (!pinResponse.ok || pinResult?.success !== true) {
    return reply({
      success: false,
      status: "not_started",
      error:
        pinResult?.error ||
        pinResult?.message ||
        "Transaction PIN verification failed.",
    }, 400);
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  // Reuse a supplied request ID on retries to help prevent duplicate orders.
  const suppliedID = String(
    body.requestID || body.requestId || body.reference || "",
  ).trim();

  const safeID = suppliedID
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 80);

  const reference = safeID
    ? `SPK-DT-${safeID}`
    : `SPK-DT-${crypto.randomUUID()}`;

  // Reserve/deduct the wallet amount before calling GSubz.
  const reserve = await admin.rpc(
    "sparkle_airtime_wallet_action",
    {
      p_user_id: user.id,
      p_action: "reserve",
      p_reference: reference,
      p_amount: amount,
      p_service: "Data",
      p_phone: phone,
      p_metadata: {
        provider: "GSubz",
        provider_service: serviceID,
        plan,
      },
    },
  );

  if (reserve.error) {
    return reply({
      success: false,
      status: "not_started",
      error:
        "Wallet reservation failed. No data order was sent.",
    }, 500);
  }

  if (!reserve.data?.success) {
    return reply({
      success: false,
      status: "not_started",
      error: reserve.data?.error || "Wallet reservation failed.",
    }, 400);
  }

  if (reserve.data?.duplicate) {
    return reply({
      success: false,
      status: reserve.data.status || "pending",
      reference,
      error:
        "This request was already processed. Check your transaction history before trying again.",
    }, 409);
  }

  const form = new FormData();
  form.append("serviceID", serviceID);
  form.append("plan", plan);
  form.append("api", gsubzKey);
  form.append("amount", "");
  form.append("phone", phone);
  form.append("requestID", reference);

  let providerData: any;
  let httpOk = false;

  try {
    const response = await fetch(
      "https://api.gsubz.com/api/pay/",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${gsubzKey}`,
          Accept: "application/json",
        },
        body: form,
        signal: AbortSignal.timeout(45000),
      },
    );

    httpOk = response.ok;
    const raw = await response.text();

    try {
      providerData = JSON.parse(raw);
    } catch {
      providerData = { raw: raw.slice(0, 1000) };
    }
  } catch {
    await admin.rpc("sparkle_airtime_wallet_action", {
      p_user_id: user.id,
      p_action: "pending",
      p_reference: reference,
      p_amount: amount,
      p_service: "Data",
      p_phone: phone,
      p_metadata: {
        provider: "GSubz",
        provider_service: serviceID,
        plan,
        reason: "provider_timeout_or_connection_error",
      },
    });

    return reply({
      success: false,
      status: "pending",
      reference,
      error:
        "GSubz has not returned a definite result. Your funds remain reserved while the order is checked. Do not retry yet.",
    }, 202);
  }

  const providerStatus = String(
    providerData?.status ??
    providerData?.data?.status ??
    providerData?.data?.transaction_status ??
    providerData?.transaction_status ??
    "",
  ).trim().toLowerCase();

  const succeeded =
    httpOk &&
    ["successful", "success", "completed"].includes(providerStatus);

  const failed = [
    "failed",
    "failure",
    "error",
    "rejected",
    "cancelled",
  ].includes(providerStatus);

  if (succeeded) {
    const finalize = await admin.rpc(
      "sparkle_airtime_wallet_action",
      {
        p_user_id: user.id,
        p_action: "success",
        p_reference: reference,
        p_amount: amount,
        p_service: "Data",
        p_phone: phone,
        p_metadata: {
          provider: "GSubz",
          provider_service: serviceID,
          plan,
          provider_response: providerData,
        },
      },
    );

    if (finalize.error || !finalize.data?.success) {
      return reply({
        success: false,
        status: "pending",
        reference,
        error:
          "GSubz reported success, but Sparkle could not finalize the wallet transaction. Contact support before retrying.",
      }, 202);
    }

    return reply({
      success: true,
      status: "successful",
      type: "data",
      reference,
      serviceID,
      phone,
      plan,
      amount,
      provider: providerData,
    });
  }

  if (failed) {
    const refund = await admin.rpc(
      "sparkle_airtime_wallet_action",
      {
        p_user_id: user.id,
        p_action: "failure",
        p_reference: reference,
        p_amount: amount,
        p_service: "Data",
        p_phone: phone,
        p_metadata: {
          provider: "GSubz",
          provider_service: serviceID,
          plan,
          provider_response: providerData,
        },
      },
    );

    if (refund.error || !refund.data?.success) {
      return reply({
        success: false,
        status: "pending",
        reference,
        error:
          "The data order failed, but the refund needs reconciliation. Do not retry yet.",
      }, 202);
    }

    return reply({
      success: false,
      status: "refunded",
      reference,
      error: "The data order failed. Your wallet has been refunded.",
      provider: providerData,
    });
  }

  // Unknown response: keep funds reserved instead of risking a duplicate.
  await admin.rpc("sparkle_airtime_wallet_action", {
    p_user_id: user.id,
    p_action: "pending",
    p_reference: reference,
    p_amount: amount,
    p_service: "Data",
    p_phone: phone,
    p_metadata: {
      provider: "GSubz",
      provider_service: serviceID,
      plan,
      provider_response: providerData,
      http_ok: httpOk,
    },
  });

  return reply({
    success: false,
    status: "pending",
    reference,
    error:
      "GSubz has not confirmed the result. Your funds remain reserved while the order is checked.",
    provider: providerData,
  }, 202);
});
