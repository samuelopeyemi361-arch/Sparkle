import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

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

  const auth = req.headers.get("Authorization");

  if (!auth?.startsWith("Bearer ")) {
    return reply({
      success: false,
      error: "Sign in required",
    }, 401);
  }

  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const gsubzKey = Deno.env.get("GSUBZ_API_KEY");

  if (!url || !anonKey || !serviceKey || !gsubzKey) {
    return reply({
      success: false,
      error: "Secure airtime service is not configured.",
    }, 500);
  }

  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false },
  });

  const {
    data: { user },
    error: authError,
  } = await userClient.auth.getUser();

  if (authError || !user) {
    return reply({
      success: false,
      error: "Invalid session. Sign in again.",
    }, 401);
  }

  let body: Record<string, unknown>;

  try {
    body = await req.json();
  } catch {
    return reply({
      success: false,
      error: "Invalid JSON.",
    }, 400);
  }

  const networkInput = String(
    body.network || body.provider || "",
  ).trim().toLowerCase();

  const networkMap: Record<string, string> = {
    mtn: "mtn",
    airtel: "airtel",
    glo: "glo",
    "9mobile": "etisalat",
    etisalat: "etisalat",
    t2: "etisalat",
  };

  const serviceID = networkMap[networkInput];
  const phone = String(
    body.phone || body.phoneNumber || "",
  ).trim();
  const amount = Number(body.amount);

  if (
    !serviceID ||
    !/^0\d{10}$/.test(phone) ||
    !Number.isSafeInteger(amount) ||
    amount < 100 ||
    amount > 1000000
  ) {
    return reply({
      success: false,
      status: "not_started",
      error:
        "Check the network, 11-digit phone number, and airtime amount (₦100 minimum).",
    }, 400);
  }

  // Verify the shared 4-digit transaction PIN first.
  const pin = typeof body.pin === "string" ? body.pin : "";

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
      `${url}/functions/v1/sparkle-transaction-pin`,
      {
        method: "POST",
        headers: {
          Authorization: auth,
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
      error:
        "PIN verification is unavailable. No purchase was sent.",
    }, 502);
  }

  let pinResult: any;

  try {
    pinResult = await pinResponse.json();
  } catch {
    return reply({
      success: false,
      status: "not_started",
      error:
        "PIN verification failed. No purchase was sent.",
    }, 502);
  }

  if (!pinResponse.ok || pinResult?.success !== true) {
    return reply({
      success: false,
      status: "not_started",
      error:
        pinResult?.error ||
        pinResult?.message ||
        "Transaction PIN verification failed. No purchase was sent.",
    }, 400);
  }

  // Reserve wallet funds only after successful PIN verification.
  const reference = "SPK-AT-" + crypto.randomUUID();

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false },
  });

  const reserve = await admin.rpc(
    "sparkle_airtime_wallet_action",
    {
      p_user_id: user.id,
      p_action: "reserve",
      p_reference: reference,
      p_amount: amount,
      p_service: "Airtime",
      p_phone: phone,
      p_metadata: {
        network: networkInput,
        provider_service: serviceID,
      },
    },
  );

  if (reserve.error) {
    return reply({
      success: false,
      status: "not_started",
      error:
        "Wallet reservation failed; no purchase was sent to the provider.",
    });
  }

  if (!reserve.data?.success) {
    return reply({
      success: false,
      status: "not_started",
      error: reserve.data?.error || "Wallet reservation failed.",
    });
  }

  if (reserve.data?.duplicate) {
    return reply({
      success: false,
      status: reserve.data.status,
      reference,
      error:
        "This request was already processed. Check transaction history before retrying.",
    }, 409);
  }

  const form = new FormData();
  form.append("serviceID", serviceID);
  form.append("api", gsubzKey);
  form.append("amount", String(amount));
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
      p_service: "Airtime",
      p_phone: phone,
      p_metadata: {
        reason: "provider_timeout_or_connection_error",
        network: networkInput,
      },
    });

    return reply({
      success: false,
      status: "pending",
      reference,
      error:
        "The provider response is uncertain. Funds remain reserved while the order is checked. Do not retry yet.",
    }, 202);
  }

  const statusValue = String(
    providerData?.status ??
    providerData?.data?.status ??
    providerData?.data?.transaction_status ??
    "",
  ).trim().toLowerCase();

  const success =
    httpOk &&
    ["successful", "success", "completed"].includes(statusValue);

  const failed = [
    "failed",
    "failure",
    "error",
    "rejected",
    "cancelled",
  ].includes(statusValue);

  if (success) {
    const finalize = await admin.rpc(
      "sparkle_airtime_wallet_action",
      {
        p_user_id: user.id,
        p_action: "success",
        p_reference: reference,
        p_amount: amount,
        p_service: "Airtime",
        p_phone: phone,
        p_metadata: {
          network: networkInput,
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
          "The provider reported success, but Sparkle could not finalize the transaction. Contact support before retrying.",
      }, 202);
    }

    return reply({
      success: true,
      status: "successful",
      reference,
      network: networkInput,
      phone,
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
        p_service: "Airtime",
        p_phone: phone,
        p_metadata: {
          network: networkInput,
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
          "The provider rejected the order, but the refund needs reconciliation. Do not retry yet.",
      }, 202);
    }

    return reply({
      success: false,
      status: "refunded",
      reference,
      error:
        "GSubz did not complete the airtime order. Your wallet has been refunded.",
      provider: providerData,
    });
  }

  await admin.rpc("sparkle_airtime_wallet_action", {
    p_user_id: user.id,
    p_action: "pending",
    p_reference: reference,
    p_amount: amount,
    p_service: "Airtime",
    p_phone: phone,
    p_metadata: {
      network: networkInput,
      provider_response: providerData,
      http_ok: httpOk,
    },
  });

  return reply({
    success: false,
    status: "pending",
    reference,
    error:
      "GSubz has not confirmed the order. Funds remain reserved until the result can be checked.",
    provider: providerData,
  }, 202);
});
