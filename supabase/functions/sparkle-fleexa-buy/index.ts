
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BASE = "https://fleexa.com.ng/developer";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return reply({ success: false, message: "POST required" }, 405);
  }

  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const fleexaKey = Deno.env.get("FLEEXA_API_KEY");

  if (!url || !anonKey || !serviceKey || !fleexaKey) {
    return reply({ success: false, message: "Server configuration incomplete" }, 500);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return reply({ success: false, message: "Please sign in" }, 401);
  }

  const authClient = createClient(url, anonKey, {
    auth: { persistSession: false },
  });

  const { data: authData, error: authError } =
    await authClient.auth.getUser(authHeader.slice(7));

  if (authError || !authData.user) {
    return reply({ success: false, message: "Invalid session" }, 401);
  }

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false },
  });

  let serviceName: string;

  try {
    const body = await req.json();
    serviceName = String(body.serviceName ?? "").trim();

    if (
      !serviceName ||
      serviceName.length > 100 ||
      !/^[a-zA-Z0-9 _.-]+$/.test(serviceName)
    ) {
      return reply({ success: false, message: "Invalid service name" }, 400);
    }
  } catch {
    return reply({ success: false, message: "Invalid request body" }, 400);
  }

  // Always fetch the price from Fleexa; never trust a browser-supplied price.
  let priceData: any;

  try {
    const response = await fetch(
      `${BASE}/sms4/prices?serviceName=${encodeURIComponent(serviceName)}`,
      { headers: { Authorization: `Bearer ${fleexaKey}` } },
    );

    priceData = await response.json();

    if (!response.ok || priceData?.success !== true) {
      return reply({
        success: false,
        message: "Fleexa could not confirm this service price",
      }, 502);
    }
  } catch {
    return reply({
      success: false,
      message: "Price service unavailable. Please try again.",
    }, 502);
  }

  const rows = Array.isArray(priceData.data)
    ? priceData.data
    : priceData.data
      ? [priceData.data]
      : [];

  const exactMatch = rows.find((item: any) =>
    String(item?.name ?? item?.serviceName ?? "").toLowerCase() ===
    serviceName.toLowerCase()
  );

  const priceItem =
    exactMatch ??
    (rows.length === 1 &&
      !rows[0]?.name &&
      !rows[0]?.serviceName
      ? rows[0]
      : null);

  const providerCost = Number(priceItem?.price_ngn);
  const maxPriceUsd = Number(priceItem?.price_usd);

  if (
    !Number.isFinite(providerCost) ||
    providerCost <= 0 ||
    !Number.isFinite(maxPriceUsd) ||
    maxPriceUsd <= 0
  ) {
    return reply({
      success: false,
      message:
        "Price format is not verified. No purchase was made and no wallet money was deducted.",
    }, 502);
  }

  const requestId = crypto.randomUUID();

  // Atomically reserve the wallet amount using the protected SQL function.
  const { data: reservation, error: reserveError } = await admin.rpc(
    "sparkle_reserve_sms_otp",
    {
      p_user_id: authData.user.id,
      p_request_id: requestId,
      p_service_name: serviceName,
      p_country: "US",
      p_provider_cost: providerCost,
    },
  );

  if (reserveError || !reservation?.success) {
    return reply({
      success: false,
      message: reserveError?.message ??
        reservation?.message ??
        "Wallet reservation failed",
    }, 400);
  }

  let buyData: any;

  try {
    const response = await fetch(`${BASE}/sms4/buy`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fleexaKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        serviceName,
        maxPrice: maxPriceUsd.toFixed(2),
      }),
    });

    buyData = await response.json();

    if (!response.ok && buyData?.success !== false) {
      // An HTTP error may not prove the provider rejected the order.
      await admin.from("sparkle_sms_otp_orders").update({
        status: "unknown",
        provider_response: buyData,
        error_message: "Ambiguous provider response; reconciliation required",
      }).eq("request_id", requestId);

      return reply({
        success: false,
        status: "unknown",
        requestId,
        message: "Order needs checking. Do not buy again yet.",
      }, 202);
    }
  } catch {
    await admin.from("sparkle_sms_otp_orders").update({
      status: "unknown",
      error_message: "Connection lost; provider order needs reconciliation",
    }).eq("request_id", requestId);

    return reply({
      success: false,
      status: "unknown",
      requestId,
      message: "Order status is uncertain. Do not purchase again yet.",
    }, 202);
  }

  const data = buyData?.data ?? {};

  if (buyData?.success === true) {
    const providerRequestId =
      data.requestId ?? data.activation_id ?? data.id ?? null;

    const phoneNumber = data.number ?? data.phone ?? null;

    if (!providerRequestId || !phoneNumber) {
      await admin.from("sparkle_sms_otp_orders").update({
        status: "unknown",
        provider_response: buyData,
        error_message: "Provider reference or phone number missing",
      }).eq("request_id", requestId);

      return reply({
        success: false,
        status: "unknown",
        requestId,
        message: "Provider response needs reconciliation before reuse.",
      }, 202);
    }

    const { error: saveError } = await admin
      .from("sparkle_sms_otp_orders")
      .update({
        provider_request_id: String(providerRequestId),
        phone_number: String(phoneNumber),
        provider_response: buyData,
        status: "pending",
        error_message: null,
      })
      .eq("request_id", requestId);

    if (saveError) {
      // Never refund automatically after the provider may have issued a number.
      return reply({
        success: false,
        status: "unknown",
        requestId,
        message: "Provider accepted the order; support reconciliation is required.",
      }, 202);
    }

    return reply({
      success: true,
      status: "pending",
      requestId,
      phoneNumber,
      amount: reservation.amount,
      message: "Number purchased. OTP retrieval is not connected yet.",
    });
  }

  if (buyData?.success === false) {
    const { error: refundError } = await admin.rpc(
      "sparkle_finish_sms_otp",
      {
        p_request_id: requestId,
        p_status: "failed",
        p_provider_response: buyData,
        p_error: String(buyData?.message ?? "Provider rejected purchase"),
      },
    );

    if (refundError) {
      return reply({
        success: false,
        status: "unknown",
        requestId,
        message: "Provider rejected the order; refund needs reconciliation.",
      }, 202);
    }

    return reply({
      success: false,
      status: "failed",
      message: "Provider rejected the purchase. Refund processed.",
    }, 502);
  }

  await admin.from("sparkle_sms_otp_orders").update({
    status: "unknown",
    provider_response: buyData,
    error_message: "Unrecognized provider response",
  }).eq("request_id", requestId);

  return reply({
    success: false,
    status: "unknown",
    requestId,
    message: "Order needs reconciliation before another purchase.",
  }, 202);
});
